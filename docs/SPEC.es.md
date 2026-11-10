# SPEC — Servicio de sincronización de disponibilidad

> Traducción al castellano de `SPEC.md` para uso personal. **La versión de referencia es `SPEC.md` (inglés).** Si cambia una, hay que actualizar la otra.

Estado: **versión inicial, escrita antes de cualquier código**. Los cambios posteriores se registran en el historial de git y se resumen en §12.

## 1. Objetivo

Un servicio en Node.js + TypeScript que acepta actualizaciones de disponibilidad/precio de los gestores, las persiste de forma duradera y las propaga a **Portal Sol** de forma fiable, respetando sus límites, de modo que el portal acabe reflejando exactamente lo que pidió el gestor. Expone el estado de sincronización por alojamiento y suficientes métricas/logs para que quien esté de guardia pueda juzgar la salud de la sincronización.

### Fuera de alcance
Autenticación, UI, despliegue, dashboards/stack de alertas, múltiples portales, múltiples instancias del servicio (ver §10), reconciliar cambios hechos en el portal por terceros.

## 2. Qué sabemos de Portal Sol

Según `API.md` más un sondeo contra la variante `base` el 2026-11-09 (~150 peticiones):

| Hecho | Fuente | Consecuencia en el diseño |
|---|---|---|
| **30 peticiones/min**, `429` + `Retry-After` preciso, ventana ~60 s | Medido | Limitador global en el cliente (25/min por defecto, configurable) + pausa global ante un 429. |
| Los `503` **cuentan para el límite** | Medido | El limitador cuenta cada petición enviada, sea cual sea el resultado. |
| `503` en **~24 %** de las peticiones, sin aplicar nada | Medido / doc | Reintentar es el camino normal, no la excepción. |
| Respuestas lentas / timeouts que pueden haberse aplicado | Doc (no observado: p50 470 ms, máx 810 ms) | Timeout en el cliente (5 s) + reintento; es seguro porque el PUT es idempotente. |
| Máx. **31 días** por PUT (inclusivo) | Doc + medido | Partir los updates en trozos de ≤ 31 días. |
| `400` / `404` son permanentes | Doc | Sin reintento; marcar como fallido. |
| Acepta campos desconocidos en el body (el doc dice `INVALID_BODY`) | Medido | Solo enviamos campos documentados; no dependemos de ninguno de los dos comportamientos. |
| `/health` informa `variant: "base"` | Medido | Otras variantes pueden comportarse distinto: todos los límites son configuración y `Retry-After` siempre manda. |

## 3. Arquitectura

```
POST /updates ──▶ API HTTP ──(1 tx)──▶ PostgreSQL ◀──(reclamar / completar)── Worker ──▶ Portal Sol
GET  /accommodations/:id/sync-status ◀─┘    updates + sync_tasks              │  limitador (global)
GET  /metrics, logs estructurados ◀───────────────────────────────────────────┘  reintentos / backoff
```

Un único proceso ejecuta la API HTTP y el worker. Módulos principales:

- `domain/` — lógica pura: validación de fechas, troceo de rangos, clasificación de respuestas, backoff. **TDD.**
- `portal/` — `PortalClient` (HTTP, timeout, API key) y `RateLimiter`. El cliente está detrás de una interfaz para poder añadir un segundo portal.
- `db/` — migraciones (SQL plano, aplicadas al arrancar) y repositorio.
- `worker/` — reclama tareas, las envía y registra el resultado.
- `http/` — rutas Fastify y validación.
- `metrics/` — registro de `prom-client`.

Organización del código (`service/`): el código de producción en `src/` y todos los tests en `test/`.

```
src/
  main.ts  config.ts
  domain/            lógica pura, sin E/S
    calendar/        fechas, troceo de rangos
    updates/         validación de peticiones, derivación del estado
    retry/           clasificación de respuestas, backoff
  portal/            cliente de Portal Sol, limitador
  db/                migrations/*.sql, migrate, pool, repository
  http/              app Fastify, formato de error, routes/
  worker/            reclamar, enviar, registrar resultados
  metrics/           registro de prom-client
test/
  unit/              replica src/ (rápidos, sin Docker)
  integration/       PostgreSQL real (y más adelante Portal Sol)
  e2e/               el servicio completo contra el portal real
  support/           helpers comunes: BD de test, fixtures, admin del portal
```

Los tests importan el código de producción con el subpath import de Node `#src/*` (`imports` en `package.json`), que Node, TypeScript y Vitest resuelven de forma nativa.

Stack: **Fastify, pino (logs JSON), `pg`, `prom-client`, Vitest**. Node 24 (`.nvmrc`).

## 4. Decisiones de diseño clave

### D1. Orden: FIFO estricto por alojamiento
Los updates de un mismo alojamiento se envían **en orden de aceptación, de uno en uno**. Nunca se envía un update posterior antes de que el anterior del mismo alojamiento haya terminado (sincronizado o fallido de forma permanente). Esto garantiza que, para cada día, el último valor que recibe el portal es el último valor que envió el gestor, así que los updates solapados acaban correctos.
*Descartado:* el modelo de estado deseado por día. Fusiona updates y gasta menos peticiones, pero necesita control de versiones y reagrupar rangos, más de lo que permite el presupuesto de tiempo. Es el siguiente paso natural (§11).

Para que el orden de aceptación esté bien definido con `POST` concurrentes, la transacción de inserción toma `pg_advisory_xact_lock(hashtext(accommodation_id))`. Así, los ids de un mismo alojamiento se asignan y confirman en orden, y un id menor nunca puede hacerse visible después de uno mayor.

### D2. Unidad de trabajo: una tarea por trozo de ≤ 31 días
Un update se guarda junto con sus trozos (`sync_tasks`) en la misma transacción. El orden dentro de un alojamiento es `task.id`, que sigue (orden del update, índice del trozo). Si falla el trozo 2 de 3, solo se reintenta el 2, así que no se gasta cupo reenviando trozos ya aplicados.

### D3. Aceptar sin preguntar al portal
`POST /updates` valida la forma y las fechas en local y nunca llama al portal. Así, la entrada sigue funcionando aunque el portal esté caído, que es precisamente la razón de tener una cola. Un `accommodationId` desconocido aparece como fallo permanente `404` en el estado y en las métricas.

### D4. Política de reintentos

| Resultado | Clase | Acción |
|---|---|---|
| 2xx | éxito | Tarea `done`. |
| 429 | transitorio | Reprogramar para `Retry-After` + 500 ms de margen (60 s si la cabecera falta o no es válida; con un máximo de 10 min, porque una cabecera disparatada no debe congelar todos los envíos); **pausar todos los envíos** hasta entonces. |
| 503, timeout, error de red, 5xx | transitorio | Reprogramar con backoff exponencial y jitter completo (base 1 s, máximo 5 min). |
| Cualquier otro código (4xx no listados aquí, 1xx, 3xx) | transitorio (inesperado) | Reintentar con backoff, con la etiqueta `unexpected_status`, y alertar. El portal no lo documenta, así que descartar el update sería perderlo; si se repite, se ve en la antigüedad del pendiente más viejo. |
| 401 | transitorio (configuración) | Reintentar con backoff. Una key incorrecta se arregla sin perder la cola; alerta inmediata. |
| 400, 404 | permanente | Tarea `failed`. Los trozos restantes del update pasan también a `failed` (fallarían igual: las fechas ya están validadas). Esto desbloquea la cola del alojamiento. |

Los fallos transitorios se reintentan **sin límite**: poner un tope significaría descartar updates ya aceptados. Una tarea que se reintenta indefinidamente se detecta con la métrica y la alerta de antigüedad del pendiente más viejo (§7).

### D5. Concurrencia y limitación de peticiones
- La concurrencia del worker es **3** por defecto, para que el rendimiento no se hunda si el portal se vuelve lento.
- **Como mucho una tarea en vuelo por alojamiento**, como exige D1.
- Un limitador global en memoria de ventana deslizante permite como mucho `PORTAL_MAX_REQUESTS_PER_MINUTE` (25 por defecto) inicios de petición en cualquier ventana de 60 s. Cada hueco del worker obtiene permiso **antes** de reclamar una tarea, para no retener un lease mientras espera. Si al reclamar no hay nada, se devuelve **ese** permiso (cada permiso tiene un token): un worker ocioso no consume cupo. La espera de un permiso se puede cancelar, así que el apagado nunca espera a la ventana. Justo antes de enviar, el hueco vuelve a comprobar la pausa global: un permiso conseguido justo antes del 429 de otro hueco no debe enviarse antes del `Retry-After`, así que la tarea se reprograma.
- **Un único worker activo por base de datos.** El worker toma un advisory lock de sesión antes de su primera reclamación; las demás instancias quedan solo con la API (en espera) y reintentan el lock, de modo que una segunda réplica, o el proceso antiguo durante un despliegue *rolling*, nunca duplica el ritmo. Al arrancar, el limitador se inicializa con los intentos del último minuto leídos de la base de datos, para que un reinicio no ponga a cero nuestra parte de la ventana del portal. Solo se guarda el último intento de cada tarea, así que una tarea reintentada dos veces en ese minuto cuenta una; el margen de 25 frente a 30 lo absorbe.

### D6. Leases para sobrevivir a caídas
Reclamar una tarea fija `locked_until = now() + lease` (30 s por defecto, muy por encima del timeout de 5 s) e incrementa `attempts`. Si el proceso muere a mitad de petición, el lease caduca y la tarea se reclama de nuevo. Reenviarla es seguro porque el PUT es idempotente. La reclamación devuelve el nuevo valor de `attempts` como **token de exclusión** (*fencing token*): completar, reprogramar o fallar una tarea solo se aplica mientras el token siga coincidiendo, de modo que un worker cuyo lease caducó no puede sobrescribir el resultado del worker que volvió a reclamar la tarea. **Todas las horas de la cola usan el reloj de la base de datos**: leases, `next_attempt_at` (la app pasa un retraso y la base de datos calcula `now() + retraso`) y `last_timeout_at`. Así, una diferencia entre los relojes de la app y de la base de datos nunca puede desplazar un reintento ni un lease. Visto en las pruebas: el reloj de la VM de Docker iba 52 s retrasado después de que el Mac entrara en reposo. Consulta de reclamación (esquema):

```sql
SELECT t.id FROM sync_tasks t
WHERE t.status = 'pending' AND t.next_attempt_at <= now()
  AND (t.locked_until IS NULL OR t.locked_until < now())
  AND NOT EXISTS (SELECT 1 FROM sync_tasks p
                  WHERE p.accommodation_id = t.accommodation_id
                    AND p.status = 'pending' AND p.id < t.id)
ORDER BY t.next_attempt_at, t.id
LIMIT 1 FOR UPDATE SKIP LOCKED;
```

### D7. Sin verificación por lectura
Confiamos en el `200` y en la idempotencia; no hacemos `GET` al portal después de cada `PUT`. Con 25 peticiones por minuto, verificar reduciría el rendimiento a la mitad. La verificación la hacen los tests de integración (§9).

### D8. Acceso a datos: `pg` con SQL escrito a mano, sin ORM
Las consultas que hacen correcto el sistema son específicas de Postgres: `FOR UPDATE SKIP LOCKED` con un lease (D6), `pg_advisory_xact_lock` para el orden (D1) y el `NOT EXISTS` que comprueba la cabeza de la cola. Un ORM como Prisma no las expresa en su API de consultas, así que acabarían como SQL crudo al lado del ORM. El ORM añadiría entonces generación de código, un fichero de schema aparte y su propia herramienta de migraciones para dos tablas, y escondería justo la parte que un revisor necesita ver.

Todo el SQL vive en una capa de repositorio fina (`db/repository.ts`) que devuelve objetos tipados. El resto del código no sabe que existe SQL, así que cambiar el enfoque de acceso a datos más adelante solo toca un fichero. Las migraciones son ficheros `.sql` numerados que aplica al arrancar un pequeño ejecutor (`db/migrate.ts`), el cual registra los ficheros aplicados en una tabla `schema_migrations`.
*Considerado:* Kysely, un query builder tipado que soporta `.forUpdate().skipLocked()`. Es una opción razonable, pero con dos tablas la seguridad de tipos que aporta no justifica una dependencia más ni lo que cuesta aprenderla, y los advisory locks seguirían siendo SQL crudo.

### D9. Aplicación tardía tras un timeout: una ventana de espera
Un PUT que expira en nuestro lado puede aplicarse en el portal **más tarde**, cuando ya lo hemos reintentado y hemos pasado al siguiente update del alojamiento. Si esa aplicación tardía llega después del PUT más nuevo, sobrescribe esos días con el valor antiguo. FIFO ordena lo que *enviamos*, no lo que el portal *aplica*, y la idempotencia no ayuda porque los valores son distintos. Se reprodujo contra el portal real: 1 estado final obsoleto de 14 PUT que expiraron. Medido en la variante `base`: un PUT abandonado se aplica más tarde o nunca (3 de 25 no se aplicaron nunca), y se observó una aplicación tardía **al menos 5 s** después de que lo diéramos por perdido. Los 30 s por defecto dejan un margen amplio sobre eso.

Por eso, cuando un intento expira, la tarea registra `last_timeout_at`. **Al reclamar**, una tarea no se puede reclamar mientras otra tarea del mismo alojamiento cuyos días se **solapen** con los suyos haya expirado hace menos de `PORTAL_TIMEOUT_SETTLE_MS` (30 s por defecto), tiempo suficiente para que la petición original termine. Comprobarlo al reclamar cubre los updates aceptados *después* de que se completara la tarea expirada, por ejemplo una corrección rápida del gestor; la primera versión solo retenía las tareas que ya estaban en cola al completar, y la review del worker encontró ese hueco. Una **caída** a mitad de petición es el mismo caso: un lease que expira sin resultado guardado significa que su proceso murió con el PUT en vuelo, así que al reclamarla de nuevo también se registra `last_timeout_at` (el test e2e de un `SIGKILL` a mitad de sincronización encontró el valor antiguo aplicado el último). Solo esperan los días solapados, y solo después de un timeout o de una caída. *Riesgo residual:* un portal que aplique una petición más de la ventana después de nuestro timeout. La solución completa es la verificación por lectura o la reconciliación periódica (§11).

## 5. Modelo de datos (PostgreSQL)

```sql
updates (
  id              bigserial PRIMARY KEY,      -- orden de aceptación
  accommodation_id text NOT NULL,
  date_from date NOT NULL, date_to date NOT NULL,
  available boolean NOT NULL,
  price_per_night numeric(12,2) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE                  -- clave opcional del cliente (SPEC §6)
)
sync_tasks (
  id              bigserial PRIMARY KEY,      -- orden de envío dentro de un alojamiento
  update_id bigint NOT NULL REFERENCES updates(id),
  accommodation_id text NOT NULL,             -- desnormalizado para la consulta de reclamación
  chunk_index int NOT NULL,
  date_from date NOT NULL, date_to date NOT NULL,
  status text NOT NULL DEFAULT 'pending',     -- pending | done | failed
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text, last_http_status int,       -- del intento más reciente; se borra tras un éxito
  last_attempt_at timestamptz,               -- cuándo empezó el último intento (sync-status, depuración)
  last_timeout_at timestamptz,               -- último intento que expiró (ventana de espera de D9)
  completed_at timestamptz
)
-- índices: (accommodation_id, status, id), (status, next_attempt_at)
```

Formatos de `last_error`: `"<status> <CODE>: <message>"` para errores HTTP (p. ej. `"404 NOT_FOUND: Accommodation acc-9999 not found"`), `"timeout after <ms> ms"`, `"network error <code>"`.

El estado de un update se **deduce** de sus tareas: `failed` si alguna falló, `synced` si todas están hechas y `pending` en otro caso. Guardarlo aparte duplicaría estado.

## 6. API HTTP

### `POST /updates`
Body como en el README. Cabecera opcional **`Idempotency-Key`** (1–128 caracteres: letras, dígitos, `_`, `-`, `.`, `:`). Validación:
- `accommodationId`: cumple `^[A-Za-z0-9_-]{1,64}$`. El id va dentro de la ruta de la URL del portal, así que `/`, `..` o espacios nunca deben llegar a ella.
- `from` y `to`: fechas `YYYY-MM-DD` reales, con `to >= from` y un rango de 366 días como mucho (`MAX_UPDATE_RANGE_DAYS`).
- `available`: booleano.
- `pricePerNight`: número finito, de 0 a 1.000.000, con 2 decimales como mucho.
- Se rechazan los campos desconocidos.

| Respuesta | Cuándo |
|---|---|
| `202 { "updateId": 42, "status": "pending", "chunks": 3 }` | Aceptado. Se devuelve **después** de confirmar la transacción. |
| `400 { "error": { "code", "message" } }` | Entrada inválida (mismo formato de error que el portal), incluido un JSON mal formado. No se persiste nada. |
| `413` | Body de más de 1 MB. |
| `415 UNSUPPORTED_MEDIA_TYPE` | El `Content-Type` no es `application/json`. |
| `400 INVALID_HEADER` | `Idempotency-Key` presente pero sin 1–128 caracteres permitidos. |
| `202` + `Idempotent-Replayed: true` | Misma `Idempotency-Key` y mismo body que una petición anterior: la respuesta original, sin guardar nada de nuevo. |
| `422 IDEMPOTENCY_KEY_REUSED` | Misma `Idempotency-Key` con un body distinto. |
| `503 UNAVAILABLE` + `Retry-After: 5` | La base de datos no está disponible o está ocupada (timeout de bloqueo). **Un update nunca se confirma (`202`) sin haberse guardado.** |

Todos los errores, incluido el `404` de rutas desconocidas, usan el mismo formato `{ "error": { "code", "message" } }`.

### `GET /accommodations/:id/sync-status`

```json
{
  "accommodationId": "acc-1003",
  "status": "pending",
  "pendingUpdates": 2,
  "failedUpdates": 0,
  "lastSyncedAt": "2026-11-09T10:15:31.000Z",
  "oldestPendingSince": "2026-11-09T10:15:20.000Z",
  "recentUpdates": [
    { "updateId": 42, "from": "2026-12-01", "to": "2027-02-28", "available": true, "pricePerNight": 120,
      "status": "pending", "acceptedAt": "…", "syncedAt": null,
      "chunks": { "total": 3, "done": 1 }, "attempts": 4,
      "lastError": "503 UNAVAILABLE", "nextAttemptAt": "…" }
  ]
}
```

- `status`: `pending` si hay algún update pendiente; si no, `failed` si falló el update más reciente; si no, `synced`.
  *Limitación conocida, aceptada:* un update antiguo fallido sobre días que no cubre un update posterior sincronizado se mostraría como `synced`. Solo `400` y `404` son permanentes: el `400` lo evita nuestra propia validación, y un `404` (alojamiento desconocido) hace fallar por igual todos los updates de ese alojamiento, así que el caso solo puede darse por un bug.
- `recentUpdates`: los últimos 20, del más nuevo al más antiguo; los contadores cubren todos los updates.
- Por update, sumando sus trozos: `attempts` es la suma de los intentos de los trozos, `lastError` viene del intento más reciente (`last_attempt_at`), `nextAttemptAt` es el más próximo entre los trozos pendientes, y `syncedAt` es el `completed_at` del último trozo.
- Un alojamiento sin updates devuelve `404`, y también un `:id` que no cumple el patrón de `accommodationId` (no puede existir ningún update para él).

### `GET /health` y `GET /ready`
- `/health` (liveness): `200 { "status": "ok" }` siempre que el proceso sirva HTTP, aunque la base de datos esté caída (reiniciar no ayudaría).
- `/ready` (readiness): `200 { "status": "ready", "database": "up", "worker": "active" | "standby" | "disabled" }`; `503` con el formato de error cuando la base de datos está caída, para que un balanceador deje de enviar updates que igualmente responderían 503.

**Justificación:** el gestor necesita saber si *su* cambio ha llegado. Quien está de guardia necesita saber si algo está atascado y por qué (intentos, último error, próximo intento). Las dos cosas se responden con los datos que D2 ya guarda.

## 7. Observabilidad

**Logs:** JSON con pino. Cada llamada al portal registra `taskId`, `updateId`, `accommodationId`, `attempt`, `outcome`, `httpStatus`, `durationMs` y `nextAttemptAt`. Los reintentos se registran en `warn` y los fallos permanentes en `error`.

**Métricas** (`GET /metrics`, formato texto de Prometheus, en el puerto de la API). Cada instancia de la app tiene su propio registro, y se incluyen las métricas del proceso Node (`process_*`, `nodejs_*`). No hay etiquetas por alojamiento, porque su cardinalidad no tiene límite. **Todos los valores de etiqueta documentados se inicializan a 0 al arrancar**: una serie con etiquetas que solo aparece en su primer incremento es invisible para `rate()`/`increase()`, así que una alerta no vería el primer evento tras cada reinicio, o no podría saltar nunca.

| Métrica | Tipo | Para qué |
|---|---|---|
| `sync_tasks_pending{state}` | gauge (BD, al hacer scrape) | Trabajo pendiente **por estado**, que responde *por qué* existe: `ready` (se reclamaría ya), `in_flight` (con lease), `waiting_retry` (backoff / `Retry-After`), `held_settle` (D9), `queued` (detrás de una tarea anterior de su alojamiento). Los estados reparten las tareas pendientes sin solaparse. |
| `sync_oldest_pending_task_age_seconds` | gauge (BD) | Antigüedad del update pendiente más viejo **desde `accepted_at`**: cuánto lleva esperando un gestor. Medirla desde el último intento la reiniciaría en cada reintento. |
| `sync_stuck_heads{min_attempts="10"}` | gauge (BD) | Alojamientos cuya tarea en cabeza lleva ≥ 10 intentos: bloqueo en cabeza de cola (D1 + reintentos ilimitados). |
| `sync_head_attempts_max` | gauge (BD) | El mayor número de intentos entre las cabezas. |
| `sync_metrics_db_up` | gauge | 1 si en este scrape se pudo leer el estado de la cola. La lectura tiene su propio timeout de 3 s. Si falla, se sirven los últimos valores buenos con su antigüedad; si no hubo ninguna lectura previa, las gauges **no aparecen**, nunca un 0 falso. |
| `sync_queue_state_age_seconds` | gauge | Antigüedad de las gauges de la cola anteriores (0 si se leyeron en este scrape). |
| `portal_requests_total{outcome}` | counter | `success`, `rate_limited`, `unavailable`, `timeout`, `network_error`, `client_error`, `unauthorized`, `server_error`, `unexpected_status`. |
| `portal_request_duration_seconds{outcome}` | histogram | Latencia del portal; intervalos `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` s. |
| `sync_retries_total{reason}` | counter | Reintentos por resultado transitorio. |
| `sync_tasks_finished_total{result}` | counter | `done` o `failed`. Un fallo permanente cuenta la tarea y sus hermanos fallidos (D4). |
| `sync_update_lag_seconds` | histogram | De la aceptación al último trozo completado, una vez por update sincronizado (salud de extremo a extremo); intervalos `1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600` s. |
| `sync_sends_deferred_total` | counter | Envíos omitidos porque la pausa global empezó entre la reclamación y el envío (D5). |
| `updates_accepted_total` | counter | Updates aceptados (sin contar las repeticiones idempotentes). |
| `updates_rejected_total{code}` | counter | `POST /updates` no aceptados, por código de error: los códigos 4xx, y `UNAVAILABLE` cuando la base de datos está caída (503). |
| `sync_stale_results_total` | counter | Resultados de intentos descartados porque la tarea había perdido su lease (fencing, D6): señal de contención de leases o de una base de datos lenta. |
| `portal_rate_limiter_paused_seconds` | gauge | Lo que queda de la pausa global tras un 429. |
| `portal_rate_limiter_window_starts` | gauge | Inicios de petición en la ventana actual de 60 s. |
| `sync_worker_active` | gauge | 1 en la instancia que tiene el lock de worker único (D5); 0 en una instancia en espera o con el worker desactivado. |

**Varias instancias:** los contadores son por proceso, así que se agregan con `sum()`. Las gauges derivadas de la BD dan el mismo valor en todas las instancias, así que se agregan con `max()`.

**Alertas** (reglas de Prometheus listas para usar en `ops/alerts.yml`, con tests de comportamiento en `ops/alerts.test.yml` que ejecuta `promtool` en el CI). La falta de datos nunca debe leerse como salud: `ServiceMetricsAbsent` salta cuando ninguna instancia expone métricas.

| Alerta | Condición | Severidad |
|---|---|---|
| Sincronización atascada | `max(sync_oldest_pending_task_age_seconds) > 600` durante 5m | crítica |
| Ningún worker activo | `max(sync_worker_active) == 0` con trabajo pendiente, durante 5m | crítica |
| Métricas del servicio ausentes | `absent(sync_worker_active)` durante 2m (no se está haciendo scrape de ninguna instancia) | crítica |
| Worker sin enviar | hay tareas listas y `sum(rate(portal_requests_total[5m])) == 0`, durante 5m, **salvo** que el limitador esté en pausa por un `Retry-After` | crítica |
| Credenciales incorrectas | `sum(increase(portal_requests_total{outcome="unauthorized"}[5m])) > 0` | crítica |
| Las métricas no pueden leer la BD | `min(sync_metrics_db_up) == 0` durante 2m | crítica |
| Gauges de la cola desactualizadas | `max(sync_queue_state_age_seconds) > 120` (servidas desde la última lectura buena) | aviso |
| Alojamiento atascado | `max(sync_stuck_heads) > 0` durante 15m | aviso |
| Portal degradado | ratio de no-éxito > 50 % en 10m (la línea base ronda el 25 %) | aviso |
| Throttling inesperado | algún `rate_limited` en 10m (nuestro limitador debería evitarlo) | aviso |
| Limitador pausado mucho tiempo | `max(portal_rate_limiter_paused_seconds) > 300` | aviso |
| Respuestas inesperadas del portal | algún `unexpected_status` en 10m (código no documentado, que se reintenta) | aviso |
| Fallos permanentes | algún `sync_tasks_finished_total{result="failed"}` en 15m | aviso |
| Retenciones de D9 persistentes | `max(sync_tasks_pending{state="held_settle"}) > 0` durante 10m (una retención dura 30 s; si persiste es que se repiten los timeouts) | aviso |
| Portal lento | p95 de `portal_request_duration_seconds` > 3 s durante 10m | aviso |
| Retraso de sincronización alto | p95 de `sync_update_lag_seconds` > 600 s durante 15m | aviso |

## 8. Configuración (variables de entorno)

`PORT=3000`, `DATABASE_URL=postgres://sync:sync@localhost:5432/sync`, `PORTAL_BASE_URL=http://localhost:4000`, `PORTAL_API_KEY=sol-demo-key`, `PORTAL_MAX_REQUESTS_PER_MINUTE=25`, `PORTAL_TIMEOUT_MS=5000`, `WORKER_CONCURRENCY=3`, `TASK_LEASE_MS=30000`, `RETRY_BASE_MS=1000`, `RETRY_MAX_MS=300000`, `WORKER_POLL_MS=500`, `WORKER_ENABLED=true` (`false` ejecuta solo la API), `PORTAL_TIMEOUT_SETTLE_MS=30000` (D9), `LOG_LEVEL=info`, `MAX_UPDATE_RANGE_DAYS=366`, `DATABASE_STARTUP_TIMEOUT_MS=30000`, `SHUTDOWN_GRACE_MS=10000`.

La configuración se valida al arrancar, y se informa de todas las variables inválidas a la vez. `TASK_LEASE_MS` debe ser mayor que `PORTAL_TIMEOUT_MS` (D6).

**Arranque:** el servicio reintenta la conexión con la base de datos con backoff durante `DATABASE_STARTUP_TIMEOUT_MS` como mucho (30 s). Si sigue sin poder conectar, sale con un código distinto de cero sin abrir el puerto HTTP, para no aceptar nunca updates que no pueda guardar. Después aplica las migraciones pendientes y empieza a escuchar. Con `SIGTERM` deja de aceptar conexiones, espera a las peticiones en curso, cierra el pool y termina con 0; si tarda más de `SHUTDOWN_GRACE_MS` (10 s), lo registra y termina con 1. Una migración que falla se registra como una línea `fatal` estructurada y termina con 1.

**Resiliencia de la base de datos en ejecución:** perder una conexión con el servicio en marcha (reinicio de la base de datos, failover, una conexión inactiva cortada por el servidor) nunca debe tumbar el proceso. El evento `error` del pool se registra, el pool vuelve a conectar en la siguiente consulta y, mientras tanto, las peticiones responden `503`. Cada conexión tiene `statement_timeout = 10 s` y `lock_timeout = 5 s`; un bloqueo que no se consigue a tiempo (por ejemplo, una transacción atascada sobre el mismo alojamiento) responde `503`, y las peticiones HTTP expiran a los 15 s, así que nada se queda colgado indefinidamente.

## 9. Criterios de aceptación

Cada criterio corresponde al menos a un test automatizado. **U** = unitario; **I** = integración contra el Portal Sol real y Postgres, usando `/__admin/reset` y `/__admin/requests`. **E2E** = el proceso real del servicio como caja negra: las comprobaciones solo usan su API HTTP, `/metrics` y el portal.

| # | Criterio | Test |
|---|---|---|
| AC1 | Un `POST /updates` válido devuelve `202` con `updateId`, y el update y sus tareas están en la BD cuando llega la respuesta. | I |
| AC2 | Una entrada inválida (fecha mal formada o inexistente, `to < from`, precio negativo o en texto, campo ausente o desconocido, rango > 366 días) devuelve `400` y no persiste nada. | U + I |
| AC3 | Un rango se parte en trozos consecutivos de 31 días como mucho que lo cubren exactamente, incluso cruzando meses y años. | U |
| AC4 | **Estado final:** tras una secuencia de updates solapados sobre un alojamiento (incluidos rangos de más de 31 días), cada día afectado en el portal coincide con el último update aceptado que lo cubre, pese a los 503 propios del portal. | I |
| AC5 | **Orden:** los PUT de un alojamiento llegan al portal en orden de aceptación (el último PUT con éxito de cada día coincide con AC4), y nunca hay más de uno en vuelo por alojamiento. | I |
| AC6 | **Límites:** con la configuración por defecto, el portal nunca responde `429`. Con el limitador puesto a propósito por encima de 30/min, tras cualquier `429` no se envía ninguna petición antes de que pase el `Retry-After` (se comprueba con las marcas de tiempo del log de admin). | I |
| AC7 | **Reinicio:** los updates aceptados y luego interrumpidos al parar el servicio antes de sincronizar (incluida una tarea con un lease activo, que simula una caída) se sincronizan todos tras el reinicio. | I |
| AC8 | **Timeouts:** con un timeout cercano a la latencia mediana del portal (≈ 400 ms), de modo que una gran parte de las peticiones expira, algunas después de que el portal las haya aplicado, todos los updates convergen igualmente al estado final correcto. (Un timeout mucho más bajo casi no dejaría pasar nada y nunca convergería.) | I |
| AC9 | **Errores permanentes:** un update para un alojamiento inexistente acaba `failed` en cuanto el portal responde `404`: **no se envía ninguna petición para él después de ese 404** (solo pueden precederlo fallos transitorios: los `503` aleatorios del portal y las respuestas lentas que abandonamos por timeout), y no bloquea a otros updates. | I |
| AC10 | La clasificación de respuestas y el backoff siguen D4: la clase correcta para cada código, un backoff dentro de sus límites y el `Retry-After` respetado. | U |
| AC11 | El limitador nunca permite más de N inicios en cualquier ventana de 60 s (con reloj simulado). | U |
| AC12 | `sync-status` muestra `pending` y luego `synced`, con contadores y progreso de trozos correctos; muestra `failed` con el error en el caso de AC9; `404` para un id desconocido. | I |
| AC13 | `/metrics` expone todas las métricas de §7. Durante una ejecución real sus valores cambian como se espera y **coinciden con la realidad**: la suma de `portal_requests_total` es igual a los PUT del log de peticiones del propio portal, y los 503 cuadran. `/health` y `/ready` se comportan como en §6. | I |
| AC14 | **Carga, caja negra:** unos 50 updates sobre 10 alojamientos, algunos solapados y algunos de más de 31 días, enviados con `POST` a la vez al servicio en marcha, acaban todos `synced` y con cada día correcto en el portal. El portal nunca responde `429`, ninguna ventana de 60 s tiene más de 30 peticiones al portal, y las métricas cuadran al final. | E2E |
| AC15 | **Ciclo de vida, caja negra:** un update aceptado por un proceso al que luego se mata (`SIGKILL`) o se para (`SIGTERM`) a mitad de sincronización lo sincroniza el siguiente proceso. Con dos procesos sobre una base de datos, solo uno envía, y el otro toma el relevo cuando el primero muere. | E2E |

Los tests de integración son lentos por naturaleza (el portal admite 30 peticiones por minuto), así que los escenarios se mantienen pequeños. Como los 503 del portal son aleatorios, los timeouts de los tests son generosos.

## 10. Trade-offs y límites de alcance

- **Un único worker activo.** Varias réplicas pueden servir la API, pero solo envía la que tiene el lock (D5). Más rendimiento que el de un worker necesitaría un limitador compartido (una fila en la BD o Redis), no más workers.
- **Polling** a la BD cada 500 ms en lugar de `LISTEN/NOTIFY`: más simple, y la latencia es despreciable frente a los límites del portal.
- **Sin fusión de updates.** Los updates ya superados por otros se envían igualmente. Es correcto, pero desperdicia peticiones si hay muchos cambios.
- **`Idempotency-Key` es opcional.** Un duplicado no siempre es inofensivo con D1. Si la conexión cae durante el `COMMIT`, el update puede quedar guardado mientras el cliente recibe un `503` y reintenta. Si el cliente envió otro update B entre medias, el A reintentado llega después de B y el portal termina con A. Con la clave, el reintento se reconoce y no se guarda nada de nuevo. Los clientes que no la envían asumen ese riesgo. (Un modelo de estado deseado por día tampoco lo eliminaría: un reintento es indistinguible de un cambio nuevo salvo que el cliente lo identifique.)
- **Sin detección de deriva.** Si alguien cambia el portal por fuera de este servicio, no nos enteramos.
- **Aplicación tardía más allá de la ventana (D9).** Si el portal aplica una petición expirada más de `PORTAL_TIMEOUT_SETTLE_MS` después de nuestro timeout, puede quedar un valor obsoleto. Aceptado: requiere un portal que tarde más de 30 s, además de nuestro timeout de 5 s; la verificación por lectura o la reconciliación (§11) lo cerrarían.

## 11. Siguientes pasos (con más tiempo)

Estado deseado por día con fusión de updates (sustituyendo D1): una fila por alojamiento y día con el valor deseado y una versión; el worker envía los días pendientes agrupados en rangos y los marca como sincronizados solo si su versión no cambió mientras tanto. Ahorra peticiones cuando los mismos días cambian repetidamente y hace `sync-status` exacto por día, a costa de un esquema, un repositorio y un worker nuevos. Se deja fuera a propósito: con D1 más `Idempotency-Key` el estado final del portal es igual de correcto, y la API no cambiaría; limitador compartido para varias instancias; relanzar a mano los updates fallidos; verificación por lectura tras los timeouts (el `GET` de los días afectados cuando se vacía la cola de un alojamiento, reencolando una corrección si no coinciden) y reconciliación periódica (`GET` y comparar) con el cupo libre, que cierran el riesgo residual de D9; `LISTEN/NOTIFY`.

## 12. Método de trabajo

- **Primero la spec** (este documento es el primer commit), después commits pequeños que cuenten la historia (Conventional Commits: `feat:`, `test:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **Ramas.**
  - `master` es la rama estable y solo recibe `develop` al cerrar una fase, mediante PR y con un tag de versión.
  - `develop` es la rama de integración.
  - Cada bloque de trabajo va en su propia rama, que sale de `develop` y vuelve a ella mediante un **PR en GitHub**. El prefijo indica qué tipo de bloque es:
    - `feature/<nombre>`: comportamiento nuevo.
    - `refactor/<nombre>`: cambio estructural sin cambio de comportamiento (p. ej. `refactor/structure`).
    - `docs/<nombre>`: solo documentación.
  - Nunca se commitea directamente en `master` ni en `develop`.
- **TDD para `domain/` y el limitador:** escribir los escenarios de §9 como tests que fallan, implementar y después refactorizar.
- **Tests end-to-end** (AC14–AC15): arrancan el proceso real y lo usan solo a través de su interfaz pública, como lo haría un cliente. Usan los valores de producción, salvo un lease y un tope de reintentos más cortos para que cada ejecución tenga una duración acotada. Se ejecutan como un job propio del CI.
- **Tests de integración** para los comportamientos que solo el portal real puede demostrar (AC4–AC9, AC12–AC13), con el worker dentro del proceso del test. La sincronización **nunca** se prueba contra un portal simulado. Un servidor HTTP falso local se usa solo para los fallos de transporte del cliente (timeouts, conexiones cortadas o rechazadas, bodies sin JSON), que el portal real no produce a demanda. El CI ejecuta la integración contra PostgreSQL **y la imagen real de Portal Sol**.
- **Asistido por IA.** Un `CLAUDE.md` recoge el stack, las convenciones, cómo montar el entorno y la regla de "tests primero". Dos skills del proyecto:
  - `tdd-cycle`: rojo → verde → refactor, con un commit por paso.
  - `verify-portal`: resetear el portal, ejecutar un escenario y comprobar `/__admin/requests` y el estado final del portal.

  Todo lo que escribe la IA se valida con esos tests y leyendo el diff. Las correcciones se apuntan en `PROCESS.md`.
- Las notas de preparación (sondeo del portal y análisis de decisiones) están en `docs/CONTEXTO.md`.

### Historial de cambios
- v1: spec inicial.
- v2: decisiones tomadas al definir los escenarios de test del core (`docs/scenarios/core.md`): patrón del `accommodationId` (va en la ruta de la URL del portal), precio máximo de 1.000.000 y, ante un 429, margen de +500 ms tras el `Retry-After` con 60 s por defecto si falta la cabecera.
- v3: cambios a raíz de la review de `feature/core`. Solo `400`/`404` son permanentes; cualquier otro código no documentado se reintenta como `unexpected_status`, con alerta, para que no pueda descartar un update aceptado. El `Retry-After` tiene un máximo de 10 min. Queda documentada la limitación conocida de `sync-status`.
- v4: §3 añade la organización del código (tests en su propio árbol `test/` que replica `src/`, y `domain/` dividido en `calendar/`, `updates/` y `retry/`), decidida antes del bloque de la API. La §12 añade el prefijo de rama `refactor/<nombre>` para cambios estructurales sin cambio de comportamiento.
- v5: decisiones tomadas al definir los escenarios de test de la API (`docs/scenarios/api.md`). §5: nueva columna `sync_tasks.last_attempt_at`. §6: `413`, `415` y `503` con `Retry-After`; un único formato para todos los errores; `404` para un `:id` inválido; la semántica de `attempts`, `lastError`, `nextAttemptAt` y `syncedAt` en updates con varios trozos. §8: `MAX_UPDATE_RANGE_DAYS`, `DATABASE_STARTUP_TIMEOUT_MS`, validación de la configuración, y comportamiento al arrancar y al apagar. Tras la review de la API: `Idempotency-Key` opcional (`updates.idempotency_key`, `422` si se reutiliza, cabecera de repetición); resiliencia de la base de datos en ejecución (errores del pool, `statement_timeout`/`lock_timeout`, timeout por petición); `SHUTDOWN_GRACE_MS`; §10/§11 explican por qué los duplicados no siempre son inofensivos y por qué el modelo por día queda fuera.
- v6: decisiones tomadas al definir los escenarios de test del worker (`docs/scenarios/worker.md`). D5: se devuelven los permisos cuando no hay nada que reclamar, y la espera es cancelable. D6: el token de exclusión `attempts`. §5: `last_error` se borra tras un éxito; formato `"<status> <CODE>: <message>"` / `"timeout after <ms> ms"` / `"network error <code>"`. §8: `WORKER_ENABLED`. AC8: un timeout cercano a la mediana en lugar de 50 ms, con el que nunca convergería. AC9: "ninguna petición tras el 404" en lugar de "exactamente 1 petición" (el portal responde 503 aleatorios incluso para alojamientos desconocidos). §12: un servidor falso solo para fallos de transporte; Portal Sol en el CI. D9 (decisión del autor después de que L6 lo destapara): una ventana de espera tras un timeout (`last_timeout_at`, `PORTAL_TIMEOUT_SETTLE_MS`), riesgo residual en §10, verificación y reconciliación en §11. D6: todas las horas de la cola con el reloj de la base de datos (descubierto cuando el reloj de la VM de Docker se desvió 52 s tras el reposo). Tras la review del worker: la retención de D9 se evalúa al reclamar y solo en días solapados; en D5, tokens de permiso, comprobación de la pausa antes de enviar, un único worker activo por base de datos (advisory lock) y un limitador inicializado desde la base de datos.
- v7: decisiones tomadas al definir los escenarios de test de las métricas (`docs/scenarios/metrics.md`). §7 reescrita: tareas pendientes por estado, cabezas atascadas, gauges del limitador y del worker activo, envíos aplazados, updates rechazados, antigüedad medida desde `accepted_at`, intervalos de los histogramas, `max()`/`sum()` con varias instancias, alertas actualizadas y entregadas también como `ops/alerts.yml`. §6: `/health` y `/ready`. AC13: las métricas deben coincidir con el log de peticiones del propio portal. Tras la review de las métricas: valores de etiqueta inicializados a 0; `ServiceMetricsAbsent`; WorkerNotSending no salta durante una pausa por `Retry-After`; tests de comportamiento de las reglas con `promtool`; la lectura del estado de la cola acotada (timeout propio, último valor bueno con su antigüedad, un índice para la subconsulta de D9); `sync_stale_results_total`; los 503 contados como rechazos `UNAVAILABLE`.
- v8: bloque end-to-end (`docs/scenarios/e2e.md`): AC14 (carga concurrente, caja negra) y AC15 (caída, reinicio limpio y despliegue *rolling*, caja negra); la §12 describe la suite e2e y su job del CI. D9: un lease que expira sin resultado (una caída a mitad de petición) también abre la ventana de espera, encontrado por el test e2e de `SIGKILL`.

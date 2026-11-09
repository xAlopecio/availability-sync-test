# Contexto del proyecto — Availability sync service

> Documento de trabajo para entender **qué hay**, **qué se pide** y **por qué es difícil**, antes de escribir el `SPEC.md`.
> Fuentes: `README.md`, `API.md`, `service/README.md`, `docker-compose.yml` y el sondeo real del portal (2026-11-09).

---

## 1. La idea en una frase

Construir un servicio intermedio que **acepta cambios de disponibilidad/precio de un gestor** y se encarga de **hacerlos llegar de forma fiable a un portal externo poco fiable** (Portal Sol), dejando constancia de en qué estado está cada cosa.

```
 Gestor (Avantio)            NUESTRO SERVICIO                         Portal Sol (externo)
 ───────────────     ─────────────────────────────────────     ───────────────────────────
                     ┌────────────┐   ┌──────────┐   ┌────────┐
 POST /updates ────▶ │ API HTTP   │──▶│ Postgres │◀──│ Worker │──── PUT /availability ───▶  limita 30 req/min
                     │ (valida y  │   │ (cola +  │   │ (envía,│◀─── 200 / 429 / 503 / ⏱ ──  falla ~24 %
 GET sync-status ◀── │  persiste) │   │  estado) │   │ reint.)│                              a veces lento
                     └────────────┘   └──────────┘   └────────┘
                            │                             │
                            └──── /metrics + logs ────────┘   → para quien esté de guardia
```

La clave: **el gestor no espera a que el portal responda**. Nosotros aceptamos el cambio, lo guardamos y respondemos enseguida (`202 Accepted`); el envío al portal ocurre después, en segundo plano, con todos los reintentos que haga falta.

---

## 2. Qué hay en el repositorio

| Elemento | Qué es |
|---|---|
| `README.md` | El enunciado: tarea, entregables, criterios de evaluación. |
| `API.md` | Contrato del portal. Es lo **único** que sabemos de él (no hay código). |
| `docker-compose.yml` | Levanta Portal Sol (`:4000`) + Postgres 18 (`:5432`) o Mongo 8. Elegimos **Postgres**. |
| `service/` | Vacío. Aquí va nuestro código. |
| `.nvmrc` | Node 24 (creado por nosotros, aún sin commitear). |

Estado actual: contenedores levantados y sanos, portal sondeado. **No hay ni una línea de código ni el `SPEC.md`.**

---

## 3. Qué se pide exactamente

### 3.1 Funcionalidad (5 requisitos)

1. **Recibir updates** — `POST /updates` con `{ accommodationId, from, to, available, pricePerNight }`.
2. **Sincronizar con Portal Sol** garantizando tres cosas:
   - **No se pierde ningún update** (aunque el portal falle o nos limite).
   - **Respetamos sus límites** (no lo saturamos).
   - **El estado final del portal = lo que pidió el gestor.**
3. **Exponer el estado** — `GET /accommodations/:id/sync-status`. La forma de la respuesta la decidimos nosotros (y la justificamos).
4. **Persistir en BD real** — si el servicio se reinicia, nada aceptado se pierde.
5. **Ser observable** — logs estructurados + endpoint `/metrics` (Prometheus) que cubra: trabajo pendiente, resultado de las llamadas al portal, latencia y reintentos. Y proponer alertas en el spec.

### 3.2 Lo que NO se pide
Autenticación, UI, despliegue, Grafana/Prometheus corriendo, 100 % de cobertura.

### 3.3 Entregables (pesan tanto como el código)

| Entregable | Cuándo | Contenido |
|---|---|---|
| `SPEC.md` | **Primer commit**, antes de código | Qué se construye, decisiones justificadas, criterios de aceptación, método de trabajo. |
| Código + tests | Varios commits | En `service/`, con `README.md` propio (arrancar, tests, URL del portal). |
| `PROCESS.md` | Al final | Qué hizo la IA y qué tú, dónde falló la IA, qué quedó fuera. |

### 3.4 Cómo se evalúa
- **Spec**: claridad, criterios de aceptación, decisiones justificadas.
- **Código**: diseño, tests con valor real, persistencia y observabilidad que **funcionen de verdad**.
- **Uso de IA**: notas honestas y coherentes con el historial de commits.
- **Criterio técnico**: trade-offs razonados, **alcance acotado**, qué se dejó fuera y por qué.

Y después hay una **fase en vivo** donde lo ampliaremos con ellos → el diseño debe ser fácil de extender (p. ej. un segundo portal, otro tipo de límite…).

**Presupuesto: 3–4 horas efectivas.** Prefieren algo bien acotado y justificado a algo exhaustivo.

---

## 4. Cómo se comporta Portal Sol (documentado + medido)

| Comportamiento | Documentado | Medido por nosotros |
|---|---|---|
| Auth `X-Api-Key: sol-demo-key` | Sí | Sin cabecera → 401 ✅ |
| Rate limit | "N por minuto", sin número | **30 req/min**. Los **503 también cuentan**. `Retry-After` exacto y decreciente; ventana ~60 s. |
| 503 UNAVAILABLE | "a veces" | **~24 %** de las peticiones (13 de 55). Es lo habitual, no la excepción. |
| Lentitud | "a veces no responde en un rato" | **No observada** en ~150 peticiones (p50 470 ms, máx 810 ms). Hay que prepararse igual. |
| Máx. 31 días por petición | Sí | Confirmado: 31 → 200, 32 → 400. |
| PUT idempotente | Sí | (Por diseño; repetir = mismo estado.) |
| Campos extra → INVALID_BODY | Sí | ❌ **Los acepta** (200). Discrepancia con el doc. |
| Fechas fuera de los 90 días | No dice | Las **acepta** (200). |
| `/health` → `variant: "base"` | No dice | Sugiere que **pueden existir otras variantes** (¿más lentas, otro límite?) al evaluar. |

**Conclusión práctica**: no hardcodear "30/min" como verdad absoluta; hacerlo configurable y **obedecer siempre `Retry-After`**.

---

## 5. Por qué el problema es más difícil de lo que parece

### 5.1 "No perder nada" → guardar antes de responder
Si respondemos `202` y luego el proceso muere antes de guardar, el update se perdió. Regla: **primero se escribe en Postgres (transacción), después se responde**. A partir de ahí, el worker lo leerá de la BD aunque el servicio se reinicie 10 veces.

Esto da una garantía de **"al menos una vez"** (at-least-once): puede que enviemos lo mismo dos veces, pero nunca cero. Y como el PUT es idempotente, enviar dos veces es inofensivo.

### 5.2 El timeout ambiguo
Si el portal tarda y cortamos la conexión, **no sabemos si aplicó el cambio o no**. Solución: tratarlo como "no confirmado" y reintentar; la idempotencia hace que sea seguro.

### 5.3 El problema estrella: orden y solapamientos
Ejemplo:

```
10:00  U1: acc-1003, días 1–10, precio 100
10:01  U2: acc-1003, días 5–7,  precio 150
```

El gestor quiere: días 1–4 y 8–10 a 100, días 5–7 a 150.

Si U1 falla (503), U2 se envía bien, y **después** reintentamos U1 → los días 5–7 quedan a 100. **El portal ha quedado mal y nadie se ha enterado.** Esto rompe directamente el requisito "estado final = lo pedido".

Dos formas típicas de resolverlo (decisión para el spec):

| Opción | Idea | Pros | Contras |
|---|---|---|---|
| **A. Orden estricto por alojamiento** | Los updates de un mismo alojamiento se envían en orden de llegada, uno tras otro. U2 no sale hasta que U1 haya salido bien. | Simple de razonar y de testear. | Un alojamiento atascado retrasa sus siguientes updates (no los de otros). |
| **B. Estado deseado por día** | Guardamos "lo que debe haber" por día. Al enviar, se manda el estado actual deseado, no el update original. U1 reintentado ya mandaría 150 en los días 5–7. | Fusiona updates (menos peticiones), siempre converge. | Más complejo: hay que reagrupar días en rangos, más modelo de datos. |

### 5.4 El presupuesto de peticiones es escaso
- 30 req/min, y cada 503 también gasta cupo → en la práctica **~23 éxitos/min**.
- Un update de 90 días = **3 peticiones** (trozos de ≤31 días).
- Con 10 alojamientos actualizándose a la vez, la cola crece rápido.
- Por eso: limitador **global** (no por alojamiento), y **no** gastar peticiones en verificar con GET tras cada PUT.

### 5.5 Reinicios a mitad de trabajo
Si el worker coge un trabajo, lo marca "en curso" y muere, ese trabajo no puede quedarse "en curso" para siempre. Patrón habitual: un **lease** (`locked_until`): si pasa el tiempo y nadie lo terminó, vuelve a estar disponible. Con Postgres, `SELECT … FOR UPDATE SKIP LOCKED` lo hace limpio.

### 5.6 Errores permanentes vs. transitorios
| Respuesta | Tipo | Qué hacemos |
|---|---|---|
| 429 | Transitorio | Esperar `Retry-After` (y pausar a **todo** el worker, no solo esa tarea). |
| 503 | Transitorio | Reintentar con backoff. |
| Timeout / error de red | Transitorio (ambiguo) | Reintentar (idempotente). |
| 400 / 404 | **Permanente** | No reintentar. Marcar como fallido y que se vea en status y métricas. |
| 401 | Configuración | No reintentar a lo loco; es un problema nuestro (API key) → alerta. |

Muchos 400 se pueden evitar **validando en nuestro `POST /updates`** (fechas válidas, `to >= from`, precio ≥ 0) y rechazando con 400 al gestor de inmediato.

---

## 6. Observabilidad: qué debería poder ver alguien de guardia

Ejemplos de métricas (borrador):

| Métrica | Tipo | Pregunta que responde |
|---|---|---|
| `sync_pending_jobs` | gauge | ¿Se está acumulando trabajo? |
| `sync_oldest_pending_age_seconds` | gauge | ¿Hay algo atascado desde hace mucho? |
| `portal_requests_total{outcome}` | counter | ¿Cuántos 200 / 429 / 503 / timeout / 4xx? |
| `portal_request_duration_seconds` | histograma | ¿El portal va lento? |
| `sync_retries_total{reason}` | counter | ¿Estamos reintentando mucho y por qué? |
| `sync_jobs_failed_total` | counter | ¿Hay updates que nunca llegarán? |

Alertas de ejemplo: trabajo pendiente más antiguo > X minutos; ratio de 503/timeouts > Y % durante Z minutos; cualquier fallo permanente; 401 > 0.

---

## 7. Método de trabajo propuesto (irá en el SPEC)

- **TDD** en lógica pura: trocear rangos, clasificar respuestas, política de reintentos, resolución de solapamientos.
- **Tests de integración** pocos pero decisivos, contra el portal real + Postgres, usando `/__admin/reset` y `/__admin/requests`:
  - estado final del portal = lo pedido (con solapamientos),
  - reinicio del servicio sin perder nada,
  - nunca se reintenta antes del `Retry-After`.
- **`CLAUDE.md`** con stack, convenciones, cómo levantar entorno y lanzar tests.
- **1–2 skills** como mucho (`tdd-cycle`, `verify-portal`).
- **Commits pequeños** que cuenten la historia (encaja con `PROCESS.md`).

Stack propuesto: **Fastify · Vitest · `pg` · `prom-client` · pino** (logs JSON, viene con Fastify).

---

## 8. Roadmap

| # | Fase | Resultado | Tiempo aprox. |
|---|---|---|---|
| 0 | Preparación ✅ | Entorno levantado, portal sondeado, este documento. | — |
| 1 | **SPEC.md** | Decisiones + criterios de aceptación + método. **Primer commit.** | 40–50 min |
| 2 | Andamiaje | `CLAUDE.md`, skills, proyecto TS, Vitest, conexión a Postgres, migraciones. | 20 min |
| 3 | Núcleo (TDD) | Troceo de rangos, clasificación de errores, backoff, rate limiter. | 40 min |
| 4 | Persistencia + API | Esquema, `POST /updates`, `GET sync-status`. | 30 min |
| 5 | Worker | Cola con lease, envío, reintentos, `Retry-After`, orden/solapamientos. | 45 min |
| 6 | Observabilidad | Métricas + logs estructurados. | 20 min |
| 7 | Integración | Tests contra portal real + reinicio. | 30 min |
| 8 | Cierre | `service/README.md`, `PROCESS.md`, repaso del SPEC. | 20 min |

Total ≈ 4 h. Si vamos justos, lo primero que se recorta: la opción B de solapamientos (nos quedamos con A), alertas solo descritas, menos tests de integración.

---

## 9. Decisiones abiertas para el SPEC

1. **Orden/solapamientos**: ¿opción A (orden estricto por alojamiento) o B (estado deseado por día)?
2. **Unidad de trabajo en la cola**: ¿el update entero o cada trozo de ≤31 días?
3. **Forma de `sync-status`**: ¿resumen (pendientes, fallidos, último éxito) + lista de updates recientes?
4. **Validación de `accommodationId`**: ¿lo aceptamos a ciegas (el portal dirá 404) o consultamos la lista del portal?
5. **Política de reintentos**: ¿infinitos para transitorios (nunca perder nada) con backoff máximo, o con tope y estado "fallido"?
6. **Concurrencia del worker**: ¿uno solo (simple, con 30 req/min sobra) o varios?
7. **Timeout** hacia el portal: ¿cuánto? (p. ej. 5 s, dado que p99 medido < 1 s).

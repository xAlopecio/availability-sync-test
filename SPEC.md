# SPEC — Availability sync service

Status: **initial version, written before any code**. Later changes are tracked in git history and summarised in §12.

## 1. Goal

A Node.js + TypeScript service that accepts availability/price updates from property managers, persists them durably, and propagates them to **Portal Sol** reliably, respecting its limits, so that the portal eventually reflects exactly what the manager asked for. It exposes per-accommodation sync status and enough metrics/logs for on-call to judge sync health.

### Non-goals
Authentication, UI, deployment, dashboards/alerting stack, multiple portals, multiple service instances (see §10), reconciling changes made to the portal by third parties.

## 2. What we know about Portal Sol

From `API.md` plus a probe run against the `base` variant on 2026-11-09 (~150 requests):

| Fact | Source | Consequence for the design |
|---|---|---|
| **30 requests/min**, `429` + accurate `Retry-After`, ~60 s window | Measured | Global client-side limiter (default 25/min, configurable) + global pause on 429. |
| `503` responses **count toward the limit** | Measured | The limiter counts every request sent, whatever the outcome. |
| `503` on **~24 %** of requests, nothing applied | Measured / doc | Retries are the normal path, not the exception. |
| Slow responses / timeouts may still be applied | Doc (not observed: p50 470 ms, max 810 ms) | Client timeout (5 s) + retry; safe because PUT is idempotent. |
| Max **31 days** per PUT (inclusive) | Doc + measured | Split updates into ≤ 31-day chunks. |
| `400` / `404` are permanent | Doc | No retry; mark as failed. |
| Unknown body fields are accepted (doc says `INVALID_BODY`) | Measured | We send only documented fields; no reliance on either behaviour. |
| `/health` reports `variant: "base"` | Measured | Other variants may differ: all limits are configuration, and `Retry-After` always wins. |

## 3. Architecture

```
POST /updates ──▶ HTTP API ──(1 tx)──▶ PostgreSQL ◀──(claim / complete)── Worker ──▶ Portal Sol
GET  /accommodations/:id/sync-status ◀─┘    updates + sync_tasks           │  rate limiter (global)
GET  /metrics, structured logs ◀───────────────────────────────────────────┘  retry / backoff
```

One process runs both the HTTP API and the worker. Main modules:

- `domain/` — pure logic: date validation, range chunking, response classification, backoff. **TDD.**
- `portal/` — `PortalClient` (HTTP, timeout, API key) and `RateLimiter`. The client sits behind an interface so a second portal could be added later.
- `db/` — migrations (plain SQL, applied at startup) and repository.
- `worker/` — claims tasks, sends them, records outcomes.
- `http/` — Fastify routes and validation.
- `metrics/` — `prom-client` registry.

Source layout (`service/`): production code in `src/`, every test in `test/`.

```
src/
  main.ts  config.ts
  domain/            pure logic, no I/O
    calendar/        dates, range chunking
    updates/         request validation, status derivation
    retry/           outcome classification, backoff
  portal/            Portal Sol client, rate limiter
  db/                migrations/*.sql, migrate, pool, repository
  http/              Fastify app, error format, routes/
  worker/            claim, send, record outcomes
  metrics/           prom-client registry
test/
  unit/              mirrors src/ (fast, no Docker)
  integration/       real PostgreSQL (and later Portal Sol)
  e2e/               the whole service against the real portal
  support/           shared helpers: test database, fixtures, portal admin
```

Tests import production code through the Node subpath import `#src/*` (`package.json` `imports`), which Node, TypeScript and Vitest all resolve natively.

Stack: **Fastify, pino (JSON logs), `pg`, `prom-client`, Vitest**. Node 24 (`.nvmrc`).

## 4. Key design decisions

### D1. Ordering: strict FIFO per accommodation
Updates for the same accommodation are sent **in acceptance order, one at a time**. A later update is never sent before an earlier one for the same accommodation has finished (synced or permanently failed). This guarantees that, for every day, the last value the portal receives is the last value the manager sent, so overlapping updates end up correct.
*Rejected:* a per-day desired-state model. It coalesces updates and uses fewer requests, but it needs version tracking and range regrouping, which is more than the time budget allows. It is the natural next step (§11).

To make acceptance order well defined under concurrent `POST`s, the insert transaction takes `pg_advisory_xact_lock(hashtext(accommodation_id))`. Ids for one accommodation are therefore allocated and committed in order, and a lower id cannot become visible after a higher one.

### D2. Unit of work: one task per ≤ 31-day chunk
An update is stored together with its chunks (`sync_tasks`) in the same transaction. Order within an accommodation is `task.id`, which follows (update order, chunk index). If chunk 2 of 3 fails, only chunk 2 is retried, so no request quota is spent re-sending chunks that are already applied.

### D3. Accept without asking the portal
`POST /updates` validates the shape and the dates locally and never calls the portal. The input path therefore keeps working while the portal is down, which is the reason the queue exists. An unknown `accommodationId` surfaces as a permanent `404` failure in status and metrics.

### D4. Retry policy

| Outcome | Class | Action |
|---|---|---|
| 2xx | success | Task `done`. |
| 429 | transient | Reschedule at `Retry-After` + 500 ms safety margin (60 s if the header is missing or invalid; capped at 10 min, since one bogus header must not freeze every send); **pause all sends** until then. |
| 503, timeout, network error, 5xx | transient | Reschedule with exponential backoff and full jitter (base 1 s, cap 5 min). |
| Any other status (4xx not listed here, 1xx, 3xx) | transient (unexpected) | Retry with backoff, labelled `unexpected_status`, and alert. Not documented by the portal, so dropping the update would lose it; a persistent one shows up in the oldest-pending age. |
| 401 | transient (config) | Retry with backoff. A wrong key is fixable without losing the queue; alert immediately. |
| 400, 404 | permanent | Task `failed`. The update's remaining chunks become `failed` too (they would fail the same way: dates are pre-validated). This unblocks the accommodation's queue. |

Transient failures are retried **without limit**: capping attempts would mean dropping accepted updates. A task that retries forever is surfaced by the oldest-pending-age metric and alert instead (§7).

### D5. Concurrency and rate limiting
- Worker concurrency defaults to **3**, so throughput does not collapse if the portal turns slow.
- **At most one task in flight per accommodation**, which D1 requires.
- A global in-memory sliding-window limiter allows at most `PORTAL_MAX_REQUESTS_PER_MINUTE` (default 25) request starts in any 60 s window. A worker slot acquires a permit **before** claiming a task, so it does not hold a lease while waiting. If the claim finds nothing, **that** permit is released (each permit has a token): an idle worker consumes no quota. Waiting for a permit is cancellable, so shutdown never waits for the window. Right before sending, a slot checks the global pause again: a permit taken just before another slot's 429 must not be sent before `Retry-After`, so the task is rescheduled instead.
- **One active worker per database.** The worker takes a session advisory lock before its first claim; other instances stay API-only (standby) and retry the lock, so a second replica, or the old process during a rolling deploy, never doubles the rate. On start, the limiter is seeded with the attempts of the last minute read from the database, so a restart does not reset the portal's window on our side. Only each task's latest attempt is stored, so a task retried twice within that minute is counted once; the 25-vs-30 margin absorbs it.

### D6. Leases for crash safety
Claiming sets `locked_until = now() + lease` (default 30 s, well above the 5 s timeout) and increments `attempts`. If the process dies mid-request, the lease expires and the task is claimed again. Re-sending is safe because the PUT is idempotent. The claim returns the new `attempts` value as a **fencing token**: completing, rescheduling or failing a task only applies while the token still matches, so a worker whose lease expired cannot overwrite the result of the worker that re-claimed the task. **Every queue time is on the database clock**: leases, `next_attempt_at` (the app passes a delay, and the database computes `now() + delay`) and `last_timeout_at`. A skew between the app's and the database's clocks can therefore never shift a retry or a lease. Seen in testing: the Docker VM's clock was 52 s behind after the Mac slept. Claim query (sketch):

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

### D7. No read-back verification
We trust `200` plus idempotency, and do not `GET` the portal after each `PUT`. With 25 requests per minute, verification would halve throughput. Integration tests do the verification instead (§9).

### D8. Data access: `pg` with hand-written SQL, no ORM
The queries that make the system correct are Postgres-specific: `FOR UPDATE SKIP LOCKED` with a lease (D6), `pg_advisory_xact_lock` for ordering (D1), and the `NOT EXISTS` head-of-queue check. An ORM such as Prisma does not express them in its query API, so they would end up as raw SQL beside the ORM. The ORM would then add code generation, a separate schema file and its own migration tool for two tables, while hiding exactly the part a reviewer needs to see.

All SQL lives in a thin repository layer (`db/repository.ts`) that returns typed objects. The rest of the code does not know SQL exists, so swapping the data-access approach later touches one file. Migrations are numbered `.sql` files applied at startup by a small runner (`db/migrate.ts`) that tracks applied files in a `schema_migrations` table.
*Considered:* Kysely, a typed query builder that supports `.forUpdate().skipLocked()`. It is a reasonable choice, but with two tables the type safety it adds does not justify one more dependency and its learning surface, and advisory locks would still be raw SQL.

### D9. Late application after a timeout: a settle window
A PUT that times out on our side may still be applied by the portal **later**, after we have retried it and moved on to the accommodation's next update. If that late application lands after the newer PUT, it overwrites those days with the older value. FIFO orders what we *send*, not what the portal *applies*, and idempotency does not help because the values differ. This was reproduced against the real portal: 1 stale final state out of 14 timed-out PUTs. Measured on the `base` variant: an abandoned PUT is applied later or never (3 of 25 were never applied), and late application **at least 5 s** after we gave up was observed. The 30 s default leaves a wide margin over that.

So, when an attempt times out, the task records `last_timeout_at`. **At claim time**, a task is not claimable while another task of the same accommodation whose days **overlap** it timed out less than `PORTAL_TIMEOUT_SETTLE_MS` ago (default 30 s), long enough for the original request to finish. Checking at claim time covers updates accepted *after* the timed-out task completed, for example a manager's quick correction; the first version held only the tasks queued at completion time, and the worker review found that gap. A **crash** mid-request is the same case: a lease that expires with no stored outcome means its holder lost the attempt mid-request (typically the process died with the PUT in flight), so re-claiming it also records `last_timeout_at`. It is conservative: it also fires after an unexpected slot error or a failed outcome write, when the PUT may never have left or already succeeded (the e2e test of a `SIGKILL` mid-sync found the older value landing last). Only overlapping days wait, and only after a timeout or a crash. *Residual risk:* a portal that applies a request more than the settle window after our timeout. The full fix is read-back verification or periodic reconciliation (§11).

## 5. Data model (PostgreSQL)

```sql
updates (
  id              bigserial PRIMARY KEY,      -- acceptance order
  accommodation_id text NOT NULL,
  date_from date NOT NULL, date_to date NOT NULL,
  available boolean NOT NULL,
  price_per_night numeric(12,2) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE                  -- optional client key (SPEC §6)
)
sync_tasks (
  id              bigserial PRIMARY KEY,      -- send order within an accommodation
  update_id bigint NOT NULL REFERENCES updates(id),
  accommodation_id text NOT NULL,             -- denormalised for the claim query
  chunk_index int NOT NULL,
  date_from date NOT NULL, date_to date NOT NULL,
  status text NOT NULL DEFAULT 'pending',     -- pending | done | failed
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text, last_http_status int,       -- of the most recent attempt; cleared on success
  last_attempt_at timestamptz,               -- when the last attempt started (sync-status, debugging)
  last_timeout_at timestamptz,               -- last attempt that timed out (D9 settle window)
  completed_at timestamptz
)
-- indexes: (accommodation_id, status, id), (status, next_attempt_at)
```

`last_error` formats: `"<status> <CODE>: <message>"` for HTTP errors (e.g. `"404 NOT_FOUND: Accommodation acc-9999 not found"`), `"timeout after <ms> ms"`, `"network error <code>"`.

An update's status is **derived** from its tasks: `failed` if any task failed, `synced` if all are done, otherwise `pending`. Storing it separately would duplicate state.

## 6. HTTP API

### `POST /updates`
Body as in the README. Optional header **`Idempotency-Key`** (1–128 characters: letters, digits, `_`, `-`, `.`, `:`). Validation:
- `accommodationId`: matches `^[A-Za-z0-9_-]{1,64}$`. The id goes into the portal's URL path, so `/`, `..` or spaces must never reach it.
- `from` and `to`: real `YYYY-MM-DD` dates, with `to >= from` and a range of at most 366 days (`MAX_UPDATE_RANGE_DAYS`).
- `available`: boolean.
- `pricePerNight`: finite number, from 0 to 1,000,000, with at most 2 decimals.
- Unknown fields are rejected.

| Response | When |
|---|---|
| `202 { "updateId": 42, "status": "pending", "chunks": 3 }` | Accepted. Returned **after** the transaction commits. |
| `400 { "error": { "code", "message" } }` | Invalid input (same error shape as the portal), including malformed JSON. Nothing is persisted. |
| `413` | Body larger than 1 MB. |
| `415 UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not `application/json`. |
| `400 INVALID_HEADER` | `Idempotency-Key` present but not 1–128 allowed characters. |
| `202` + `Idempotent-Replayed: true` | Same `Idempotency-Key` and same body as an earlier request: the original response, nothing stored again. |
| `422 IDEMPOTENCY_KEY_REUSED` | Same `Idempotency-Key` with a different body. |
| `503 UNAVAILABLE` + `Retry-After: 5` | The database is unavailable or busy (lock timeout). **An update is never acknowledged (`202`) unless it has been committed.** |

Every error, including `404` for unknown routes, uses the same `{ "error": { "code", "message" } }` shape.

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

- `status`: `pending` if any update is pending; otherwise `failed` if the most recent update failed; otherwise `synced`.
  *Known limitation, accepted:* an older failed update over days that a newer synced update does not cover would read `synced`. Only `400` and `404` are permanent: `400` is prevented by our own validation, and `404` (unknown accommodation) fails every update of that accommodation alike, so the case needs a bug to happen.
- `recentUpdates`: the last 20, newest first; the counts cover every update.
- Per update, across its chunks: `attempts` is the sum of the chunks' attempts, `lastError` comes from the most recent attempt (`last_attempt_at`), `nextAttemptAt` is the earliest among pending chunks, and `syncedAt` is the last chunk's `completed_at`.
- An accommodation with no updates returns `404`, and so does an `:id` that does not match the `accommodationId` pattern (no update can exist for it).

### `GET /health` and `GET /ready`
- `/health` (liveness): `200 { "status": "ok" }` whenever the process serves HTTP, even with the database down (restarting would not help).
- `/ready` (readiness): `200 { "status": "ready", "database": "up", "worker": "active" | "standby" | "disabled" }`; `503` in the error shape when the database is down, so a load balancer stops routing updates that would 503 anyway.

**Rationale:** the manager needs to know whether *their* change has arrived. On-call needs to know whether something is stuck and why (attempts, last error, next attempt). Both can be answered from the data D2 already stores.

## 7. Observability

**Logs:** pino JSON. Every portal call logs `taskId`, `updateId`, `accommodationId`, `attempt`, `outcome`, `httpStatus`, `durationMs` and `nextAttemptAt`. Retries are logged at `warn`, permanent failures at `error`.

**Metrics** (`GET /metrics`, Prometheus text format, on the API port). Each app instance has its own registry, and Node's process metrics (`process_*`, `nodejs_*`) are included. There are no per-accommodation labels, because their cardinality is unbounded. **Every documented label value is initialised at 0 at startup**: a labelled series that only appears at its first increment is invisible to `rate()`/`increase()`, so an alert would miss the first event after each restart, or could never fire at all.

| Metric | Type | Purpose |
|---|---|---|
| `sync_tasks_pending{state}` | gauge (DB, at scrape) | Backlog **by state**, which answers *why* it exists: `ready` (would be claimed now), `in_flight` (leased), `waiting_retry` (backoff / `Retry-After`), `held_settle` (D9), `queued` (behind an earlier task of its accommodation). The states partition the pending tasks. |
| `sync_oldest_pending_task_age_seconds` | gauge (DB) | Age of the oldest pending update **since `accepted_at`**: how long a manager has been waiting. Measuring from the last attempt would reset on every retry. |
| `sync_stuck_heads{min_attempts="10"}` | gauge (DB) | Accommodations whose head task has ≥ 10 attempts: head-of-line blocking (D1 + unlimited retries). |
| `sync_head_attempts_max` | gauge (DB) | Highest attempt count among heads. |
| `sync_metrics_db_up` | gauge | 1 if the queue state could be read at this scrape. The read has its own 3 s timeout. If it fails, the last good values are served with their age; with no previous read, the gauges are **absent**, never a false 0. |
| `sync_queue_state_age_seconds` | gauge | Age of the queue gauges above (0 when read at this scrape). |
| `portal_requests_total{outcome}` | counter | `success`, `rate_limited`, `unavailable`, `timeout`, `network_error`, `client_error`, `unauthorized`, `server_error`, `unexpected_status`. |
| `portal_request_duration_seconds{outcome}` | histogram | Portal latency; buckets `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` s. |
| `sync_retries_total{reason}` | counter | Retries by transient outcome. |
| `sync_tasks_finished_total{result}` | counter | `done` or `failed`. A permanent failure counts the task and its failed siblings (D4). |
| `sync_update_lag_seconds` | histogram | Acceptance → last chunk done, observed once per synced update (end-to-end health); buckets `1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600` s. |
| `sync_sends_deferred_total` | counter | Sends skipped because the global pause started between claim and send (D5). |
| `updates_accepted_total` | counter | Updates accepted (not idempotent replays). |
| `updates_rejected_total{code}` | counter | `POST /updates` not accepted, by error code: the 4xx codes, and `UNAVAILABLE` when the database is down (503). |
| `sync_stale_results_total` | counter | Attempt results discarded because the task's lease had been lost (fencing, D6): a sign of lease contention or a slow database. |
| `sync_tasks_reclaimed_total` | counter | Tasks re-claimed after their lease expired with no stored outcome (D6, D9): crash recovery. Each one is also logged as a warning; a steady rise means a crash loop. |
| `portal_rate_limiter_paused_seconds` | gauge | What remains of the global pause after a 429. |
| `portal_rate_limiter_window_starts` | gauge | Request starts in the current 60 s window. |
| `sync_worker_active` | gauge | 1 on the instance holding the single-worker lock (D5); 0 on a standby or with the worker disabled. |

**Several instances:** counters are per process, so aggregate them with `sum()`. The DB-derived gauges report the same value on every instance, so aggregate them with `max()`.

**Alerts** (ready-to-use Prometheus rules in `ops/alerts.yml`, with behaviour tests in `ops/alerts.test.yml` run by `promtool` in CI). Missing data must never read as healthy: `ServiceMetricsAbsent` fires when no instance exposes metrics.

| Alert | Condition | Severity |
|---|---|---|
| Sync stuck | `max(sync_oldest_pending_task_age_seconds) > 600` for 5m | critical |
| No active worker | `max(sync_worker_active) == 0` while work is pending, for 5m | critical |
| Service metrics absent | `absent(sync_worker_active)` for 2m (no instance is being scraped) | critical |
| Worker not sending | ready tasks exist and `sum(rate(portal_requests_total[5m])) == 0`, for 5m, **unless** the limiter is paused by a `Retry-After` | critical |
| Bad credentials | `sum(increase(portal_requests_total{outcome="unauthorized"}[5m])) > 0` | critical |
| Metrics cannot read the database | `min(sync_metrics_db_up) == 0` for 2m | critical |
| Queue gauges stale | `max(sync_queue_state_age_seconds) > 120` (served from the last good read) | warning |
| Stuck accommodation | `max(sync_stuck_heads) > 0` for 15m | warning |
| Portal degraded | non-success ratio > 50 % over 10m (the baseline is about 25 %) | warning |
| Unexpected throttling | any `rate_limited` in 10m (our limiter should prevent it) | warning |
| Rate limiter paused for long | `max(portal_rate_limiter_paused_seconds) > 300` | warning |
| Unexpected portal responses | any `unexpected_status` in 10m (undocumented status, retried) | warning |
| Permanent failures | any `sync_tasks_finished_total{result="failed"}` in 15m | warning |
| Settle holds persisting | `max(sync_tasks_pending{state="held_settle"}) > 0` for 10m (a hold lasts 30 s; persistent holds mean repeated timeouts) | warning |
| Portal slow | p95 of `portal_request_duration_seconds` > 3 s for 10m | warning |
| Sync lag high | p95 of `sync_update_lag_seconds` > 600 s for 15m | warning |

## 8. Configuration (env vars)

`PORT=3000`, `DATABASE_URL=postgres://sync:sync@localhost:5432/sync`, `PORTAL_BASE_URL=http://localhost:4000`, `PORTAL_API_KEY=sol-demo-key`, `PORTAL_MAX_REQUESTS_PER_MINUTE=25`, `PORTAL_TIMEOUT_MS=5000`, `WORKER_CONCURRENCY=3`, `TASK_LEASE_MS=30000`, `RETRY_BASE_MS=1000`, `RETRY_MAX_MS=300000`, `WORKER_POLL_MS=500`, `WORKER_ENABLED=true` (`false` runs the API only), `PORTAL_TIMEOUT_SETTLE_MS=30000` (D9), `LOG_LEVEL=info`, `MAX_UPDATE_RANGE_DAYS=366`, `DATABASE_STARTUP_TIMEOUT_MS=30000`, `SHUTDOWN_GRACE_MS=10000`.

The configuration is validated at startup, and every invalid variable is reported at once. `TASK_LEASE_MS` must be greater than `PORTAL_TIMEOUT_MS` (D6).

**Startup:** the service retries the database connection with backoff for up to `DATABASE_STARTUP_TIMEOUT_MS` (30 s). If it is still unreachable, it exits with a non-zero code without opening the HTTP port, so it never accepts updates it cannot persist. It then applies pending migrations and starts listening. On `SIGTERM` it stops accepting connections, waits for in-flight requests, closes the pool and exits 0; if that takes longer than `SHUTDOWN_GRACE_MS` (10 s) it logs it and exits 1. A failing migration is logged as a structured `fatal` line and exits 1.

**Database resilience at runtime:** losing a connection while running (database restart, failover, an idle connection killed by the server) must never crash the process. The pool's `error` event is logged, the pool reconnects on the next query, and requests in the meantime answer `503`. Every connection has `statement_timeout = 10 s` and `lock_timeout = 5 s`; a lock that cannot be taken in time (for example a stuck transaction on the same accommodation) answers `503`, and HTTP requests time out after 15 s, so nothing hangs indefinitely.

## 9. Acceptance criteria

Each criterion maps to at least one automated test. **U** = unit, **I** = integration against the real Portal Sol and Postgres, using `/__admin/reset` and `/__admin/requests`. **E2E** = the real service process as a black box: only its HTTP API, `/metrics` and the portal are used for assertions.

| # | Criterion | Test |
|---|---|---|
| AC1 | A valid `POST /updates` returns `202` with `updateId`, and the update and its tasks are in the DB when the response arrives. | I |
| AC2 | Invalid input (bad or non-existent date, `to < from`, negative or string price, missing or unknown field, range > 366 days) returns `400` and persists nothing. | U + I |
| AC3 | A range is split into consecutive chunks of at most 31 days that cover it exactly, across month and year boundaries. | U |
| AC4 | **Final state:** after a sequence of overlapping updates on one accommodation (including ranges > 31 days), every affected day in the portal equals the last accepted update covering it, despite the portal's natural 503s. | I |
| AC5 | **Order:** the PUTs for one accommodation reach the portal in acceptance order (the last successful PUT per day matches AC4), and there is never more than one in flight per accommodation. | I |
| AC6 | **Limits:** with the default config, the portal never answers `429`. With the limiter deliberately set above 30/min, after any `429` no request is sent before `Retry-After` has elapsed (checked via admin log timestamps). | I |
| AC7 | **Restart:** updates accepted and then the service stopped before syncing (including a task left with an active lease, simulating a crash) are all synced after restart. | I |
| AC8 | **Timeouts:** with a timeout near the portal's median latency (≈ 400 ms), so that a large share of requests time out, some of them after the portal applied them, all updates still converge to the correct final state. (A much lower timeout would let almost nothing succeed and never converge.) | I |
| AC9 | **Permanent errors:** an update for a non-existent accommodation ends `failed` as soon as the portal answers `404`: **no request is sent for it after that 404** (only transient failures may precede it: the portal's random `503`s and slow responses we abandoned on a timeout), and it does not block other updates. | I |
| AC10 | Response classification and backoff follow D4: the right class for each status, a backoff within its bounds, and `Retry-After` respected. | U |
| AC11 | The limiter never allows more than N starts in any 60 s window (fake clock). | U |
| AC12 | `sync-status` reports `pending`, then `synced`, with correct counts and chunk progress; it shows `failed` with the error for AC9; `404` for an unknown id. | I |
| AC13 | `/metrics` exposes every metric in §7. During a real run their values move as expected and **agree with reality**: the sum of `portal_requests_total` equals the PUTs in the portal's own request log, and the 503s match. `/health` and `/ready` behave as in §6. | I |
| AC14 | **Load, black box:** about 50 updates over 10 accommodations, some overlapping and some over 31 days, `POST`ed concurrently to the running service, all end `synced` with every portal day correct. The portal never answers `429`, no 60 s window holds more than 30 portal requests, and the metrics agree at the end. | E2E |
| AC15 | **Lifecycle, black box:** an update accepted by a process that is then killed (`SIGKILL`) or stopped (`SIGTERM`) mid-sync is synced by the next process. With two processes on one database, only one sends, and the other takes over when it dies. | E2E |

Integration tests are slow by nature (the portal allows 30 requests per minute), so scenarios are kept small. Because the portal's 503s are random, test timeouts are generous.

## 10. Trade-offs and scope limits

- **One active worker.** Several replicas can serve the API, but only the lock holder sends (D5). Higher throughput than one worker would need a shared limiter (a DB row or Redis), not more workers.
- **Polling** the DB every 500 ms instead of `LISTEN/NOTIFY`: simpler, and the latency is negligible next to the portal's limits.
- **No coalescing.** Superseded updates are still sent. Correct, but wasteful under heavy churn.
- **`Idempotency-Key` is optional.** A duplicate is not always harmless under D1. If the connection drops during `COMMIT`, the update may be stored while the client gets a `503` and retries. If the client sent another update B in between, the retried A lands after B and the portal ends with A. With the key, the retry is recognised and nothing is stored again. Clients that do not send it accept that risk. (A per-day desired-state model would not remove it either: a retry is indistinguishable from a new change unless the client identifies it.)
- **No drift detection.** If someone changes the portal outside this service, we don't notice.
- **Late application beyond the settle window (D9).** If the portal applies a timed-out request more than `PORTAL_TIMEOUT_SETTLE_MS` after our timeout, a stale value can remain. Accepted: it needs a portal slower than 30 s on top of our 5 s timeout; read-back verification or reconciliation (§11) would close it.

## 11. Next steps (if there were more time)

Per-day desired state with coalescing (replacing D1): one row per accommodation and day with the desired value and a version; the worker sends dirty days grouped into ranges and marks them synced only if their version did not change meanwhile. It saves requests when the same days change repeatedly and makes `sync-status` exact per day, at the cost of a new schema, repository and worker. Kept out on purpose: with D1 plus `Idempotency-Key` the final portal state is equally correct, and the API would not change; shared rate limiter for multiple instances; manual re-drive of failed updates; read-back verification after timeouts (the `GET` of the affected days once an accommodation's queue drains, re-queueing a correction on a mismatch) and periodic reconciliation (`GET` and compare) during idle quota, which close D9's residual risk; `LISTEN/NOTIFY`.

## 12. Working method

- **Spec first** (this document is the first commit), then small commits that tell the story (Conventional Commits: `feat:`, `test:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **Branching.**
  - `master` is the stable branch and only receives `develop` when a phase is closed, via PR and with a version tag.
  - `develop` is the integration branch.
  - Each block of work goes on its own branch cut from `develop`, and is merged back through a **GitHub PR**. The prefix says what kind of block it is:
    - `feature/<name>`: new behaviour.
    - `refactor/<name>`: structural change with no behaviour change (e.g. `refactor/structure`).
    - `docs/<name>`: documentation only.
  - Nothing is committed directly to `master` or `develop`.
- **TDD for `domain/` and the limiter:** write the scenarios from §9 as failing tests, implement, then refactor.
- **End-to-end tests** (AC14–AC15) start the real process and use it only through its public interface, as a client would. They use production defaults, except a shorter lease and retry cap so that a run stays bounded. They run as their own CI job.
- **Integration tests** for the behaviours that only the real portal can prove (AC4–AC9, AC12–AC13), with the worker in-process. Sync behaviour is **never** tested against a simulated portal. A local fake HTTP server is used only for the client's transport faults (timeouts, resets, refused connections, non-JSON bodies), which the real portal cannot produce on demand. CI runs the integration suite against PostgreSQL **and the real Portal Sol image**.
- **AI-assisted.** A `CLAUDE.md` holds the stack, conventions, environment setup and the "tests first" rule. Two project skills:
  - `tdd-cycle`: red → green → refactor, with a commit per step.
  - `verify-portal`: reset the portal, run a scenario, then check `/__admin/requests` and the portal's final state.

  Everything the AI writes is validated by those tests and by reading the diff. Corrections are recorded in `PROCESS.md`.
- Preparation notes (portal probe and decision analysis) live in `docs/CONTEXTO.md`.

### Changelog
- v1: initial spec.
- v2: decisions taken while defining the core test scenarios (`docs/scenarios/core.md`): `accommodationId` pattern (it goes into the portal URL path), maximum price of 1,000,000, and for a 429 a +500 ms margin after `Retry-After` with a 60 s fallback when the header is missing.
- v3: changes from the `feature/core` review. Only `400`/`404` are permanent; any other undocumented status is retried as `unexpected_status`, with an alert, so it cannot drop an accepted update. `Retry-After` is capped at 10 min. The known `sync-status` limitation is documented.
- v4: §3 adds the source layout (tests in their own `test/` tree mirroring `src/`, `domain/` split into `calendar/`, `updates/` and `retry/`), decided before the API block. §12 adds the `refactor/<name>` branch prefix for structural changes without behaviour change.
- v5: decisions taken while defining the API test scenarios (`docs/scenarios/api.md`). §5: new `sync_tasks.last_attempt_at` column. §6: `413`, `415` and `503` with `Retry-After`; one error shape for every error; `404` for an invalid `:id`; the multi-chunk semantics of `attempts`, `lastError`, `nextAttemptAt` and `syncedAt`. §8: `MAX_UPDATE_RANGE_DAYS`, `DATABASE_STARTUP_TIMEOUT_MS`, config validation, and startup and shutdown behaviour. After the API review: optional `Idempotency-Key` (`updates.idempotency_key`, `422` on reuse, replay header); runtime database resilience (pool errors, `statement_timeout`/`lock_timeout`, request timeout); `SHUTDOWN_GRACE_MS`; §10/§11 explain why duplicates are not always harmless and why the per-day model stays out.
- v6: decisions taken while defining the worker test scenarios (`docs/scenarios/worker.md`). D5: permits released when a claim finds nothing, cancellable waits. D6: the `attempts` fencing token. §5: `last_error` cleared on success, format `"<status> <CODE>: <message>"` / `"timeout after <ms> ms"` / `"network error <code>"`. §8: `WORKER_ENABLED`. AC8: a timeout near the median instead of 50 ms, which could never converge. AC9: "no request after the 404" instead of "exactly 1 request" (the portal answers random 503s even for unknown accommodations). §12: a fake server only for transport faults; Portal Sol in CI. D9 (author's decision after L6 exposed it): a settle window after a timeout (`last_timeout_at`, `PORTAL_TIMEOUT_SETTLE_MS`), residual risk in §10, verification and reconciliation in §11. D6: every queue time on the database clock (found when the Docker VM clock drifted 52 s after sleep). After the worker review: the D9 hold is evaluated at claim time on overlapping days; D5 permit tokens, a pause check before sending, one active worker per database (advisory lock) and a limiter seeded from the database.
- v7: decisions taken while defining the metrics test scenarios (`docs/scenarios/metrics.md`). §7 rewritten: pending tasks by state, stuck heads, the limiter and active-worker gauges, deferred sends, rejected updates, oldest age measured from `accepted_at`, histogram buckets, `max()`/`sum()` across instances, alerts updated and also shipped as `ops/alerts.yml`. §6: `/health` and `/ready`. AC13: the metrics must agree with the portal's own request log. After the metrics review: label values initialised at 0; `ServiceMetricsAbsent`; WorkerNotSending not during a `Retry-After` pause; rule behaviour tests with `promtool`; the queue-state read bounded (own timeout, last good value with its age, an index for the D9 subquery); `sync_stale_results_total`; 503s counted as `UNAVAILABLE` rejections.
- v8: end-to-end block (`docs/scenarios/e2e.md`): AC14 (concurrent load, black box) and AC15 (crash, graceful restart and rolling deploy, black box); §12 describes the e2e suite and its CI job. D9: a lease that expires with no outcome (a crash mid-request) also opens the settle window, found by the `SIGKILL` e2e test. After the e2e review: §7 `sync_tasks_reclaimed_total` and a warning log for each re-claim.

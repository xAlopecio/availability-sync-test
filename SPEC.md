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
| 429 | transient | Reschedule at `Retry-After`; **pause all sends** until then. |
| 503, timeout, network error, 5xx | transient | Reschedule with exponential backoff and full jitter (base 1 s, cap 5 min). |
| 401 | transient (config) | Retry with backoff. A wrong key is fixable without losing the queue; alert immediately. |
| 400, 404, other 4xx | permanent | Task `failed`. The update's remaining chunks become `failed` too (they would fail the same way: dates are pre-validated). This unblocks the accommodation's queue. |

Transient failures are retried **without limit**: capping attempts would mean dropping accepted updates. A task that retries forever is surfaced by the oldest-pending-age metric and alert instead (§7).

### D5. Concurrency and rate limiting
- Worker concurrency defaults to **3**, so throughput does not collapse if the portal turns slow.
- **At most one task in flight per accommodation**, which D1 requires.
- A global in-memory sliding-window limiter allows at most `PORTAL_MAX_REQUESTS_PER_MINUTE` (default 25) request starts in any 60 s window. A worker slot acquires a permit **before** claiming a task, so it does not hold a lease while waiting.

### D6. Leases for crash safety
Claiming sets `locked_until = now() + lease` (default 30 s, well above the 5 s timeout) and increments `attempts`. If the process dies mid-request, the lease expires and the task is claimed again. Re-sending is safe because the PUT is idempotent. Claim query (sketch):

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

## 5. Data model (PostgreSQL)

```sql
updates (
  id              bigserial PRIMARY KEY,      -- acceptance order
  accommodation_id text NOT NULL,
  date_from date NOT NULL, date_to date NOT NULL,
  available boolean NOT NULL,
  price_per_night numeric(12,2) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
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
  last_error text, last_http_status int,
  completed_at timestamptz
)
-- indexes: (accommodation_id, status, id), (status, next_attempt_at)
```

An update's status is **derived** from its tasks: `failed` if any task failed, `synced` if all are done, otherwise `pending`. Storing it separately would duplicate state.

## 6. HTTP API

### `POST /updates`
Body as in the README. Validation:
- `accommodationId`: non-empty string.
- `from` and `to`: real `YYYY-MM-DD` dates, with `to >= from` and a range of at most 366 days (configurable).
- `available`: boolean.
- `pricePerNight`: finite number, ≥ 0, with at most 2 decimals.
- Unknown fields are rejected.

| Response | When |
|---|---|
| `202 { "updateId": 42, "status": "pending", "chunks": 3 }` | Accepted. Returned **after** the transaction commits. |
| `400 { "error": { "code", "message" } }` | Invalid input (same error shape as the portal). Nothing is persisted. |

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
- `recentUpdates`: the last 20, newest first.
- An accommodation with no updates returns `404`.

**Rationale:** the manager needs to know whether *their* change has arrived. On-call needs to know whether something is stuck and why (attempts, last error, next attempt). Both can be answered from the data D2 already stores.

## 7. Observability

**Logs:** pino JSON. Every portal call logs `taskId`, `updateId`, `accommodationId`, `attempt`, `outcome`, `httpStatus`, `durationMs` and `nextAttemptAt`. Retries are logged at `warn`, permanent failures at `error`.

**Metrics** (`GET /metrics`, Prometheus text format):

| Metric | Type | Purpose |
|---|---|---|
| `sync_tasks_pending` | gauge (from DB at scrape) | Backlog size. |
| `sync_oldest_pending_task_age_seconds` | gauge (from DB at scrape) | Is anything stuck? |
| `portal_requests_total{outcome}` | counter | `success`, `rate_limited`, `unavailable`, `timeout`, `network_error`, `client_error`, `unauthorized`, `server_error`. |
| `portal_request_duration_seconds{outcome}` | histogram | Portal latency. |
| `sync_retries_total{reason}` | counter | Retry volume and cause. |
| `sync_tasks_finished_total{result}` | counter | `done` or `failed`. |
| `sync_update_lag_seconds` | histogram | Time from acceptance to fully synced (end-to-end health). |
| `updates_accepted_total` | counter | Input rate. |

**Proposed alerts:**

| Alert | Condition | Severity |
|---|---|---|
| Sync stuck | `sync_oldest_pending_task_age_seconds > 600` for 5m | critical |
| Worker not sending | `sync_tasks_pending > 0` and `rate(portal_requests_total[5m]) == 0` | critical |
| Bad credentials | `increase(portal_requests_total{outcome="unauthorized"}[5m]) > 0` | critical |
| Portal degraded | non-success ratio > 50 % over 10m (baseline is about 25 %) | warning |
| Unexpected throttling | `increase(…{outcome="rate_limited"}[10m]) > 0` (our limiter should prevent it) | warning |
| Permanent failures | `increase(sync_tasks_finished_total{result="failed"}[15m]) > 0` | warning |
| Portal slow | p95 `portal_request_duration_seconds` > 3 s for 10m | warning |

## 8. Configuration (env vars)

`PORT=3000`, `DATABASE_URL=postgres://sync:sync@localhost:5432/sync`, `PORTAL_BASE_URL=http://localhost:4000`, `PORTAL_API_KEY=sol-demo-key`, `PORTAL_MAX_REQUESTS_PER_MINUTE=25`, `PORTAL_TIMEOUT_MS=5000`, `WORKER_CONCURRENCY=3`, `TASK_LEASE_MS=30000`, `RETRY_BASE_MS=1000`, `RETRY_MAX_MS=300000`, `WORKER_POLL_MS=500`, `LOG_LEVEL=info`.

## 9. Acceptance criteria

Each criterion maps to at least one automated test. **U** = unit, **I** = integration against the real Portal Sol and Postgres, using `/__admin/reset` and `/__admin/requests`.

| # | Criterion | Test |
|---|---|---|
| AC1 | A valid `POST /updates` returns `202` with `updateId`, and the update and its tasks are in the DB when the response arrives. | I |
| AC2 | Invalid input (bad or non-existent date, `to < from`, negative or string price, missing or unknown field, range > 366 days) returns `400` and persists nothing. | U + I |
| AC3 | A range is split into consecutive chunks of at most 31 days that cover it exactly, across month and year boundaries. | U |
| AC4 | **Final state:** after a sequence of overlapping updates on one accommodation (including ranges > 31 days), every affected day in the portal equals the last accepted update covering it, despite the portal's natural 503s. | I |
| AC5 | **Order:** the PUTs for one accommodation reach the portal in acceptance order (the last successful PUT per day matches AC4), and there is never more than one in flight per accommodation. | I |
| AC6 | **Limits:** with the default config, the portal never answers `429`. With the limiter deliberately set above 30/min, after any `429` no request is sent before `Retry-After` has elapsed (checked via admin log timestamps). | I |
| AC7 | **Restart:** updates accepted and then the service stopped before syncing (including a task left with an active lease, simulating a crash) are all synced after restart. | I |
| AC8 | **Timeouts:** with a very low timeout (e.g. 50 ms), so that requests time out but may have been applied, all updates still converge to the correct final state. | I |
| AC9 | **Permanent errors:** an update for a non-existent accommodation ends `failed` after exactly 1 portal request, with no retries, and does not block other updates. | I |
| AC10 | Response classification and backoff follow D4: the right class for each status, a backoff within its bounds, and `Retry-After` respected. | U |
| AC11 | The limiter never allows more than N starts in any 60 s window (fake clock). | U |
| AC12 | `sync-status` reports `pending`, then `synced`, with correct counts and chunk progress; it shows `failed` with the error for AC9; `404` for an unknown id. | I |
| AC13 | `/metrics` exposes every metric in §7, and the values move as expected during AC4 and AC9. | I |

Integration tests are slow by nature (the portal allows 30 requests per minute), so scenarios are kept small. Because the portal's 503s are random, test timeouts are generous.

## 10. Trade-offs and scope limits

- **Single instance.** The DB claim logic (`SKIP LOCKED`, leases) is already multi-instance safe; only the rate limiter is in-memory. Running several replicas would need a shared limiter (a DB row or Redis).
- **Polling** the DB every 500 ms instead of `LISTEN/NOTIFY`: simpler, and the latency is negligible next to the portal's limits.
- **No coalescing.** Superseded updates are still sent. Correct, but wasteful under heavy churn.
- **No `Idempotency-Key` on `POST /updates`.** A duplicated POST is harmless under D1: the same value is sent twice.
- **No drift detection.** If someone changes the portal outside this service, we don't notice.

## 11. Next steps (if there were more time)

Per-day desired state with coalescing (replacing D1); shared rate limiter for multiple instances; manual re-drive of failed updates; periodic reconciliation (`GET` and compare) during idle quota; `LISTEN/NOTIFY`.

## 12. Working method

- **Spec first** (this document is the first commit), then small commits that tell the story (Conventional Commits: `feat:`, `test:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **Branching.**
  - `master` is the stable branch and only receives `develop` when a phase is closed, via PR and with a version tag.
  - `develop` is the integration branch.
  - Each block of work goes on its own `feature/<name>` (or `docs/<name>`) branch cut from `develop`, and is merged back through a **GitHub PR**.
  - Nothing is committed directly to `master` or `develop`.
- **TDD for `domain/` and the limiter:** write the scenarios from §9 as failing tests, implement, then refactor.
- **Integration tests** for the behaviours that only the real portal can prove (AC4–AC9, AC12–AC13).
- **AI-assisted.** A `CLAUDE.md` holds the stack, conventions, environment setup and the "tests first" rule. Two project skills:
  - `tdd-cycle`: red → green → refactor, with a commit per step.
  - `verify-portal`: reset the portal, run a scenario, then check `/__admin/requests` and the portal's final state.

  Everything the AI writes is validated by those tests and by reading the diff. Corrections are recorded in `PROCESS.md`.
- Preparation notes (portal probe and decision analysis) live in `docs/CONTEXTO.md`.

### Changelog
- v1: initial spec.
- v2: §12 adds the branching strategy (`master` / `develop` / `feature/*`, integration through PRs).

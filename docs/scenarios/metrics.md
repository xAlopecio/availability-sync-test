# Test scenarios — `feature/metrics`

The observability block (README requirement 5; SPEC §7, AC13). Someone on call must be able to tell from `/metrics` whether sync is healthy, **without reading the code**.

This block adds:
- the SPEC §7 metrics;
- what the reviews deferred here: D9 holds, head-of-line blocking, the limiter's state, the active worker;
- health and readiness endpoints.

Written and approved **before any test exists**, as for the earlier blocks.

**Test levels:** **U** unit, **I-db** real PostgreSQL, **I-portal** real PostgreSQL and the real Portal Sol.

Status: **v1, approved by the author** (2026-11-10). The decisions in §6 are closed and reflected in SPEC v7.

---

## 1. Registry and exposition — `src/metrics/registry.ts` (U, I-db)

`createMetrics()` returns **its own** prom-client registry (never the global default one, so tests and app instances never share counters) and the typed instruments. `GET /metrics` serves it in the Prometheus text format.

| Id | Scenario | Expected |
|---|---|---|
| M1 | `GET /metrics` on a fresh app | `200`, `Content-Type: text/plain; version=0.0.4`; every SPEC §7 metric (and those added in §2 below) has `# HELP` and `# TYPE` with the right type |
| M2 | Label sets | Undeclared label **names** throw (no per-accommodation labels: unbounded cardinality). Label **values** are enforced at compile time by typed `record*` functions — *changed while implementing: prom-client accepts any label value, contrary to the first assumption* |
| M3 | Two apps built in one process | Independent counters (a separate registry each) |
| M4 | Node process metrics (`process_*`, `nodejs_*`) | Present (prom-client's default collectors on our registry) |

## 2. Queue state, read from the database at scrape — `src/metrics/queue-state.ts` (I-db)

A single aggregate query per scrape. Every pending task falls into exactly one state, so `sum by () (sync_tasks_pending)` is the backlog:

| State | Meaning |
|---|---|
| `ready` | Head of its queue, due, unleased, not held: would be claimed now |
| `in_flight` | Leased |
| `waiting_retry` | `next_attempt_at` in the future (backoff, `Retry-After`) |
| `held_settle` | Due, but held by D9 (an overlapping timeout within the settle window) |
| `queued` | Behind an earlier pending task of its accommodation (FIFO) |

| Id | Scenario | Expected |
|---|---|---|
| Q1 / AC13 | One task seeded in each state | `sync_tasks_pending{state}` = 1 for each of the five states |
| Q2 / AC13 | The oldest pending update was accepted 10 min ago | `sync_oldest_pending_task_age_seconds` ≈ 600 (from `accepted_at`: how long the manager has been waiting) |
| Q3 | Nothing pending | Every state `0`; oldest age `0` |
| Q4 | **Stuck heads** (deferred from the worker review): heads with many attempts | `sync_stuck_heads{min_attempts="10"}` (the number of accommodations whose head has ≥ 10 attempts), plus `sync_head_attempts_max` |
| Q5 | The database is unreachable during a scrape | `/metrics` still answers `200` with the process counters; `sync_metrics_db_up 0`; the DB-derived gauges are **absent**, not reported as a false 0 |

## 3. Instrumentation of the worker and the API — `src/worker/worker.ts`, `src/http/routes/updates.ts` (I-db + scripted client)

| Id | Scenario | Expected |
|---|---|---|
| W1 / AC13 | Scripted attempts: 503, 200, 429, timeout, 404 | `portal_requests_total{outcome}` +1 for each; `portal_request_duration_seconds_count{outcome}` likewise |
| W2 / AC13 | The same run | `sync_retries_total{reason}` +1 for `unavailable`, `rate_limited` and `timeout`; none for the `success` or the `404` |
| W3 / AC13 | A `404` on chunk 1 of a 3-chunk update | `sync_tasks_finished_total{result="failed"}` **+3** (the task and its 2 siblings, D4); `{result="done"}` +1 for the success |
| W4 / AC13 | A multi-chunk update completes its **last** chunk | `sync_update_lag_seconds` observed **once**, ≈ `completed_at − accepted_at`; not observed for the earlier chunks, nor for a failed update |
| W5 | A deferred send (the L13 pause check) | No `portal_requests_total` increment (nothing was sent); `sync_sends_deferred_total` +1 |
| W6 / AC13 | `POST /updates` accepted / replayed (Idempotency-Key) / rejected (400) | `updates_accepted_total` +1 / +0 / +0; `updates_rejected_total{code}` +1 for the 400 |
| W7 | Limiter state | `portal_rate_limiter_paused_seconds` = what remains of the global pause; `portal_rate_limiter_window_starts` = the starts in the current window |
| W8 | Leadership (SPEC D5) | `sync_worker_active` = 1 on the lock holder, 0 on a standby or with `WORKER_ENABLED=false` |

## 4. The metrics agree with reality — (I-portal)

| Id | Scenario | Expected |
|---|---|---|
| R1 / AC13 | A small run against the real portal (overlapping updates, natural 503s) | After syncing: the **sum of `portal_requests_total` over all outcomes equals the number of PUTs in the portal's own `/__admin/requests`**, and `{outcome="unavailable"}` equals the 503s there. `sync_tasks_pending` is 0; `sync_tasks_finished_total{result="done"}` equals the task count |

## 5. Health and readiness — `src/http/routes/health.ts` (I-db)

| Id | Scenario | Expected |
|---|---|---|
| H1 | `GET /health` (liveness) | `200 { "status": "ok" }` whenever the process serves HTTP, even with the DB down (restarting would not help) |
| H2 | `GET /ready` (readiness) with the DB up | `200 { "status": "ready", "database": "up", "worker": "active" \| "standby" \| "disabled" }` |
| H3 | `GET /ready` with the DB down | `503`, `"database": "down"`, in the API's error shape. A load balancer stops routing `POST /updates` that would 503 anyway |

---

## 6. Decisions (approved)

| # | Question | Decision |
|---|---|---|
| Q1 | Queue gauges by state instead of one `sync_tasks_pending` | **`sync_tasks_pending{state}`** with the five states of §2. It answers *why* the backlog exists (rate-limited? held by D9? one stuck head?), which a single number cannot. The SPEC §7 metric name stays; it gains a label. |
| Q2 | Histogram buckets | **Portal latency:** `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` s (the measured p50 is ~0.47 s, the timeout 5 s). **Update lag:** `1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600` s. |
| Q3 | Several instances | Counters are per process. DB-derived gauges report the same value on every instance, so **alerts aggregate them with `max()`**, not `sum()`. Documented next to the alerts. |
| Q4 | Metrics and health on the API port | **Yes**, same port and no auth (out of scope per the README). |
| Q5 | Alert rules | **SPEC §7 rewritten for the new metrics**, plus **`ops/alerts.yml`** in the Prometheus rule format. Valid, copy-pasteable rules for on-call, with no Prometheus running (the README does not ask for one). New: D9 holds for too long, stuck heads, no active worker anywhere, limiter paused for long, `sync_metrics_db_up == 0`. |
| Q6 | Where `sync_oldest_pending_task_age_seconds` is measured from | **The update's `accepted_at`**: how long the manager has been waiting, which is what "Sync stuck" means. `last_attempt_at` would reset on every retry and hide a task that has been failing for an hour. |

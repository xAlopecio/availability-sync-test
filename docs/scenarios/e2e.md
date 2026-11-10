# Test scenarios — `feature/e2e`

End-to-end tests treat the service as a **black box**. They start the real process (`node src/main.ts`, worker enabled) and talk to it **only through its public HTTP API** (`POST /updates`, `GET …/sync-status`, `/metrics`, `/ready`), as a client of Avantio would. They check the outcome in the **real Portal Sol** (its `GET` and `/__admin/requests`).

The database is only touched to create and drop each test's scratch database, never to set up or inspect state. The earlier blocks proved each mechanism from the inside; this block proves that the assembled service keeps the README's promises from the outside.

Written and approved **before any test exists**, as for the earlier blocks.

Status: **v1, approved by the author** (2026-11-10). The decisions in §3 are closed and reflected in SPEC v8.

---

## 1. Flows — `test/e2e/flows.test.ts`

| Id | Scenario | Expected |
|---|---|---|
| E1 | **The README flow:** `POST` the README's example update, poll `sync-status` | `202`, then `synced`; the portal holds the values for those days; `/metrics` shows `updates_accepted_total 1` and the successful portal call |
| E2 / AC4 | **A manager's day:** overlapping updates over HTTP, including one longer than 31 days, plus a **quick correction** a few seconds after an earlier update finished (the path of the worker review's R1) | Every day in the portal equals the last accepted update covering it |
| E3 / AC7 | **Crash mid-sync:** `POST` a batch, **`SIGKILL`** the process while it is sending (no graceful shutdown), start a new process on the same database | No update lost: every `sync-status` reads `synced` and the portal state is correct. The leases of the killed process expired and were re-claimed. *Restart safety only: whether a PUT is in flight at the kill is up to timing, so the late-write case is gated by integration test Q17 (added after the review)* |
| E4 | **Graceful restart mid-sync:** the same, with `SIGTERM` | Exit 0; the new process finishes the rest; same final state |
| E5 | **Safe client retry:** the same `POST` sent twice with one `Idempotency-Key`, and once with a different body | `202` + `Idempotent-Replayed: true`, then `422`; `sync-status` shows one update; the portal receives it once (plus its own retries) |
| E6 / AC2 | **Invalid input over HTTP** (bad date, unknown field, `../` id) | `400` with the error shape; nothing reaches the portal |
| E7 / AC9 | **Unknown accommodation** among valid ones | Its `sync-status` reads `failed` with `lastError` `404 NOT_FOUND …`; the others reach `synced` |
| E8 / D5 | **Rolling deploy:** two processes on one database, both serving the API; `POST` through both; then kill the active one | Both accept updates; **only one sends at a time** (from the portal's log); the standby takes over after the kill; everything ends `synced` |
| E9 | **Readiness across the lifecycle** | `/ready` is `200` with `worker: "active"` on the lock holder and `"standby"` on the other |

## 2. Load — `test/e2e/load.test.ts`

| Id | Scenario | Expected |
|---|---|---|
| L1 / AC6 | **A burst:** ~50 updates over 10 accommodations, some overlapping and some over 31 days, **`POST`ed concurrently** | All `202`. Eventually all `synced`, and every day in the portal equals the last accepted update. Throughout the run: no `429` in the portal's log, and **no 60 s window holds more than 30 portal requests** (computed from the log's timestamps). At the end the metrics agree (`sync_tasks_pending` all 0, `sync_tasks_finished_total{done}` = tasks) |
| L2 | **Throughput report** for the same run | Printed in the test output: updates/min, portal calls/min, the 503 share, and p50/p95 of `sync_update_lag_seconds`. Loosely bounded (it must finish within the expected time for 25/min). For `PROCESS.md` and the README |

---

## 3. Decisions (approved)

| # | Question | Decision |
|---|---|---|
| Q1 | Run the e2e suite in CI? | **Yes, as a separate job** (PostgreSQL + Portal Sol services), in parallel with the integration job. It adds about 10 minutes of wall time to each PR. |
| Q2 | How strict is "black box"? | **Strict:** assertions only through the service's HTTP API, `/metrics`, and the portal (its `GET` and admin log). The database is used only to create and drop the scratch database. |
| Q3 | Load size | **About 50 updates over 10 accommodations, posted concurrently** (about 70 portal calls with the natural 503s, roughly 4 minutes at 25/min). Large enough to exercise concurrency, ordering and the rate limit; small enough to run on every PR. |
| Q4 | Configuration for the e2e processes | **Production defaults, except** `TASK_LEASE_MS=12000` (so E3 does not wait 30 s for a dead lease; *raised from 6000 after the review: 1 s over the 5 s timeout invited re-claims of live attempts on a slow CI runner*) and `RETRY_MAX_MS=5000` (so a streak of 503s cannot push one retry to 5 minutes and stretch the run). Everything else as shipped, including D9's 30 s window. |
| Q5 | Assert on performance? | **Only loose bounds** (completion within the time 25/min allows, plus margin); the figures are printed, not asserted, because the portal's 503s and slowness make them noisy. |

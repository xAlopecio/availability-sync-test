# Availability sync service

Syncs availability and price updates to Portal Sol without losing any, within the portal's limits. Design, decisions and acceptance criteria are in [`../SPEC.md`](../SPEC.md). How the work was done with AI is in [`../PROCESS.md`](../PROCESS.md).

## Requirements

- Node.js 24 or later (`nvm use` reads the repo's `.nvmrc`)
- Docker, to run Portal Sol and PostgreSQL

## Start the dependencies

From the repository root:

```bash
docker compose --profile postgres up -d     # Portal Sol on :4000, PostgreSQL 18 on :5432
curl http://localhost:4000/health
```

## Install and run

```bash
cd service
npm install
npm start          # node src/main.ts; Node 24 runs TypeScript directly, no build step
npm run dev        # same, restarting on file changes
```

## Configuration

Through environment variables, validated at startup: every invalid variable is reported at once, and the service exits. The defaults suit the local `docker compose` setup.

| Variable                         | Default                                    | Purpose                                                                                                                     |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `3000`                                     | HTTP port (`0` = any free port)                                                                                             |
| `DATABASE_URL`                   | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL connection                                                                                                       |
| `DATABASE_STARTUP_TIMEOUT_MS`    | `30000`                                    | How long startup retries an unreachable database, then exits                                                                |
| `SHUTDOWN_GRACE_MS`              | `10000`                                    | How long `SIGTERM` waits for in-flight work before forcing the exit                                                         |
| `MAX_UPDATE_RANGE_DAYS`          | `366`                                      | Longest accepted `from`..`to` range                                                                                         |
| `LOG_LEVEL`                      | `info`                                     | pino level (`fatal` … `trace`, `silent`)                                                                                    |
| `WORKER_ENABLED`                 | `true`                                     | `false` runs the API only. With several instances, only one worker is active at a time (database lock); the others stand by |
| `PORTAL_BASE_URL`                | `http://localhost:4000`                    | Portal Sol URL                                                                                                              |
| `PORTAL_API_KEY`                 | `sol-demo-key`                             | Portal Sol API key                                                                                                          |
| `PORTAL_MAX_REQUESTS_PER_MINUTE` | `25`                                       | Client-side rate limit, below the portal's 30/min (`503`s count too)                                                        |
| `PORTAL_TIMEOUT_MS`              | `5000`                                     | Timeout per portal request                                                                                                  |
| `PORTAL_TIMEOUT_SETTLE_MS`       | `30000`                                    | After a timed-out attempt, how long the accommodation's next update waits (a late write could still land)                   |
| `WORKER_CONCURRENCY`             | `3`                                        | Parallel sends (never two for one accommodation)                                                                            |
| `TASK_LEASE_MS`                  | `30000`                                    | Lease on a claimed task; must exceed `PORTAL_TIMEOUT_MS`                                                                    |
| `WORKER_POLL_MS`                 | `500`                                      | Idle polling interval                                                                                                       |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `300000`                          | Backoff base and cap for transient failures                                                                                 |

On startup the service waits for the database, applies pending migrations, listens, and starts the worker. `SIGTERM` stops the worker (in-flight attempts finish and are stored), then the HTTP server, then the database pool. Losing the database while running never crashes the process: requests answer `503` until it is back.

## API

- `POST /updates`: `202 { updateId, status: "pending", chunks }` once the update is stored; `400`, `413`, `415`, `422`, `503` (database down or busy, with `Retry-After`).
  - Send an **`Idempotency-Key`** header to retry safely: the same key and body return the original `202` (with `Idempotent-Replayed: true`) without storing anything again.
- `GET /accommodations/:id/sync-status`: the summary and the 20 most recent updates; `404` if there are none.

Every error has the shape `{ "error": { "code", "message" } }`. Details in SPEC §6.

## Observability

- `GET /metrics`: Prometheus text format. It covers:
  - pending tasks **by state** (`ready`, `in_flight`, `waiting_retry`, `held_settle`, `queued`) and the oldest pending age;
  - stuck heads;
  - portal calls by outcome, with latency;
  - retries, finished tasks and the end-to-end lag;
  - the limiter, and which instance runs the worker.

  The full list is in SPEC §7.

- `GET /health`: liveness (`200` while the process serves HTTP).
- `GET /ready`: readiness (`503` when the database is unreachable); it also reports the worker state.
- `../ops/alerts.yml`: Prometheus alert rules, ready to load. DB-derived gauges are the same on every instance, so aggregate them with `max()`; aggregate counters with `sum()`.
- Logs are JSON (pino). Every portal attempt is one line with the task, the outcome, the HTTP status, the duration and the next attempt. A task re-claimed after a crash is logged as a warning and counted in `sync_tasks_reclaimed_total`.

## Project layout

```
src/          production code: domain/ (pure logic), portal/, db/, http/, worker/, metrics/
test/unit/    unit tests, mirroring src/
test/integration/   tests against real PostgreSQL (and Portal Sol)
test/e2e/     the whole service against the real portal
test/support/ shared test helpers
```

Tests import production code as `#src/...` (Node subpath import, see `package.json`). The full layout is described in SPEC §3.

## Tests and checks

```bash
npm test                    # unit tests: fast, no Docker needed
npm run test:integration    # against the real PostgreSQL and Portal Sol (start them first); a few minutes
npm run test:e2e            # the whole service, as a black box, against the real portal (~6 min)
npm run test:alerts         # behaviour tests of ../ops/alerts.yml with promtool (Docker)
npm run check               # typecheck + lint + format check + unit tests
```

Integration and e2e tests are slow by nature (the portal allows 30 requests per minute), so scenarios are kept small. Because the portal's 503s are random, test timeouts are generous.

CI (`.github/workflows/ci.yml`) runs four jobs on every PR: `check`; the integration suite and the e2e suite, each against its own PostgreSQL and Portal Sol; and the alert-rule tests.

The test scenarios, written and approved before each block's tests, are in [`../docs/scenarios/`](../docs/scenarios/). Each test names the scenario or acceptance criterion it covers.

## Measured behaviour

The e2e load test (L1/L2, `base` portal variant) sends 50 concurrent updates over 10 accommodations. That is 58 tasks, because some updates span more than 31 days. It ends with every update `synced`, the portal state correct, no `429`, and at most 26 portal requests in any 60 s window:

| Portal calls | 503 share | Wall time | Updates/min | Lag p50 / p95 |
| ------------ | --------- | --------- | ----------- | ------------- |
| 73           | 16 %      | 2.6 min   | 18.9        | 63 s / 130 s  |

Throughput is bound by the portal's limit (25/min client-side, below its 30), not by the service. The lag is the time from acceptance to the last chunk synced.

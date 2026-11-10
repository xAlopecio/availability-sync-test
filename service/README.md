# Availability sync service

Syncs availability and price updates to Portal Sol. Design, decisions and acceptance criteria are in [`../SPEC.md`](../SPEC.md).

> Work in progress: this README is completed as each block lands. Commands marked _(planned)_ are not wired yet.

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

| Variable                         | Default                                    | Purpose                                                                                                   |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `3000`                                     | HTTP port (`0` = any free port)                                                                           |
| `DATABASE_URL`                   | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL connection                                                                                     |
| `DATABASE_STARTUP_TIMEOUT_MS`    | `30000`                                    | How long startup retries an unreachable database, then exits                                              |
| `SHUTDOWN_GRACE_MS`              | `10000`                                    | How long `SIGTERM` waits for in-flight work before forcing the exit                                       |
| `MAX_UPDATE_RANGE_DAYS`          | `366`                                      | Longest accepted `from`..`to` range                                                                       |
| `LOG_LEVEL`                      | `info`                                     | pino level (`fatal` … `trace`, `silent`)                                                                  |
| `WORKER_ENABLED`                 | `true`                                     | `false` runs the API only (nothing is sent to the portal)                                                 |
| `PORTAL_BASE_URL`                | `http://localhost:4000`                    | Portal Sol URL                                                                                            |
| `PORTAL_API_KEY`                 | `sol-demo-key`                             | Portal Sol API key                                                                                        |
| `PORTAL_MAX_REQUESTS_PER_MINUTE` | `25`                                       | Client-side rate limit, below the portal's 30/min (`503`s count too)                                      |
| `PORTAL_TIMEOUT_MS`              | `5000`                                     | Timeout per portal request                                                                                |
| `PORTAL_TIMEOUT_SETTLE_MS`       | `30000`                                    | After a timed-out attempt, how long the accommodation's next update waits (a late write could still land) |
| `WORKER_CONCURRENCY`             | `3`                                        | Parallel sends (never two for one accommodation)                                                          |
| `TASK_LEASE_MS`                  | `30000`                                    | Lease on a claimed task; must exceed `PORTAL_TIMEOUT_MS`                                                  |
| `WORKER_POLL_MS`                 | `500`                                      | Idle polling interval                                                                                     |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `300000`                          | Backoff base and cap for transient failures                                                               |

On startup the service waits for the database, applies pending migrations, listens, and starts the worker. `SIGTERM` stops the worker (in-flight attempts finish and are stored), then the HTTP server, then the database pool. Losing the database while running never crashes the process: requests answer `503` until it is back.

## API

- `POST /updates`: `202 { updateId, status: "pending", chunks }` once the update is stored; `400`, `413`, `415`, `422`, `503` (database down or busy, with `Retry-After`).
  - Send an **`Idempotency-Key`** header to retry safely: the same key and body return the original `202` (with `Idempotent-Replayed: true`) without storing anything again.
- `GET /accommodations/:id/sync-status`: the summary and the 20 most recent updates; `404` if there are none.

Every error has the shape `{ "error": { "code", "message" } }`. Details in SPEC §6.

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
npm run test:e2e            # the whole service against the real portal; the slowest suite
npm run check               # typecheck + lint + format check + unit tests (also runs in CI on every PR)
```

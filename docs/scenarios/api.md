# Test scenarios — `feature/api`

Scenarios for the first block with real I/O: configuration, database migrations, persistence of accepted updates, and the two HTTP endpoints. Written and approved **before any test exists**, as for `feature/core` (see `core.md`).

**Test levels:**
- **U**: unit test, pure.
- **I**: integration test against the **real PostgreSQL** from `docker compose`, using a dedicated `sync_test` database that is never the dev one. HTTP goes through `fastify.inject()`: the real routes and handlers, without opening a port.

The portal and the worker are **not** part of this block, so "the worker made progress" is simulated by updating `sync_tasks` rows directly in the test.

Status: **v1, approved by the author** (2026-11-09). The decisions in §8 are closed and reflected in SPEC v5.

---

## 1. Configuration — `src/config.ts` (U, `test/unit/config.test.ts`)

`loadConfig(env)` parses environment variables (SPEC §8) into a typed, frozen object, or throws one error that lists **every** invalid variable.

| Id | Scenario | Expected |
|---|---|---|
| K1 | Empty environment | All SPEC §8 defaults |
| K2 | Every variable overridden with a valid value | Parsed values (numbers as numbers) |
| K2b | `PORT=0` — *added when W1 failed: the process tests listen on a free port* | Allowed (the OS picks the port) |
| K3 | Invalid numbers: `abc`, `""`, `-1`, `0` where it must be > 0, `1.5` where it must be an integer | Throws; the message names each invalid variable, **all of them at once** |
| K4 | `PORTAL_BASE_URL`: not a URL → error; trailing slash `http://x:4000/` → `http://x:4000` | As stated |
| K5 | `TASK_LEASE_MS` ≤ `PORTAL_TIMEOUT_MS` (cross-field, SPEC D6: the lease must outlive the request) | Throws |
| K5b | `RETRY_MAX_MS` < `RETRY_BASE_MS` — *added while writing the tests: the backoff ceiling would be below its base* | Throws |
| K6 | `LOG_LEVEL` not a pino level | Throws |
| K7 | `PORTAL_MAX_REQUESTS_PER_MINUTE` above 30 | **Allowed**: AC6 needs it to provoke 429s |
| K8 | `MAX_UPDATE_RANGE_DAYS` (see Q6) | Default 366; passed to `validateUpdateRequest` |
| K9 | `DATABASE_STARTUP_TIMEOUT_MS` — *added while writing W3: a test cannot wait 30 s* | Default 30000; positive integer |
| K10 | `SHUTDOWN_GRACE_MS` — *added after the review* | Default 10000; positive integer |

## 2. Migrations — `src/db/migrate.ts` (I, `test/integration/db/migrate.test.ts`)

Numbered `.sql` files in `db/migrations/`, applied at startup, recorded in `schema_migrations` (SPEC D8). The runner takes the directory as a parameter, so tests can use temporary migrations.

| Id | Scenario | Expected |
|---|---|---|
| M1 | Fresh database | All files applied in numeric order; `updates` and `sync_tasks` exist; `schema_migrations` lists every file |
| M2 | Run twice | The second run is a no-op |
| M3 | Two runners at the same time (two instances starting together) | Both succeed; each migration applied **exactly once** (advisory lock) |
| M4 | A migration that fails halfway | That file is rolled back and not recorded; the error surfaces; earlier files stay applied |

## 3. Persistence — `src/db/repository.ts` (I, `test/integration/db/repository.test.ts`)

| Id | Scenario | Expected |
|---|---|---|
| P1 / AC1 | `acceptUpdate(request, chunks)` | 1 `updates` row + N `sync_tasks` rows in **one transaction**. Tasks: `pending`, `attempts = 0`, `next_attempt_at ≤ now`, no lease, `chunk_index` 0…N−1 with the chunk dates |
| P2 / AC1 | Failure while inserting the tasks | **No** `updates` row remains (atomic) |
| P3 / D1 | 20 concurrent `acceptUpdate` for the **same** accommodation | Ordering `sync_tasks.id` matches ordering by (`update_id`, `chunk_index`): ids are allocated in commit order (advisory lock). Without the lock this can interleave |
| P4 / D1 | Concurrent accepts for **different** accommodations | They do not wait on each other (the lock is per accommodation) |
| P5 | `pricePerNight` `19.99` and `1000000` | Read back exactly (`numeric(12,2)` → number, never `19.989999…`) |
| P6 | Dates read back from `DATE` columns, with tests running in `Europe/Madrid` | Exactly `YYYY-MM-DD`, never shifted a day. node-pg's default parses `DATE` into a local JS `Date`, so a type parser is required |
| P7 | Every pooled connection has `statement_timeout = 10s` and `lock_timeout = 5s` — *added after the review* | `SHOW` returns them |
| P8 | Idempotency in `acceptUpdate`: a new key is stored; the same key and body returns the original `updateId` with `replayed: true` and stores nothing; the same key with a different body is a conflict; **concurrent** requests with the same key store one update — *added after the review* | As stated |

## 4. `POST /updates` — `src/http/routes/updates.ts` (I, `test/integration/http/updates.test.ts`)

| Id | Scenario | Expected |
|---|---|---|
| H1 / AC1 | Valid body (the README example) | `202 { updateId, status: "pending", chunks: 1 }`; the rows exist **when the response arrives** |
| H2 / AC1 | 90-day update | `chunks: 3`; 3 task rows with the exact chunk ranges |
| H3 / AC2 | One representative per validation class (non-existent date, `to < from`, unknown field, bad `accommodationId`, string price, 367-day range) | `400 { error: { code, message } }` with the portal's codes; **row counts unchanged** |
| H4 / AC2 | Malformed JSON | `400 INVALID_BODY` in **our** error shape, not Fastify's default |
| H5 | Missing or non-JSON `Content-Type` | See Q1 |
| H6 | Body larger than the limit (1 MB) | `413` in our error shape |
| H7 / AC1 | Database unavailable | `503 { error: { code: "UNAVAILABLE" } }`. **Never a `202` without a commit**: an acknowledged update is a persisted update |
| H8 | Unknown route or method | `404` in our error shape |
| H9 | `Idempotency-Key`: replay → `202` + `Idempotent-Replayed: true` and the same body; different body → `422 IDEMPOTENCY_KEY_REUSED`; invalid key (empty, 129 chars, spaces) → `400` — *added after the review* | Row counts prove nothing is stored twice |
| H10 | Another transaction holds the accommodation's lock longer than `lock_timeout` — *added after the review* | `503` + `Retry-After`, nothing stored, other accommodations unaffected |
| H11 | A malformed HTTP request (raw socket) — *added after the review* | `400` in our error shape, not Fastify's default |
| H12 | A body with `__proto__` — *added after the review: the message said "not valid JSON" twice* | `400 INVALID_BODY` with an accurate message |

## 5. `GET /accommodations/:id/sync-status` — `src/http/routes/sync-status.ts` (I, `test/integration/http/sync-status.test.ts`)

Shape as in SPEC §6. "Worker progress" is simulated by updating task rows.

| Id | Scenario | Expected |
|---|---|---|
| G1 / AC12 | Accommodation with no updates | `404 { error: { code: "NOT_FOUND" } }` |
| G2 | `:id` not matching the `accommodationId` pattern (`a b`, too long) | See Q2 |
| G3 / AC12 | One accepted update, nothing sent yet | `status: "pending"`, `pendingUpdates: 1`, `failedUpdates: 0`, `lastSyncedAt: null`, `oldestPendingSince` = its `acceptedAt`; `recentUpdates[0]` with every field of SPEC §6 (`chunks: { total, done: 0 }`, `attempts: 0`, `lastError: null`, `nextAttemptAt`, `pricePerNight` as a number) |
| G4 / AC12 | 1 of 3 chunks done | `chunks.done: 1`, still `pending` |
| G5 / AC12 | All chunks done | Update `synced`, `syncedAt` = the last chunk's `completed_at`; accommodation `synced`, `lastSyncedAt` set |
| G6 / AC12 | One chunk failed (status 404, error text) | Update `failed` with `lastError`; accommodation `failed` if it is the newest; `failedUpdates: 1` |
| G7 | Retries in progress: chunks with attempts 2 and 3, the last one with an error | `attempts: 5` (sum over chunks), `lastError` from the most recent attempt, `nextAttemptAt` = earliest pending chunk (see Q5) |
| G8 | 25 updates | `recentUpdates` has the newest 20, newest first; the counts cover all 25 |
| G9 | Updates of other accommodations | Never included in the response |
| G10 | Database unavailable on `GET` — *added after the review* | `503` with a message that does not talk about storing updates |

## 6. Wiring and startup — `src/http/app.ts`, `src/main.ts` (I, `test/integration/startup.test.ts`)

| Id | Scenario | Expected |
|---|---|---|
| W1 | `node src/main.ts` against the test database | Runs the migrations, then listens; `POST /updates` and `GET …/sync-status` work over a real port |
| W2 | `SIGTERM` | Stops accepting connections, closes the pool, exits with code 0 within a few seconds |
| W3 | Database unreachable at startup (with `DATABASE_STARTUP_TIMEOUT_MS` lowered) | Retries, then exits non-zero with a clear log line, **never** having listened (Q7) |
| W4 | Every request is logged as JSON; an accepted update logs `updateId`, `accommodationId` and `chunks` | Present in the log output |
| W5 | **PostgreSQL kills the service's connections while it runs** (`pg_terminate_backend`) — *added after the review: the process crashed (HIGH)* | The process stays up, logs the pool error as JSON, and the next `POST` is `202` |
| W6 | A migration fails at startup — *added after the review* | A structured `fatal` log line, exit code 1, never listening |
| W7 | `SIGTERM` while a request is stuck longer than `SHUTDOWN_GRACE_MS` — *added after the review* | Logs the timeout and exits 1 within about the grace period |

## 7. Test infrastructure — `test/support/`

| Id | Scenario | Expected |
|---|---|---|
| T1 | Integration setup (Vitest `globalSetup` + `test/support/test-db.ts`) | Creates `sync_test` from scratch (drop and create) and migrates it. Each test starts with empty tables. **Never touches the `sync` dev database** |
| T2 | CI | See Q3 |

---

## 8. Decisions (approved)

| # | Question | Decision |
|---|---|---|
| Q1 | `POST /updates` without a JSON `Content-Type`? | **`415 UNSUPPORTED_MEDIA_TYPE`**, in our error shape. It is the correct HTTP status and tells the client exactly what is wrong. |
| Q2 | `GET` with an `:id` that can never be valid? | **`404 NOT_FOUND`**, the same as an unknown accommodation. No update can exist for it; a separate `400` adds a code without adding information. |
| Q3 | Run the integration tests in CI? | **Yes, now.** A second CI job with a `postgres:18` service container runs `npm run test:integration`. Later blocks add the Portal Sol image as a second service. That makes AC1/AC2/AC12 verifiable on every PR, not only on the author's machine. |
| Q4 | `503` when the DB is down: include `Retry-After`? | **Yes, `Retry-After: 5`.** It is cheap and tells the caller when to retry. |
| Q5 | Meaning of `attempts`, `lastError` and `nextAttemptAt` for multi-chunk updates? | **`attempts` = sum over chunks; `lastError` = from the most recent attempt; `nextAttemptAt` = earliest among pending chunks.** "Most recent" needs a new column `sync_tasks.last_attempt_at` (SPEC §5, v4). It is also useful for debugging. |
| Q6 | Environment variable for the 366-day limit? | **`MAX_UPDATE_RANGE_DAYS=366`.** SPEC §6 says "configurable", but §8 has no variable for it (SPEC v4). |
| Q7 | Database unreachable at startup? | **Retry the connection with backoff for up to 30 s, then exit with a non-zero code** and a clear log line. A container orchestrator restarts it, and no port is opened that would accept updates it cannot persist. |

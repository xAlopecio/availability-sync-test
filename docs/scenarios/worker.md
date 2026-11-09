# Test scenarios — `feature/worker`

The block that actually syncs. It covers the Portal Sol client, the claim/complete queue in PostgreSQL, the worker loop that ties them to the domain logic from `core`, and its wiring into the service. It also proves the acceptance criteria that only the real portal can prove (**AC4–AC9**).

As for the earlier blocks, these scenarios are written and approved **before any test exists**.

**Test levels:**
- **U**: unit, pure.
- **I-db**: real PostgreSQL.
- **I-portal**: real PostgreSQL **and the real Portal Sol** (`POST /__admin/reset` before each test; assertions on `/__admin/requests` and on the portal's day-by-day state).
- **I-fake**: a local throwaway HTTP server, used **only** for transport faults the real portal cannot produce on demand: slow responses, connection resets, refused connections (see Q6).

Portal tests are slow by nature: 25 requests per minute by default, and about 24 % of responses are 503. Each test keeps its traffic small and has generous timeouts.

Status: **v1, approved by the author** (2026-11-10). The decisions in §8 are closed and reflected in SPEC v6.

---

## 1. Portal client — `src/portal/client.ts` (I-portal, I-fake)

`createPortalClient({ baseUrl, apiKey, timeoutMs })` exposes `putAvailability(accommodationId, { from, to, available, pricePerNight })` and returns a `PortalCallResult` (the input type of `classifyOutcome`), plus the portal's error `code`/`message` when there is a body. **It never throws for HTTP or transport outcomes.**

| Id | Scenario | Level | Expected |
|---|---|---|---|
| PC1 | A valid PUT | I-portal | `{ kind: 'response', status: 200 }`; the portal's state for those days changed (checked with its `GET`) |
| PC2 | What goes on the wire | I-portal | Only the four documented body fields; `X-Api-Key`; `Content-Type: application/json`; the path `/api/v1/accommodations/<id>/availability` (checked in `/__admin/requests`) |
| PC3 | Unknown accommodation | I-portal | `status: 404` with `code: "NOT_FOUND"` and the portal's message |
| PC4 | Wrong API key | I-portal | `status: 401`, `code: "UNAUTHORIZED"` |
| PC5 | 429 with `Retry-After` | I-fake | `status: 429`, `retryAfter: "17"` passed through untouched |
| PC6 | No response within `timeoutMs` | I-fake | `{ kind: 'timeout' }`, returned within about `timeoutMs` (not after the server finally answers) |
| PC7 | Connection refused / reset mid-response | I-fake | `{ kind: 'network_error', code }` (`ECONNREFUSED`, `ECONNRESET`…) |
| PC8 | Error response with a non-JSON body | I-fake | `status` kept; `code` and `message` are `null`; no throw |

## 2. Attempt decision — `src/worker/decide.ts` (U)

A pure function from (task, call result, now, random, policy) to **one action**: `complete`, `reschedule { at, error }`, or `fail { error }`, plus an optional `pauseFor` for the rate limiter. It composes `classifyOutcome` and `nextAttemptAt` from core. The loop only executes the decision.

| Id | Scenario | Expected |
|---|---|---|
| WD1 | `200` | `complete` |
| WD2 | `503` on attempt 3 | `reschedule` at the full-jitter backoff time; error `"503 UNAVAILABLE"` |
| WD3 | `429` + `Retry-After: 17` | `reschedule` at `now + 17 s + 500 ms` **and** `pauseFor: 17 500 ms` (global pause) |
| WD4 | `404` with the portal's code and message | `fail`; error `"404 NOT_FOUND: Accommodation acc-9999 not found"` |
| WD5 | Timeout | `reschedule`; error `"timeout after 5000 ms"` |
| WD6 | Network error | `reschedule`; error `"network error ECONNREFUSED"` |
| WD7 | `401` | `reschedule`, flagged for an error-level log (it needs a human) |
| WD8 | Undocumented status (`409`) | `reschedule` as `unexpected_status` (SPEC v3) |

## 3. Queue operations — `src/db/queue.ts` (I-db)

The claim query of SPEC D6 plus the three outcomes. Each claim returns a **fencing token** (the task's `attempts` after the increment). Completing, rescheduling or failing only applies if the token still matches (see Q3).

| Id | Scenario | Expected |
|---|---|---|
| Q1 / D1 | Several updates over two accommodations, all due | `claim()` returns only the **head** of each accommodation's queue (lowest pending `id`) |
| Q2 / D6 | `claim()` | Sets `locked_until = now + lease`, increments `attempts`, sets `last_attempt_at`; returns the task with the chunk's dates, the update's values and the token |
| Q3 / D1 | The head is leased (in flight) | No later task of that accommodation is claimable; other accommodations are |
| Q4 / D6 | 10 concurrent `claim()` over 4 accommodations with 3 tasks each | Never the same task twice; at most one task per accommodation in flight |
| Q5 / D6, AC7 | A task whose lease has expired (its worker died) | Claimable again; `attempts` grows |
| Q6 | Not due yet (`next_attempt_at` in the future) | Not claimed; due tasks first (`ORDER BY next_attempt_at, id`) |
| Q7 | `complete` with a valid token | `done`, `completed_at`, `last_http_status = 200`, lease cleared, `last_error` cleared (see Q2) |
| Q8 | `reschedule` | Stays `pending`, lease cleared, `next_attempt_at`, `last_error`, `last_http_status` set |
| Q9 / D4 | `fail` | The task **and the pending siblings of the same update** become `failed`, with the same error, in **one transaction**; the accommodation's next update becomes the head |
| Q10 / D6 | A stale token (the lease expired and another worker re-claimed it) | `complete`/`reschedule`/`fail` is a no-op that returns `false`; the newer claim wins |

## 4. Rate limiter additions — `src/portal/rate-limiter.ts` (U)

| Id | Scenario | Expected |
|---|---|---|
| R12 | `release()` returns the most recent permit (a claim found nothing, see Q1) | The window has room again |
| R13 | `acquire({ signal })` aborted while waiting (shutdown) | Rejects with an `AbortError` promptly; takes no permit |

## 5. Worker loop — `src/worker/worker.ts` (I-portal unless stated)

`createWorker({ pool, client, limiter, config, log, now?, random? })` with `start()` and `stop()`. `WORKER_CONCURRENCY` slots, each repeating: **acquire a permit → claim → (nothing: release the permit, sleep `WORKER_POLL_MS`) → call the portal → decide → apply**.

| Id | Scenario | Expected |
|---|---|---|
| L1 / **AC4** | Overlapping updates on one accommodation, one of them longer than 31 days (e.g. U1 90 days at 100 €; U2 a week inside it at 150 €, unavailable; U3 two days inside U2 at 170 €) | After syncing, **every day** in the portal (`GET` per accommodation) equals the last accepted update covering it, **despite the portal's natural 503s** |
| L2 / **AC5** | The same run as L1, from `/__admin/requests` | The **successful** PUTs reach the portal in acceptance order (by task id), and **no two PUTs for that accommodation overlap in time** (timestamp + duration) |
| L3 / **AC6** | 30 single-chunk updates across 5 accommodations with the default limit (25/min) | **No `429`** in the admin log |
| L4 / **AC6** | The same with `PORTAL_MAX_REQUESTS_PER_MINUTE=60` (deliberately above the portal's 30) | `429`s happen. After each one, **no request reaches the portal before its `Retry-After` has elapsed**, checked against the worker's recorded `Retry-After` values and the admin log timestamps. Everything still syncs |
| L5 / **AC7** | Accept updates; run the worker briefly; `stop()` mid-way; also leave one task with a lease as if its worker had crashed; start a **new** worker | Everything ends `done` and the portal state is correct; the crashed task is retried after its lease expires |
| L6 / **AC8** | `PORTAL_TIMEOUT_MS` near the portal's median latency (see Q5), so that many requests time out, some of them after the portal applied them | Every update still converges to the correct final state (idempotent PUT + retry) |
| L7 / **AC9** | An update for `acc-9999` (does not exist) between two valid updates of other accommodations, and one valid update after it for the same id | The `acc-9999` update is `failed` after **exactly 1** portal request for it, with `lastError` from the portal; the others sync; nothing waits on it |
| L8 / D5 | `WORKER_CONCURRENCY=3`, 6 accommodations with work (admin log) | Never more than 3 PUTs overlapping in time, never 2 for one accommodation |
| L9 | `stop()` while slots are waiting for a permit and one request is in flight | Waiting slots stop promptly (abort); the in-flight request finishes and its outcome is stored; `stop()` resolves; no claim afterwards |
| L10 (I-db + fake client) | An idle worker with an empty queue for several poll intervals | **Consumes no permits** (the limiter still has its full window); no portal calls |
| L11 (I-db + fake client) | Every attempt is logged | JSON line with `taskId`, `updateId`, `accommodationId`, `attempt`, `outcome`, `httpStatus`, `durationMs`, `nextAttemptAt` (SPEC §7); retries at `warn`, permanent failures at `error` |

## 6. Wiring — `src/main.ts` (I-portal)

| Id | Scenario | Expected |
|---|---|---|
| WW1 | The service process with the worker enabled: `POST /updates` over HTTP | `sync-status` eventually reads `synced`, and the portal holds the values |
| WW2 | `SIGTERM` | Stops the worker first (in-flight finished and stored), then HTTP, then the pool; exit 0 |
| WW3 | `WORKER_ENABLED=false` (see Q4) | The API works and nothing is sent to the portal |

## 7. Tooling

| Id | Scenario | Expected |
|---|---|---|
| T3 | ESLint type-aware `@typescript-eslint/no-floating-promises` (deferred from the core review) | `npm run lint` flags an un-awaited promise in `src/` |
| T4 | CI | See Q8 |

---

## 8. Decisions (approved)

| # | Question | Decision |
|---|---|---|
| Q1 | "Phantom" permits: D5 takes a permit **before** claiming, so a claim that finds nothing wastes one (core review) | **Keep the order and `release()` the permit when the claim finds nothing** (R12, L10). Claiming first would hold a lease while waiting for a permit, up to 60 s, longer than the 30 s lease, which risks a double send. |
| Q2 | On success, keep or clear `last_error`? | **Clear it.** `sync-status.lastError` describes the most recent attempt, and an attempt that succeeded has no error. The history is in the logs. |
| Q3 | Fencing on complete, reschedule and fail | **Yes, with the `attempts` value returned by the claim.** If a lease expired and another worker re-claimed the task, the stale result is discarded instead of overwriting the newer one (Q10). |
| Q4 | `WORKER_ENABLED` | **Yes, default `true`** (SPEC §8 v6). It allows an API-only instance and keeps the API tests from sending real traffic to the portal. |
| Q5 | AC8 says "a very low timeout (e.g. 50 ms)". With a portal median of about 470 ms, **almost no request would ever succeed**, so the test would never converge | **Change AC8 to a timeout near the median (≈ 400 ms):** a large share of requests time out, some of them after being applied, and the rest succeed. SPEC v6. |
| Q6 | A local fake HTTP server for transport faults | **Yes, but only for the client's timeout, reset, refused-connection and non-JSON paths** (PC5–PC8), which the real portal cannot produce on demand. Every sync behaviour (AC4–AC9) runs against the **real** portal. `CLAUDE.md` gets this nuance. |
| Q7 | Where AC4–AC9 are proven | **Here, with the worker in-process** against the real portal and DB (precise, and reasonably fast). `feature/e2e` then runs the **whole process as a black box** over HTTP for the headline flows, and adds a load scenario. |
| Q8 | Portal Sol in CI | **Yes, now.** The image is public (it was pulled without credentials). The integration job gets a `portal-sol` service next to `postgres`. The suite becomes slower, a few minutes, because of the portal's 30/min. |
| Q9 | Format of `last_error` | **`"<status> <CODE>: <message>"`** for HTTP errors (`"404 NOT_FOUND: …"`), `"timeout after <ms> ms"`, `"network error <code>"`. Readable in `sync-status`, greppable in logs. |

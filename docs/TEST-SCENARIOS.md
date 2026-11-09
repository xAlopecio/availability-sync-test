# Test scenarios — `feature/core`

Scenarios for the pure logic of the service, written and approved **before any test exists** (the `tdd-cycle` skill). Each scenario becomes one or more `it(...)` cases, named with its id and, where it maps to one, its acceptance criterion (e.g. `it('C3 / AC3: splits 32 days into 31 + 1')`).

Scope: everything in this block is pure (no I/O, no DB, no HTTP). The clock and randomness are injected. Order of implementation follows the dependencies: dates → chunking → validation → outcome → backoff → rate limiter → status.

Status: **v1, approved by the author** (2026-11-09). The decisions in §8 are closed and reflected in SPEC v2.

---

## 1. Calendar dates — `domain/dates.ts`

Dates are calendar days (`YYYY-MM-DD`, no time or zone), as in `API.md`. Arithmetic is done on UTC day numbers, so the host time zone can never shift a day.

| Id | Scenario | Expected |
|---|---|---|
| D1 | `2026-10-01` | valid |
| D2 | Day that does not exist: `2026-02-30`, `2026-04-31` | invalid |
| D3 | Leap years: `2028-02-29` valid; `2026-02-29` invalid; `2100-02-29` invalid; `2000-02-29` valid | as stated |
| D4 | Out-of-range parts: month `00`, month `13`, day `00`, day `32` | invalid |
| D5 | Wrong format: `2026-1-01`, `2026/10/01`, `20261001`, `2026-10-01T00:00:00Z`, `" 2026-10-01"`, `""` | invalid |
| D6 | `daysInclusive(from, to)`: same day = 1; `10-01..10-07` = 7; `12-31..01-01` = 2; Feb 2028 = 29 | as stated |
| D7 | `addDays`: across month end, year end and leap day (`2028-02-28` + 1 = `2028-02-29`, + 2 = `2028-03-01`) | as stated |
| D8 | DST change days (`2026-03-29`, `2026-10-25` in Europe): consecutive days still advance by exactly 1 | no skipped or duplicated day |

## 2. Range chunking — `domain/chunking.ts` (AC3)

`splitRange(from, to, maxDays = 31)` returns consecutive chunks of at most `maxDays` days, inclusive at both ends.

| Id | Scenario | Expected |
|---|---|---|
| C1 | 1 day | 1 chunk equal to the input |
| C2 | Exactly 31 days | 1 chunk |
| C3 | 32 days | 31 + 1 |
| C4 | 62 days / 63 days | 31 + 31 / 31 + 31 + 1 |
| C5 | 90 days starting `2026-11-09` | exact boundaries: `11-09..12-09`, `12-10..01-09`, `01-10..02-06` |
| C6 | **Invariant**, checked for every length from 1 to 400 days: first chunk starts at `from`, last ends at `to`, each next chunk starts the day after the previous one ends, every chunk is ≤ `maxDays`, and the day count sums to the total | holds for all |
| C7 | Crosses month and year: `2026-12-15..2027-02-10` | correct boundaries |
| C8 | Includes `2028-02-29` | leap day neither lost nor duplicated |
| C9 | `maxDays = 7` (parameter, for testability) | chunks of 7 |
| C10 | `to < from` (programming error: validation runs first) | throws |
| C11 | `maxDays` not a positive integer (`0`, `-1`, `1.5`, `NaN`) — *added during implementation: `0` made the loop infinite* | throws `RangeError` |

## 3. Update validation — `domain/update-validation.ts` (AC2)

`validateUpdateRequest(body: unknown)` returns `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. The codes mirror the portal's (`INVALID_BODY`, `INVALID_DATE`, `RANGE_TOO_LARGE`), and the message names the field. When several things are wrong, the first error in field order is returned.

| Id | Scenario | Expected |
|---|---|---|
| V1 | The README example | ok, values unchanged |
| V2 | Body is `null`, an array, a string or a number | `INVALID_BODY` |
| V3 | Each required field missing, one at a time | `INVALID_BODY` naming the field |
| V4 | Unknown extra field | `INVALID_BODY` |
| V5 | `accommodationId`: non-string, `""`, or characters outside the allowed pattern (`acc 1`, `../x`, `a/b`, more than 64 chars) | `INVALID_BODY` (see Q2) |
| V6 | `from` or `to` not a string, or invalid per D2–D5 | `INVALID_DATE` |
| V7 | `to` earlier than `from` | `INVALID_DATE` |
| V8 | Range of 366 days ok; 367 days | ok / `RANGE_TOO_LARGE` (the limit is a parameter) |
| V9 | `available` is `"true"`, `1` or `null` | `INVALID_BODY` |
| V10 | `pricePerNight`: `0` ok, `120` ok, `120.5` ok, `19.99` ok, `0.07` ok; negative, `"120"`, `null` | ok / `INVALID_BODY` |
| V11 | `pricePerNight` with more than 2 decimals (`120.555`, `1.005`) | `INVALID_BODY` |
| V12 | `pricePerNight` above the maximum (see Q3), `NaN` or `Infinity` | `INVALID_BODY` |
| V13 | Dates in the past | ok (see Q1) |

## 4. Portal outcome classification — `domain/outcome.ts` (AC10)

`classifyOutcome(result, now)` maps what happened to a portal call to `success`, `transient` (with a `reason` and an optional `retryAfterMs`) or `permanent`. The `reason` values are the `outcome` labels of the `portal_requests_total` metric in SPEC §7.

| Id | Input | Expected |
|---|---|---|
| O1 | `200`, `204` | `success` |
| O2 | `429` + `Retry-After: 17` | transient `rate_limited`, `retryAfterMs = 17000` |
| O3 | `429` + `Retry-After` as an HTTP date | transient `rate_limited`, ms relative to `now` |
| O4 | `429` with `Retry-After` missing, garbage, negative or a past date | transient `rate_limited`, fallback delay (see Q4) |
| O5 | `429` + `Retry-After: 0` | `retryAfterMs = 0` |
| O6 | `503` | transient `unavailable` |
| O7 | `500`, `502`, `504` | transient `server_error` |
| O8 | Client-side timeout | transient `timeout` |
| O9 | Network error (connection refused or reset, DNS) | transient `network_error` |
| O10 | `401` | transient `unauthorized` |
| O11 | `400`, `404`, `409`, `422` (any 4xx other than `401` and `429`) | permanent `client_error` |
| O12 | Unexpected status outside 2xx/4xx/5xx (`302`, `304`) | transient `server_error`: never drop an update on something we don't understand |

## 5. Retry scheduling — `domain/backoff.ts` (AC10)

`nextAttemptAt({ attempt, outcome, now, random, baseMs, maxMs })`. Here `attempt` is the number of attempts already made (≥ 1), and `random()` is injected, returning a value in `[0, 1)`.

| Id | Scenario | Expected |
|---|---|---|
| B1 | Exponential ceiling: attempt 1 → 1 s, 2 → 2 s, 3 → 4 s, … | `ceiling = min(maxMs, baseMs · 2^(attempt−1))` |
| B2 | Full jitter: `random = 0` and `random → 1` | delay `0` and just under the ceiling |
| B3 | The ceiling is capped at `maxMs` (300 s) from attempt 10 on | never exceeds `maxMs` |
| B4 | Huge attempt number (1000) | finite, ≤ `maxMs`, never `NaN` or `Infinity` |
| B5 | `rate_limited` with `retryAfterMs` | `now + retryAfterMs + safety margin` (see Q5), no jitter, **never earlier than `Retry-After`** |
| B6 | Same inputs | same output (deterministic) |

## 6. Rate limiter — `portal/rate-limiter.ts` (AC11)

A sliding window of `limit` request starts per `windowMs` (default 25 per 60 s), plus a global pause. The core is pure: `tryAcquire(now)` returns `{ ok: true }` or `{ ok: false, waitMs }`. A small async `acquire()` wrapper waits and retries.

| Id | Scenario | Expected |
|---|---|---|
| R1 | `limit` acquisitions in a burst | all ok; the next one is denied with `waitMs` = time until the oldest leaves the window |
| R2 | Window boundary: a start at `t` occupies the window `(t − windowMs, t]` | at `t + windowMs` a new start is allowed |
| R3 | **Invariant**: 10 simulated minutes of random acquisition attempts (fake clock, seeded random) | no 60 s window ever holds more than `limit` starts |
| R4 | Denied attempts | do not consume permits |
| R5 | `pauseUntil(t)`, as after a 429 | everything is denied until `t`, with `waitMs = t − now`; normal behaviour after `t` |
| R6 | A shorter pause after a longer one | does not shorten the longer pause |
| R7 | `limit = 1` | works (edge case) |
| R8 | Async `acquire()`: 3 concurrent callers, `limit = 2` (fake timers) | 2 resolve immediately; the third only once the window frees a permit; never more than `limit` |
| R9 | Invalid configuration: `limit` not a positive integer, `windowMs` ≤ 0 — *added while writing the tests, after C11* | throws `RangeError` |

## 7. Sync status derivation — `domain/sync-status.ts` (supports AC12)

| Id | Scenario | Expected |
|---|---|---|
| S1 | Update: all tasks `done` | `synced` |
| S2 | Update: any task `failed` (even if others are `done`) | `failed` |
| S3 | Update: some `pending`, none `failed` | `pending` |
| S4 | Accommodation: any update `pending` (even if others failed) | `pending` |
| S5 | Accommodation: none pending, most recent `failed` | `failed` |
| S6 | Accommodation: none pending, an older update `failed`, the most recent `synced` | `synced` |
| S7 | Accommodation with no updates | `null` (the route answers `404`) |

---

## 8. Decisions (approved)

| # | Question | Decision |
|---|---|---|
| Q1 | Accept dates in the past? | **Yes.** It is not our call: the portal accepts them, and a manager may fix history. |
| Q2 | Format of `accommodationId`? | **`^[A-Za-z0-9_-]{1,64}$`.** It goes into the portal URL path, so `/`, `..` or spaces would change the request (path injection). There is no specific `acc-NNNN` pattern, so new portal ids are not rejected. |
| Q3 | Maximum `pricePerNight`? | **≤ 1,000,000.** It fits `numeric(12,2)` and catches typos (an extra 0s). |
| Q4 | Delay when a 429 has no valid `Retry-After`? | **60 s**, the portal's window: the safe worst case. |
| Q5 | Safety margin added to `Retry-After`? | **+500 ms.** `Retry-After` comes in whole seconds; the probe saw it count down to `1` and only be accepted at about +2 s, so arriving just at the limit risks a second 429. |
| Q6 | `404` as permanent? | **Yes** (SPEC D4). An accommodation that does not exist will not exist on retry. |

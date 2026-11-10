# Process log

Running record of how the work was split between the author and the AI (Claude Code), kept **as it happens**, in the same PR as the work it describes. `PROCESS.md` (half a page, required) is distilled from this file at the end.

Each entry says **who** did what, **what went wrong or was discarded**, and **how we noticed**. Commit hashes point to the evidence.

Legend: 🤖 delegated to the AI · 👤 decided or done by the author · ⚠️ AI mistake or discarded proposal · 🔍 caught by review or verification

---

## Phase 0 — Understanding the exercise (before SPEC)

- 🤖 Read `README.md`, `API.md`, `docker-compose.yml` and `service/README.md`, and summarised requirements, portal quirks and hidden difficulties (overlapping updates, timeouts that may have been applied, global rate limit).
- 👤 Asked for an explanatory document before any spec work, then for an explanation of how each open design decision would affect the result. 🤖 Wrote `docs/CONTEXTO.md` and an analysis of 7 decisions with a recommended package. 👤 Accepted the package.
- ⚠️ The AI reported that **Docker was not installed**. 👤 The author said Docker Desktop was installed: its CLI was simply not on the shell's `PATH`. The AI had concluded too early from a "command not found". Workaround documented in `CLAUDE.md`.

## Phase 0 — Probing Portal Sol

- 🤖 Wrote a throwaway probe script (auth, validation, burst, paced PUTs) and ran ~150 requests. Measured: **30 req/min**, 503s count toward the limit, accurate `Retry-After`, **~24 % 503s**, p50 470 ms / max 810 ms, extra body fields accepted (the docs say `INVALID_BODY`), and `/health` reporting `variant: "base"`. All of this fed SPEC §2.
- ⚠️🔍 The paced probe seemed to **hang for ~40 min**, which looked like the portal's documented slowness. The data contradicted that: every request had taken < 810 ms, but the portal's admin log showed a gap between consecutive timestamps. `pmset -g log` confirmed **the Mac had gone to sleep** on battery. The finding "slowness not observed" was kept, and the false one ("portal hangs") was discarded.

## Phase 1 — SPEC (`f878a08`)

- 🤖 Drafted `SPEC.md` (English, like the exercise). 👤 Asked for a Spanish mirror (`docs/SPEC.es.md`), kept in sync on every change.
- 👤 Asked "ORM or not?". 🤖 Argued against Prisma, since the critical queries (`SKIP LOCKED`, advisory locks) would be raw SQL anyway. Added as **D8**.
- 👤 Before pushing, noticed **no branching strategy** had been defined. 🤖 Moved the SPEC commit from `master` to a new `develop` branch.
- ⚠️ The AI recorded the branching strategy as a **SPEC v2** through PR #1. 👤 The author objected that it had been decided before any code, so it belonged in v1. Amended into the SPEC commit and force-pushed (`develop` only, minutes old). PR #1 was closed with an explanatory comment.
- ⚠️ The AI proposed `feature/scaffolding`. 👤 The author wanted simpler names: `feature/setup`, `core`, `api`, `worker`, `metrics`, `e2e`, `docs/process`.

## Phase 2 — Setup (PR #2)

- 🤖 Scaffolded `service/` (`76faf68`): Node 24 native type stripping (no build step), strict `tsc --noEmit`, Vitest with `unit` and `integration` projects. Wrote `CLAUDE.md` (`454ee02`) and two skills, `tdd-cycle` and `verify-portal` (`2463167`).
- ⚠️🔍 The AI's first `verify-portal` helper flagged requests "sent before `Retry-After` elapsed". On rereading before commit, the AI realised that the portal's admin log **does not record `Retry-After`**, so the flag would have been made up. It was replaced by "time since last 429"; the exact check belongs in the AC6 test.
- ⚠️ The AI had skipped linting to save time. 👤 The author asked for ESLint + Prettier with basic rules (`093c828`).
- ⚠️🔍 The AI had installed **TypeScript 7** ("latest") without checking the ecosystem. Before adding typescript-eslint, checking its `peerDependencies` showed it supports TS < 6.1. Pinned TS 5.9 (`093c828`).
- 👤 Brought an adversarial **review agent** from another project (`9bbd869`). 🤖 Pointed out that its forced minimum of 3 risks would be noise on 20-line TDD commits. 👤 Decided to run it **once per PR block** (`9eac238`).
- 🔍 **First review (PR #2, `fast`): `PROCEED`.** Root risk: the process rules existed only as prose, with nothing enforcing them. Outcome:
  - Fixed: a GitHub Action runs `npm run check` on every PR (`de2ee8f`). 👤 The author chose CI over a local hook, because a hook would block the red commits of TDD.
  - Fixed: `passWithNoTests` let `test:integration` pass with zero tests (`ac8875e`).
  - Fixed: `service/README.md` was still the placeholder (`ece9b3b`).
  - Fixed: `no-console` only warned; the portal limit was presented as a fixed fact.
  - ⚠️ **Reviewer overstated:** a substring filter in `portal.mjs` was flagged MEDIUM, but the real ids (`acc-1001…acc-1010`) cannot collide. It was fixed anyway because the fix is one line (`cf3bb88`).
  - Accepted: `pino` not declared (Fastify's logger is used); workstation paths in `CLAUDE.md`.
- 🔍 The first CI run warned that `actions/*@v4` target the deprecated Node 20. Bumped to v7 (`b1e5b45`).

## Phase 3 — Core domain logic with TDD (`feature/core`)

- 👤 Insisted that the scenarios be defined **before** any test. 🤖 Wrote the core test scenarios (now `docs/scenarios/core.md`; ~60 scenarios, 7 modules, 6 open questions). 👤 Approved them all (`add901b`).
- 🔍 Writing the scenarios exposed a spec gap: SPEC only required a "non-empty" `accommodationId`, but the id goes into the portal URL path, so `../x` or `a/b` would change the request. The pattern `^[A-Za-z0-9_-]{1,64}$` and the other approved decisions went into **SPEC v2** (`de907c1`).
- 🤖 Implemented the 7 modules red → green, with one commit per step. Every red step was checked to fail **with "not implemented"**, not with an import or syntax error.
- ⚠️🔍 **C10 passed against the stub.** It only asserted that *something* was thrown, and the stub throws. It was tightened to the specific `RangeError` before committing the red step (`68bf4fb`).
- ⚠️🔍 **A scenario was missing (C11).** While implementing `splitRange`, `maxDays = 0` turned out to loop forever: the new test hung until a 20 s alarm killed it. The guard and scenario C11 were added, marked "added during implementation" (`a7f3890`). The same lesson led to R9 (invalid rate-limiter configuration).
- ⚠️🔍 **A code comment claimed more than was true.** It said that `Date.parse` accepts `"-5"` and `"17.5"`. Checked in Node: `"-5"` becomes a date in 2001, `"17.5"` is `NaN`. The comment was corrected before commit (`9a25a23`).
- 🔍 Validation beyond the tests:
  - Date arithmetic cross-checked against `Date` over 1900–2199 (109,573 consecutive days).
  - The rate limiter **mutation-tested**: an off-by-one on the limit and a shifted window boundary were introduced on purpose, and both were caught, including by the 10-minute invariant R3 (`55519ed`).
- 🤖 Design choices made inside the block:
  - Integer days-from-civil arithmetic instead of `Date`, which avoids `Date.UTC` mapping years 0–99 to 19xx.
  - Unit tests run in `Europe/Madrid`, so that DST bugs show up.
  - The 2-decimal price check uses a `toFixed(2)` round trip rather than an epsilon, which breaks near the 1,000,000 cap.
- 🔍 **Review of the block (`deep`): `PROCEED`.** Root risk: the shared rate limiter accepted any time input. The reviewer showed that a huge `Retry-After` froze every send, and that above 2³¹ ms `setTimeout` overflows into a 1 ms busy loop. Outcome:
  - Fixed (`4431f65`): `Retry-After` capped at 10 min; long waits slept in steps of ≤ 60 s; a monotonic clock plus `pauseFor(ms)`; the `maxRangeDays` guard (`NaN` disabled the range check).
  - 👤 **Decided by the author, SPEC v3** (`d692fb4`): only `400`/`404` are permanent. Any undocumented status is retried as `unexpected_status`, with an alert. Before, a 408 or 409 would have **dropped an accepted update**, which our own spec had allowed against the "no update lost" requirement.
  - 👤 Accepted and documented: `sync-status` can read `synced` while an older non-overlapping update failed. With only `400`/`404` permanent this needs a bug to happen.
  - Deferred: "phantom" permits (D5 takes a permit *before* claiming a task) → `feature/worker`. Cancellable `acquire()` → worker. Portal error code on permanent failures → worker. Limiter state in metrics → `feature/metrics`.
  - ⚠️ **Partly right, accepted:** "oversized for the budget". The hand-rolled calendar arithmetic could have been `Date.UTC` day numbers, and the HTTP-date `Retry-After` branch goes beyond the portal contract. Both were already done and verified, and redoing them would cost more than it saves. Recorded honestly here.
  - ⚠️ **Reviewer wrong, by design of its isolation:** it called the 25/min default "a guess", but it comes from our probe (30/min measured). The reviewer does not see the probe.
- ⚠️🔍 **A silent no-op edit by the AI:** one scripted text replacement did not match (Prettier had reflowed the line) and the script did not assert the match, so `unexpected_status` never reached the type. The tests still passed, because Vitest strips types without checking them. **`tsc` in `npm run check` caught it.** That is the case for running typecheck in the gate, not just the tests.
- 👤 Asked for the deliberate-defect check (mutation testing) to be extended from the rate limiter to `outcome` and `validation`. 🤖 Wrote a throwaway script with 41 hand-written mutants.
  - First run: **11 survived**. Real gaps: the 2xx/5xx upper bounds, an empty `Retry-After` (it would have retried immediately instead of waiting 60 s), the letter guard before `Date.parse`, the `to` = `from` − 1 boundary, and the order of date errors.
  - ⚠️🔍 One of the new tests was itself wrong: `"2030"` was meant to reach the date path, but it is read as delay-seconds first. It **failed against the correct code**, which exposed the mistaken assumption, and it was replaced by `"2030-01-01"`.
  - Final: outcome 19/19 killed, validation 20/22. The 2 survivors are proven equivalent mutants (redundant guards), documented in `docs/scenarios/core.md` §9.

## Phase 3b — Source layout (`refactor/structure`)

- 👤 Before starting the API block, the author noticed in the editor that tests sat next to the code in `src/domain/` (12 mixed files), while `test/integration/` existed but was empty. They asked for a solid structure **before** writing more code. 🤖 Proposed the full target tree for every remaining block. 👤 Chose: tests in their own `test/` tree mirroring `src/`, `domain/` split by topic (`calendar/`, `updates/`, `retry/`, against the AI's suggestion to keep it flat), and `docs/scenarios/`.
- 🤖 Moved the files with `git mv` (history kept, renames detected) and added the `#src/*` subpath import so that tests do not use `../../../src`. Checked that **Node, `tsc` and Vitest** all resolve it natively before relying on it. Recorded the layout in SPEC v4 §3, `CLAUDE.md`, the `tdd-cycle` skill and the README.
- ⚠️🔍 The AI's first commit swept in a docs rename already staged by `git mv`, and a later `git add` failed silently on a path that no longer existed (the error was redirected to `/dev/null`). Caught by reading `git show --stat` before pushing. The two commits were redone so that code and docs are separate. Lesson: do not hide `git` errors.
- 🔍 **Review (`fast`): `PROCEED`**, no root risk. The reviewer verified by itself that behaviour is unchanged, that `#src` resolves in plain Node, and that `git log --follow` still reaches the original TDD commits. Outcome (`fix(service): make misplaced tests…`):
  - Fixed: tests placed in `test/e2e/` or inside `src/` would have been **skipped silently**. Added an `e2e` Vitest project, plus a layout test that fails on misplaced test files.
  - Fixed: nothing enforced the import convention. Added ESLint rules in both directions.
  - ⚠️🔍 The AI's first version of the `src/` rule did nothing. ESLint reads `group` patterns with gitignore syntax, where a leading `#` starts a comment, so `#src/**` was ignored. Caught by **probing the rule with a throwaway file**, not by trusting the config; switched to the `regex` option.
  - Accepted: the domain split ("premature", says the reviewer; it is the author's explicit choice, and cheap to revert); the docs commit following the code commit; the scenario-doc move (part of the author's layout decision, which the reviewer cannot see).
- ⚠️ The AI named this branch `refactor/structure` although SPEC §12 only allowed `feature/` and `docs/`. It flagged the inconsistency itself and proposed fixing it in the next block. 👤 The author decided it belongs **in this same PR**, because it is structural. The rule was folded into SPEC v4, which is not yet merged, rather than opening a v5.

## Phase 4 — API: configuration, persistence and HTTP (`feature/api`)

- 🤖 Drafted ~40 scenarios (`docs/scenarios/api.md`) with 7 open questions. 👤 Paused the block to fix the source layout first (Phase 3b), then approved all 7 decisions, which became SPEC v5.
- 🤖 Implemented 6 groups red → green, **against real PostgreSQL**: config, migrations, persistence, `POST /updates`, `sync-status`, and the service process. The integration tests use their own databases (`sync_test` and one scratch database per migration and startup test), never the dev one.
- ⚠️🔍 **The red-step shape mattered twice.**
  - A throwing pool stub inside `beforeAll` made the whole repository file *skip* instead of fail. The stub became a plain `pg` pool, so that P5/P6 fail on their own assertions.
  - **P2 passed against the stub** (it only expected *a* rejection, the C10 lesson again). It was tightened to require the `sync_tasks_range_valid` constraint error.
- ⚠️🔍 **The AI wrote a nonsense assertion** in G8 (it compared a date against a boolean, so it always passed). Caught on rereading before the red commit, and replaced by a real check of `oldestPendingSince`.
- 🔍 **Mutation checks**, after the C10/C11 lessons:
  - migrations without the advisory lock fail M3 in 3 runs out of 3;
  - persistence without the per-accommodation lock fails P3/P4, and without the `DATE` or `NUMERIC` parsers fails P1/P5/P6;
  - HTTP: 7 mutants, 6 killed. The survivor (the id-pattern guard) is equivalent, since the query then finds nothing and also answers 404.
- ⚠️🔍 **W2 checked nothing in one assertion.** "No DB connections left after exit" holds even without `pool.end()`, because the OS closes sockets on any exit, and a mutant proved it. It now checks that the logged shutdown steps ran in order, and the same mutant fails it.
- ⚠️🔍 **Two pieces written by the AI contradicted each other.** The process tests started the service with `PORT=0` (a free port), but the config only accepted 1–65535. The first W1 run exposed it; `PORT=0` is now valid, with its own test (K2b).
- ⚠️ **A destructive command was blocked**, and rightly so. To undo a mutant, the AI ran `git stash` + `stash drop` on `main.ts`, which would also have discarded uncommitted work (the new shutdown logs). The permission classifier denied it before it ran; nothing was lost. The AI redid it by restoring from a copy, as with the other mutants.
- 🔍 **Real-world traps covered by tests:**
  - node-pg turns a `DATE` into a local `Date`, a day early east of UTC; tests run in `Europe/Madrid` to catch it.
  - Fastify accepts `text/plain` bodies by default, which would have broken the `415`.
  - A pool without a connection timeout would hang on a hung database instead of answering `503`.
- 👤 Q3: the integration tests now run in CI against a `postgres:18` service.
- 🔍 **Review of the block (`deep`): `PROCEED`, "but not mergeable as is".** The reviewer started the service itself and killed its database connections with `pg_terminate_backend`.
  - ⚠️🔍 **Root risk, HIGH and real:** the process **crashed** when PostgreSQL dropped an idle connection, because the pool's `error` event was unhandled. Our H7 test could not catch it: it used a pool that never connected. Fixed (`fix: survive database failures…`), and W5 now reproduces the reviewer's exact scenario. A mutant without the handler fails it.
  - Fixed as well:
    - statement and lock timeouts (H10: a held lock now answers `503` in about 300 ms instead of hanging), plus a request timeout and a forced shutdown after a grace period (W7);
    - a structured `fatal` on a failing migration (W6);
    - our error shape for malformed HTTP requests (H11);
    - accurate body error messages (H12). Probing showed that Fastify itself reports `__proto__` as "not valid JSON", hence our own parser.
  - 🤖 The reviewer also found a **real design hole the AI had missed**: SPEC §10 claimed that duplicate `POST`s are harmless under D1. They are not: a retry after an ambiguous `COMMIT` can land after a newer update. 👤 The author chose an optional `Idempotency-Key` (P8, H9, migration 002).
  - The reviewer argued that the per-day desired-state model would close that hole without a key. 👤 The author asked for an explanation before deciding. 🤖 The explanation showed that **the reviewer was wrong on that point**: a retry is indistinguishable from a new change in both models, so only the key closes it. 👤 Kept D1; the per-day model is documented in §11.
  - Not applicable: "failed with pending chunks". D4 marks the sibling chunks failed, and the reviewer had not been given D4. It becomes a worker scenario.
  - Accepted: implausible dates (the probe showed the portal accepts them); the cost of reading the full history in `sync-status`.
  - Deferred: `/health` and readiness → `feature/metrics`; worker column semantics → worker tests.
- ⚠️🔍 Two more equivalent mutants found and documented: the id-pattern guard on `GET`, and the in-transaction idempotency lookup (the unique-constraint path gives the same result).
- ⚠️ **Leftover process:** a `node src/main.ts` started by the AI during the restructuring had been listening on port 3998 for hours. The `kill %1` had run in another shell. The reviewer noticed it; the AI confirmed it was its own and stopped it.

## Phase 5 — The worker: sending to Portal Sol (`feature/worker`)

- 🤖 Drafted ~45 scenarios (`docs/scenarios/worker.md`) with 9 open questions. 👤 Asked for Q6 (a local fake server) to be explained, then approved all of them: SPEC v6.
  - 🔍 Writing the scenarios exposed **AC8 as written could never pass**: a 50 ms timeout against a portal median of 470 ms lets almost nothing succeed. It became "≈ 400 ms".
  - 🔍 AC9's "exactly 1 request" would have been flaky: the portal answers random 503s even for unknown ids. It became "nothing after the 404".
- 🤖 Implemented, red → green: limiter `release()` / abortable `acquire()`, the attempt decision, the portal client (real portal + a fake server **only** for transport faults), the queue (claim with fencing token, sibling failure, D6), the worker loop, wiring into `main.ts`, type-aware `no-floating-promises`, and Portal Sol in CI.
- 🔍 **Mutation checks:**
  - queue: removing the head-of-queue check, the fencing, the sibling failure or the lease-expiry condition is each caught. **Removing `SKIP LOCKED` survived** (Postgres waits and re-evaluates, so the result is the same, only later). New test Q11 holds a row lock from outside and requires an immediate claim.
  - worker: too many slots, no permit release, a non-cancellable wait, and **no global pause after a 429** (L4 then sees sends before `Retry-After`) are each caught.
  - D9: removing the settle hold is caught by Q13.
- ⚠️🔍 **Test bugs the AI wrote, caught by failing runs:**
  - L8 measured concurrency as "attempts overlapping a given one", which overstates it; it now uses a sweep line.
  - Q13 assumed a claim order the claim rule does not promise.
  - P1, Q2 and Q12 compared host time with database time.
- ⚠️🔍 **The big one: AC8 (L6) failed intermittently, and it was a real correctness hole, not test flakiness.**
  - A PUT that times out on our side can be applied by the portal **after** the accommodation's next update, leaving the older value. FIFO orders what we send, not what the portal applies.
  - The AI reproduced it outside the tests (1 stale result in 14 timeouts). 👤 The author chose option A: **D9, a settle window** after a timeout.
  - The first test window (3 s) still failed 1 in 5. Diagnostics in L6 showed a late write ≥ 5 s after we gave up; measurement showed abandoned PUTs land later or never (3 of 25). The AI's first estimate ("under 1 s", from 2 samples) was wrong. The test window became 15 s (production 30 s), and 8/8 + repeated full runs pass.
- ⚠️🔍 **The environment fooled the tests twice, and the investigation still found a real bug:**
  - The Mac slept during several runs (`pmset` confirmed), which stalled tests and left the Docker VM clock 52 s behind the host.
  - That exposed that the queue **mixed clocks** (the app computed `next_attempt_at`, Postgres compared it with `now()`). Every queue time is now on the database clock: `rescheduleTask` takes a delay, D6.
  - Long runs now use `caffeinate -i`.
- 🔍 **The portal's documented slowness (> 5 s) finally showed up.** Tests that expect a status now treat a timeout as transient, like a 503.
- ⚠️ **AI process slip:** one commit was made with a failing `npm run check` (formatting only), because the commands were chained with `;` instead of `&&`. Caught on re-reading the output and fixed in a separate commit (`545220e`).
- 🔍 **Review of the block (`deep`): `PROCEED`, conditional on two HIGH fixes.** The reviewer ran `check`, wrote probes, and read the queue and loop closely.
  - ⚠️🔍 **Root risk R1, real:** the D9 hold only delayed tasks already queued when the timed-out task completed. A manager's correction accepted seconds later was claimed at once, so the late write could overwrite it. Our L6 accepted every update before starting the worker, so it could never see this. Fixed by evaluating the hold **at claim time**, and only on **overlapping days** (Q15 reproduces R1; Q16 guards against over-holding).
  - ⚠️🔍 **R2, real:** the worker's idle pause leaked one abort listener per poll. The reviewer measured ~535 B/poll, about 280 MB per idle day. No test runs long enough to notice. Fixed with `timers/promises` (L14 counts the listeners).
  - Also fixed:
    - a 429 race (pause re-checked right before sending, L13);
    - `release()` returning another slot's permit (tokens, R14);
    - an unexpected throw killing the process (L12);
    - the client → worker type dependency.
  - 👤 **Author's decision:** enforce a single active worker (a database advisory lock; others stand by) and seed the limiter from the database on start (WK1, WK2). Two replicas, or a restart, could otherwise exceed the portal's limit.
  - ⚠️ WK1's first version **passed without an implementation**: the first worker drained the queue before the second started. Both now start before any work exists.
  - Deferred to `feature/metrics`: visibility of D9 holds and of head-of-line blocking. Accepted: the shutdown budget (only a lease is held, nothing is lost).
  - The reviewer noted that the portal has a `GET` endpoint, which makes read-back verification (§11) a realistic next step for D9's residual risk.
- ⚠️ One more run was spoiled by the Mac sleeping (idle sleep in dark wake, despite `caffeinate -i`). Runs now use `caffeinate -dims`; unattended runs need power and the lid open.

## Phase 6 — Observability (`feature/metrics`)

- 🤖 Drafted ~25 scenarios (`docs/scenarios/metrics.md`) with 6 questions. 👤 Approved them all: SPEC v7. §7 was rewritten: pending tasks by state, stuck heads, limiter and worker gauges, `max()`/`sum()` across instances, `ops/alerts.yml`.
- 🔍 **Probing the library before trusting it:**
  - prom-client prints an unlabelled gauge **even after `reset()`** (as `0`), so "absent when the DB is down" was impossible with long-lived gauges. The DB-derived gauges now live in a registry built per scrape and merged only on success.
  - ⚠️🔍 The AI's first code comment and scenario M2 claimed that prom-client rejects undocumented label values. It **accepts any value** and only rejects undeclared label names. The red test exposed it, and a probe confirmed it. The values are now enforced at compile time (`recordPortalCall`/`recordRetry` + `@ts-expect-error`); widening the type makes `tsc` fail.
- ⚠️🔍 **Q5 passed against the stub:** the test helper reads a missing metric as `0`, so "`sync_metrics_db_up` is 0" held with nothing published. It was tightened to require the sample itself.
- 🔍 **Q6 added while implementing:** the metrics' `ready` state and `claimTask` implement the same rules in two places and could drift. Q6 checks that they agree; a mutant that ignores D9 holds in the metrics fails it.
- 🔍 **R1 (AC13) cross-checks the metrics against reality:** after a run against the real portal, the calls we count equal the PUTs in the portal's own log, 503s included.
- 🔍 Mutation checks on the instrumentation: the lag on every chunk, uncounted failed siblings and counted replays are each caught (W3, W4, W6).
- ⚠️ Several scripted edits stopped on their own match checks (Prettier reflowed lines, or a regex hit a parenthesis). Nothing was applied silently; each was redone on the real text. The lesson from Phase 3 (assert every replacement) paid off.
- 🔍 **Review of the block (`deep`): `PROCEED`, conditional.** Root risk: **the alerting layer read missing data as healthy.** The reviewer measured the scrape cost with a load script and checked the PromQL against Prometheus semantics.
  - ⚠️🔍 Labelled counters only appeared at their first increment. So `WorkerNotSending` **could never fire after a restart**, and one-shot `increase() > 0` alerts missed the first event (Prometheus does not count a series' first sample). Fixed by initialising every documented label value at 0 (M5). `promtool` test A4b now documents the failure mode.
  - ⚠️🔍 No rule fired when the whole service was absent; `ServiceMetricsAbsent` was added. `WorkerNotSending` would have paged during a legitimate long `Retry-After`; it is now suppressed while the limiter is paused.
  - 👤 The author chose **rule behaviour tests with `promtool`** (pinned Docker image, locally and in a new CI job): A2–A6. Two of them failed against the original rules (A3, A5), so the tests caught real bugs.
  - 🔍 **Scrape cost** (the reviewer's load script, 50k pending / 400k done): 1.3 s → 0.89 s with a partial index → **0.22 s** with a window function for the queue head and a lazily evaluated D9 check. 👤 The author chose a dedicated 3 s timeout plus the last good value with its age (Q7). The Q7 timeout test first used 1 ms, which a tiny query beats; it now blocks the read with a table lock.
  - Also fixed:
    - the D9 predicate is now shared by the claim and the metrics, so they cannot drift;
    - a failing lag lookup no longer throws into the slot loop (W10);
    - stale results and 503s are counted (W9, W11);
    - rejection codes are typed.
  - Accepted: SyncStuck and StuckAccommodation overlap in severity; one extra lag query per completion.

## Phase 7 — End to end (`feature/e2e`)

- 🤖 Drafted the black-box scenarios (`docs/scenarios/e2e.md`: flows E1–E9, load L1/L2) with 5 questions. 👤 Approved them all: SPEC v8 (AC14 load, AC15 lifecycle). Strict black box: assertions only through the service's HTTP API, `/metrics` and the real portal.
- 🔍 **The e2e suite found a real bug on its first run (7 of 8 flows passed).** E3 (`SIGKILL` mid-sync) ended with two days holding the *older* value (`201`, want `301`). Every earlier block had tested the lease expiry from the inside, but never with a process that dies **while its PUT is in flight**.
  - Cause: a dead process stores no outcome, so no `last_timeout_at` is recorded and D9 never holds the overlapping successor. The next process re-claims after the lease, sends `201` and then `301`, and the dead process's original `201` can still land after both, exactly the late write D9 exists for.
  - Fix (`acf4cb4` red, `45af542` green): a re-claim of a lease that expired with no outcome records `last_timeout_at`, so a crash counts as a timeout. Integration test Q17 covers it, the D9 text in SPEC v8 is updated, and E1–E9 then passed twice in a row.
  - Lesson: the internal tests checked each mechanism against what the code *knew*. Only a real process kill showed what the portal could still receive.
- ⚠️🔍 **The load test's first run failed on its own traffic.** After the burst, the test's ten state-read GETs count toward the portal's 30/min and drew a `429`. The "no 429" and "≤30 per 60 s" checks also read a log that included those GETs. The service was not at fault. `portalDays` now obeys `Retry-After`, and L1 and E8 snapshot the log before reading the portal state.
- 🔍 Vitest 5 hides a passing test's `console.log`, so the L2 report never appeared. A probe confirmed it; the report now goes to `process.stdout`.
- 🔍 **Review of the block (`deep`): `PROCEED`.** Root risk: **the e2e suite checks timing-dependent properties with timing-dependent oracles.** The reviewer confirmed that the `claimTask` change is correct under `FOR UPDATE SKIP LOCKED`, fencing and restarts, and that it cannot hold work forever.
  - ✅ It independently found the load-test contamination, which we had already fixed (above).
  - It called out that E3 hits "PUT in flight, then applied late" only by chance. The deterministic gate is Q17, and E3's comment, the scenarios and the PR now say so. 👤 The author decided against several kill cycles: they would still be probabilistic.
  - 👤 Approved, all addressed:
    - the metric is compared with the log only once the portal is quiet;
    - the e2e lease went from 6 s to 12 s (1 s over the 5 s timeout invited re-claims of live attempts);
    - re-claims are visible through `sync_tasks_reclaimed_total` and a warning (W12, SPEC v8 §7), and after `SIGTERM` the next process re-claims nothing (E4);
    - D9's wording now says "a lease that expired with no stored outcome", not "the process died";
    - the e2e CI timeout is 45 minutes;
    - E6 reads `updates_accepted_total` instead of sleeping;
    - E8 requires the standby's counter to exist.
  - Accepted:
    - the settle window stays a heuristic, with read-back verification (§11) as the generic fix; the review sees this block as the best argument for it;
    - the late application of a killed connection's PUT was not measured separately (our timeout also tears the connection down, which is what was measured);
    - the unpinned `:latest` portal image;
    - a rare double `200` in E5.

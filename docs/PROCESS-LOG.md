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

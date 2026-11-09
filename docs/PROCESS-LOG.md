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

# CLAUDE.md

Take-home for Avantio: a service that syncs availability/price updates to the fictional **Portal Sol**.

- **What to build and why:** `SPEC.md` is the source of truth (decisions D1–D8, acceptance criteria AC1–AC13). Read it before changing behaviour.
- **Portal contract:** `API.md`. We have no portal code; treat it as a black box.
- **Background:** `docs/CONTEXTO.md` (probe results, decision analysis).

## Environment

```bash
# Docker Desktop is installed but its CLI is NOT on PATH in Claude's shell:
export PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH
docker compose --profile postgres up -d        # Portal Sol :4000 + Postgres :5432
curl http://localhost:4000/health

# Default Node is 22; the project needs 24:
source ~/.nvm/nvm.sh && nvm use                # reads .nvmrc
```

Commands (run from `service/`):

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the service (`node src/main.ts`, native type stripping, no build). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` / `npm run lint:fix` | ESLint: basic recommended rules plus typescript-eslint, not type-aware. |
| `npm run format` / `npm run format:check` | Prettier (single quotes, width 100, trailing commas). |
| `npm run check` | typecheck + lint + format check + unit tests. **Must pass before every commit.** |
| `npm test` | Unit tests (`test/unit/`). Fast, no Docker needed. |
| `npm run test:integration` | Integration tests (`test/integration/`) against real Portal Sol + Postgres. Slow: the portal rate-limits requests (30 req/min in the `base` variant). |
| `npm run test:e2e` | End-to-end tests (`test/e2e/`): the whole service against the real portal. |

TypeScript is pinned to **5.9.x**: typescript-eslint supports TS < 6.1, so do not upgrade to TS 7.

## Code conventions

- TypeScript strict, ESM. **Erasable syntax only** (Node runs `.ts` directly): no `enum`, no `namespace`, no constructor parameter properties. Use union types and `as const` objects instead.
- Relative imports use the `.ts` extension (`import { x } from './x.ts'`); type-only imports use `import type`.
- Layout (SPEC §3): production code in `src/`, **all tests in `test/`**, never next to the code.
  - `src/domain/{calendar,updates,retry}/` hold pure logic with no I/O; `src/portal/` holds the client and rate limiter; `src/db/` holds the migrations and `repository.ts`; `src/http/`, `src/worker/`, `src/metrics/`.
  - `test/unit/` mirrors `src/` (the test for `src/x/y.ts` is `test/unit/x/y.test.ts`); `test/integration/` and `test/e2e/` hold tests that need services; `test/support/` holds shared helpers.
  - Tests import production code as `#src/...` (a Node subpath import), never with `../../src`. ESLint enforces both directions, and `test/unit/layout.test.ts` fails if a test file sits where no Vitest project would run it.
- **No ORM.** All SQL lives in `db/repository.ts` (SPEC D8). Migrations are numbered `.sql` files in `db/migrations/`.
- Inject time (`now()`) and randomness (jitter) into domain logic so tests are deterministic.
- Configuration only through env vars (SPEC §8), parsed in a single `config.ts`.
- The service must **never** call `/__admin/*`. Those endpoints are for tests only.

## Testing rules

- **TDD for `domain/` and the rate limiter.** Use the `tdd-cycle` skill: failing test, then the minimum implementation, then refactor.
- Each test names the acceptance criterion it covers (`AC3: …`) when it maps to one.
- Integration tests call `POST /__admin/reset` first and assert on `/__admin/requests` and on the portal's final state. Use the `verify-portal` skill for manual checks.
- Never weaken or delete a test just to make it pass. If a test looks wrong, say so and explain why.
- Portal 503s are random (~24 %), so integration tests must tolerate retries. **Never test sync behaviour against a simulated portal.** The only exception: a local throwaway HTTP server for the portal client's transport faults (timeouts, resets, refused connections, non-JSON bodies), which the real portal cannot produce on demand (SPEC §12).

## PR review (one per block of work)

Commits inside a branch only need `npm run check` to pass. When a block of work (a `feature/*` branch) is finished, and **before opening its PR**, launch the **`review` agent** (`.claude/agents/review.md`) over the whole block.

The agent receives **exactly three inputs, and none of our reasoning**:
1. `problem_statement`: the SPEC sections and ACs the block implements, quoted verbatim.
2. `constraints_contract`: external constraints only, taken from `README.md` and `API.md` (Node + TS, PostgreSQL, no lost updates, portal limits, 31-day ranges, idempotent PUT). Never our own design decisions.
3. `implementation_output`: `git diff develop...HEAD`.

Mode: `fast` for tooling or local blocks; `deep` when the block touches a SPEC decision (D1–D8), the data model or the worker's concurrency.

- `STOP_AND_REPLAN` → do not open the PR. Report to the user.
- `PROCEED` → show the user the risks found, and say which ones we address and which we accept, with the reason. Fixes go in new commits on the same branch.
- Once the PR is open, add a comment with the decision, the risks, and what was addressed or accepted, as evidence for the reviewer.

The agent is required to find at least 3 risks, so not every risk is a real problem: the user decides. Record what the review caught (or got wrong) for `PROCESS.md`.

## Git workflow

- Branches: `master` (stable, receives `develop` only at phase close, via PR and with a tag) ← `develop` ← a block branch. **Never commit to `master` or `develop` directly.**
- Block branch prefixes: `feature/<name>` (new behaviour), `refactor/<name>` (structural change with no behaviour change), `docs/<name>` (documentation only).
- Branches so far and planned: `feature/setup`, `feature/core`, `refactor/structure`, `feature/api`, `feature/worker`, `feature/metrics`, `feature/e2e`, `docs/process`.
- **Merged branches are never deleted** (locally or on GitHub): they are part of the visible process.
- Small Conventional Commits (`feat:`, `test:`, `fix:`, `refactor:`, `docs:`, `chore:`), with a scope when useful (`feat(worker): …`). In TDD, the failing test and its implementation may be separate commits.
- Integrate through GitHub PRs into `develop` (`gh pr create --base develop`). CI (`.github/workflows/ci.yml`) runs `npm run check` and, in a second job with a PostgreSQL service, `npm run test:integration` on every PR; both must be green. The user reviews and merges.
- **PR descriptions are detailed** (in English), with these sections:
  1. **Summary**: what the block delivers and why. Link the SPEC sections and ACs it covers.
  2. **What's included**: changes grouped by area, naming the key files.
  3. **Decisions and trade-offs**: choices made inside the block and their alternatives. Any SPEC change and its version.
  4. **Review**: the `review` agent's decision and root risk; what was addressed (with commits), accepted or deferred. The full table also goes as a PR comment.
  5. **Verification**: commands run and results (`npm run check`, CI, integration tests, `verify-portal` checks).
  6. **Out of scope / follow-ups**: what is deliberately left for later blocks.
  7. **How to review**: suggested reading order, and the commit list.

## Documentation rules

- **`SPEC.md` ⇄ `docs/SPEC.es.md` are mirrors.** Every change to one is applied to the other in the same commit, and both changelogs get the new version entry.
- If implementation forces a design change, update the spec (bump its version, explain why) and do not let the code drift silently.
- **`docs/PROCESS-LOG.md`** records, as it happens, what the AI did, what was corrected or discarded, and how we noticed, with commit hashes. Add the entries **in the same PR** as the work they describe. `PROCESS.md` (half a page) is distilled from it at the end.

## Portal Sol facts (measured 2026-11-09, `base` variant)

30 req/min (503s count toward the limit), accurate `Retry-After`, ~24 % 503s, p50 470 ms and max 810 ms (slowness documented but never observed), max 31 days per PUT, extra body fields accepted despite what the docs say. Limits may differ in other variants: keep them configurable and always obey `Retry-After`.

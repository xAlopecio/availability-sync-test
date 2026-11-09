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
| `npm run typecheck` | `tsc --noEmit`. Must pass before every commit. |
| `npm test` | Unit tests (`src/**/*.test.ts`). Fast, no Docker needed. |
| `npm run test:integration` | Integration tests (`test/integration/`) against real Portal Sol + Postgres. Slow: the portal allows 30 req/min. |

## Code conventions

- TypeScript strict, ESM. **Erasable syntax only** (Node runs `.ts` directly): no `enum`, no `namespace`, no constructor parameter properties. Use union types and `as const` objects instead.
- Relative imports use the `.ts` extension (`import { x } from './x.ts'`); type-only imports use `import type`.
- Layout (see SPEC §3): `domain/` holds pure logic with no I/O; `portal/` holds the client and rate limiter; `db/` holds the migrations and `repository.ts`; `worker/`, `http/`, `metrics/`.
- **No ORM.** All SQL lives in `db/repository.ts` (SPEC D8). Migrations are numbered `.sql` files in `db/migrations/`.
- Inject time (`now()`) and randomness (jitter) into domain logic so tests are deterministic.
- Configuration only through env vars (SPEC §8), parsed in a single `config.ts`.
- The service must **never** call `/__admin/*`. Those endpoints are for tests only.

## Testing rules

- **TDD for `domain/` and the rate limiter.** Use the `tdd-cycle` skill: failing test, then the minimum implementation, then refactor.
- Each test names the acceptance criterion it covers (`AC3: …`) when it maps to one.
- Integration tests call `POST /__admin/reset` first and assert on `/__admin/requests` and on the portal's final state. Use the `verify-portal` skill for manual checks.
- Never weaken or delete a test just to make it pass. If a test looks wrong, say so and explain why.
- Portal 503s are random (~24 %), so integration tests must tolerate retries. Do not mock the portal in integration tests.

## Git workflow

- Branches: `master` (stable, receives `develop` only at phase close, via PR and with a tag) ← `develop` ← `feature/<name>` or `docs/<name>`. **Never commit to `master` or `develop` directly.**
- Planned branches: `feature/setup`, `feature/core`, `feature/api`, `feature/worker`, `feature/metrics`, `feature/e2e`, `docs/process`.
- Small Conventional Commits (`feat:`, `test:`, `fix:`, `refactor:`, `docs:`, `chore:`), with a scope when useful (`feat(worker): …`). In TDD, the failing test and its implementation may be separate commits.
- Integrate through GitHub PRs into `develop` (`gh pr create --base develop`). The user reviews and merges.

## Documentation rules

- **`SPEC.md` ⇄ `docs/SPEC.es.md` are mirrors.** Every change to one is applied to the other in the same commit, and both changelogs get the new version entry.
- If implementation forces a design change, update the spec (bump its version, explain why) and do not let the code drift silently.
- Keep notes for `PROCESS.md` as we go: what the AI did, what was corrected, and how we noticed.

## Portal Sol facts (measured 2026-11-09, `base` variant)

30 req/min (503s count toward the limit), accurate `Retry-After`, ~24 % 503s, p50 470 ms and max 810 ms (slowness documented but never observed), max 31 days per PUT, extra body fields accepted despite what the docs say. Limits may differ in other variants: keep them configurable and always obey `Retry-After`.

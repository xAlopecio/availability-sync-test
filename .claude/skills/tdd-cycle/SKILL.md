---
name: tdd-cycle
description: Red-green-refactor loop for this repo. Use when implementing any logic in service/src/domain/ or the rate limiter, or whenever the user asks to "hacer TDD" or to implement an acceptance criterion from SPEC.md test-first.
---

# TDD cycle

Work on a `feature/*` branch, never on `develop` or `master`. Run every command from `service/` with Node 24 (`source ~/.nvm/nvm.sh && nvm use`).

## 1. Scenarios first
- Find the acceptance criteria in `SPEC.md` §9 (and the decision in §4) that the unit covers.
- List the scenarios **before writing code**: happy path, boundaries (month/year change, 1-day and 31/32-day ranges, 0 price…) and every error case. Show the list to the user and wait for their approval before going on: this is where design mistakes are cheapest to catch.

## 2. Red
- Write the tests in `src/<module>/<file>.test.ts`. Name them with the AC they cover, e.g. `it('AC3: splits 32 days into 31 + 1', …)`.
- Run `npm test`. They **must fail, and for the right reason** (missing function or wrong result, not a syntax or import error). If a test passes before any implementation exists, it is testing nothing: fix the test.
- Commit: `test(<scope>): <behaviour> (red)`.

## 3. Green
- Write the **minimum** code to pass. No speculative options and no unrequested features.
- `npm run check` (typecheck, lint, format and unit tests) must pass.
- Run the pre-commit review (`review` agent, see `CLAUDE.md`), then commit: `feat(<scope>): <behaviour>`.

## 4. Refactor
- Improve names, remove duplication and simplify, with `npm run check` still green.
- Commit only if something changed: `refactor(<scope>): …`.

## Rules
- Domain code is pure: inject the clock and randomness, no I/O.
- Never change a test's expectation just to make it pass. If the spec looks wrong, stop and raise it, then update `SPEC.md` and `docs/SPEC.es.md` together.
- Note anything the AI got wrong during the cycle for `PROCESS.md`.

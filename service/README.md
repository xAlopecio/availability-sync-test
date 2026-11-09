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

Through environment variables. Defaults suit the local `docker compose` setup.

| Variable          | Default                                    | Purpose                           |
| ----------------- | ------------------------------------------ | --------------------------------- |
| `PORT`            | `3000`                                     | HTTP port of this service         |
| `PORTAL_BASE_URL` | `http://localhost:4000`                    | Portal Sol URL _(planned)_        |
| `PORTAL_API_KEY`  | `sol-demo-key`                             | Portal Sol API key _(planned)_    |
| `DATABASE_URL`    | `postgres://sync:sync@localhost:5432/sync` | PostgreSQL connection _(planned)_ |

The full list (rate limit, timeouts, worker concurrency, retries) is in SPEC §8.

## Tests and checks

```bash
npm test                    # unit tests: fast, no Docker needed
npm run test:integration    # against the real Portal Sol + PostgreSQL (start them first); slow by design
npm run check               # typecheck + lint + format check + unit tests (also runs in CI on every PR)
```

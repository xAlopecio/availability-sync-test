# Take-home — Availability sync service

Thank you for taking part in Avantio's selection process. This exercise is designed for **3-4 hours of effective work**. You have one week to deliver it, but we neither expect nor reward spending more time than that: we prefer a well-scoped, justified solution over an exhaustive one.

## On using AI

At Avantio we work with coding agents every day (Claude Code, Cursor, Copilot or similar). In this exercise their use is **not just allowed: it is expected**. Work the way you would on a normal day. What we want to evaluate is how you direct the AI, what you decide to delegate and how you validate the result, not whether you can write the code unaided.

## Context

Avantio is a platform for vacation-rental property managers. When a manager changes the availability or price of an accommodation for a set of dates, that change must propagate to the external portals where the accommodation is listed (Booking, Airbnb, etc.).

In this exercise you will work with **a single fictional external portal, "Portal Sol"**, for which we provide a server ready to run with Docker. Like any real portal it has its quirks: it limits the number of requests per minute and sometimes fails or is slow to respond. Its API is documented in [`API.md`](./API.md); **you do not have access to its code**, so treat it as you would a real portal.

## Your task

Build a backend service in **Node.js + TypeScript** that:

1. **Receives availability and price updates** for accommodations through an HTTP API:

   ```
   POST /updates
   {
     "accommodationId": "acc-1003",
     "from": "2026-10-01",
     "to": "2026-10-07",
     "available": true,
     "pricePerNight": 120.00
   }
   ```

2. **Syncs those updates with Portal Sol** through its API (documented in `API.md`), guaranteeing that:
   - **No update is lost**, even if the portal fails or throttles requests.
   - The service **respects the portal's limits** and does not overwhelm it.
   - The final state in the portal reflects what the manager asked for.

3. **Exposes the sync status** of an accommodation:

   ```
   GET /accommodations/:id/sync-status
   ```

   What information to return and in which shape is your decision; justify it in the spec.

4. **Persists its state in a real database**, PostgreSQL or MongoDB (pick one; both are provided in `docker-compose.yml`), so that **no accepted update is lost if the service restarts**. How you model pending work, retries and status is a design decision; justify it in the spec.

5. **Is observable**: structured logs and a metrics endpoint (Prometheus text format or equivalent) that would let someone on call tell whether synchronisation is healthy without reading the code. Cover at least the pending work, the outcome of portal calls and their latency, and retries. In the spec, say which alerts you would set on those metrics.

### What we do not ask for

- Dashboards or an alerting stack: exposing the metrics is enough. You do not need Grafana or Prometheus running.
- Authentication for the service, deployment or a user interface.
- 100% test coverage: we prefer a few tests that check what matters over many that check nothing.

## Deliverables

All three are mandatory and weigh as much as the code in the evaluation:

1. **`SPEC.md`** — Written **before you start coding** and committed as the first commit. It describes what you are going to build, the main design decisions and the acceptance criteria. You may update it during the exercise, but we want to see the starting point in the history.

2. **Code** with tests, in the `service/` folder of this same repository, with a commit history (not a single final commit).

3. **`PROCESS.md`** — Half a page is enough. Tell us:
   - What you delegated to the AI and what you did by hand, and why.
   - Where the AI got it wrong or proposed something you discarded, and how you noticed.
   - What you left out for lack of time and what you would do next.

## Getting started

You need Docker (or Docker Desktop) and Node.js 24 or later.

```bash
# 1. Create your repository from this template ("Use this template" on GitHub) and clone it.

# 2. Start Portal Sol and the database you choose (one profile or the other)
docker compose --profile postgres up -d    # Portal Sol + PostgreSQL 18 on localhost:5432
docker compose --profile mongo up -d       # Portal Sol + MongoDB 8 on localhost:27017
curl http://localhost:4000/health          # → {"status":"ok",...}

#    Connection strings (see docker-compose.yml):
#    postgres://sync:sync@localhost:5432/sync
#    mongodb://localhost:27017/sync

# 3. Read API.md and write SPEC.md. Make your first commit.

# 4. Build your service in the service/ folder
#    (free structure; include instructions to start it and run the tests)
```

Portal Sol exposes two admin endpoints that will help you verify your implementation:
`GET /__admin/requests` returns the log of every request it has received (including rejected ones)
and `POST /__admin/reset` puts everything back to the initial state. They are described in `API.md`.

The portal keeps its state in memory: if you restart the container it goes back to the initial data.

## What we evaluate

| Dimension | What we look at |
|---|---|
| Specification | Clarity, acceptance criteria, justified decisions |
| Code quality | Design, tests with real value, maintainability; persistence and observability that actually work |
| Use of AI | Concrete and honest process notes; consistency with the commit history |
| Technical judgement | Reasoned trade-offs, bounded scope, what you left out and why |

## Submission

When you are done, share the repository (public or with access for the user we indicate) by replying to the process email. In the next phase we will go through your solution with you and extend it together, live.

Good luck!

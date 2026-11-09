---
name: verify-portal
description: Verify the sync service's real effect on Portal Sol. Reset the portal, run a scenario, then inspect the portal's request log and the final day-by-day state. Use to validate any sync, retry or rate-limit behaviour, or when the user asks to check what reached the portal.
---

# Verify against Portal Sol

The point is to **never trust the service's own view**: check what the portal received and what it holds now.
The admin endpoints are for verification only. The service code must never call them.

## Prerequisites
```bash
export PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH
docker compose --profile postgres up -d && curl -s http://localhost:4000/health
source ~/.nvm/nvm.sh && nvm use
```

## Helper
`node .claude/skills/verify-portal/portal.mjs <command>` (run from the repo root):

| Command | Effect |
|---|---|
| `reset` | `POST /__admin/reset`: initial data, empty log, rate-limit counter reset. |
| `log [accId]` | Summary of `/__admin/requests`: counts by status, and per request the time, method, path, body, status, duration and time since the last 429. The portal log does not record `Retry-After`, so compare against the `Retry-After` values in the service logs. |
| `state <accId> <from> <to>` | Day-by-day state in the portal. Costs **one rate-limited request**. |

## Procedure
1. `reset`.
2. Run the scenario (e.g. `curl -X POST localhost:3000/updates …`) and wait until `GET /accommodations/:id/sync-status` reports `synced` (or `failed`).
3. `log`: check the order of PUTs per accommodation, that there is never more than one in flight per accommodation, the 429/`Retry-After` behaviour, and the absence of unexpected 4xx.
4. `state`: check that every day equals the **last accepted update covering it**.
5. Report what you expected, what you observed and any discrepancy. Do not explain a discrepancy away.

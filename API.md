# Portal Sol — API documentation

Portal Sol is a (fictional) vacation-rental portal. This API lets a channel manager publish the
availability and nightly price of the accommodations it has listed on the portal.

> This document is the **complete contract** of the portal. You do not have access to the server code:
> work only with what is described here and with the observable behaviour.

## Getting started

The portal is distributed as a Docker image:

```bash
docker run --rm -p 4000:4000 ghcr.io/avantio/portal-sol:latest
```

Base URL: `http://localhost:4000`. Check that it is up with `GET /health`.

The portal keeps its state in memory: restarting the container brings back the initial data.

## Authentication

Every route under `/api/` requires the `X-Api-Key` header.

```
X-Api-Key: sol-demo-key
```

Without the header, or with a wrong key, the portal answers `401 UNAUTHORIZED`.

## Conventions

- Request and response bodies are JSON (`Content-Type: application/json`).
- Dates are **calendar days** in `YYYY-MM-DD` format, with no time or time zone.
- Date ranges are **inclusive** at both ends: `from: 2026-10-01, to: 2026-10-07` covers 7 nights.
- `pricePerNight` is a decimal number (EUR per night), greater than or equal to 0.
- Errors always have this shape:

  ```json
  { "error": { "code": "RANGE_TOO_LARGE", "message": "Date range covers 32 days; ..." } }
  ```

## Limits and portal behaviour

Like any real portal, Portal Sol has its quirks. Keep them in mind when designing your integration:

| Situation | Portal response | What is expected from your integration |
|---|---|---|
| You exceed the allowed number of requests per minute | `429 RATE_LIMITED` with a `Retry-After: <seconds>` header | Do not retry before that many seconds have passed. Rejected requests are not processed. |
| The portal cannot handle the request right now | `503 UNAVAILABLE` | The request has **not** been applied. It can be retried later. |
| The portal is slow to answer | No response for a while | Configure a reasonable timeout. **A request that times out on your side may still have been processed by the portal.** |
| Date range too long | `400 RANGE_TOO_LARGE` | Each request may cover at most **31 days** (`from` and `to` inclusive). Longer ranges must be split into several requests. |

`PUT` requests are **idempotent**: repeating exactly the same request leaves the portal in the same state.

## Endpoints

### `GET /api/v1/accommodations`

Lists the accommodations published on the portal.

```json
{
  "accommodations": [
    { "id": "acc-1001", "name": "Apartamento Sol y Mar" },
    { "id": "acc-1002", "name": "Casa Rural Los Olivos" }
  ]
}
```

### `GET /api/v1/accommodations/:id`

Current day-by-day state of an accommodation. Accepts the optional `from` and `to` query parameters
(`YYYY-MM-DD`, inclusive) to narrow the result.

```
GET /api/v1/accommodations/acc-1003?from=2026-10-01&to=2026-10-03
```

```json
{
  "id": "acc-1003",
  "name": "Ático Centro Histórico",
  "days": [
    { "date": "2026-10-01", "available": true,  "pricePerNight": 120 },
    { "date": "2026-10-02", "available": true,  "pricePerNight": 140 },
    { "date": "2026-10-03", "available": false, "pricePerNight": 140 }
  ]
}
```

Errors: `404 NOT_FOUND` if the accommodation does not exist; `400 INVALID_DATE` if `from`/`to` are not valid dates.

### `PUT /api/v1/accommodations/:id/availability`

Sets availability and price for every day in the given range.

Body:

```json
{
  "from": "2026-10-01",
  "to": "2026-10-07",
  "available": false,
  "pricePerNight": 120.0
}
```

| Field | Type | Rules |
|---|---|---|
| `from` | string `YYYY-MM-DD` | Required. Valid date. |
| `to` | string `YYYY-MM-DD` | Required. Same day as `from` or later. **At most 31 days** counting both ends. |
| `available` | boolean | Required. |
| `pricePerNight` | number | Required. `>= 0`. |

`200` response:

```json
{ "accommodationId": "acc-1003", "from": "2026-10-01", "to": "2026-10-07", "daysUpdated": 7 }
```

Errors: `400 INVALID_BODY`, `400 INVALID_DATE`, `400 RANGE_TOO_LARGE`, `404 NOT_FOUND`, plus the
`401`, `429` and `503` described above.

### `GET /health`

No authentication. Answers `200 { "status": "ok", ... }` when the portal is ready to receive requests.

## Admin endpoints

These endpoints are **not part of a real portal API**: they exist so you can verify your implementation
(manually or from your tests). They require no `X-Api-Key`, do not count towards the request limit, and
your sync service should not depend on them during normal operation.

### `GET /__admin/requests`

Log of every request received under `/api/` (including those rejected with `401`, `429` or `503`), in
arrival order. The last 1000 entries are kept.

```json
{
  "count": 2,
  "requests": [
    {
      "id": 1,
      "timestamp": "2026-09-02T10:15:30.123Z",
      "method": "PUT",
      "path": "/api/v1/accommodations/acc-1003/availability",
      "body": { "from": "2026-10-01", "to": "2026-10-07", "available": false, "pricePerNight": 120 },
      "status": 200,
      "durationMs": 412
    },
    {
      "id": 2,
      "timestamp": "2026-09-02T10:15:31.001Z",
      "method": "GET",
      "path": "/api/v1/accommodations/acc-1003",
      "body": null,
      "status": 429,
      "durationMs": 2
    }
  ]
}
```

If the client closed the connection before receiving a response, the entry has `"status": null` and
`"clientDisconnected": true`. That does not mean the request was not applied.

### `POST /__admin/reset`

Restores the initial data of every accommodation, empties the request log and resets the per-minute
counter. Answers `200 { "ok": true }`. Handy at the start of each test.

## Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_BODY` | The body is not valid JSON, a field is missing or unexpected, or has the wrong type. |
| 400 | `INVALID_DATE` | Malformed or non-existent date (e.g. `2026-02-30`), or `to` earlier than `from`. |
| 400 | `RANGE_TOO_LARGE` | The range covers more than 31 days. |
| 401 | `UNAUTHORIZED` | Missing `X-Api-Key` header or invalid key. |
| 404 | `NOT_FOUND` | The accommodation (or the route) does not exist. |
| 429 | `RATE_LIMITED` | Requests-per-minute limit exceeded. Check `Retry-After`. |
| 503 | `UNAVAILABLE` | The portal cannot handle the request right now. Nothing was applied. |

## Available accommodations

The portal starts with these 10 accommodations, each with 90 days of availability from the current
date. You can list them with `GET /api/v1/accommodations`.

| id | Name |
|---|---|
| `acc-1001` | Apartamento Sol y Mar |
| `acc-1002` | Casa Rural Los Olivos |
| `acc-1003` | Ático Centro Histórico |
| `acc-1004` | Villa Las Dunas |
| `acc-1005` | Estudio Playa Norte |
| `acc-1006` | Chalet Sierra Blanca |
| `acc-1007` | Loft Puerto Viejo |
| `acc-1008` | Cortijo El Almendral |
| `acc-1009` | Piso Familiar Ensanche |
| `acc-1010` | Cabaña Lago Azul |

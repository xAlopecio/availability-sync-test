import { describe, expect, it } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { buildApp } from '#src/http/app.ts';
import { createMetrics, type Metrics } from '#src/metrics/registry.ts';
import type { PortalClient } from '#src/portal/client.ts';
import { SlidingWindowRateLimiter } from '#src/portal/rate-limiter.ts';
import type { ObservedCall } from '#src/worker/decide.ts';
import { parseExposition, valueOf } from '../../support/exposition.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';
import { portalDay } from '../../support/portal.ts';
import {
  acceptAll,
  allSettled,
  captureLog,
  testWorker,
  waitUntil,
  type Change,
} from '../../support/worker-harness.ts';

const db = useMigratedDatabase();
const samplesOf = async (m: Metrics) => parseExposition(await m.registry.metrics()).samples;
const scripted = (responses: ObservedCall[]) => {
  let calls = 0;
  const client: PortalClient = {
    async putAvailability() {
      calls++;
      return responses.shift() ?? { kind: 'response', status: 200 };
    },
  };
  return { client, calls: () => calls };
};
const oneDay = (accommodationId: string, offset: number): Change => ({
  accommodationId,
  from: portalDay(offset),
  to: portalDay(offset),
  available: true,
  pricePerNight: 100 + offset,
});
const run = async (
  m: Metrics,
  client: PortalClient,
  extra: Parameters<typeof testWorker>[1] = {},
) => {
  const { worker } = testWorker(db.pool(), {
    client,
    metrics: m,
    concurrency: 1,
    random: () => 0,
    ...extra,
  });
  worker.start();
  try {
    await waitUntil(allSettled(db.pool()), 20_000, 'all tasks settled');
  } finally {
    await worker.stop();
  }
};

describe('worker instrumentation', () => {
  it('W1 + W2 / AC13: every portal call is counted by outcome with its latency; retries by reason', async () => {
    await acceptAll(
      db.pool(),
      ['acc-1001', 'acc-1002', 'acc-1003', 'acc-1004', 'acc-1005'].map((a, i) => oneDay(a, i)),
    );
    const m = createMetrics();
    const { client } = scripted([
      { kind: 'response', status: 503, portalError: { code: 'UNAVAILABLE', message: 'later' } },
      { kind: 'response', status: 200 },
      {
        kind: 'response',
        status: 429,
        retryAfter: '1',
        portalError: { code: 'RATE_LIMITED', message: 'slow down' },
      },
      { kind: 'timeout' },
      {
        kind: 'response',
        status: 404,
        portalError: { code: 'NOT_FOUND', message: 'no such accommodation' },
      },
    ]);
    await run(m, client);
    const s = await samplesOf(m);
    const calls = (outcome: string) => valueOf(s, 'portal_requests_total', { outcome });
    expect({
      success: calls('success'),
      unavailable: calls('unavailable'),
      rate_limited: calls('rate_limited'),
      timeout: calls('timeout'),
      client_error: calls('client_error'),
    }).toEqual({ success: 4, unavailable: 1, rate_limited: 1, timeout: 1, client_error: 1 });
    expect(valueOf(s, 'portal_request_duration_seconds_count')).toBe(8);
    const retries = (reason: string) => valueOf(s, 'sync_retries_total', { reason });
    expect([retries('unavailable'), retries('rate_limited'), retries('timeout')]).toEqual([
      1, 1, 1,
    ]);
    expect(valueOf(s, 'sync_retries_total')).toBe(3); // none for the success or the 404
  });

  it('W3 / AC13: a permanent failure counts the task and its failed siblings; successes count once', async () => {
    await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1001',
        from: portalDay(0),
        to: portalDay(89),
        available: true,
        pricePerNight: 1,
      }, // 3 chunks
      oneDay('acc-1002', 1),
    ]);
    const m = createMetrics();
    const { client } = scripted([
      { kind: 'response', status: 404, portalError: { code: 'NOT_FOUND', message: 'x' } },
    ]);
    await run(m, client);
    const s = await samplesOf(m);
    expect(valueOf(s, 'sync_tasks_finished_total', { result: 'failed' })).toBe(3);
    expect(valueOf(s, 'sync_tasks_finished_total', { result: 'done' })).toBe(1);
  });

  it('W4 / AC13: the update lag is observed once, when the last chunk is done, from accepted_at', async () => {
    const [updateId] = await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1001',
        from: portalDay(0),
        to: portalDay(40),
        available: true,
        pricePerNight: 1,
      }, // 2 chunks
    ]);
    await db
      .pool()
      .query("UPDATE updates SET accepted_at = now() - interval '100 seconds' WHERE id = $1", [
        updateId,
      ]);
    const m = createMetrics();
    await run(m, scripted([]).client);
    const s = await samplesOf(m);
    expect(valueOf(s, 'sync_update_lag_seconds_count')).toBe(1);
    const lag = valueOf(s, 'sync_update_lag_seconds_sum');
    expect(lag).toBeGreaterThanOrEqual(100);
    expect(lag).toBeLessThan(115);
  });

  it('W5: a send deferred by the pause is not a portal call', async () => {
    await acceptAll(db.pool(), [oneDay('acc-1001', 1)]);
    const m = createMetrics();
    const limiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    let paused = false;
    const { client, calls } = scripted([]);
    const { worker } = testWorker(db.pool(), {
      client,
      metrics: m,
      limiter,
      concurrency: 1,
      onClaimed: () => {
        if (!paused) {
          paused = true;
          limiter.pauseFor(60_000);
        }
      },
    });
    worker.start();
    await waitUntil(
      async () => valueOf(await samplesOf(m), 'sync_sends_deferred_total') === 1,
      5_000,
      'a deferred send',
    );
    await worker.stop();
    expect(calls()).toBe(0);
    expect(valueOf(await samplesOf(m), 'portal_requests_total')).toBe(0);
  });
});

describe('instrumentation edge cases', () => {
  it('W9: a stale result (lease lost while in flight) is counted, and not as a retry or a finished task', async () => {
    await acceptAll(db.pool(), [oneDay('acc-1001', 1)]);
    const m = createMetrics();
    let raced = false;
    const client: PortalClient = {
      async putAvailability() {
        if (!raced) {
          raced = true;
          // Another worker re-claimed the task meanwhile: our fencing token is now stale.
          await db.pool().query('UPDATE sync_tasks SET attempts = attempts + 1');
        }
        return { kind: 'response', status: 200 };
      },
    };
    const { worker } = testWorker(db.pool(), { client, metrics: m, concurrency: 1, leaseMs: 500 });
    worker.start();
    await waitUntil(
      async () => valueOf(await samplesOf(m), 'sync_stale_results_total') === 1,
      10_000,
      'a stale result',
    );
    await worker.stop();
    const s = await samplesOf(m);
    expect(valueOf(s, 'sync_tasks_finished_total', { result: 'done' })).toBeLessThanOrEqual(1); // the re-claim may finish it
    expect(valueOf(s, 'sync_retries_total')).toBe(0);
  });

  it('W10: if the lag lookup fails after a completion, the attempt is still logged as a success', async () => {
    await acceptAll(db.pool(), [oneDay('acc-1001', 1)]);
    const m = createMetrics();
    const log = captureLog();
    const client: PortalClient = {
      async putAvailability() {
        // The completion only touches sync_tasks; the lag lookup joins updates, so this breaks it.
        await db.pool().query('ALTER TABLE updates RENAME TO updates_hidden');
        return { kind: 'response', status: 200 };
      },
    };
    const { worker } = testWorker(db.pool(), { client, metrics: m, log, concurrency: 1 });
    try {
      worker.start();
      await waitUntil(
        async () => log.entries.some((e) => /succeeded|unexpected/.test(e.msg)),
        10_000,
        'an attempt log',
      );
      await worker.stop();
    } finally {
      await db.pool().query('ALTER TABLE IF EXISTS updates_hidden RENAME TO updates');
    }
    expect(log.entries.some((e) => e.msg === 'portal attempt succeeded')).toBe(true);
    expect(log.entries.some((e) => /unexpected error in a worker slot/.test(e.msg))).toBe(false);
  });

  it('W12 / D9: re-claiming a lease that expired with no outcome is counted and logged as a warning', async () => {
    await acceptAll(db.pool(), [oneDay('acc-1001', 1)]);
    // A process claimed the task and died mid-request: attempts and the lease, but no outcome.
    await db
      .pool()
      .query(
        "UPDATE sync_tasks SET attempts = 1, last_attempt_at = now(), locked_until = now() - interval '1 second'",
      );
    const m = createMetrics();
    const log = captureLog();
    const { worker } = testWorker(db.pool(), {
      client: scripted([]).client,
      metrics: m,
      log,
      concurrency: 1,
    });
    worker.start();
    await waitUntil(
      async () =>
        valueOf(await samplesOf(m), 'sync_tasks_finished_total', { result: 'done' }) === 1,
      10_000,
      'the re-claimed task finishes',
    );
    await worker.stop();
    expect(valueOf(await samplesOf(m), 'sync_tasks_reclaimed_total')).toBe(1);
    const warning = log.entries.find((e) => /re-claimed/.test(e.msg));
    expect(warning?.level).toBe('warn');
    expect(warning?.obj).toMatchObject({ updateId: expect.any(Number), attempt: 2 });
  });
});

describe('API and gauges instrumentation', () => {
  const post = (
    app: ReturnType<typeof buildApp>,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/updates',
      headers: { 'content-type': 'application/json', ...headers },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  const readme = {
    accommodationId: 'acc-1003',
    from: '2026-12-01',
    to: '2026-12-07',
    available: true,
    pricePerNight: 120,
  };

  it('W6 / AC13: accepted updates count once (not replays); rejections by code', async () => {
    const m = createMetrics();
    const app = buildApp({ pool: db.pool(), maxUpdateRangeDays: 366, logger: false, metrics: m });
    try {
      await post(app, readme, { 'idempotency-key': 'k-1' });
      await post(app, readme, { 'idempotency-key': 'k-1' }); // replay
      await post(app, { ...readme, from: '2026-02-30' });
      await post(app, JSON.stringify(readme), { 'content-type': 'text/plain' });
      const s = await samplesOf(m);
      expect(valueOf(s, 'updates_accepted_total')).toBe(1);
      expect(valueOf(s, 'updates_rejected_total', { code: 'INVALID_DATE' })).toBe(1);
      expect(valueOf(s, 'updates_rejected_total', { code: 'UNSUPPORTED_MEDIA_TYPE' })).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('W7 + W8: /metrics reports the limiter state and whether this instance runs the worker', async () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    limiter.tryAcquire(performance.now());
    limiter.tryAcquire(performance.now());
    limiter.pauseFor(5_000);
    let state: 'active' | 'standby' = 'active';
    const app = buildApp({
      pool: db.pool(),
      maxUpdateRangeDays: 366,
      logger: false,
      limiter,
      workerState: () => state,
    });
    try {
      let s = parseExposition((await app.inject({ method: 'GET', url: '/metrics' })).body).samples;
      expect(valueOf(s, 'portal_rate_limiter_window_starts')).toBe(2);
      expect(valueOf(s, 'portal_rate_limiter_paused_seconds')).toBeGreaterThan(4);
      expect(valueOf(s, 'sync_worker_active')).toBe(1);
      state = 'standby';
      s = parseExposition((await app.inject({ method: 'GET', url: '/metrics' })).body).samples;
      expect(valueOf(s, 'sync_worker_active')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('W11: POST /updates with the database down counts an UNAVAILABLE rejection', async () => {
    const m = createMetrics();
    const pool = createPool('postgres://sync:sync@127.0.0.1:1/nowhere', { max: 1 });
    const dead = buildApp({ pool, maxUpdateRangeDays: 366, logger: false, metrics: m });
    try {
      expect((await post(dead, readme)).statusCode).toBe(503);
      expect(valueOf(await samplesOf(m), 'updates_rejected_total', { code: 'UNAVAILABLE' })).toBe(
        1,
      );
    } finally {
      await dead.close();
      await pool.end();
    }
  });
});

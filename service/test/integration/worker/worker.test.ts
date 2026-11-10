import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortalClient } from '#src/portal/client.ts';
import { SlidingWindowRateLimiter } from '#src/portal/rate-limiter.ts';
import type { ObservedCall } from '#src/worker/decide.ts';
import type { Worker } from '#src/worker/worker.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';
import {
  portalDay,
  portalDays,
  portalRequests,
  resetPortal,
  waitForPortalQuiet,
} from '../../support/portal.ts';
import {
  acceptAll,
  allSettled,
  captureLog,
  expectedDays,
  testWorker,
  waitUntil,
  type Change,
} from '../../support/worker-harness.ts';

const db = useMigratedDatabase();
let running: Worker[] = [];
const track = <T extends { worker: Worker }>(h: T) => {
  running.push(h.worker);
  return h;
};
beforeEach(async () => {
  await resetPortal();
});
afterEach(async () => {
  await Promise.all(running.map((w) => w.stop()));
  running = [];
  await waitForPortalQuiet(); // late requests of this test must not leak into the next one
});

const statuses = async () =>
  (
    await db
      .pool()
      .query('SELECT status, count(*)::int AS n FROM sync_tasks GROUP BY status ORDER BY status')
  ).rows;
const assertPortalMatches = async (changes: Change[], accommodationId: string) => {
  const expected = expectedDays(changes, accommodationId);
  const dates = [...expected.keys()].sort();
  const actual = await portalDays(accommodationId, dates[0]!, dates.at(-1)!);
  for (const day of actual) {
    if (expected.has(day.date)) {
      expect({
        date: day.date,
        available: day.available,
        pricePerNight: day.pricePerNight,
      }).toEqual({
        date: day.date,
        ...expected.get(day.date),
      });
    }
  }
  expect(actual.filter((d) => expected.has(d.date))).toHaveLength(expected.size);
};

describe('worker against the real Portal Sol', () => {
  it('L1 / AC4 + L2 / AC5: overlapping updates end correct per day; successful PUTs in acceptance order, never overlapping', async () => {
    const changes: Change[] = [
      {
        accommodationId: 'acc-1003',
        from: portalDay(0),
        to: portalDay(89),
        available: true,
        pricePerNight: 100,
      }, // 3 chunks
      {
        accommodationId: 'acc-1003',
        from: portalDay(10),
        to: portalDay(16),
        available: false,
        pricePerNight: 150,
      },
      {
        accommodationId: 'acc-1003',
        from: portalDay(12),
        to: portalDay(13),
        available: true,
        pricePerNight: 170,
      },
    ];
    await acceptAll(db.pool(), changes);
    const taskOrder = (
      await db.pool().query('SELECT date_from, date_to FROM sync_tasks ORDER BY id')
    ).rows;
    const { worker } = track(testWorker(db.pool()));
    worker.start();
    await waitUntil(allSettled(db.pool()), 150_000, 'all tasks settled');
    expect(await statuses()).toEqual([{ status: 'done', n: 5 }]);

    // AC4: every day equals the last accepted update covering it.
    await assertPortalMatches(changes, 'acc-1003');

    // AC5: the successful PUTs arrived in acceptance (task id) order…
    const puts = (await portalRequests()).filter(
      (r) => r.method === 'PUT' && r.path.includes('/acc-1003/'),
    );
    const ok = puts
      .filter((r) => r.status === 200)
      .map((r) => ({ date_from: r.body!['from'], date_to: r.body!['to'] }));
    expect(ok).toEqual(taskOrder);
    // …and no two PUTs for the accommodation overlapped in time.
    for (let i = 1; i < puts.length; i++) {
      const prevEnd = Date.parse(puts[i - 1]!.timestamp) + (puts[i - 1]!.durationMs ?? 0);
      expect(Date.parse(puts[i]!.timestamp)).toBeGreaterThanOrEqual(prevEnd - 5); // 5 ms clock slack
    }
  });

  it('L3 / AC6: with the default limit (25/min) the portal never answers 429', async () => {
    const changes: Change[] = Array.from({ length: 30 }, (_, i) => ({
      accommodationId: `acc-100${(i % 5) + 1}`,
      from: portalDay(i),
      to: portalDay(i),
      available: i % 2 === 0,
      pricePerNight: 100 + i,
    }));
    await acceptAll(db.pool(), changes);
    const { worker } = track(testWorker(db.pool()));
    worker.start();
    await waitUntil(allSettled(db.pool()), 240_000, 'all tasks settled');
    const answered = await portalRequests();
    // On failure, show what the portal had received in the 60 s before each 429.
    const diagnostics = answered
      .filter((r) => r.status === 429)
      .map((r) => {
        const at = Date.parse(r.timestamp);
        const window = answered.filter(
          (o) => Date.parse(o.timestamp) > at - 60_000 && Date.parse(o.timestamp) < at,
        );
        return {
          id: r.id,
          at: r.timestamp,
          requestsInPrevious60s: window.length,
          firstOfRun: answered[0]?.timestamp,
          statusesInWindow: window.map((o) => o.status).join(','),
        };
      });
    expect(diagnostics).toEqual([]);
    expect(await statuses()).toEqual([{ status: 'done', n: 30 }]);
  });

  it('L4 / AC6: above the portal limit, 429s happen and nothing is sent before Retry-After elapses', async () => {
    const changes: Change[] = Array.from({ length: 36 }, (_, i) => ({
      accommodationId: `acc-100${(i % 6) + 1}`,
      from: portalDay(i),
      to: portalDay(i),
      available: true,
      pricePerNight: 200 + i,
    }));
    await acceptAll(db.pool(), changes);
    const { worker, records } = track(testWorker(db.pool(), { maxRequestsPerMinute: 60 }));
    worker.start();
    await waitUntil(allSettled(db.pool()), 300_000, 'all tasks settled');

    const limited = records.filter((r) => r.action.outcome === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0); // the scenario really provoked the portal
    for (const r of limited) {
      const retryAfterMs = Number((r.call as { retryAfter?: string }).retryAfter) * 1000;
      const sentTooEarly = records.filter(
        (o) => o.startedAt > r.endedAt && o.startedAt < r.endedAt + retryAfterMs,
      );
      expect(sentTooEarly.map((o) => o.startedAt - r.endedAt)).toEqual([]);
    }
    expect(await statuses()).toEqual([{ status: 'done', n: 36 }]);
  });

  it('L5 / AC7: a worker stopped mid-way and a crashed lease are both completed by a new worker', async () => {
    const changes: Change[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        accommodationId: 'acc-1001',
        from: portalDay(i * 3),
        to: portalDay(i * 3 + 5),
        available: i % 2 === 0,
        pricePerNight: 110 + i,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        accommodationId: 'acc-1002',
        from: portalDay(i * 3),
        to: portalDay(i * 3 + 5),
        available: i % 2 === 1,
        pricePerNight: 120 + i,
      })),
    ];
    await acceptAll(db.pool(), changes);
    const first = testWorker(db.pool(), { concurrency: 1 });
    first.worker.start();
    await waitUntil(
      async () => first.records.some((r) => r.action.type === 'complete'),
      60_000,
      'one completed attempt',
    );
    await first.worker.stop();

    // A worker that "crashed" holding a lease on acc-1002's head.
    const crashed = (
      await db.pool().query(
        `UPDATE sync_tasks SET locked_until = now() + interval '2 seconds', attempts = attempts + 1, last_attempt_at = now()
          WHERE id = (SELECT min(id) FROM sync_tasks WHERE status = 'pending' AND accommodation_id = 'acc-1002')
          RETURNING id`,
      )
    ).rows[0].id as number;

    const second = track(testWorker(db.pool()));
    second.worker.start();
    await waitUntil(allSettled(db.pool()), 180_000, 'all tasks settled');
    expect(await statuses()).toEqual([{ status: 'done', n: 8 }]);
    const row = (await db.pool().query('SELECT attempts FROM sync_tasks WHERE id = $1', [crashed]))
      .rows[0];
    expect(row.attempts).toBeGreaterThanOrEqual(2); // re-claimed after the lease expired
    await assertPortalMatches(changes, 'acc-1001');
    await assertPortalMatches(changes, 'acc-1002');
  });

  it('L6 / AC8: with a timeout near the median latency, overlapping updates still converge', async () => {
    const changes: Change[] = Array.from({ length: 6 }, (_, i) => ({
      accommodationId: 'acc-1004',
      from: portalDay(i),
      to: portalDay(i + 6),
      available: i % 2 === 0,
      pricePerNight: 300 + i,
    }));
    await acceptAll(db.pool(), changes);
    // D9 window shorter than production (30 s) but above the measured late-application delay
    // (≥ 5 s seen): 3 s was too short and let a late write through (diagnosed run).
    const { worker, records } = track(
      testWorker(db.pool(), { timeoutMs: 400, timeoutSettleMs: 15_000 }),
    );
    worker.start();
    await waitUntil(allSettled(db.pool()), 240_000, 'all tasks settled');
    expect(records.filter((r) => r.action.outcome === 'timeout').length).toBeGreaterThan(0); // timeouts happened
    expect(await statuses()).toEqual([{ status: 'done', n: 6 }]);
    try {
      await assertPortalMatches(changes, 'acc-1004');
    } catch (error) {
      // Diagnostics for an intermittent failure: what the portal received vs what the worker did.
      const puts = (await portalRequests()).filter((r) => r.method === 'PUT');
      console.error(
        'L6 portal log:\n' +
          puts
            .map(
              (r) =>
                `${r.id} ${r.timestamp} price=${r.body?.['pricePerNight']} status=${r.status} server=${r.durationMs}ms${r.clientDisconnected ? ' DISCONNECTED' : ''}`,
            )
            .join('\n'),
      );
      console.error(
        'L6 worker attempts:\n' +
          records
            .map(
              (r) =>
                `${new Date(r.startedAt).toISOString()} → +${r.endedAt - r.startedAt}ms price=${r.task.pricePerNight} task=${r.task.taskId}#${r.task.attempt} ${r.action.outcome}`,
            )
            .join('\n'),
      );
      const settle = (
        await db
          .pool()
          .query('SELECT id, last_timeout_at, completed_at FROM sync_tasks ORDER BY id')
      ).rows;
      console.error(
        'L6 tasks:\n' +
          settle
            .map(
              (t) =>
                `${t.id} timeout=${t.last_timeout_at?.toISOString()} done=${t.completed_at?.toISOString()}`,
            )
            .join('\n'),
      );
      throw error;
    }
  });

  it('L7 / AC9: an unknown accommodation fails on its 404, is never retried after it, and blocks nothing', async () => {
    const changes: Change[] = [
      {
        accommodationId: 'acc-1001',
        from: portalDay(1),
        to: portalDay(2),
        available: false,
        pricePerNight: 401,
      },
      {
        accommodationId: 'acc-9999',
        from: portalDay(1),
        to: portalDay(40),
        available: false,
        pricePerNight: 402,
      }, // 2 chunks
      {
        accommodationId: 'acc-1002',
        from: portalDay(1),
        to: portalDay(2),
        available: false,
        pricePerNight: 403,
      },
      {
        accommodationId: 'acc-9999',
        from: portalDay(3),
        to: portalDay(4),
        available: true,
        pricePerNight: 404,
      },
    ];
    const [, missing1, , missing2] = await acceptAll(db.pool(), changes);
    const { worker } = track(testWorker(db.pool()));
    worker.start();
    await waitUntil(allSettled(db.pool()), 120_000, 'all tasks settled');

    const tasks = (
      await db.pool().query('SELECT update_id, status, last_error FROM sync_tasks ORDER BY id')
    ).rows;
    for (const t of tasks.filter((t) => t.update_id === missing1 || t.update_id === missing2)) {
      expect(t.status).toBe('failed');
      expect(t.last_error).toMatch(/^404 NOT_FOUND/);
    }
    expect(tasks.filter((t) => t.status === 'done')).toHaveLength(2);
    // No request for acc-9999 after a 404. Before each 404 only transient failures may appear:
    // 503s, and requests we abandoned on a timeout (the portal's documented slowness, seen > 5 s),
    // which the portal logs with status null.
    const missingPuts = (await portalRequests()).filter((r) => r.path.includes('/acc-9999/'));
    expect(missingPuts.filter((r) => r.status === 404)).toHaveLength(2); // one per failed update
    const lastNotFound = missingPuts.map((r) => r.status).lastIndexOf(404);
    expect(missingPuts.slice(lastNotFound + 1)).toEqual([]);
    expect(
      missingPuts
        .filter(
          (r) =>
            r.status !== 404 && r.status !== 503 && !(r.status === null && r.clientDisconnected),
        )
        .map((r) => ({
          id: r.id,
          at: r.timestamp,
          status: r.status,
          clientDisconnected: r.clientDisconnected,
          durationMs: r.durationMs,
        })),
    ).toEqual([]);
  });

  it('L8 / D5: at most WORKER_CONCURRENCY attempts in flight, never two for one accommodation', async () => {
    const changes: Change[] = Array.from({ length: 12 }, (_, i) => ({
      accommodationId: `acc-100${(i % 6) + 1}`,
      from: portalDay(i),
      to: portalDay(i),
      available: true,
      pricePerNight: 500 + i,
    }));
    await acceptAll(db.pool(), changes);
    const { worker, records } = track(testWorker(db.pool(), { concurrency: 3 }));
    worker.start();
    await waitUntil(allSettled(db.pool()), 120_000, 'all tasks settled');
    // Maximum number of attempts in flight at the same instant (sweep over start/end points).
    // Counting the attempts that overlap a given one would overstate it: three short attempts
    // one after another inside a long one all overlap it without ever overlapping each other.
    const maxInFlight = (rs: typeof records) => {
      const events = rs.flatMap((r) => [
        { at: r.startedAt, delta: 1 },
        { at: r.endedAt, delta: -1 },
      ]);
      events.sort((x, y) => x.at - y.at || x.delta - y.delta); // an end before a start at the same ms
      let current = 0;
      let max = 0;
      for (const e of events) max = Math.max(max, (current += e.delta));
      return max;
    };
    expect(records.length).toBeGreaterThanOrEqual(12);
    expect(maxInFlight(records)).toBeLessThanOrEqual(3);
    for (const acc of new Set(records.map((r) => r.task.accommodationId))) {
      expect(maxInFlight(records.filter((r) => r.task.accommodationId === acc))).toBe(1);
    }
  });

  it('L9: stop() aborts waiting slots promptly, lets the in-flight attempt finish and store its outcome', async () => {
    const changes: Change[] = ['acc-1001', 'acc-1002', 'acc-1003'].map((accommodationId, i) => ({
      accommodationId,
      from: portalDay(i),
      to: portalDay(i),
      available: true,
      pricePerNight: 600 + i,
    }));
    await acceptAll(db.pool(), changes);
    // One permit per minute: one slot sends, the other two wait for the window.
    const { worker } = testWorker(db.pool(), { concurrency: 3, maxRequestsPerMinute: 1 });
    worker.start();
    await waitUntil(
      async () =>
        Number((await db.pool().query('SELECT max(attempts) AS a FROM sync_tasks')).rows[0].a) ===
        1,
      10_000,
      'the first claim',
    );
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(6_000);
    const rows = (
      await db.pool().query('SELECT attempts, locked_until, status FROM sync_tasks ORDER BY id')
    ).rows;
    expect(rows.filter((r) => r.attempts === 1)).toHaveLength(1);
    expect(rows.filter((r) => r.attempts === 0)).toHaveLength(2); // never claimed
    expect(rows.every((r) => r.locked_until === null)).toBe(true); // the in-flight outcome was stored
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      Number((await db.pool().query('SELECT sum(attempts) AS s FROM sync_tasks')).rows[0].s),
    ).toBe(1); // no claim after stop
  });
});

describe('worker with a counting client (loop mechanics)', () => {
  const scripted = (responses: ObservedCall[]) => {
    const calls: string[] = [];
    const client: PortalClient = {
      async putAvailability(accommodationId) {
        calls.push(accommodationId);
        return responses.shift() ?? { kind: 'response', status: 200 };
      },
    };
    return { client, calls };
  };

  it('L10: an idle worker with an empty queue consumes no permits and makes no calls', async () => {
    const { client, calls } = scripted([]);
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 });
    const { worker } = track(testWorker(db.pool(), { client, limiter, pollMs: 20 }));
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 400)); // ~20 poll cycles × 3 slots
    await worker.stop();
    expect(calls).toEqual([]);
    expect(limiter.tryAcquire(performance.now()).ok).toBe(true);
    expect(limiter.tryAcquire(performance.now()).ok).toBe(true); // the full window is still free
  });

  it('L11: every attempt is logged with the SPEC §7 fields, at the right level', async () => {
    const { client } = scripted([
      {
        kind: 'response',
        status: 503,
        portalError: { code: 'UNAVAILABLE', message: 'retry later' },
      },
      { kind: 'response', status: 200 },
      {
        kind: 'response',
        status: 404,
        portalError: { code: 'NOT_FOUND', message: 'Accommodation acc-1001 not found' },
      },
    ]);
    const log = captureLog();
    await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1001',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 1,
      },
      {
        accommodationId: 'acc-1002',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 2,
      },
    ]);
    const { worker } = track(
      testWorker(db.pool(), { client, log, concurrency: 1, random: () => 0 }),
    );
    worker.start();
    await waitUntil(allSettled(db.pool()), 10_000, 'all tasks settled');
    const attempts = log.entries.filter((e) => 'outcome' in e.obj);
    expect(attempts.map((e) => [e.level, e.obj['outcome'], e.obj['httpStatus']])).toEqual([
      ['warn', 'unavailable', 503],
      ['info', 'success', 200],
      ['error', 'client_error', 404],
    ]);
    for (const e of attempts) {
      expect(Object.keys(e.obj)).toEqual(
        expect.arrayContaining([
          'taskId',
          'updateId',
          'accommodationId',
          'attempt',
          'outcome',
          'httpStatus',
          'durationMs',
          'nextAttemptAt',
        ]),
      );
    }
    expect(attempts[0]!.obj['nextAttemptAt']).toEqual(expect.any(String));
    expect(attempts[1]!.obj['nextAttemptAt']).toBeNull();
  });

  it('L12: an unexpected throw from the client is logged; the task is retried after its lease; the loop goes on', async () => {
    let calls = 0;
    const client: PortalClient = {
      async putAvailability() {
        calls++;
        if (calls === 1) throw new Error('boom');
        return { kind: 'response', status: 200 };
      },
    };
    const log = captureLog();
    await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1001',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 1,
      },
    ]);
    const { worker } = track(testWorker(db.pool(), { client, log, concurrency: 1, leaseMs: 500 }));
    worker.start();
    await waitUntil(allSettled(db.pool()), 15_000, 'all tasks settled');
    expect(calls).toBe(2);
    expect(
      log.entries.some(
        (e) => e.level === 'error' && e.obj['taskId'] !== undefined && /unexpected/i.test(e.msg),
      ),
    ).toBe(true);
  });

  it('L13: a pause that starts between claim and send stops the send; the task waits for the pause', async () => {
    const { client, calls } = scripted([]);
    const limiter = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    let paused = false;
    await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1001',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 1,
      },
    ]);
    const { worker } = track(
      testWorker(db.pool(), {
        client,
        limiter,
        concurrency: 1,
        onClaimed: () => {
          if (!paused) {
            paused = true;
            limiter.pauseFor(5_000); // another slot's 429 lands right now
          }
        },
      }),
    );
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(calls).toEqual([]); // nothing sent during the pause
    const row = (
      await db
        .pool()
        .query('SELECT attempts, locked_until, next_attempt_at, now() AS db_now FROM sync_tasks')
    ).rows[0];
    expect(row.locked_until).toBeNull();
    expect(
      (row.next_attempt_at as Date).getTime() - (row.db_now as Date).getTime(),
    ).toBeGreaterThan(3_000);
  });

  it('WK1: two workers on one database: only one sends; when it stops, the standby takes over', async () => {
    const a = scripted([]);
    const b = scripted([]);
    const changes = (offset: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        accommodationId: `acc-10${String(i + 1).padStart(2, '0')}`,
        from: portalDay(offset + i),
        to: portalDay(offset + i),
        available: true,
        pricePerNight: 10 + i,
      }));
    // Both start before any work exists, so they really compete for it.
    const first = track(
      testWorker(db.pool(), { client: a.client, leaderRetryMs: 200, pollMs: 20 }),
    );
    const second = track(
      testWorker(db.pool(), { client: b.client, leaderRetryMs: 200, pollMs: 20 }),
    );
    first.worker.start();
    second.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await acceptAll(db.pool(), changes(0));
    await waitUntil(allSettled(db.pool()), 15_000, 'first batch settled');
    expect([a.calls.length, b.calls.length].sort((x, y) => x - y)).toEqual([0, 8]); // only the lock holder sent

    const [active, standby] = a.calls.length > 0 ? [first, b] : [second, a];
    await active.worker.stop();
    await acceptAll(db.pool(), changes(20));
    await waitUntil(allSettled(db.pool()), 15_000, 'second batch settled by the standby');
    expect(standby.calls).toHaveLength(8);
  });

  it('WK2: a worker started right after another process used the window waits for those starts to age out', async () => {
    // The previous process sent 3 requests 57 s ago (their last_attempt_at is in the database).
    await acceptAll(
      db.pool(),
      [1, 2, 3].map((i) => ({
        accommodationId: 'acc-1001',
        from: portalDay(i),
        to: portalDay(i),
        available: true,
        pricePerNight: i,
      })),
    );
    await db
      .pool()
      .query(
        "UPDATE sync_tasks SET status = 'done', attempts = 1, last_attempt_at = now() - interval '57 seconds'",
      );
    await acceptAll(db.pool(), [
      {
        accommodationId: 'acc-1002',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 9,
      },
    ]);
    const sentAt: number[] = [];
    const client: PortalClient = {
      async putAvailability() {
        sentAt.push(Date.now());
        return { kind: 'response', status: 200 };
      },
    };
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 60_000 });
    const started = Date.now();
    const { worker } = track(testWorker(db.pool(), { client, limiter }));
    worker.start();
    await waitUntil(allSettled(db.pool()), 15_000, 'the new update settled');
    expect(sentAt[0]! - started).toBeGreaterThan(2_000); // ~3 s: the seeded starts left the window
  });
});

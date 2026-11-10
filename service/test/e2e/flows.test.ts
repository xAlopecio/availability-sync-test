import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { valueOf } from '../support/exposition.ts';
import { maxPerMinute, portalMismatches, startE2E, stop, waitAllSettled } from '../support/e2e.ts';
import { portalDay, portalRequests, resetPortal, waitForPortalQuiet } from '../support/portal.ts';
import type { RunningService } from '../support/service-process.ts';
import { createScratchDatabase, dropDatabase } from '../support/test-db.ts';
import type { Change } from '../support/worker-harness.ts';

let dbName: string;
let running: RunningService[] = [];
const start = async (env: Record<string, string> = {}) => {
  const s = await startE2E(dbName, env);
  running.push(s.service);
  return s;
};
beforeEach(async () => {
  dbName = await createScratchDatabase();
  await resetPortal();
});
afterEach(async () => {
  await Promise.all(running.map((s) => stop(s)));
  running = [];
  await waitForPortalQuiet();
  await dropDatabase(dbName);
});

const postAll = async (post: (b: unknown) => Promise<Response>, changes: readonly Change[]) => {
  for (const c of changes) expect((await post(c)).status).toBe(202);
};
const waitUntil = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};
const putsOk = async () =>
  (await portalRequests()).filter((r) => r.method === 'PUT' && r.status === 200).length;

describe('the service as a black box', () => {
  it('E1: the README flow — POST, then synced, with the values in the portal and in /metrics', async () => {
    const { api } = await start();
    // The README's example payload, with dates inside the portal's 90 days.
    const update = {
      accommodationId: 'acc-1003',
      from: portalDay(10),
      to: portalDay(16),
      available: true,
      pricePerNight: 120.0,
    };
    expect((await api.post(update)).status).toBe(202);
    await waitUntil(
      async () => (await api.status('acc-1003')).body.status === 'synced',
      60_000,
      'synced',
    );
    expect(await portalMismatches([update], 'acc-1003')).toEqual([]);
    const m = await api.metrics();
    expect(valueOf(m, 'updates_accepted_total')).toBe(1);
    expect(valueOf(m, 'portal_requests_total', { outcome: 'success' })).toBe(1);
  });

  it("E2 / AC4: a manager's day — overlapping updates, one over 31 days, and a quick correction", async () => {
    const { api, baseUrl } = await start();
    const day: Change[] = [
      {
        accommodationId: 'acc-1003',
        from: portalDay(0),
        to: portalDay(89),
        available: true,
        pricePerNight: 100,
      },
      {
        accommodationId: 'acc-1003',
        from: portalDay(10),
        to: portalDay(16),
        available: false,
        pricePerNight: 150,
      },
    ];
    await postAll(api.post, day);
    await waitAllSettled(baseUrl, ['acc-1003'], 180_000);
    // The manager corrects two of those days seconds after the update finished (the R1 path).
    const correction: Change = {
      accommodationId: 'acc-1003',
      from: portalDay(12),
      to: portalDay(13),
      available: true,
      pricePerNight: 170,
    };
    expect((await api.post(correction)).status).toBe(202);
    await waitAllSettled(baseUrl, ['acc-1003'], 120_000);
    expect(await portalMismatches([...day, correction], 'acc-1003')).toEqual([]);
  });

  for (const [id, signal, exitCode] of [
    ['E3 / AC7', 'SIGKILL', null],
    ['E4', 'SIGTERM', 0],
  ] as const) {
    it(`${id}: ${signal} mid-sync loses nothing — the next process finishes the work`, async () => {
      const first = await start();
      const changes: Change[] = [
        'acc-1001',
        'acc-1002',
        'acc-1004',
        'acc-1005',
        'acc-1006',
        'acc-1007',
      ].flatMap((acc, i) => [
        {
          accommodationId: acc,
          from: portalDay(i),
          to: portalDay(i + 5),
          available: true,
          pricePerNight: 200 + i,
        },
        {
          accommodationId: acc,
          from: portalDay(i + 2),
          to: portalDay(i + 3),
          available: false,
          pricePerNight: 300 + i,
        },
      ]);
      await postAll(first.api.post, changes);
      await waitUntil(async () => (await putsOk()) >= 3, 60_000, 'the first process is sending');
      first.service.process.kill(signal);
      const exited = await first.service.exited;
      expect(exited.code).toBe(exitCode);

      const second = await start();
      const accs = [...new Set(changes.map((c) => c.accommodationId))];
      const statuses = await waitAllSettled(second.baseUrl, accs, 240_000);
      for (const s of statuses) expect(s.body.status).toBe('synced');
      for (const acc of accs) expect(await portalMismatches(changes, acc)).toEqual([]);
    });
  }

  it('E5: a client retry with the same Idempotency-Key is safe; a reused key with another body is refused', async () => {
    const { api, baseUrl } = await start();
    const update = {
      accommodationId: 'acc-1008',
      from: portalDay(4),
      to: portalDay(5),
      available: false,
      pricePerNight: 88,
    };
    const first = await api.post(update, { 'idempotency-key': 'mgr-42:edit-7' });
    const retry = await api.post(update, { 'idempotency-key': 'mgr-42:edit-7' });
    const reused = await api.post(
      { ...update, pricePerNight: 99 },
      { 'idempotency-key': 'mgr-42:edit-7' },
    );
    expect([first.status, retry.status, reused.status]).toEqual([202, 202, 422]);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    const [settled] = await waitAllSettled(baseUrl, ['acc-1008'], 60_000);
    expect(settled!.body.recentUpdates).toHaveLength(1);
    const ok = (await portalRequests()).filter(
      (r) => r.method === 'PUT' && r.status === 200 && r.path.includes('/acc-1008/'),
    );
    expect(ok).toHaveLength(1);
  });

  it('E6 / AC2: invalid input over HTTP is 400 and nothing reaches the portal', async () => {
    const { api } = await start();
    const valid = {
      accommodationId: 'acc-1003',
      from: portalDay(1),
      to: portalDay(2),
      available: true,
      pricePerNight: 10,
    };
    const responses = await Promise.all([
      api.post({ ...valid, from: '2026-02-30' }),
      api.post({ ...valid, discount: 5 }),
      api.post({ ...valid, accommodationId: '../acc-1003' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400]);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await portalRequests()).filter((r) => r.method === 'PUT')).toEqual([]);
  });

  it('E7 / AC9: an unknown accommodation fails with the portal 404; the others sync', async () => {
    const { api, baseUrl } = await start();
    await postAll(api.post, [
      {
        accommodationId: 'acc-1001',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 1,
      },
      {
        accommodationId: 'acc-9999',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 2,
      },
      {
        accommodationId: 'acc-1002',
        from: portalDay(1),
        to: portalDay(1),
        available: true,
        pricePerNight: 3,
      },
    ]);
    const [a, missing, b] = await waitAllSettled(
      baseUrl,
      ['acc-1001', 'acc-9999', 'acc-1002'],
      60_000,
    );
    expect([a!.body.status, b!.body.status]).toEqual(['synced', 'synced']);
    expect(missing!.body.status).toBe('failed');
    expect(missing!.body.recentUpdates[0]!.lastError).toMatch(/^404 NOT_FOUND/);
  });

  it('E8 + E9 / AC15: rolling deploy — two processes, one sender, takeover on death; /ready tells which', async () => {
    const a = await start();
    const b = await start();
    let active: typeof a, standby: typeof a;
    await waitUntil(
      async () => {
        const [ra, rb] = await Promise.all([a.api.ready(), b.api.ready()]);
        return [ra.body.worker, rb.body.worker].sort().join() === 'active,standby';
      },
      15_000,
      'one active and one standby',
    );
    if ((await a.api.ready()).body.worker === 'active') [active, standby] = [a, b];
    else [active, standby] = [b, a];

    const changes: Change[] = [
      'acc-1001',
      'acc-1002',
      'acc-1003',
      'acc-1004',
      'acc-1005',
      'acc-1006',
    ].map((acc, i) => ({
      accommodationId: acc,
      from: portalDay(20 + i),
      to: portalDay(24 + i),
      available: i % 2 === 0,
      pricePerNight: 400 + i,
    }));
    await postAll(active.api.post, changes.slice(0, 3));
    await postAll(standby.api.post, changes.slice(3)); // both instances accept updates
    await waitUntil(async () => (await putsOk()) >= 2, 60_000, 'the active process is sending');
    expect(valueOf(await standby.api.metrics(), 'portal_requests_total')).toBe(0); // the standby never sent

    active.service.process.kill('SIGKILL');
    await active.service.exited;
    await waitUntil(
      async () => (await standby.api.ready()).body.worker === 'active',
      30_000,
      'the standby takes over',
    );
    const accs = changes.map((c) => c.accommodationId);
    const statuses = await waitAllSettled(standby.baseUrl, accs, 180_000);
    // The services' traffic, snapshotted before the test's own GETs (they count toward the limit).
    const log = (await portalRequests()).filter((r) => r.path.startsWith('/api/'));
    for (const s of statuses) expect(s.body.status).toBe('synced');
    for (const acc of accs) expect(await portalMismatches(changes, acc)).toEqual([]);
    expect(maxPerMinute(log)).toBeLessThanOrEqual(30);
  });
});

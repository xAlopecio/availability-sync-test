import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { valueOf } from '../support/exposition.ts';
import { maxPerMinute, portalMismatches, startE2E, stop, waitAllSettled } from '../support/e2e.ts';
import { portalDay, portalRequests, resetPortal, waitForPortalQuiet } from '../support/portal.ts';
import type { RunningService } from '../support/service-process.ts';
import { createScratchDatabase, dropDatabase } from '../support/test-db.ts';
import type { Change } from '../support/worker-harness.ts';

let dbName: string;
let service: RunningService | undefined;
beforeEach(async () => {
  dbName = await createScratchDatabase();
  await resetPortal();
});
afterEach(async () => {
  await stop(service);
  await waitForPortalQuiet();
  await dropDatabase(dbName);
});

const ACCOMMODATIONS = Array.from(
  { length: 10 },
  (_, i) => `acc-10${String(i + 1).padStart(2, '0')}`,
);

/** ~50 updates: 5 per accommodation, overlapping within each, every 7th one over 31 days. */
function burst(): Change[] {
  return Array.from({ length: 50 }, (_, i) => {
    const start = (i * 3) % 50;
    const length = i % 7 === 0 ? 40 : 3 + (i % 5);
    return {
      accommodationId: ACCOMMODATIONS[i % 10]!,
      from: portalDay(start),
      to: portalDay(start + length - 1),
      available: i % 3 !== 0,
      pricePerNight: 500 + i,
    };
  });
}
const chunksOf = (c: Change) =>
  Math.ceil(
    (Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`) + 86_400_000) /
      (31 * 86_400_000),
  );
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

describe('load, black box', () => {
  it('L1 + L2 / AC14: a concurrent burst ends correct, within the portal limit, and the metrics agree', async () => {
    const e2e = await startE2E(dbName);
    service = e2e.service;
    const changes = burst();
    const tasks = changes.reduce((n, c) => n + chunksOf(c), 0);

    const started = Date.now();
    // All POSTed at once: the per-accommodation lock (D1) must still order them by commit.
    const responses = await Promise.all(changes.map((c) => e2e.api.post(c)));
    expect(responses.map((r) => r.status)).toEqual(changes.map(() => 202));
    // The acceptance order per accommodation is what the portal must end with.
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { updateId: number }).updateId),
    );
    const accepted = changes
      .map((c, i) => ({ c, id: ids[i]! }))
      .sort((x, y) => x.id - y.id)
      .map((x) => x.c);

    // Bound: the tasks plus the portal's ~24 % 503s, at 25/min, with a wide margin.
    const budgetMs = ((tasks * 1.4) / 25) * 60_000 + 180_000;
    const statuses = await waitAllSettled(e2e.baseUrl, ACCOMMODATIONS, budgetMs);
    const elapsedMin = (Date.now() - started) / 60_000;

    for (const s of statuses) expect(s.body.status).toBe('synced');
    for (const acc of ACCOMMODATIONS) expect(await portalMismatches(accepted, acc)).toEqual([]);

    const log = (await portalRequests()).filter((r) => r.path.startsWith('/api/'));
    const puts = log.filter((r) => r.method === 'PUT');
    expect(log.filter((r) => r.status === 429)).toEqual([]);
    expect(maxPerMinute(log)).toBeLessThanOrEqual(30);

    const m = await e2e.api.metrics();
    expect(valueOf(m, 'sync_tasks_pending')).toBe(0);
    expect(valueOf(m, 'sync_tasks_finished_total', { result: 'done' })).toBe(tasks);
    expect(valueOf(m, 'portal_requests_total')).toBe(puts.length);

    // L2: the figures, printed (not asserted: the portal's 503s and slowness make them noisy).
    const lags = statuses
      .flatMap((s) => s.body.recentUpdates)
      .map((u) => (Date.parse(u.syncedAt!) - Date.parse(u.acceptedAt)) / 1000)
      .sort((a, b) => a - b);
    const report = {
      updates: changes.length,
      tasks,
      portalCalls: puts.length,
      share503: Number((puts.filter((r) => r.status === 503).length / puts.length).toFixed(2)),
      minutes: Number(elapsedMin.toFixed(1)),
      updatesPerMin: Number((changes.length / elapsedMin).toFixed(1)),
      callsPerMin: Number((puts.length / elapsedMin).toFixed(1)),
      maxCallsIn60s: maxPerMinute(log),
      lagP50s: Math.round(percentile(lags, 0.5)),
      lagP95s: Math.round(percentile(lags, 0.95)),
    };
    console.log(`L2 load report: ${JSON.stringify(report)}`);
  });
});

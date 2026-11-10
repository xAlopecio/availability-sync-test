import { describe, expect, it } from 'vitest';
import { createMetrics } from '#src/metrics/registry.ts';
import { parseExposition, valueOf } from '../../support/exposition.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';
import {
  portalDay,
  portalRequests,
  resetPortal,
  waitForPortalQuiet,
} from '../../support/portal.ts';
import { acceptAll, allSettled, testWorker, waitUntil } from '../../support/worker-harness.ts';

const db = useMigratedDatabase();

describe('the metrics agree with the real portal', () => {
  it("R1 / AC13: the portal calls we count equal the PUTs in the portal's own log, 503s included", async () => {
    await resetPortal();
    const changes = [
      {
        accommodationId: 'acc-1009',
        from: portalDay(0),
        to: portalDay(40),
        available: true,
        pricePerNight: 900,
      }, // 2 chunks
      {
        accommodationId: 'acc-1009',
        from: portalDay(5),
        to: portalDay(9),
        available: false,
        pricePerNight: 901,
      },
      {
        accommodationId: 'acc-1010',
        from: portalDay(2),
        to: portalDay(3),
        available: false,
        pricePerNight: 902,
      },
    ];
    await acceptAll(db.pool(), changes);
    const m = createMetrics();
    const { worker } = testWorker(db.pool(), { metrics: m });
    worker.start();
    try {
      await waitUntil(allSettled(db.pool()), 120_000, 'all tasks settled');
    } finally {
      await worker.stop();
    }
    await waitForPortalQuiet();
    const s = parseExposition(await m.registry.metrics()).samples;
    const puts = (await portalRequests()).filter((r) => r.method === 'PUT');
    expect(valueOf(s, 'portal_requests_total')).toBe(puts.length);
    expect(valueOf(s, 'portal_requests_total', { outcome: 'unavailable' })).toBe(
      puts.filter((r) => r.status === 503).length,
    );
    expect(valueOf(s, 'portal_requests_total', { outcome: 'success' })).toBe(
      puts.filter((r) => r.status === 200).length,
    );
    expect(valueOf(s, 'sync_tasks_finished_total', { result: 'done' })).toBe(4);
  });
});

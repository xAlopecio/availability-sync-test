import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  jsonLines,
  startService,
  withTimeout,
  type RunningService,
} from '../support/service-process.ts';
import { createScratchDatabase, databaseUrl, dropDatabase } from '../support/test-db.ts';
import {
  PORTAL_URL,
  portalDay,
  portalDays,
  portalRequests,
  resetPortal,
  waitForPortalQuiet,
} from '../support/portal.ts';

let dbName: string;
let service: RunningService | undefined;
beforeEach(async () => {
  dbName = await createScratchDatabase();
  await resetPortal();
});
afterEach(async () => {
  if (service && service.process.exitCode === null) {
    service.process.kill('SIGKILL');
    await service.exited;
  }
  service = undefined;
  await waitForPortalQuiet();
  await dropDatabase(dbName);
});

const update = {
  accommodationId: 'acc-1008',
  from: portalDay(3),
  to: portalDay(4),
  available: false,
  pricePerNight: 812.5,
};
const post = (baseUrl: string) =>
  fetch(`${baseUrl}/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
const status = async (baseUrl: string) =>
  (await (
    await fetch(`${baseUrl}/accommodations/${update.accommodationId}/sync-status`)
  ).json()) as { status: string };
const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: databaseUrl(dbName),
  PORTAL_BASE_URL: PORTAL_URL,
  RETRY_BASE_MS: '200',
  RETRY_MAX_MS: '3000',
  ...extra,
});

describe('the service process with its worker', () => {
  it('WW1: an update POSTed over HTTP ends synced, and the portal holds its values', async () => {
    service = startService(env({ WORKER_ENABLED: 'true' }));
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    expect((await post(baseUrl)).status).toBe(202);
    const deadline = Date.now() + 60_000;
    while ((await status(baseUrl)).status !== 'synced') {
      if (Date.now() > deadline)
        throw new Error(`not synced: ${JSON.stringify(await status(baseUrl))}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const days = await portalDays(update.accommodationId, update.from, update.to);
    expect(days.map((d) => [d.date, d.available, d.pricePerNight])).toEqual([
      [update.from, false, 812.5],
      [update.to, false, 812.5],
    ]);
  });

  it('WW2: SIGTERM stops the worker first, then HTTP, then the pool; exit 0', async () => {
    service = startService(env({ WORKER_ENABLED: 'true' }));
    await withTimeout(service.listening, 15_000, 'listening');
    service.process.kill('SIGTERM');
    expect(await withTimeout(service.exited, 10_000, 'exit')).toEqual({ code: 0, signal: null });
    const steps = jsonLines(service.lines)
      .map((l) => String(l['msg']))
      .filter((m) =>
        ['shutting down', 'worker stopped', 'http server closed', 'database pool closed'].includes(
          m,
        ),
      );
    expect(steps).toEqual([
      'shutting down',
      'worker stopped',
      'http server closed',
      'database pool closed',
    ]);
  });

  it('WW3: with WORKER_ENABLED=false the API works and nothing reaches the portal', async () => {
    service = startService(env({ WORKER_ENABLED: 'false' }));
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    expect((await post(baseUrl)).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await status(baseUrl)).status).toBe('pending');
    expect((await portalRequests()).filter((r) => r.method === 'PUT')).toEqual([]);
  });
});

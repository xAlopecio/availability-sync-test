import { parseExposition, type Sample } from './exposition.ts';
import { PORTAL_URL, portalDays, type LoggedRequest } from './portal.ts';
import { startService, withTimeout, type RunningService } from './service-process.ts';
import { databaseUrl } from './test-db.ts';
import { expectedDays, type Change } from './worker-harness.ts';

/**
 * The real service as a black box (SPEC §12, AC14–AC15): production defaults, except a shorter
 * lease (a killed process's tasks come back in 12 s, not 30 s; still well above the 5 s portal
 * timeout, so a slow CI runner does not re-claim live attempts) and a 5 s retry cap (a streak of
 * 503s cannot push one retry to 5 minutes). D9 keeps its real 30 s window.
 */
export async function startE2E(dbName: string, env: Record<string, string> = {}) {
  const service = startService({
    DATABASE_URL: databaseUrl(dbName),
    PORTAL_BASE_URL: PORTAL_URL,
    WORKER_ENABLED: 'true',
    TASK_LEASE_MS: '12000',
    RETRY_MAX_MS: '5000',
    ...env,
  });
  const baseUrl = await withTimeout(service.listening, 20_000, 'service listening');
  return { service, baseUrl, api: api(baseUrl) };
}

export type SyncStatus = {
  status: string;
  pendingUpdates: number;
  failedUpdates: number;
  recentUpdates: {
    updateId: number;
    status: string;
    acceptedAt: string;
    syncedAt: string | null;
    lastError: string | null;
  }[];
};

export function api(baseUrl: string) {
  return {
    post: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}/updates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    status: async (accommodationId: string): Promise<{ code: number; body: SyncStatus }> => {
      const res = await fetch(`${baseUrl}/accommodations/${accommodationId}/sync-status`);
      return { code: res.status, body: (await res.json()) as SyncStatus };
    },
    metrics: async (): Promise<Sample[]> =>
      parseExposition(await (await fetch(`${baseUrl}/metrics`)).text()).samples,
    ready: async () => {
      const res = await fetch(`${baseUrl}/ready`);
      return { code: res.status, body: (await res.json()) as { worker?: string } };
    },
  };
}

/** Polls the service's own sync-status until no accommodation has pending updates. */
export async function waitAllSettled(
  baseUrl: string,
  accommodationIds: readonly string[],
  timeoutMs: number,
) {
  const client = api(baseUrl);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(accommodationIds.map((id) => client.status(id)));
    if (statuses.every((s) => s.code === 200 && s.body.pendingUpdates === 0)) return statuses;
    if (Date.now() > deadline) {
      throw new Error(
        `not settled: ${JSON.stringify(statuses.map((s) => [s.code, s.body.status, s.body.pendingUpdates]))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Every day the changes touch equals the last accepted change covering it (AC4). */
export async function portalMismatches(changes: readonly Change[], accommodationId: string) {
  const expected = expectedDays(changes, accommodationId);
  const dates = [...expected.keys()].sort();
  const actual = await portalDays(accommodationId, dates[0]!, dates.at(-1)!);
  const seen = new Set(actual.map((d) => d.date));
  const wrong = actual
    .filter((d) => expected.has(d.date))
    .filter(
      (d) =>
        d.available !== expected.get(d.date)!.available ||
        d.pricePerNight !== expected.get(d.date)!.pricePerNight,
    )
    .map((d) => ({
      date: d.date,
      got: [d.available, d.pricePerNight],
      want: Object.values(expected.get(d.date)!),
    }));
  const missing = dates.filter((d) => !seen.has(d));
  return [...wrong, ...missing.map((date) => ({ date, missing: true }))];
}

/** The most requests the portal saw in any 60 s window (by arrival timestamp). */
export function maxPerMinute(requests: readonly LoggedRequest[]): number {
  const times = requests.map((r) => Date.parse(r.timestamp)).sort((a, b) => a - b);
  let max = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= 60_000) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

export async function stop(
  service: RunningService | undefined,
  signal: NodeJS.Signals = 'SIGKILL',
) {
  if (!service || service.process.exitCode !== null || service.process.signalCode !== null) return;
  service.process.kill(signal);
  await service.exited;
}

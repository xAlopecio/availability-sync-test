import type pg from 'pg';
import { acceptUpdate } from '#src/db/repository.ts';
import { splitRange } from '#src/domain/calendar/chunking.ts';
import { parseIsoDate, type IsoDate } from '#src/domain/calendar/dates.ts';
import { createPortalClient, type PortalClient } from '#src/portal/client.ts';
import { SlidingWindowRateLimiter } from '#src/portal/rate-limiter.ts';
import {
  createWorker,
  type AttemptRecord,
  type WorkerLog,
  type WorkerOptions,
} from '#src/worker/worker.ts';
import { PORTAL_API_KEY, PORTAL_URL, type PortalDay } from './portal.ts';

export type Change = {
  accommodationId: string;
  from: string;
  to: string;
  available: boolean;
  pricePerNight: number;
};

const iso = (s: string): IsoDate => {
  const d = parseIsoDate(s);
  if (!d) throw new Error(`bad date ${s}`);
  return d;
};

export async function acceptAll(pool: pg.Pool, changes: readonly Change[]): Promise<number[]> {
  const ids: number[] = [];
  for (const c of changes) {
    const request = { ...c, from: iso(c.from), to: iso(c.to) };
    ids.push((await acceptUpdate(pool, request, splitRange(request.from, request.to))).updateId);
  }
  return ids;
}

/** For every day, the last accepted change covering it (what the portal must end with, AC4). */
export function expectedDays(
  changes: readonly Change[],
  accommodationId: string,
): Map<string, Omit<PortalDay, 'date'>> {
  const days = new Map<string, Omit<PortalDay, 'date'>>();
  for (const c of changes.filter((x) => x.accommodationId === accommodationId)) {
    for (
      let d = new Date(`${c.from}T00:00:00Z`);
      d <= new Date(`${c.to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      days.set(d.toISOString().slice(0, 10), {
        available: c.available,
        pricePerNight: c.pricePerNight,
      });
    }
  }
  return days;
}

export const silentLog: WorkerLog = { info() {}, warn() {}, error() {} };

export function captureLog(): WorkerLog & {
  entries: { level: string; obj: Record<string, unknown>; msg: string }[];
} {
  const entries: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: object, msg: string) =>
    entries.push({ level, obj: obj as Record<string, unknown>, msg });
  return { entries, info: at('info'), warn: at('warn'), error: at('error') };
}

/** A worker on the real portal with fast test retries (behaviour identical, smaller delays). */
export function testWorker(
  pool: pg.Pool,
  overrides: Partial<WorkerOptions> & { maxRequestsPerMinute?: number } = {},
): {
  worker: ReturnType<typeof createWorker>;
  records: AttemptRecord[];
  limiter: SlidingWindowRateLimiter;
  client: PortalClient;
} {
  const records: AttemptRecord[] = [];
  const timeoutMs = overrides.timeoutMs ?? 5_000;
  const limiter =
    overrides.limiter ??
    new SlidingWindowRateLimiter({ limit: overrides.maxRequestsPerMinute ?? 25, windowMs: 60_000 });
  const client =
    overrides.client ??
    createPortalClient({ baseUrl: PORTAL_URL, apiKey: PORTAL_API_KEY, timeoutMs });
  const worker = createWorker({
    pool,
    client,
    limiter,
    log: silentLog,
    concurrency: 3,
    leaseMs: 30_000,
    pollMs: 100,
    timeoutMs,
    retry: { baseMs: 200, maxMs: 3_000, rateLimitMarginMs: 500 },
    ...overrides,
    onAttempt: (r) => {
      records.push(r);
      overrides.onAttempt?.(r);
    },
  });
  return { worker, records, limiter, client };
}

export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const allSettled = (pool: pg.Pool) => async () =>
  Number(
    (await pool.query("SELECT count(*) AS n FROM sync_tasks WHERE status = 'pending'")).rows[0].n,
  ) === 0;

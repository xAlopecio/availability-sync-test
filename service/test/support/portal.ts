/** Helpers for tests against the real Portal Sol (docker-compose, or a CI service). */
export const PORTAL_URL = (process.env['TEST_PORTAL_URL'] ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);
export const PORTAL_API_KEY = 'sol-demo-key';

export type LoggedRequest = {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  status: number | null;
  durationMs: number | null;
  clientDisconnected?: boolean;
};
export type PortalDay = { date: string; available: boolean; pricePerNight: number };

export async function resetPortal(): Promise<void> {
  const res = await fetch(`${PORTAL_URL}/__admin/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`portal reset failed: ${res.status}`);
}

export async function portalRequests(): Promise<LoggedRequest[]> {
  const res = await fetch(`${PORTAL_URL}/__admin/requests`);
  return ((await res.json()) as { requests: LoggedRequest[] }).requests;
}

/**
 * Repeats `call` while the portal answers 503 (about 24 % of requests): the assertion is about
 * the other outcome, not about the portal's random unavailability.
 */
export async function retryOn503<T extends { status: number }>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 20; i++) {
    const result = await call();
    if (result.status !== 503) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('portal answered 503 twenty times in a row');
}

/** The portal's day-by-day state (rate-limited: one request, retried on 503). */
export async function portalDays(
  accommodationId: string,
  from: string,
  to: string,
): Promise<PortalDay[]> {
  const res = await retryOn503(() =>
    fetch(`${PORTAL_URL}/api/v1/accommodations/${accommodationId}?from=${from}&to=${to}`, {
      headers: { 'X-Api-Key': PORTAL_API_KEY },
    }),
  );
  if (!res.ok) throw new Error(`portal GET failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { days: PortalDay[] }).days;
}

/** `YYYY-MM-DD` for today + `offset` days in UTC: the portal holds 90 days from its start date. */
export const portalDay = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Waits until the portal's request log stops growing for `quietMs`. A request that timed out on
 * our side is still processed by the portal and only logged when it finishes; without this, one
 * test's late requests can land in (and count against the limit of) the next test.
 */
export async function waitForPortalQuiet(quietMs = 2_000, maxMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = (await portalRequests()).length;
    if (count !== last) {
      last = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

import { beforeEach, describe, expect, it } from 'vitest';
import { createPortalClient } from '#src/portal/client.ts';
import { refusedUrl, startFakeServer } from '../../support/fake-http.ts';
import {
  PORTAL_API_KEY,
  PORTAL_URL,
  portalDay,
  portalDays,
  portalRequests,
  resetPortal,
  retryOn503,
} from '../../support/portal.ts';

const real = (overrides: Partial<{ apiKey: string; timeoutMs: number }> = {}) =>
  createPortalClient({
    baseUrl: PORTAL_URL,
    apiKey: PORTAL_API_KEY,
    timeoutMs: 5000,
    ...overrides,
  });
const body = (offset: number, pricePerNight = 177.5) => ({
  from: portalDay(offset),
  to: portalDay(offset + 1),
  available: false,
  pricePerNight,
});
const statusOf = (call: Awaited<ReturnType<ReturnType<typeof real>['putAvailability']>>) =>
  call.kind === 'response' ? call.status : -1;
/**
 * Repeats a real-portal call while it fails transiently: random 503s, and the portal's
 * documented slow responses (seen: > 5 s), which the client reports as timeouts.
 */
const untilAnswered = async (call: () => ReturnType<ReturnType<typeof real>['putAvailability']>) =>
  retryOn503(async () => {
    const c = await call();
    return Object.assign(c, { status: c.kind === 'timeout' ? 503 : statusOf(c) });
  });

describe('portal client against the real Portal Sol', () => {
  beforeEach(resetPortal);

  it('PC1: a valid PUT answers 200 and changes the portal state', async () => {
    const client = real();
    const call = await untilAnswered(() => client.putAvailability('acc-1003', body(5)));
    expect(call).toMatchObject({ kind: 'response', status: 200 });
    const days = await portalDays('acc-1003', portalDay(5), portalDay(6));
    expect(days.map((d) => [d.available, d.pricePerNight])).toEqual([
      [false, 177.5],
      [false, 177.5],
    ]);
  });

  it('PC2: sends only the four documented fields to the documented path', async () => {
    const client = real();
    await untilAnswered(() => client.putAvailability('acc-1003', body(5)));
    const puts = (await portalRequests()).filter((r) => r.method === 'PUT');
    expect(puts.at(-1)).toMatchObject({
      path: '/api/v1/accommodations/acc-1003/availability',
      body: body(5),
    });
    expect(Object.keys(puts.at(-1)!.body!).sort()).toEqual([
      'available',
      'from',
      'pricePerNight',
      'to',
    ]);
  });

  it("PC3: an unknown accommodation is 404 with the portal's code and message", async () => {
    const client = real();
    const call = await untilAnswered(() => client.putAvailability('acc-9999', body(5)));
    expect(call).toMatchObject({
      kind: 'response',
      status: 404,
      portalError: { code: 'NOT_FOUND', message: expect.stringContaining('acc-9999') },
    });
  });

  it('PC4: a wrong API key is 401 UNAUTHORIZED', async () => {
    const client = real({ apiKey: 'wrong-key' });
    const call = await untilAnswered(() => client.putAvailability('acc-1003', body(5)));
    expect(call).toMatchObject({
      kind: 'response',
      status: 401,
      portalError: { code: 'UNAUTHORIZED' },
    });
  });
});

describe('portal client transport faults (local fake server, SPEC §12)', () => {
  it('PC2: sends X-Api-Key and Content-Type: application/json', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const fake = await startFakeServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    try {
      await createPortalClient({
        baseUrl: fake.url,
        apiKey: 'k-123',
        timeoutMs: 1000,
      }).putAvailability('acc-1003', body(5));
      expect(seen['x-api-key']).toBe('k-123');
      expect(seen['content-type']).toMatch(/^application\/json/);
    } finally {
      await fake.close();
    }
  });

  it('PC5: a 429 passes Retry-After through untouched', async () => {
    const fake = await startFakeServer((_req, res) =>
      res
        .writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' })
        .end('{"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded"}}'),
    );
    try {
      const call = await createPortalClient({
        baseUrl: fake.url,
        apiKey: 'k',
        timeoutMs: 1000,
      }).putAvailability('acc-1003', body(5));
      expect(call).toEqual({
        kind: 'response',
        status: 429,
        retryAfter: '17',
        portalError: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' },
      });
    } finally {
      await fake.close();
    }
  });

  it('PC6: no response within timeoutMs → timeout, returned at about timeoutMs', async () => {
    const fake = await startFakeServer((_req, res) => {
      setTimeout(() => res.writeHead(200).end('{}'), 2_000);
    });
    try {
      const started = Date.now();
      const call = await createPortalClient({
        baseUrl: fake.url,
        apiKey: 'k',
        timeoutMs: 200,
      }).putAvailability('acc-1003', body(5));
      expect(call).toEqual({ kind: 'timeout' });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await fake.close();
    }
  });

  it('PC7: a refused connection is a network error with its code', async () => {
    const call = await createPortalClient({
      baseUrl: await refusedUrl(),
      apiKey: 'k',
      timeoutMs: 1000,
    }).putAvailability('acc-1003', body(5));
    expect(call).toEqual({ kind: 'network_error', code: 'ECONNREFUSED' });
  });

  it('PC7: a connection reset mid-response is a network error', async () => {
    const fake = await startFakeServer((req) => req.socket.destroy());
    try {
      const call = await createPortalClient({
        baseUrl: fake.url,
        apiKey: 'k',
        timeoutMs: 1000,
      }).putAvailability('acc-1003', body(5));
      expect(call.kind).toBe('network_error');
      expect(typeof (call as { code?: unknown }).code).toBe('string');
    } finally {
      await fake.close();
    }
  });

  it('PC8: an error with a non-JSON body keeps the status; code and message are null', async () => {
    const fake = await startFakeServer((_req, res) =>
      res.writeHead(500, { 'content-type': 'text/plain' }).end('oops'),
    );
    try {
      const call = await createPortalClient({
        baseUrl: fake.url,
        apiKey: 'k',
        timeoutMs: 1000,
      }).putAvailability('acc-1003', body(5));
      expect(call).toEqual({
        kind: 'response',
        status: 500,
        portalError: { code: null, message: null },
      });
    } finally {
      await fake.close();
    }
  });
});

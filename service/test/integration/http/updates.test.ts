import { describe, expect, it } from 'vitest';
import { buildApp } from '#src/http/app.ts';
import { createPool } from '#src/db/pool.ts';
import { errorCodeOf, useApp } from '../../support/app.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const app = useApp(db);

const readme = {
  accommodationId: 'acc-1003',
  from: '2026-10-01',
  to: '2026-10-07',
  available: true,
  pricePerNight: 120.0,
};
const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app().inject({
    method: 'POST',
    url: '/updates',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
const rowCounts = async () => {
  const { rows } = await db
    .pool()
    .query(
      'SELECT (SELECT count(*) FROM updates) AS updates, (SELECT count(*) FROM sync_tasks) AS tasks',
    );
  return rows[0] as { updates: number; tasks: number };
};

describe('POST /updates', () => {
  it('H1 / AC1: accepts the README example with 202, persisted before the response', async () => {
    const res = await post(readme);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ updateId: 1, status: 'pending', chunks: 1 });
    expect(await rowCounts()).toEqual({ updates: 1, tasks: 1 });
    const { rows } = await db.pool().query('SELECT * FROM updates');
    expect(rows[0]).toMatchObject({
      accommodation_id: 'acc-1003',
      date_from: '2026-10-01',
      date_to: '2026-10-07',
      available: true,
      price_per_night: 120,
    });
  });

  it('H2 / AC1: a 90-day update becomes 3 tasks with the exact chunk ranges', async () => {
    const res = await post({ ...readme, from: '2026-11-09', to: '2027-02-06' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ chunks: 3 });
    const { rows } = await db
      .pool()
      .query('SELECT date_from, date_to FROM sync_tasks ORDER BY chunk_index');
    expect(rows).toEqual([
      { date_from: '2026-11-09', date_to: '2026-12-09' },
      { date_from: '2026-12-10', date_to: '2027-01-09' },
      { date_from: '2027-01-10', date_to: '2027-02-06' },
    ]);
  });

  it.each([
    ['a non-existent date', { from: '2026-02-30' }, 'INVALID_DATE'],
    ['to before from', { from: '2026-10-07', to: '2026-10-01' }, 'INVALID_DATE'],
    ['an unknown field', { discount: 10 }, 'INVALID_BODY'],
    ['a bad accommodationId', { accommodationId: '../acc' }, 'INVALID_BODY'],
    ['a string price', { pricePerNight: '120' }, 'INVALID_BODY'],
    ['a 367-day range', { from: '2026-01-01', to: '2027-01-02' }, 'RANGE_TOO_LARGE'],
  ])('H3 / AC2: rejects %s with 400 %s and stores nothing', async (_, change, code) => {
    const res = await post({ ...readme, ...change });
    expect(res.statusCode).toBe(400);
    expect(errorCodeOf(res.json())).toBe(code);
    expect(await rowCounts()).toEqual({ updates: 0, tasks: 0 });
  });

  it.each(['{"accommodationId":', '', 'not json'])(
    'H4 / AC2: malformed JSON (%j) is 400 INVALID_BODY in our error shape',
    async (payload) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(errorCodeOf(res.json())).toBe('INVALID_BODY');
      expect(await rowCounts()).toEqual({ updates: 0, tasks: 0 });
    },
  );

  it.each(['text/plain', 'application/x-www-form-urlencoded'])(
    'H5: Content-Type %s is 415 UNSUPPORTED_MEDIA_TYPE',
    async (contentType) => {
      const res = await post(JSON.stringify(readme), { 'content-type': contentType });
      expect(res.statusCode).toBe(415);
      expect(errorCodeOf(res.json())).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(await rowCounts()).toEqual({ updates: 0, tasks: 0 });
    },
  );

  it('H6: a body over 1 MB is 413 in our error shape', async () => {
    const res = await post({ ...readme, padding: 'x'.repeat(1_100_000) });
    expect(res.statusCode).toBe(413);
    expect(errorCodeOf(res.json())).toBe('PAYLOAD_TOO_LARGE');
  });

  it('H7 / AC1: with the database unavailable it answers 503 + Retry-After, never 202', async () => {
    const deadPool = createPool('postgres://sync:sync@127.0.0.1:1/nowhere', { max: 1 });
    const deadApp = buildApp({ pool: deadPool, maxUpdateRangeDays: 366, logger: false });
    try {
      const res = await deadApp.inject({
        method: 'POST',
        url: '/updates',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(readme),
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(errorCodeOf(res.json())).toBe('UNAVAILABLE');
    } finally {
      await deadApp.close();
      await deadPool.end();
    }
  });

  it.each([
    ['GET', '/nope'],
    ['DELETE', '/updates'],
  ])('H8: %s %s is 404 in our error shape', async (method, url) => {
    const res = await app().inject({ method: method as 'GET' | 'DELETE', url });
    expect(res.statusCode).toBe(404);
    expect(errorCodeOf(res.json())).toBe('NOT_FOUND');
  });
});

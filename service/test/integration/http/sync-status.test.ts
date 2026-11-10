import { describe, expect, it } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { acceptUpdate } from '#src/db/repository.ts';
import { buildApp } from '#src/http/app.ts';
import { errorCodeOf, useApp } from '../../support/app.ts';
import { anUpdate, chunksOf, day } from '../../support/fixtures.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const app = useApp(db);

const accept = async (overrides: Parameters<typeof anUpdate>[0] = {}) => {
  const request = anUpdate(overrides);
  return (await acceptUpdate(db.pool(), request, chunksOf(request))).updateId;
};
const ninetyDays = { from: day('2026-11-09'), to: day('2027-02-06') }; // 3 chunks
/** Simulates the worker: updates one task row of an update. */
const setTask = (updateId: number, chunk: number, fields: Record<string, unknown>) => {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  return db
    .pool()
    .query(`UPDATE sync_tasks SET ${sets} WHERE update_id = $1 AND chunk_index = $2`, [
      updateId,
      chunk,
      ...keys.map((k) => fields[k]),
    ]);
};
const status = async (id: string) => {
  const res = await app().inject({ method: 'GET', url: `/accommodations/${id}/sync-status` });
  return { code: res.statusCode, body: res.json() };
};
const at = (iso: string) => new Date(iso);

describe('GET /accommodations/:id/sync-status', () => {
  it('G1 / AC12: an accommodation with no updates is 404 NOT_FOUND', async () => {
    const res = await status('acc-1003');
    expect(res.code).toBe(404);
    expect(errorCodeOf(res.body)).toBe('NOT_FOUND');
  });

  it.each(['a%20b', 'x'.repeat(65), 'acc.1'])(
    'G2: an id that can never be valid (%s) is 404 NOT_FOUND',
    async (id) => {
      const res = await status(id);
      expect(res.code).toBe(404);
      expect(errorCodeOf(res.body)).toBe('NOT_FOUND');
    },
  );

  it('G3 / AC12: a freshly accepted update reports every field as pending', async () => {
    const updateId = await accept({ ...ninetyDays, pricePerNight: 19.99, available: false });
    const { code, body } = await status('acc-1003');
    expect(code).toBe(200);
    expect(body).toEqual({
      accommodationId: 'acc-1003',
      status: 'pending',
      pendingUpdates: 1,
      failedUpdates: 0,
      lastSyncedAt: null,
      oldestPendingSince: expect.any(String),
      recentUpdates: [
        {
          updateId,
          from: '2026-11-09',
          to: '2027-02-06',
          available: false,
          pricePerNight: 19.99,
          status: 'pending',
          acceptedAt: expect.any(String),
          syncedAt: null,
          chunks: { total: 3, done: 0 },
          attempts: 0,
          lastError: null,
          nextAttemptAt: expect.any(String),
        },
      ],
    });
    expect(body.oldestPendingSince).toBe(body.recentUpdates[0].acceptedAt);
    expect(Number.isNaN(Date.parse(body.recentUpdates[0].nextAttemptAt))).toBe(false);
  });

  it('G4 / AC12: progress on one chunk of three keeps the update pending', async () => {
    const updateId = await accept(ninetyDays);
    await setTask(updateId, 0, { status: 'done', completed_at: at('2026-11-09T10:00:00Z') });
    const { body } = await status('acc-1003');
    expect(body.status).toBe('pending');
    expect(body.recentUpdates[0]).toMatchObject({
      status: 'pending',
      chunks: { total: 3, done: 1 },
    });
  });

  it('G5 / AC12: all chunks done → synced, syncedAt = the last chunk completed', async () => {
    const updateId = await accept(ninetyDays);
    await setTask(updateId, 0, { status: 'done', completed_at: at('2026-11-09T10:00:00Z') });
    await setTask(updateId, 1, { status: 'done', completed_at: at('2026-11-09T10:05:00Z') });
    await setTask(updateId, 2, { status: 'done', completed_at: at('2026-11-09T10:02:00Z') });
    const { body } = await status('acc-1003');
    expect(body).toMatchObject({
      status: 'synced',
      pendingUpdates: 0,
      failedUpdates: 0,
      lastSyncedAt: '2026-11-09T10:05:00.000Z',
      oldestPendingSince: null,
    });
    expect(body.recentUpdates[0]).toMatchObject({
      status: 'synced',
      syncedAt: '2026-11-09T10:05:00.000Z',
      chunks: { total: 3, done: 3 },
      nextAttemptAt: null,
    });
  });

  it('G6 / AC12: a failed chunk → update failed with its error; newest failed → accommodation failed', async () => {
    const older = await accept();
    await setTask(older, 0, { status: 'done', completed_at: at('2026-11-09T09:00:00Z') });
    const newer = await accept(ninetyDays);
    await setTask(newer, 0, { status: 'done', completed_at: at('2026-11-09T10:00:00Z') });
    await setTask(newer, 1, {
      status: 'failed',
      attempts: 1,
      last_error: '404 NOT_FOUND',
      last_http_status: 404,
      last_attempt_at: at('2026-11-09T10:01:00Z'),
      completed_at: at('2026-11-09T10:01:00Z'),
    });
    await setTask(newer, 2, { status: 'failed', last_error: '404 NOT_FOUND' });
    const { body } = await status('acc-1003');
    expect(body).toMatchObject({ status: 'failed', pendingUpdates: 0, failedUpdates: 1 });
    expect(body.lastSyncedAt).toBe('2026-11-09T09:00:00.000Z'); // the older, synced update
    expect(body.recentUpdates[0]).toMatchObject({
      updateId: newer,
      status: 'failed',
      lastError: '404 NOT_FOUND',
      syncedAt: null,
    });
  });

  it('G7: retries in progress — attempts summed, latest error, earliest next attempt', async () => {
    const updateId = await accept(ninetyDays);
    await setTask(updateId, 0, {
      attempts: 2,
      last_error: '503 UNAVAILABLE',
      last_attempt_at: at('2026-11-09T10:00:00Z'),
      next_attempt_at: at('2026-11-09T10:10:00Z'),
    });
    await setTask(updateId, 1, {
      attempts: 3,
      last_error: 'timeout',
      last_attempt_at: at('2026-11-09T10:03:00Z'),
      next_attempt_at: at('2026-11-09T10:04:00Z'),
    });
    const { body } = await status('acc-1003');
    expect(body.recentUpdates[0]).toMatchObject({
      status: 'pending',
      attempts: 5,
      lastError: 'timeout',
      // Chunk 2 has never been tried: its next_attempt_at is its creation time, the earliest.
      nextAttemptAt: expect.any(String),
    });
    await setTask(updateId, 2, { next_attempt_at: at('2026-11-09T10:20:00Z') });
    expect((await status('acc-1003')).body.recentUpdates[0].nextAttemptAt).toBe(
      '2026-11-09T10:04:00.000Z',
    );
  });

  it('G8: 25 updates → the 20 newest, newest first; counts cover all 25', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await accept({ pricePerNight: 100 + i }));
    const { body } = await status('acc-1003');
    expect(body.pendingUpdates).toBe(25);
    expect(body.recentUpdates.map((u: { updateId: number }) => u.updateId)).toEqual(
      ids.slice(5).reverse(),
    );
    // The oldest pending update (#1) is outside the 20 shown, but the summary still covers it.
    const { rows } = await db
      .pool()
      .query('SELECT accepted_at FROM updates WHERE id = $1', [ids[0]]);
    expect(body.oldestPendingSince).toBe((rows[0].accepted_at as Date).toISOString());
  });

  it('G9: updates of other accommodations never appear', async () => {
    await accept({ accommodationId: 'acc-1001' });
    const mine = await accept({ accommodationId: 'acc-1003' });
    await accept({ accommodationId: 'acc-10031' });
    const { body } = await status('acc-1003');
    expect(body.pendingUpdates).toBe(1);
    expect(body.recentUpdates.map((u: { updateId: number }) => u.updateId)).toEqual([mine]);
  });

  it('G10: with the database unavailable it answers 503 without talking about storing updates', async () => {
    const deadPool = createPool('postgres://sync:sync@127.0.0.1:1/nowhere', { max: 1 });
    const deadApp = buildApp({ pool: deadPool, maxUpdateRangeDays: 366, logger: false });
    try {
      const res = await deadApp.inject({
        method: 'GET',
        url: '/accommodations/acc-1003/sync-status',
      });
      expect(res.statusCode).toBe(503);
      expect(errorCodeOf(res.json())).toBe('UNAVAILABLE');
      expect(res.json().error.message).not.toMatch(/stor/i);
    } finally {
      await deadApp.close();
      await deadPool.end();
    }
  });
});

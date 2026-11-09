import { describe, expect, it } from 'vitest';
import {
  claimTask,
  completeTask,
  failTask,
  rescheduleTask,
  type ClaimedTask,
} from '#src/db/queue.ts';
import { acceptUpdate } from '#src/db/repository.ts';
import { anUpdate, chunksOf, day } from '../../support/fixtures.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const LEASE = { leaseMs: 30_000 };
const accept = async (overrides: Parameters<typeof anUpdate>[0] = {}) => {
  const request = anUpdate(overrides);
  return (await acceptUpdate(db.pool(), request, chunksOf(request))).updateId;
};
const claim = () => claimTask(db.pool(), LEASE);
const task = async (id: number) =>
  (await db.pool().query('SELECT * FROM sync_tasks WHERE id = $1', [id])).rows[0];
const tasksOf = async (updateId: number) =>
  (
    await db
      .pool()
      .query('SELECT * FROM sync_tasks WHERE update_id = $1 ORDER BY chunk_index', [updateId])
  ).rows;
const ninety = { from: day('2026-11-09'), to: day('2027-02-06') }; // 3 chunks

describe('claimTask', () => {
  it('Q1 / D1: returns only the head of each accommodation queue', async () => {
    const a1 = await accept({ accommodationId: 'acc-1001', ...ninety });
    await accept({ accommodationId: 'acc-1001' });
    const b1 = await accept({ accommodationId: 'acc-1002' });
    const first = await claim();
    const second = await claim();
    expect(await claim()).toBeNull(); // both heads are now in flight
    expect([first?.updateId, second?.updateId].sort()).toEqual([a1, b1].sort());
    expect([first?.chunkIndex, second?.chunkIndex]).toEqual([0, 0]);
  });

  it('Q2 / D6: sets the lease, increments attempts and returns everything needed to send', async () => {
    const updateId = await accept({ ...ninety, available: false, pricePerNight: 19.99 });
    const before = Date.now();
    const claimed = await claim();
    expect(claimed).toEqual({
      taskId: expect.any(Number),
      updateId,
      accommodationId: 'acc-1003',
      chunkIndex: 0,
      from: '2026-11-09',
      to: '2026-12-09',
      available: false,
      pricePerNight: 19.99,
      attempt: 1,
    });
    const row = await task(claimed!.taskId);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    const leaseLeft = (row.locked_until as Date).getTime() - before;
    expect(leaseLeft).toBeGreaterThan(25_000);
    expect(leaseLeft).toBeLessThan(35_000);
    expect(row.last_attempt_at).not.toBeNull();
  });

  it('Q3 / D1: a leased head blocks its own accommodation only', async () => {
    await accept({ accommodationId: 'acc-1001' });
    await accept({ accommodationId: 'acc-1001' });
    const head = await claim(); // acc-1001's first update, now in flight
    expect(await claim()).toBeNull(); // acc-1001's second update must wait
    const other = await accept({ accommodationId: 'acc-1002' });
    expect((await claim())?.updateId).toBe(other);
    expect(head?.accommodationId).toBe('acc-1001');
  });

  it('Q4 / D6: concurrent claimers never share a task and keep one in flight per accommodation', async () => {
    for (const acc of ['acc-1001', 'acc-1002', 'acc-1003', 'acc-1004']) {
      for (let i = 0; i < 3; i++) await accept({ accommodationId: acc, pricePerNight: 100 + i });
    }
    const claims = (await Promise.all(Array.from({ length: 10 }, () => claim()))).filter(
      (c): c is ClaimedTask => c !== null,
    );
    expect(claims).toHaveLength(4);
    expect(new Set(claims.map((c) => c.taskId)).size).toBe(4);
    expect(new Set(claims.map((c) => c.accommodationId)).size).toBe(4);
    for (const c of claims) expect(c.pricePerNight).toBe(100); // the head: the first accepted
  });

  it('Q11 / D6: a head row locked by another transaction does not block claiming other accommodations', async () => {
    const locked = await accept({ accommodationId: 'acc-1001' });
    const free = await accept({ accommodationId: 'acc-1002' });
    const holder = await db.pool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sync_tasks WHERE update_id = $1 FOR UPDATE', [locked]);
      const started = Date.now();
      const claimed = await claim();
      expect(claimed?.updateId).toBe(free);
      expect(Date.now() - started).toBeLessThan(1_000); // skipped, not waited for
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('Q5 / D6, AC7: a task whose lease expired is claimable again', async () => {
    await accept();
    const first = await claim();
    await db.pool().query("UPDATE sync_tasks SET locked_until = now() - interval '1 second'");
    const again = await claim();
    expect(again?.taskId).toBe(first?.taskId);
    expect(again?.attempt).toBe(2);
  });

  it('Q6: tasks not yet due are skipped; due tasks come oldest-due first', async () => {
    const later = await accept({ accommodationId: 'acc-1001' });
    const sooner = await accept({ accommodationId: 'acc-1002' });
    const notYet = await accept({ accommodationId: 'acc-1003' });
    await db
      .pool()
      .query(
        "UPDATE sync_tasks SET next_attempt_at = now() - interval '10 seconds' WHERE update_id = $1",
        [sooner],
      );
    await db
      .pool()
      .query(
        "UPDATE sync_tasks SET next_attempt_at = now() - interval '5 seconds' WHERE update_id = $1",
        [later],
      );
    await db
      .pool()
      .query(
        "UPDATE sync_tasks SET next_attempt_at = now() + interval '1 hour' WHERE update_id = $1",
        [notYet],
      );
    expect((await claim())?.updateId).toBe(sooner);
    expect((await claim())?.updateId).toBe(later);
    expect(await claim()).toBeNull();
  });
});

describe('completeTask / rescheduleTask / failTask', () => {
  it('Q7: complete marks done, clears the lease and the last error', async () => {
    await accept();
    const claimed = (await claim())!;
    await rescheduleTask(db.pool(), claimed, {
      at: Date.now() - 1,
      error: '503 UNAVAILABLE',
      httpStatus: 503,
    });
    const retry = (await claim())!;
    expect(await completeTask(db.pool(), retry, { httpStatus: 200 })).toBe(true);
    expect(await task(retry.taskId)).toMatchObject({
      status: 'done',
      locked_until: null,
      last_error: null,
      last_http_status: 200,
      completed_at: expect.any(Date),
    });
  });

  it('Q8: reschedule keeps it pending with the next attempt time and the error', async () => {
    await accept();
    const claimed = (await claim())!;
    const at = Date.now() + 60_000;
    expect(
      await rescheduleTask(db.pool(), claimed, {
        at,
        error: 'timeout after 5000 ms',
        httpStatus: null,
      }),
    ).toBe(true);
    const row = await task(claimed.taskId);
    expect(row).toMatchObject({
      status: 'pending',
      locked_until: null,
      last_error: 'timeout after 5000 ms',
      last_http_status: null,
    });
    expect(Math.abs((row.next_attempt_at as Date).getTime() - at)).toBeLessThan(5);
    expect(await claim()).toBeNull(); // not due for a minute
  });

  it('Q9 / D4: fail marks the task and its pending siblings failed together; the next update becomes the head', async () => {
    const failing = await accept({ ...ninety });
    const next = await accept();
    const first = (await claim())!; // chunk 0 of `failing`
    expect(await completeTask(db.pool(), first, { httpStatus: 200 })).toBe(true);
    const second = (await claim())!; // chunk 1
    const error = '404 NOT_FOUND: Accommodation acc-1003 not found';
    expect(await failTask(db.pool(), second, { error, httpStatus: 404 })).toBe(true);
    expect((await tasksOf(failing)).map((t) => [t.status, t.last_error])).toEqual([
      ['done', null],
      ['failed', error],
      ['failed', error],
    ]);
    expect((await claim())?.updateId).toBe(next);
  });

  it('Q10 / D6: a stale token cannot complete, reschedule or fail; the newer claim wins', async () => {
    await accept();
    const stale = (await claim())!;
    await db.pool().query("UPDATE sync_tasks SET locked_until = now() - interval '1 second'");
    const current = (await claim())!;
    expect(current.attempt).toBe(stale.attempt + 1);
    expect(await completeTask(db.pool(), stale, { httpStatus: 200 })).toBe(false);
    expect(
      await rescheduleTask(db.pool(), stale, { at: Date.now(), error: 'x', httpStatus: 503 }),
    ).toBe(false);
    expect(await failTask(db.pool(), stale, { error: 'x', httpStatus: 404 })).toBe(false);
    expect((await task(current.taskId)).status).toBe('pending');
    expect(await completeTask(db.pool(), current, { httpStatus: 200 })).toBe(true);
  });
});

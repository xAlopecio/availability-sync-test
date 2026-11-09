import { describe, expect, it } from 'vitest';
import { ACCOMMODATION_LOCK_SQL, acceptUpdate } from '#src/db/repository.ts';
import { anUpdate, chunksOf, day } from '../../support/fixtures.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const count = async (table: 'updates' | 'sync_tasks') =>
  Number((await db.pool().query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

describe('acceptUpdate', () => {
  it('P1 / AC1: stores the update and one pending task per chunk', async () => {
    const request = anUpdate({ from: day('2026-11-09'), to: day('2027-02-06') }); // 90 days
    const before = Date.now();
    const accepted = await acceptUpdate(db.pool(), request, chunksOf(request));
    expect(accepted).toEqual({ updateId: 1, chunks: 3 });

    const update = (await db.pool().query('SELECT * FROM updates')).rows;
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({
      id: 1,
      accommodation_id: 'acc-1003',
      date_from: '2026-11-09',
      date_to: '2027-02-06',
      available: true,
      price_per_night: 120,
    });

    const tasks = (await db.pool().query('SELECT * FROM sync_tasks ORDER BY id')).rows;
    expect(tasks.map((t) => [t.chunk_index, t.date_from, t.date_to])).toEqual([
      [0, '2026-11-09', '2026-12-09'],
      [1, '2026-12-10', '2027-01-09'],
      [2, '2027-01-10', '2027-02-06'],
    ]);
    for (const task of tasks) {
      expect(task).toMatchObject({
        update_id: 1,
        accommodation_id: 'acc-1003',
        status: 'pending',
        attempts: 0,
        locked_until: null,
        last_attempt_at: null,
      });
      expect((task.next_attempt_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
      expect((task.next_attempt_at as Date).getTime()).toBeGreaterThan(before - 5_000);
    }
  });

  it('P2 / AC1: if a task cannot be stored, the update is not stored either', async () => {
    const request = anUpdate();
    // A 40-day chunk violates the ≤ 31-day CHECK on sync_tasks, after the update row is inserted.
    const badChunks = [{ from: day('2026-12-01'), to: day('2027-01-09') }];
    // Require the constraint error: a generic failure would pass without any transaction at all.
    await expect(acceptUpdate(db.pool(), request, badChunks)).rejects.toThrow(
      /sync_tasks_range_valid/,
    );
    expect(await count('updates')).toBe(0);
    expect(await count('sync_tasks')).toBe(0);
  });

  it('P3 / D1: concurrent accepts for one accommodation get task ids in commit order', async () => {
    const requests = Array.from({ length: 20 }, (_, i) =>
      anUpdate({ from: day('2026-11-09'), to: day('2027-02-06'), pricePerNight: 100 + i }),
    );
    await Promise.all(requests.map((r) => acceptUpdate(db.pool(), r, chunksOf(r))));
    const tasks = (
      await db
        .pool()
        .query<{ update_id: number; chunk_index: number }>(
          'SELECT update_id, chunk_index FROM sync_tasks ORDER BY id',
        )
    ).rows;
    const byQueueOrder = [...tasks].sort(
      (a, b) => a.update_id - b.update_id || a.chunk_index - b.chunk_index,
    );
    expect(tasks).toHaveLength(60);
    expect(tasks).toEqual(byQueueOrder);
  });

  it('P4 / D1: the lock is per accommodation — another accommodation is not blocked', async () => {
    const holder = await db.pool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(ACCOMMODATION_LOCK_SQL, ['acc-1001']); // acc-1001 is now locked

      const other = anUpdate({ accommodationId: 'acc-1002' });
      await expect(acceptUpdate(db.pool(), other, chunksOf(other))).resolves.toBeDefined();

      const same = anUpdate({ accommodationId: 'acc-1001' });
      let finished = false;
      const blocked = acceptUpdate(db.pool(), same, chunksOf(same)).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false); // waiting for acc-1001's lock

      await holder.query('COMMIT');
      await blocked;
      expect(finished).toBe(true);
    } finally {
      holder.release();
    }
  });

  it.each([19.99, 0.07, 1_000_000, 0])(
    'P5: pricePerNight %s is read back exactly',
    async (pricePerNight) => {
      const request = anUpdate({ pricePerNight });
      await acceptUpdate(db.pool(), request, chunksOf(request));
      const { rows } = await db.pool().query('SELECT price_per_night FROM updates');
      expect(rows[0].price_per_night).toBe(pricePerNight);
    },
  );

  it('P6: DATE columns come back as the exact YYYY-MM-DD string, whatever the time zone', async () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Madrid');
    const request = anUpdate({ from: day('2026-10-25'), to: day('2026-10-25') }); // DST change day
    await acceptUpdate(db.pool(), request, chunksOf(request));
    const { rows } = await db.pool().query('SELECT date_from, date_to FROM sync_tasks');
    expect(rows[0]).toEqual({ date_from: '2026-10-25', date_to: '2026-10-25' });
  });
});

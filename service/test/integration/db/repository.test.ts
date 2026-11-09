import { describe, expect, it } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { databaseUrl } from '../../support/test-db.ts';
import {
  ACCOMMODATION_LOCK_SQL,
  acceptUpdate,
  IdempotencyKeyReusedError,
} from '#src/db/repository.ts';
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
    expect(accepted).toEqual({ updateId: 1, chunks: 3, replayed: false });

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

describe('createPool', () => {
  it('P7: every connection has statement_timeout 10s and lock_timeout 5s', async () => {
    const pool = createPool(databaseUrl(), { max: 1 });
    try {
      const client = await pool.connect();
      try {
        const statement = (await client.query('SHOW statement_timeout')).rows[0].statement_timeout;
        const lock = (await client.query('SHOW lock_timeout')).rows[0].lock_timeout;
        expect({ statement, lock }).toEqual({ statement: '10s', lock: '5s' });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe('acceptUpdate with an Idempotency-Key (P8)', () => {
  const accept = (request = anUpdate(), idempotencyKey?: string) =>
    acceptUpdate(db.pool(), request, chunksOf(request), idempotencyKey ? { idempotencyKey } : {});

  it('P8: a new key is stored with the update', async () => {
    expect(await accept(anUpdate(), 'k-1')).toEqual({ updateId: 1, chunks: 1, replayed: false });
    const { rows } = await db.pool().query('SELECT idempotency_key FROM updates');
    expect(rows).toEqual([{ idempotency_key: 'k-1' }]);
  });

  it('P8: the same key and body returns the original update and stores nothing', async () => {
    const request = anUpdate({ from: day('2026-11-09'), to: day('2027-02-06') });
    const first = await accept(request, 'k-1');
    expect(await accept(request, 'k-1')).toEqual({ ...first, replayed: true });
    expect([await count('updates'), await count('sync_tasks')]).toEqual([1, 3]);
  });

  it('P8: the same key with a different body is a conflict and stores nothing', async () => {
    await accept(anUpdate({ pricePerNight: 120 }), 'k-1');
    await expect(accept(anUpdate({ pricePerNight: 130 }), 'k-1')).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    expect(await count('updates')).toBe(1);
  });

  it('P8: concurrent requests with the same key and body store exactly one update', async () => {
    const request = anUpdate();
    const results = await Promise.all(Array.from({ length: 10 }, () => accept(request, 'k-1')));
    expect(await count('updates')).toBe(1);
    expect(new Set(results.map((r) => r.updateId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('P8: concurrent use of one key for two accommodations stores one and rejects the other', async () => {
    const outcomes = await Promise.allSettled([
      accept(anUpdate({ accommodationId: 'acc-1001' }), 'k-1'),
      accept(anUpdate({ accommodationId: 'acc-1002' }), 'k-1'),
    ]);
    expect(await count('updates')).toBe(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('P8: without a key, identical requests are two updates (nothing is deduplicated)', async () => {
    await accept();
    await accept();
    expect(await count('updates')).toBe(2);
  });
});

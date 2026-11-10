import { describe, expect, it } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { acceptUpdate } from '#src/db/repository.ts';
import { buildApp } from '#src/http/app.ts';
import { useApp } from '../../support/app.ts';
import { parseExposition, valueOf } from '../../support/exposition.ts';
import { anUpdate, chunksOf } from '../../support/fixtures.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const app = useApp(db);
const accept = async (accommodationId: string) => {
  const request = anUpdate({ accommodationId });
  return (await acceptUpdate(db.pool(), request, chunksOf(request))).updateId;
};
const sql = (text: string, params: unknown[] = []) => db.pool().query(text, params);
const scrape = async () =>
  parseExposition((await app().inject({ method: 'GET', url: '/metrics' })).body);
const pendingByState = async () => {
  const { samples } = await scrape();
  return Object.fromEntries(
    samples.filter((s) => s.name === 'sync_tasks_pending').map((s) => [s.labels['state'], s.value]),
  );
};

describe('queue state at scrape', () => {
  it('Q1 / AC13: every pending task falls in exactly one state', async () => {
    await accept('acc-1001'); // ready
    const b1 = await accept('acc-1002');
    await accept('acc-1002'); // queued behind b1
    const c1 = await accept('acc-1003');
    const d1 = await accept('acc-1004');
    await accept('acc-1004'); // overlaps d1: held while d1's timeout is recent
    await sql(
      "UPDATE sync_tasks SET locked_until = now() + interval '1 minute', attempts = 1 WHERE update_id = $1",
      [b1],
    );
    await sql(
      "UPDATE sync_tasks SET next_attempt_at = now() + interval '1 hour', attempts = 1 WHERE update_id = $1",
      [c1],
    );
    await sql(
      "UPDATE sync_tasks SET status = 'done', completed_at = now(), last_timeout_at = now(), attempts = 2 WHERE update_id = $1",
      [d1],
    );
    expect(await pendingByState()).toEqual({
      ready: 1,
      in_flight: 1,
      waiting_retry: 1,
      held_settle: 1,
      queued: 1,
    });
  });

  it('Q2 / AC13: the oldest pending age is measured from accepted_at', async () => {
    const old = await accept('acc-1001');
    await accept('acc-1002');
    await sql("UPDATE updates SET accepted_at = now() - interval '600 seconds' WHERE id = $1", [
      old,
    ]);
    await sql('UPDATE sync_tasks SET last_attempt_at = now(), attempts = 5 WHERE update_id = $1', [
      old,
    ]); // retried just now
    const age = valueOf((await scrape()).samples, 'sync_oldest_pending_task_age_seconds');
    expect(age).toBeGreaterThanOrEqual(599);
    expect(age).toBeLessThan(610);
  });

  it('Q3: nothing pending → every state 0 and age 0', async () => {
    const { samples } = await scrape();
    expect(await pendingByState()).toEqual({
      ready: 0,
      in_flight: 0,
      waiting_retry: 0,
      held_settle: 0,
      queued: 0,
    });
    expect(valueOf(samples, 'sync_oldest_pending_task_age_seconds')).toBe(0);
    expect(valueOf(samples, 'sync_metrics_db_up')).toBe(1);
  });

  it('Q4: stuck heads count heads with 10+ attempts; the max covers heads only', async () => {
    const a = await accept('acc-1001');
    const b = await accept('acc-1002');
    const behind = await accept('acc-1002');
    await sql('UPDATE sync_tasks SET attempts = 12 WHERE update_id = $1', [a]);
    await sql('UPDATE sync_tasks SET attempts = 3 WHERE update_id = $1', [b]);
    await sql('UPDATE sync_tasks SET attempts = 50 WHERE update_id = $1', [behind]); // not a head
    const { samples } = await scrape();
    expect(valueOf(samples, 'sync_stuck_heads', { min_attempts: '10' })).toBe(1);
    expect(valueOf(samples, 'sync_head_attempts_max')).toBe(12);
  });

  it('Q5: with the database down /metrics still answers; DB gauges are absent, not a false 0', async () => {
    const pool = createPool('postgres://sync:sync@127.0.0.1:1/nowhere', { max: 1 });
    const dead = buildApp({ pool, maxUpdateRangeDays: 366, logger: false });
    try {
      const res = await dead.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      const { types, samples } = parseExposition(res.body);
      // It must be reported as 0, not merely missing (valueOf would read a missing metric as 0).
      expect(samples.filter((x) => x.name === 'sync_metrics_db_up').map((x) => x.value)).toEqual([
        0,
      ]);
      for (const name of [
        'sync_tasks_pending',
        'sync_oldest_pending_task_age_seconds',
        'sync_stuck_heads',
        'sync_head_attempts_max',
      ]) {
        expect(types.has(name)).toBe(false);
      }
      expect(types.get('portal_requests_total')).toBe('counter'); // the process metrics are still there
    } finally {
      await dead.close();
      await pool.end();
    }
  });
});

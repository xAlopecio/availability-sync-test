import type pg from 'pg';
import type { DateRange } from '../domain/calendar/chunking.ts';
import type { TaskStatus } from '../domain/updates/sync-status.ts';
import type { UpdateRequest } from '../domain/updates/update-validation.ts';

/**
 * Serialises inserts per accommodation (D1) so ids are allocated in commit order. Two-key form,
 * so it can never collide with the single-key migration lock.
 */
export const ACCOMMODATION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(1, hashtext($1))';

export type AcceptedUpdate = { readonly updateId: number; readonly chunks: number };

/** Stores an update and its ≤ 31-day tasks in one transaction (D2). */
export async function acceptUpdate(
  pool: pg.Pool,
  request: UpdateRequest,
  chunks: readonly DateRange[],
): Promise<AcceptedUpdate> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Taken before any id is allocated, so ids for one accommodation follow commit order (D1).
    await client.query(ACCOMMODATION_LOCK_SQL, [request.accommodationId]);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO updates (accommodation_id, date_from, date_to, available, price_per_night)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [request.accommodationId, request.from, request.to, request.available, request.pricePerNight],
    );
    const updateId = rows[0]!.id;
    // One insert per chunk, in order: at most 12 for a 366-day update.
    for (const [index, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO sync_tasks (update_id, accommodation_id, chunk_index, date_from, date_to)
         VALUES ($1, $2, $3, $4, $5)`,
        [updateId, request.accommodationId, index, chunk.from, chunk.to],
      );
    }
    await client.query('COMMIT');
    return { updateId, chunks: chunks.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One accepted update with its tasks aggregated, for `sync-status` (SPEC §6). */
export type UpdateSummary = {
  readonly updateId: number;
  readonly from: string;
  readonly to: string;
  readonly available: boolean;
  readonly pricePerNight: number;
  readonly acceptedAt: Date;
  /** Task statuses in chunk order (never empty). */
  readonly taskStatuses: readonly [TaskStatus, ...TaskStatus[]];
  readonly chunksDone: number;
  /** Sum of the tasks' attempts. */
  readonly attempts: number;
  /** Error of the most recent attempt (`last_attempt_at`), if any. */
  readonly lastError: string | null;
  /** Earliest `next_attempt_at` among pending tasks. */
  readonly nextAttemptAt: Date | null;
  /** Latest `completed_at` among the tasks. */
  readonly lastCompletedAt: Date | null;
};

/** Every update of an accommodation, newest first. */
export async function listUpdateSummaries(
  _pool: pg.Pool,
  _accommodationId: string,
): Promise<UpdateSummary[]> {
  throw new Error('not implemented');
}

import type pg from 'pg';
import type { DateRange } from '../domain/calendar/chunking.ts';
import type { TaskStatus } from '../domain/updates/sync-status.ts';
import type { UpdateRequest } from '../domain/updates/update-validation.ts';

/**
 * Serialises inserts per accommodation (D1) so ids are allocated in commit order. Two-key form,
 * so it can never collide with the single-key migration lock.
 */
export const ACCOMMODATION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(1, hashtext($1))';

export type AcceptedUpdate = {
  readonly updateId: number;
  readonly chunks: number;
  /** True when an earlier request with the same Idempotency-Key was returned instead. */
  readonly replayed: boolean;
};

/** The Idempotency-Key was already used for a different update (SPEC §6, 422). */
export class IdempotencyKeyReusedError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      `Idempotency-Key ${JSON.stringify(idempotencyKey)} was already used for a different update`,
    );
    this.name = 'IdempotencyKeyReusedError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** Stores an update and its ≤ 31-day tasks in one transaction (D2). */
export async function acceptUpdate(
  pool: pg.Pool,
  request: UpdateRequest,
  chunks: readonly DateRange[],
  _options: { idempotencyKey?: string } = {},
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
    return { updateId, chunks: chunks.length, replayed: false };
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
  pool: pg.Pool,
  accommodationId: string,
): Promise<UpdateSummary[]> {
  const { rows } = await pool.query(
    `SELECT u.id AS update_id, u.date_from, u.date_to, u.available, u.price_per_night,
            u.accepted_at,
            array_agg(t.status ORDER BY t.chunk_index) AS task_statuses,
            count(*) FILTER (WHERE t.status = 'done') AS chunks_done,
            sum(t.attempts) AS attempts,
            (array_agg(t.last_error ORDER BY t.last_attempt_at DESC)
               FILTER (WHERE t.last_attempt_at IS NOT NULL))[1] AS last_error,
            min(t.next_attempt_at) FILTER (WHERE t.status = 'pending') AS next_attempt_at,
            max(t.completed_at) AS last_completed_at
       FROM updates u
       JOIN sync_tasks t ON t.update_id = u.id
      WHERE u.accommodation_id = $1
      GROUP BY u.id
      ORDER BY u.id DESC`,
    [accommodationId],
  );
  return rows.map((row) => ({
    updateId: row.update_id,
    from: row.date_from,
    to: row.date_to,
    available: row.available,
    pricePerNight: row.price_per_night,
    acceptedAt: row.accepted_at,
    taskStatuses: row.task_statuses,
    chunksDone: row.chunks_done,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    lastCompletedAt: row.last_completed_at,
  }));
}

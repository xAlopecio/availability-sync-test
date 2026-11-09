import type pg from 'pg';
import type { DateRange } from '../domain/calendar/chunking.ts';
import type { UpdateRequest } from '../domain/updates/update-validation.ts';

/**
 * Serialises inserts per accommodation (D1) so ids are allocated in commit order. Two-key form,
 * so it can never collide with the single-key migration lock.
 */
export const ACCOMMODATION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(1, hashtext($1))';

export type AcceptedUpdate = { readonly updateId: number; readonly chunks: number };

/** Stores an update and its ≤ 31-day tasks in one transaction (D2). */
export async function acceptUpdate(
  _pool: pg.Pool,
  _request: UpdateRequest,
  _chunks: readonly DateRange[],
): Promise<AcceptedUpdate> {
  throw new Error('not implemented');
}

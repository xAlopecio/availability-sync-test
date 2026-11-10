import type pg from 'pg';
import type { Registry } from 'prom-client';

export const PENDING_STATES = [
  'ready',
  'in_flight',
  'waiting_retry',
  'held_settle',
  'queued',
] as const;
export const STUCK_HEAD_ATTEMPTS = 10;

export type QueueState = {
  readonly pending: Record<(typeof PENDING_STATES)[number], number>;
  readonly oldestPendingAgeSeconds: number;
  readonly stuckHeads: number;
  readonly headAttemptsMax: number;
};

export async function readQueueState(_pool: pg.Pool, _settleMs: number): Promise<QueueState> {
  throw new Error('not implemented');
}

/**
 * The DB-derived gauges, in a registry built for one scrape: if the database cannot be read they
 * are absent (prom-client always prints an unlabelled gauge, even after reset(), so a long-lived
 * gauge would report a false 0).
 */
export function queueStateRegistry(_state: QueueState | null): Registry {
  throw new Error('not implemented');
}

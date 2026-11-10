import pg from 'pg';

const { builtins } = pg.types;

/** Parsers that differ from pg's defaults. Everything else falls through to pg. */
const PARSERS: Partial<Record<number, (value: string) => unknown>> = {
  // pg's default turns a DATE into a JS Date at *local* midnight: east of UTC, '2026-10-01' would
  // read back as 2026-09-30T22:00Z. Calendar days stay strings end to end.
  [builtins.DATE]: (value) => value,
  // numeric(12,2) and bigint come back as strings by default. Both fit in a double here
  // (prices ≤ 1,000,000 with 2 decimals; ids and counts far below 2^53).
  [builtins.NUMERIC]: Number,
  [builtins.INT8]: Number,
};

/**
 * A pool whose type parsers return what the domain expects (SPEC D8): `DATE` as the raw
 * `YYYY-MM-DD` string, `NUMERIC` and `INT8` as numbers. Scoped to this pool, never global.
 */
export function createPool(
  connectionString: string,
  options: {
    max?: number;
    connectionTimeoutMs?: number;
    statementTimeoutMs?: number;
    lockTimeoutMs?: number;
    /** Called when an idle pooled connection fails (e.g. the server terminated it). */
    onError?: (error: Error) => void;
  } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Without a timeout, a hung database would hang every request instead of answering 503.
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    // Server-side limits per connection (SPEC §8): nothing waits indefinitely on a stuck query or
    // on another transaction's lock (for example the per-accommodation advisory lock).
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        PARSERS[oid] ?? pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  // An idle client that errors (database restart, failover, pg_terminate_backend) is emitted on
  // the pool. Unhandled, that 'error' event crashes the whole process; handled, the pool drops the
  // client and the next query opens a new connection (SPEC §8, runtime resilience).
  pool.on('error', (error) => options.onError?.(error));
  return pool;
}

/**
 * Waits until the database answers, retrying with backoff (250 ms doubling, capped at 2 s) for at
 * most `timeoutMs`. Throws the last error when the window is over (SPEC §8, startup).
 */
export async function waitForDatabase(
  pool: pg.Pool,
  options: { timeoutMs: number; onRetry?: (error: unknown, attempt: number) => void },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      options.onRetry?.(error, attempt);
      const delay = Math.min(250 * 2 ** (attempt - 1), 2_000, remaining);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

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
  options: { max?: number; connectionTimeoutMs?: number } = {},
): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Without a timeout, a hung database would hang every request instead of answering 503.
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        PARSERS[oid] ?? pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
}

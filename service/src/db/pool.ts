import pg from 'pg';

/**
 * A pool whose type parsers return what the domain expects (SPEC D8): `DATE` as the raw
 * `YYYY-MM-DD` string, `NUMERIC` and `INT8` as numbers. Scoped to this pool, never global.
 */
export function createPool(connectionString: string, options: { max?: number } = {}): pg.Pool {
  // Stub: a plain pool with pg's default (global) parsers — P5/P6 must fail against it.
  return new pg.Pool({ connectionString, max: options.max ?? 10 });
}

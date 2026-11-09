import type pg from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { migrate } from '#src/db/migrate.ts';
import { databaseUrl } from './test-db.ts';

/**
 * For integration test files that need the schema: one pool on `sync_test` (recreated by the
 * global setup), migrated once, with empty tables before every test.
 */
export function useMigratedDatabase(): { readonly pool: () => pg.Pool } {
  let pool: pg.Pool | undefined;
  beforeAll(async () => {
    pool = createPool(databaseUrl(), { max: 10 });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool!.query('TRUNCATE sync_tasks, updates RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
  });
  return {
    pool: () => {
      if (!pool) throw new Error('pool used outside a test');
      return pool;
    },
  };
}

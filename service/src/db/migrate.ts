import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory of the numbered `.sql` migrations shipped with the service. */
export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** Arbitrary but fixed: every instance contends for the same advisory lock. */
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies pending migrations in numeric order, each in its own transaction, recorded in
 * `schema_migrations`. Safe to run concurrently from several instances (advisory lock).
 * Returns the names of the files applied by this call.
 */
export async function migrate(
  pool: pg.Pool,
  options: { dir?: URL | string } = {},
): Promise<string[]> {
  const dirOption = options.dir ?? MIGRATIONS_DIR;
  const dir = dirOption instanceof URL ? fileURLToPath(dirOption) : dirOption;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => numericPrefix(a) - numericPrefix(b) || a.localeCompare(b));

  const client = await pool.connect();
  try {
    // Session-level lock: a second instance waits here until the first has finished.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    const applied: string[] = [];
    for (const file of files.filter((name) => !done.has(name))) {
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

function numericPrefix(name: string): number {
  const match = /^(\d+)/.exec(name);
  if (!match) throw new Error(`migration file must start with a number: ${name}`);
  return Number(match[1]);
}

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '#src/db/migrate.ts';
import { createScratchDatabase, databaseUrl, dropDatabase } from '../../support/test-db.ts';

let dbName: string;
let pools: pg.Pool[] = [];
const newPool = () => {
  const pool = new pg.Pool({ connectionString: databaseUrl(dbName), max: 2 });
  pools.push(pool);
  return pool;
};
const tablesOf = async (pool: pg.Pool) =>
  (
    await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    )
  ).rows.map((r) => r.table_name);
const recorded = async (pool: pg.Pool) =>
  (await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
    (r) => r.name,
  );
const migrationsDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

beforeEach(async () => {
  dbName = await createScratchDatabase();
});
afterEach(async () => {
  await Promise.all(pools.map((p) => p.end()));
  pools = [];
  await dropDatabase(dbName);
});

describe('migrate', () => {
  it('M1: applies the shipped migrations to a fresh database and records them', async () => {
    const pool = newPool();
    const applied = await migrate(pool);
    expect(applied.length).toBeGreaterThan(0);
    expect(await tablesOf(pool)).toEqual(['schema_migrations', 'sync_tasks', 'updates']);
    expect(await recorded(pool)).toEqual([...applied].sort());
    const columns = (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'sync_tasks'`,
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(['last_attempt_at', 'locked_until', 'next_attempt_at', 'attempts']),
    );
  });

  it('M1: applies files in numeric order (2 before 10)', async () => {
    const pool = newPool();
    const dir = migrationsDir({
      '10_third.sql': "INSERT INTO trail VALUES ('10');",
      '1_first.sql': 'CREATE TABLE trail (step text, at serial);',
      '2_second.sql': "INSERT INTO trail VALUES ('2');",
    });
    expect(await migrate(pool, { dir })).toEqual(['1_first.sql', '2_second.sql', '10_third.sql']);
    const steps = (await pool.query<{ step: string }>('SELECT step FROM trail ORDER BY at')).rows;
    expect(steps.map((r) => r.step)).toEqual(['2', '10']);
  });

  it('M2: running twice is a no-op the second time', async () => {
    const pool = newPool();
    const first = await migrate(pool);
    expect(await migrate(pool)).toEqual([]);
    expect(await recorded(pool)).toEqual([...first].sort());
  });

  it('M3: two instances migrating at the same time apply each file exactly once', async () => {
    const [a, b] = [newPool(), newPool()];
    const [appliedA, appliedB] = await Promise.all([migrate(a), migrate(b)]);
    const all = [...appliedA, ...appliedB].sort();
    expect(all).toEqual(await recorded(a)); // every file applied once, by one of them
    expect(new Set(all).size).toBe(all.length);
  });

  it('M4: a failing migration is rolled back, not recorded, and earlier ones stay', async () => {
    const pool = newPool();
    const dir = migrationsDir({
      '001_ok.sql': 'CREATE TABLE kept (id int);',
      '002_broken.sql': 'CREATE TABLE half (id int);\nSELECT * FROM no_such_table;',
    });
    await expect(migrate(pool, { dir })).rejects.toThrow(/002_broken\.sql/);
    expect(await tablesOf(pool)).toEqual(['kept', 'schema_migrations']); // `half` rolled back
    expect(await recorded(pool)).toEqual(['001_ok.sql']);
  });
});

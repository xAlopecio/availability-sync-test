import { describe, expect, it } from 'vitest';
import { createPool } from '#src/db/pool.ts';
import { buildApp } from '#src/http/app.ts';
import { errorCodeOf, useApp } from '../../support/app.ts';
import { parseExposition } from '../../support/exposition.ts';
import { useMigratedDatabase } from '../../support/migrated-db.ts';

const db = useMigratedDatabase();
const app = useApp(db);

describe('GET /metrics', () => {
  it('M1 / AC13: serves the Prometheus text format with the service metrics', async () => {
    const res = await app().inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    const { types } = parseExposition(res.body);
    expect(types.get('portal_requests_total')).toBe('counter');
    expect(types.get('sync_worker_active')).toBe('gauge');
  });
});

describe('health and readiness', () => {
  const dead = () => {
    const pool = createPool('postgres://sync:sync@127.0.0.1:1/nowhere', { max: 1 });
    return { pool, app: buildApp({ pool, maxUpdateRangeDays: 366, logger: false }) };
  };

  it('H1: /health is 200 whenever the process serves HTTP, even with the database down', async () => {
    expect((await app().inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
    });
    const d = dead();
    try {
      const res = await d.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    } finally {
      await d.app.close();
      await d.pool.end();
    }
  });

  it('H2: /ready is 200 with the database up, reporting the worker state', async () => {
    const res = await app().inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', database: 'up', worker: 'disabled' });
  });

  it('H3: /ready is 503 in the error shape when the database is down', async () => {
    const d = dead();
    try {
      const res = await d.app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      expect(errorCodeOf(res.json())).toBe('NOT_READY');
    } finally {
      await d.app.close();
      await d.pool.end();
    }
  });
});

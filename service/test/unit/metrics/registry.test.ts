import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMetrics, OUTCOMES } from '#src/metrics/registry.ts';
import { parseExposition } from '../../support/exposition.ts';

const expose = async () => parseExposition(await createMetrics().registry.metrics());

describe('createMetrics', () => {
  it('M1 / AC13: declares every SPEC §7 instrument with the right type', async () => {
    const { types } = await expose();
    expect(
      Object.fromEntries([...types].filter(([name]) => !/^(process|nodejs)_/.test(name))),
    ).toEqual({
      portal_requests_total: 'counter',
      portal_request_duration_seconds: 'histogram',
      sync_retries_total: 'counter',
      sync_tasks_finished_total: 'counter',
      sync_update_lag_seconds: 'histogram',
      sync_sends_deferred_total: 'counter',
      updates_accepted_total: 'counter',
      updates_rejected_total: 'counter',
      portal_rate_limiter_paused_seconds: 'gauge',
      portal_rate_limiter_window_starts: 'gauge',
      sync_worker_active: 'gauge',
    });
  });

  it('M2: undeclared label names throw; undocumented outcome values do not compile', () => {
    const m = createMetrics();
    for (const outcome of OUTCOMES) expect(() => m.recordPortalCall(outcome, 0.1)).not.toThrow();
    // prom-client rejects an undeclared label NAME at runtime (no per-accommodation labels)…
    expect(() => m.portalRequests.inc({ accommodationId: 'acc-1003' } as never)).toThrow();
    // …but accepts any label VALUE, so the documented values are enforced by the types (tsc).
    if (Math.random() > 2) {
      // @ts-expect-error 'surprise' is not a documented outcome
      m.recordPortalCall('surprise', 0.1);
      // @ts-expect-error a successful call is never a retry reason
      m.recordRetry('success');
    }
  });

  it('M2: histogram buckets as decided (SPEC §7)', async () => {
    const m = createMetrics();
    m.portalRequestDuration.observe({ outcome: 'success' }, 0.3);
    m.updateLag.observe(42);
    const { samples } = parseExposition(await m.registry.metrics());
    const les = (name: string) =>
      samples
        .filter((s) => s.name === `${name}_bucket` && s.labels['le'] !== '+Inf')
        .map((s) => Number(s.labels['le']));
    expect(les('portal_request_duration_seconds')).toEqual([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
    expect(les('sync_update_lag_seconds')).toEqual([1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600]);
  });

  it('M3: two instances never share counters (each has its own registry)', async () => {
    const a = createMetrics();
    const b = createMetrics();
    a.updatesAccepted.inc();
    expect(await a.updatesAccepted.get()).toMatchObject({ values: [{ value: 1 }] });
    expect(await b.updatesAccepted.get()).toMatchObject({ values: [{ value: 0 }] });
  });

  it('M4: includes the Node process metrics', async () => {
    const { types } = await expose();
    expect(types.has('process_cpu_user_seconds_total')).toBe(true);
    expect([...types.keys()].some((name) => name.startsWith('nodejs_'))).toBe(true);
  });
});

describe('ops/alerts.yml', () => {
  it('A1: every metric an alert rule references exists in the service', async () => {
    const rules = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'ops', 'alerts.yml'),
      'utf8',
    );
    const referenced = new Set(
      [...rules.matchAll(/\b((?:sync|portal|updates)_[a-z_]+)\b/g)].map((m) => m[1]!),
    );
    // DB-derived gauges are built per scrape (absent if the DB is down), so list them explicitly.
    const dbGauges = [
      'sync_tasks_pending',
      'sync_oldest_pending_task_age_seconds',
      'sync_stuck_heads',
      'sync_head_attempts_max',
      'sync_metrics_db_up',
    ];
    const { types } = await expose();
    const known = new Set([...types.keys(), ...dbGauges]);
    const base = (name: string) => name.replace(/_(bucket|count|sum)$/, '');
    expect([...referenced].filter((name) => !known.has(base(name)))).toEqual([]);
    expect(referenced.size).toBeGreaterThan(8);
  });
});

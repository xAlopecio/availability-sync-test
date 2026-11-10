import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { clientErrorHandler, registerErrorHandling } from './errors.ts';
import { registerJsonBodyParser } from './json-body.ts';
import { createMetrics, type Metrics } from '../metrics/registry.ts';
import { registerObservabilityRoutes, type WorkerState } from './routes/observability.ts';
import { registerSyncStatusRoutes } from './routes/sync-status.ts';
import { registerUpdateRoutes } from './routes/updates.ts';

export type AppDependencies = {
  readonly pool: pg.Pool;
  readonly maxUpdateRangeDays: number;
  /** Fastify logger options; `false` silences it (tests). */
  readonly logger?: boolean | { level: string };
  /** The service's metrics; a fresh set if not given (tests). */
  readonly metrics?: Metrics;
  /** What `/ready` reports about the worker; `disabled` if not given. */
  readonly workerState?: () => WorkerState;
  /** D9 settle window, used by `/metrics` to classify held tasks (default 30 s). */
  readonly timeoutSettleMs?: number;
  /** The limiter whose state `/metrics` reports, when this instance runs the worker. */
  readonly limiter?: { pausedRemaining(): number; windowStarts(): number };
};

/** Builds the HTTP app without listening, so tests can drive it with `inject()`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? true,
    bodyLimit: 1_048_576,
    // A request that is still running after 15 s is answered by Node with 408 (SPEC §8).
    requestTimeout: 15_000,
    clientErrorHandler,
  });
  // Only JSON is accepted: without this, Fastify would parse text/plain bodies too (SPEC §6, 415).
  app.removeContentTypeParser('text/plain');
  registerJsonBodyParser(app);
  const metrics = deps.metrics ?? createMetrics();
  registerErrorHandling(app, metrics.updatesRejected);
  registerUpdateRoutes(app, { ...deps, metrics });
  registerSyncStatusRoutes(app, deps);
  registerObservabilityRoutes(app, {
    pool: deps.pool,
    metrics,
    workerState: deps.workerState ?? (() => 'disabled'),
    settleMs: deps.timeoutSettleMs ?? 30_000,
    ...(deps.limiter ? { limiter: deps.limiter } : {}),
  });
  return app;
}

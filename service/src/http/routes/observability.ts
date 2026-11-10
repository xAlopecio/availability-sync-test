import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { Registry } from 'prom-client';
import { queueStateRegistry, readQueueState, type QueueState } from '../../metrics/queue-state.ts';
import type { Metrics } from '../../metrics/registry.ts';
import { errorBody } from '../errors.ts';

export type WorkerState = 'active' | 'standby' | 'disabled';

export function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: {
    readonly pool: pg.Pool;
    readonly metrics: Metrics;
    readonly workerState: () => WorkerState;
    /** D9 settle window, to classify held tasks the way the claim does. */
    readonly settleMs: number;
    readonly limiter?: { pausedRemaining(): number; windowStarts(): number };
    readonly queueStateTimeoutMs?: number;
  },
): void {
  /** Last good queue state, served (with its age) when a read fails. */
  let lastGood: { state: QueueState; at: number } | undefined;

  app.get('/metrics', async (request, reply) => {
    const { metrics } = deps;
    metrics.workerActive.set(deps.workerState() === 'active' ? 1 : 0);
    metrics.limiterPausedSeconds.set((deps.limiter?.pausedRemaining() ?? 0) / 1000);
    metrics.limiterWindowStarts.set(deps.limiter?.windowStarts() ?? 0);
    let readNow = true;
    try {
      lastGood = {
        state: await readQueueState(deps.pool, deps.settleMs, deps.queueStateTimeoutMs),
        at: Date.now(),
      };
    } catch (error) {
      readNow = false;
      request.log.warn(
        { err: error },
        'metrics: could not read the queue state; serving the last good one',
      );
    }
    const ageSeconds = lastGood ? (Date.now() - lastGood.at) / 1000 : 0;
    const db = queueStateRegistry(lastGood?.state ?? null, {
      readNow,
      ageSeconds: readNow ? 0 : ageSeconds,
    });
    const merged = Registry.merge([deps.metrics.registry, db]);
    return reply.header('content-type', merged.contentType).send(await merged.metrics());
  });

  // Liveness: the process serves HTTP. Never depends on the database, because restarting the
  // process would not bring it back.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: can this instance store updates right now?
  app.get('/ready', async (request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
    } catch (error) {
      request.log.warn({ err: error }, 'not ready: database unreachable');
      return reply.code(503).send(errorBody('NOT_READY', 'The database is unreachable'));
    }
    return { status: 'ready', database: 'up', worker: deps.workerState() };
  });
}

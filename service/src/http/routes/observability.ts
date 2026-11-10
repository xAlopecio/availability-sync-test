import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Metrics } from '../../metrics/registry.ts';
import { errorBody } from '../errors.ts';

export type WorkerState = 'active' | 'standby' | 'disabled';

export function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: {
    readonly pool: pg.Pool;
    readonly metrics: Metrics;
    readonly workerState: () => WorkerState;
  },
): void {
  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', deps.metrics.registry.contentType)
      .send(await deps.metrics.registry.metrics());
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

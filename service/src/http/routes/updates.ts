import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { acceptUpdate } from '../../db/repository.ts';
import { splitRange } from '../../domain/calendar/chunking.ts';
import { validateUpdateRequest } from '../../domain/updates/update-validation.ts';
import { errorBody } from '../errors.ts';

export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: { readonly pool: pg.Pool; readonly maxUpdateRangeDays: number },
): void {
  app.post('/updates', async (request, reply) => {
    const result = validateUpdateRequest(request.body, { maxRangeDays: deps.maxUpdateRangeDays });
    if (!result.ok) {
      return reply.code(400).send(errorBody(result.error.code, result.error.message));
    }
    const update = result.value;
    const chunks = splitRange(update.from, update.to);
    // Only after the commit: a 202 always means the update is persisted (SPEC §6, AC1).
    const accepted = await acceptUpdate(deps.pool, update, chunks);
    request.log.info(
      {
        updateId: accepted.updateId,
        accommodationId: update.accommodationId,
        chunks: accepted.chunks,
      },
      'update accepted',
    );
    return reply
      .code(202)
      .send({ updateId: accepted.updateId, status: 'pending', chunks: accepted.chunks });
  });
}

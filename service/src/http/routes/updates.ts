import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { acceptUpdate, IdempotencyKeyReusedError } from '../../db/repository.ts';
import { splitRange } from '../../domain/calendar/chunking.ts';
import { validateUpdateRequest } from '../../domain/updates/update-validation.ts';
import type { Metrics } from '../../metrics/registry.ts';
import { errorBody } from '../errors.ts';

/** SPEC §6: 1–128 characters, letters, digits and `_ - . :`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: { readonly pool: pg.Pool; readonly maxUpdateRangeDays: number; readonly metrics: Metrics },
): void {
  app.post('/updates', async (request, reply) => {
    const result = validateUpdateRequest(request.body, { maxRangeDays: deps.maxUpdateRangeDays });
    if (!result.ok) {
      deps.metrics.recordRejection(result.error.code);
      return reply.code(400).send(errorBody(result.error.code, result.error.message));
    }
    const header = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      deps.metrics.recordRejection('INVALID_HEADER');
      return reply
        .code(400)
        .send(
          errorBody(
            'INVALID_HEADER',
            'Idempotency-Key must be 1-128 characters: A-Z a-z 0-9 _ - . :',
          ),
        );
    }
    const update = result.value;
    const chunks = splitRange(update.from, update.to);
    let accepted;
    try {
      // Only after the commit: a 202 always means the update is persisted (SPEC §6, AC1).
      accepted = await acceptUpdate(
        deps.pool,
        update,
        chunks,
        idempotencyKey === undefined ? {} : { idempotencyKey },
      );
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        deps.metrics.recordRejection('IDEMPOTENCY_KEY_REUSED');
        return reply.code(422).send(errorBody('IDEMPOTENCY_KEY_REUSED', error.message));
      }
      throw error;
    }
    request.log.info(
      {
        updateId: accepted.updateId,
        accommodationId: update.accommodationId,
        chunks: accepted.chunks,
        replayed: accepted.replayed,
      },
      accepted.replayed ? 'update replayed (idempotency key)' : 'update accepted',
    );
    if (accepted.replayed) reply.header('idempotent-replayed', 'true');
    else deps.metrics.updatesAccepted.inc();
    return reply
      .code(202)
      .send({ updateId: accepted.updateId, status: 'pending', chunks: accepted.chunks });
  });
}

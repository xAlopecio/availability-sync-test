import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { listUpdateSummaries, type UpdateSummary } from '../../db/repository.ts';
import {
  deriveAccommodationStatus,
  deriveUpdateStatus,
  type UpdateStatus,
} from '../../domain/updates/sync-status.ts';
import { ACCOMMODATION_ID_PATTERN } from '../../domain/updates/update-validation.ts';
import { errorBody } from '../errors.ts';

export const RECENT_UPDATES_LIMIT = 20;

export function registerSyncStatusRoutes(
  app: FastifyInstance,
  deps: { readonly pool: pg.Pool },
): void {
  app.get<{ Params: { id: string } }>('/accommodations/:id/sync-status', async (request, reply) => {
    const { id } = request.params;
    const notFound = () =>
      reply.code(404).send(errorBody('NOT_FOUND', `No updates for accommodation ${id}`));
    // An id outside the pattern can never have updates (SPEC §6).
    if (!ACCOMMODATION_ID_PATTERN.test(id)) return notFound();
    const summaries = await listUpdateSummaries(deps.pool, id);
    const response = buildSyncStatus(id, summaries);
    return response === null ? notFound() : response;
  });
}

/** Assembles the SPEC §6 response from every update of the accommodation, newest first. */
export function buildSyncStatus(accommodationId: string, summaries: readonly UpdateSummary[]) {
  const updates = summaries.map((summary) => ({
    summary,
    status: deriveUpdateStatus(summary.taskStatuses),
  }));
  const status = deriveAccommodationStatus(
    updates.map((u) => ({ updateId: u.summary.updateId, status: u.status })),
  );
  if (status === null) return null;

  const withStatus = (s: UpdateStatus) => updates.filter((u) => u.status === s);
  const latest = (dates: (Date | null)[]) =>
    dates.reduce<Date | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
  const earliest = (dates: Date[]) =>
    dates.reduce<Date | null>((a, b) => (a === null || b < a ? b : a), null);

  return {
    accommodationId,
    status,
    pendingUpdates: withStatus('pending').length,
    failedUpdates: withStatus('failed').length,
    lastSyncedAt: latest(withStatus('synced').map((u) => u.summary.lastCompletedAt)),
    oldestPendingSince: earliest(withStatus('pending').map((u) => u.summary.acceptedAt)),
    recentUpdates: updates.slice(0, RECENT_UPDATES_LIMIT).map(({ summary: s, status: st }) => ({
      updateId: s.updateId,
      from: s.from,
      to: s.to,
      available: s.available,
      pricePerNight: s.pricePerNight,
      status: st,
      acceptedAt: s.acceptedAt,
      syncedAt: st === 'synced' ? s.lastCompletedAt : null,
      chunks: { total: s.taskStatuses.length, done: s.chunksDone },
      attempts: s.attempts,
      lastError: s.lastError,
      nextAttemptAt: st === 'pending' ? s.nextAttemptAt : null,
    })),
  };
}

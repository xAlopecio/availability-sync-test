import { splitRange } from '#src/domain/calendar/chunking.ts';
import { parseIsoDate, type IsoDate } from '#src/domain/calendar/dates.ts';
import type { UpdateRequest } from '#src/domain/updates/update-validation.ts';

export const day = (s: string): IsoDate => {
  const parsed = parseIsoDate(s);
  if (parsed === null) throw new Error(`fixture is not a valid date: ${s}`);
  return parsed;
};

/** A valid update request; override any field. */
export const anUpdate = (overrides: Partial<Record<keyof UpdateRequest, unknown>> = {}) =>
  ({
    accommodationId: 'acc-1003',
    from: day('2026-12-01'),
    to: day('2026-12-07'),
    available: true,
    pricePerNight: 120,
    ...overrides,
  }) as UpdateRequest;

export const chunksOf = (request: UpdateRequest) => splitRange(request.from, request.to);

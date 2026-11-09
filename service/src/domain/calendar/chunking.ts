import { addDays, daysInclusive, type IsoDate } from './dates.ts';

export type DateRange = { readonly from: IsoDate; readonly to: IsoDate };

/** Portal Sol accepts at most 31 days per PUT (inclusive). */
export const PORTAL_MAX_DAYS_PER_REQUEST = 31;

/** Splits `[from, to]` into consecutive chunks of at most `maxDays` days, both ends included. */
export function splitRange(
  from: IsoDate,
  to: IsoDate,
  maxDays: number = PORTAL_MAX_DAYS_PER_REQUEST,
): DateRange[] {
  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new RangeError(`splitRange: maxDays must be a positive integer, got ${maxDays}`);
  }
  if (daysInclusive(from, to) < 1) {
    throw new RangeError(`splitRange: to (${to}) is earlier than from (${from})`);
  }
  const chunks: DateRange[] = [];
  let start = from;
  while (daysInclusive(start, to) > maxDays) {
    const end = addDays(start, maxDays - 1);
    chunks.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  chunks.push({ from: start, to });
  return chunks;
}

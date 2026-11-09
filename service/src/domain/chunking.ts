import type { IsoDate } from './dates.ts';

export type DateRange = { readonly from: IsoDate; readonly to: IsoDate };

/** Portal Sol accepts at most 31 days per PUT (inclusive). */
export const PORTAL_MAX_DAYS_PER_REQUEST = 31;

/** Splits `[from, to]` into consecutive chunks of at most `maxDays` days, both ends included. */
export function splitRange(
  _from: IsoDate,
  _to: IsoDate,
  _maxDays: number = PORTAL_MAX_DAYS_PER_REQUEST,
): DateRange[] {
  throw new Error('not implemented');
}

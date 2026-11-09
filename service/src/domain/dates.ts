/** A calendar day in `YYYY-MM-DD` form (no time, no zone), as used by Portal Sol. */
export type IsoDate = string & { readonly __brand: 'IsoDate' };

export function parseIsoDate(_value: unknown): IsoDate | null {
  throw new Error('not implemented');
}

export function addDays(_date: IsoDate, _days: number): IsoDate {
  throw new Error('not implemented');
}

/** Number of days from `from` to `to`, both included (`from == to` → 1). */
export function daysInclusive(_from: IsoDate, _to: IsoDate): number {
  throw new Error('not implemented');
}

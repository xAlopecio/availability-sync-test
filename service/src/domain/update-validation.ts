import { daysInclusive, parseIsoDate, type IsoDate } from './dates.ts';

/** A validated `POST /updates` body. */
export type UpdateRequest = {
  readonly accommodationId: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly available: boolean;
  readonly pricePerNight: number;
};

export type ValidationErrorCode = 'INVALID_BODY' | 'INVALID_DATE' | 'RANGE_TOO_LARGE';

export type ValidationResult =
  | { readonly ok: true; readonly value: UpdateRequest }
  | {
      readonly ok: false;
      readonly error: { readonly code: ValidationErrorCode; readonly message: string };
    };

/** It goes into the portal URL path: no `/`, `..` or spaces may ever reach it (SPEC §6). */
export const ACCOMMODATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PRICE_PER_NIGHT = 1_000_000;
export const DEFAULT_MAX_RANGE_DAYS = 366;

const FIELDS = ['accommodationId', 'from', 'to', 'available', 'pricePerNight'] as const;

export function validateUpdateRequest(
  body: unknown,
  options: { maxRangeDays?: number } = {},
): ValidationResult {
  const maxRangeDays = options.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;
  if (!Number.isInteger(maxRangeDays) || maxRangeDays < 1) {
    throw new RangeError(`maxRangeDays must be a positive integer, got ${maxRangeDays}`);
  }
  const fail = (code: ValidationErrorCode, message: string): ValidationResult => ({
    ok: false,
    error: { code, message },
  });

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('INVALID_BODY', 'Body must be a JSON object');
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown !== undefined) return fail('INVALID_BODY', `Unexpected field "${unknown}"`);
  const missing = FIELDS.find((field) => !(field in input));
  if (missing !== undefined) return fail('INVALID_BODY', `"${missing}" is required`);

  const { accommodationId, available, pricePerNight } = input;
  if (typeof accommodationId !== 'string' || !ACCOMMODATION_ID_PATTERN.test(accommodationId)) {
    return fail(
      'INVALID_BODY',
      '"accommodationId" must be 1-64 characters: letters, digits, "_" or "-"',
    );
  }
  const from = parseIsoDate(input.from);
  if (from === null)
    return fail('INVALID_DATE', '"from" must be a valid date in YYYY-MM-DD format');
  const to = parseIsoDate(input.to);
  if (to === null) return fail('INVALID_DATE', '"to" must be a valid date in YYYY-MM-DD format');
  const days = daysInclusive(from, to);
  if (days < 1) return fail('INVALID_DATE', '"to" must be the same day as "from" or later');
  if (days > maxRangeDays) {
    return fail(
      'RANGE_TOO_LARGE',
      `Date range covers ${days} days; the maximum is ${maxRangeDays}`,
    );
  }
  if (typeof available !== 'boolean') return fail('INVALID_BODY', '"available" must be a boolean');
  if (!isValidPrice(pricePerNight)) {
    return fail(
      'INVALID_BODY',
      `"pricePerNight" must be a number from 0 to ${MAX_PRICE_PER_NIGHT} with at most 2 decimals`,
    );
  }
  return { ok: true, value: { accommodationId, from, to, available, pricePerNight } };
}

function isValidPrice(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 0 || value > MAX_PRICE_PER_NIGHT) return false;
  // Exact for binary floats: 19.99 round-trips through toFixed(2), 1.005 (really 1.00499…) does not.
  return Number(value.toFixed(2)) === value;
}

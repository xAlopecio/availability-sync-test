import type { IsoDate } from './dates.ts';

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

export function validateUpdateRequest(
  _body: unknown,
  _options: { maxRangeDays?: number } = {},
): ValidationResult {
  throw new Error('not implemented');
}

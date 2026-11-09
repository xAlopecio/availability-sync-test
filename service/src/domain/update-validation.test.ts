import { describe, expect, it } from 'vitest';
import { validateUpdateRequest, type ValidationErrorCode } from './update-validation.ts';

const valid = {
  accommodationId: 'acc-1003',
  from: '2026-10-01',
  to: '2026-10-07',
  available: true,
  pricePerNight: 120.0,
};
const without = (field: keyof typeof valid) => {
  const copy: Record<string, unknown> = { ...valid };
  delete copy[field];
  return copy;
};

function expectError(body: unknown, code: ValidationErrorCode, field?: string) {
  const result = validateUpdateRequest(body);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  if (field) expect(result.error.message).toContain(field);
}
function expectOk(body: unknown) {
  const result = validateUpdateRequest(body);
  expect(result).toEqual({ ok: true, value: body });
}

describe('validateUpdateRequest', () => {
  it('V1 / AC2: accepts the README example unchanged', () => {
    expectOk(valid);
  });

  it.each([null, [], 'body', 42])('V2 / AC2: rejects a body that is not an object (%j)', (body) => {
    expectError(body, 'INVALID_BODY');
  });

  it.each(Object.keys(valid) as (keyof typeof valid)[])(
    'V3 / AC2: rejects a missing %s, naming it',
    (field) => {
      expectError(without(field), 'INVALID_BODY', field);
    },
  );

  it('V4 / AC2: rejects an unknown extra field, naming it', () => {
    expectError({ ...valid, discount: 10 }, 'INVALID_BODY', 'discount');
  });

  it.each([123, '', 'acc 1', '../x', 'a/b', 'a'.repeat(65), 'acc-1003?x=1'])(
    'V5 / AC2: rejects an accommodationId outside the allowed pattern (%j)',
    (accommodationId) => {
      expectError({ ...valid, accommodationId }, 'INVALID_BODY', 'accommodationId');
    },
  );

  it('V5: accepts a 64-character id with letters, digits, _ and -', () => {
    expectOk({ ...valid, accommodationId: 'A_b-9'.repeat(12) + 'abcd' });
  });

  it.each([
    ['from', '2026-02-30'],
    ['from', '2026/10/01'],
    ['from', 20261001],
    ['to', '2026-13-01'],
    ['to', null],
  ])('V6 / AC2: rejects an invalid %s (%j)', (field, value) => {
    expectError({ ...valid, [field]: value }, 'INVALID_DATE', field);
  });

  it('V7 / AC2: rejects to earlier than from', () => {
    expectError({ ...valid, from: '2026-10-07', to: '2026-10-01' }, 'INVALID_DATE', 'to');
  });

  it('V8 / AC2: accepts 366 days and rejects 367 (default limit)', () => {
    expectOk({ ...valid, from: '2026-01-01', to: '2027-01-01' });
    expectError({ ...valid, from: '2026-01-01', to: '2027-01-02' }, 'RANGE_TOO_LARGE');
  });

  it('V8: the range limit is a parameter', () => {
    const body = { ...valid, from: '2026-10-01', to: '2026-10-11' };
    expect(validateUpdateRequest(body, { maxRangeDays: 10 }).ok).toBe(false);
    expect(validateUpdateRequest(body, { maxRangeDays: 11 }).ok).toBe(true);
  });

  it.each(['true', 1, null])('V9 / AC2: rejects a non-boolean available (%j)', (available) => {
    expectError({ ...valid, available }, 'INVALID_BODY', 'available');
  });

  it.each([0, 120, 120.5, 19.99, 0.07, 999_999.99, 1_000_000])(
    'V10: accepts pricePerNight %s',
    (pricePerNight) => {
      expectOk({ ...valid, pricePerNight });
    },
  );

  it.each([-0.01, -1, '120', null])('V10 / AC2: rejects pricePerNight %j', (pricePerNight) => {
    expectError({ ...valid, pricePerNight }, 'INVALID_BODY', 'pricePerNight');
  });

  it.each([120.555, 1.005, 0.001])(
    'V11 / AC2: rejects pricePerNight with more than 2 decimals (%s)',
    (pricePerNight) => {
      expectError({ ...valid, pricePerNight }, 'INVALID_BODY', 'pricePerNight');
    },
  );

  it.each([1_000_000.01, 5_000_000, Number.NaN, Number.POSITIVE_INFINITY])(
    'V12: rejects pricePerNight above the maximum or not finite (%s)',
    (pricePerNight) => {
      expectError({ ...valid, pricePerNight }, 'INVALID_BODY', 'pricePerNight');
    },
  );

  it.each([Number.NaN, 0, -1, 1.5])('V14: rejects a maxRangeDays option of %s', (maxRangeDays) => {
    expect(() => validateUpdateRequest(valid, { maxRangeDays })).toThrow(RangeError);
  });

  it('V13: accepts dates in the past', () => {
    expectOk({ ...valid, from: '2020-01-01', to: '2020-01-31' });
  });

  it('returns the first error in field order when several fields are wrong', () => {
    expectError({ ...valid, from: 'bad', pricePerNight: -1 }, 'INVALID_DATE', 'from');
  });
});

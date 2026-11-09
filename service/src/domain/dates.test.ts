import { describe, expect, it } from 'vitest';
import { addDays, daysInclusive, parseIsoDate, type IsoDate } from './dates.ts';

const d = (s: string): IsoDate => {
  const parsed = parseIsoDate(s);
  if (parsed === null) throw new Error(`test fixture is not a valid date: ${s}`);
  return parsed;
};

describe('parseIsoDate', () => {
  it('D1: accepts a valid calendar day', () => {
    expect(parseIsoDate('2026-10-01')).toBe('2026-10-01');
  });

  it.each(['2026-02-30', '2026-04-31'])('D2: rejects a day that does not exist (%s)', (s) => {
    expect(parseIsoDate(s)).toBeNull();
  });

  it.each([
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2100-02-29', false],
    ['2000-02-29', true],
  ])('D3: leap years — %s valid=%s', (s, valid) => {
    expect(parseIsoDate(s) !== null).toBe(valid);
  });

  it.each(['2026-00-10', '2026-13-01', '2026-10-00', '2026-10-32'])(
    'D4: rejects out-of-range month or day (%s)',
    (s) => {
      expect(parseIsoDate(s)).toBeNull();
    },
  );

  it.each(['2026-1-01', '2026/10/01', '20261001', '2026-10-01T00:00:00Z', ' 2026-10-01', ''])(
    'D5: rejects a wrong format (%j)',
    (s) => {
      expect(parseIsoDate(s)).toBeNull();
    },
  );

  it.each([20261001, null, undefined, {}, ['2026-10-01']])(
    'D5: rejects non-string values (%j)',
    (v) => {
      expect(parseIsoDate(v)).toBeNull();
    },
  );
});

describe('daysInclusive', () => {
  it.each([
    ['2026-10-01', '2026-10-01', 1],
    ['2026-10-01', '2026-10-07', 7],
    ['2026-12-31', '2027-01-01', 2],
    ['2028-02-01', '2028-02-29', 29],
  ])('D6: %s..%s covers %i days', (from, to, n) => {
    expect(daysInclusive(d(from), d(to))).toBe(n);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-02-28', 2, '2028-03-01'],
    ['2027-03-01', -1, '2027-02-28'],
    ['2026-11-09', 0, '2026-11-09'],
  ])('D7: %s + %i = %s', (start, n, expected) => {
    expect(addDays(d(start), n)).toBe(expected);
  });

  it('D8: DST change days advance by exactly one day (tests run in Europe/Madrid)', () => {
    // Guard: the scenario only means something if the process time zone has DST.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Madrid');
    expect(addDays(d('2026-03-28'), 1)).toBe('2026-03-29');
    expect(addDays(d('2026-03-29'), 1)).toBe('2026-03-30');
    expect(addDays(d('2026-10-24'), 1)).toBe('2026-10-25');
    expect(addDays(d('2026-10-25'), 1)).toBe('2026-10-26');
    expect(daysInclusive(d('2026-03-01'), d('2026-03-31'))).toBe(31);
    expect(daysInclusive(d('2026-10-01'), d('2026-10-31'))).toBe(31);
  });
});

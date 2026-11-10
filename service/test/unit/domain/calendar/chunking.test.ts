import { describe, expect, it } from 'vitest';
import { splitRange } from '#src/domain/calendar/chunking.ts';
import { addDays, daysInclusive, parseIsoDate, type IsoDate } from '#src/domain/calendar/dates.ts';

const d = (s: string): IsoDate => {
  const parsed = parseIsoDate(s);
  if (parsed === null) throw new Error(`test fixture is not a valid date: ${s}`);
  return parsed;
};
const lengths = (from: string, to: string, max?: number) =>
  splitRange(d(from), d(to), max).map((c) => daysInclusive(c.from, c.to));

describe('splitRange', () => {
  it('C1 / AC3: a single day is one chunk equal to the input', () => {
    expect(splitRange(d('2026-10-01'), d('2026-10-01'))).toEqual([
      { from: '2026-10-01', to: '2026-10-01' },
    ]);
  });

  it('C2 / AC3: exactly 31 days is one chunk', () => {
    expect(splitRange(d('2026-10-01'), d('2026-10-31'))).toEqual([
      { from: '2026-10-01', to: '2026-10-31' },
    ]);
  });

  it('C3 / AC3: 32 days is 31 + 1', () => {
    expect(splitRange(d('2026-10-01'), d('2026-11-01'))).toEqual([
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-11-01', to: '2026-11-01' },
    ]);
  });

  it('C4 / AC3: 62 days is 31 + 31 and 63 days is 31 + 31 + 1', () => {
    const start = d('2026-10-01');
    expect(lengths(start, addDays(start, 61))).toEqual([31, 31]);
    expect(lengths(start, addDays(start, 62))).toEqual([31, 31, 1]);
  });

  it('C5 / AC3: the 90 days the portal holds have exact boundaries', () => {
    expect(splitRange(d('2026-11-09'), d('2027-02-06'))).toEqual([
      { from: '2026-11-09', to: '2026-12-09' },
      { from: '2026-12-10', to: '2027-01-09' },
      { from: '2027-01-10', to: '2027-02-06' },
    ]);
  });

  it('C6 / AC3: chunks cover the range exactly, contiguous and ≤ 31 days, for every length 1..400', () => {
    const from = d('2026-11-09');
    for (let total = 1; total <= 400; total++) {
      const to = addDays(from, total - 1);
      const chunks = splitRange(from, to);
      expect(chunks[0]?.from).toBe(from);
      expect(chunks.at(-1)?.to).toBe(to);
      let sum = 0;
      chunks.forEach((chunk, i) => {
        const size = daysInclusive(chunk.from, chunk.to);
        expect(size).toBeGreaterThanOrEqual(1);
        expect(size).toBeLessThanOrEqual(31);
        if (i > 0) expect(chunk.from).toBe(addDays(chunks[i - 1]!.to, 1));
        sum += size;
      });
      expect(sum).toBe(total);
      expect(chunks).toHaveLength(Math.ceil(total / 31));
    }
  });

  it('C7 / AC3: crosses month and year boundaries', () => {
    expect(splitRange(d('2026-12-15'), d('2027-02-10'))).toEqual([
      { from: '2026-12-15', to: '2027-01-14' },
      { from: '2027-01-15', to: '2027-02-10' },
    ]);
  });

  it('C8 / AC3: keeps the leap day exactly once', () => {
    expect(splitRange(d('2028-02-01'), d('2028-03-05'))).toEqual([
      { from: '2028-02-01', to: '2028-03-02' },
      { from: '2028-03-03', to: '2028-03-05' },
    ]);
    expect(lengths('2028-02-01', '2028-03-05').reduce((a, b) => a + b)).toBe(34);
  });

  it('C9: respects a custom maxDays', () => {
    expect(lengths('2026-10-01', '2026-10-20', 7)).toEqual([7, 7, 6]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'C11: rejects a maxDays that is not a positive integer (%s)',
    (max) => {
      expect(() => splitRange(d('2026-10-01'), d('2026-10-05'), max)).toThrow(RangeError);
    },
  );

  it('C10: throws when to is earlier than from (validation must run first)', () => {
    expect(() => splitRange(d('2026-10-02'), d('2026-10-01'))).toThrow(
      new RangeError('splitRange: to (2026-10-01) is earlier than from (2026-10-02)'),
    );
  });
});

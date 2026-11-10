import { describe, expect, it } from 'vitest';
import {
  deriveAccommodationStatus,
  deriveUpdateStatus,
  type UpdateStatus,
} from '#src/domain/updates/sync-status.ts';

const updates = (...statuses: UpdateStatus[]) =>
  statuses.map((status, i) => ({ updateId: i + 1, status })); // listed oldest → newest

describe('deriveUpdateStatus', () => {
  it('S1: all tasks done → synced', () => {
    expect(deriveUpdateStatus(['done'])).toBe('synced');
    expect(deriveUpdateStatus(['done', 'done', 'done'])).toBe('synced');
  });

  it('S2: any task failed → failed, even if the others are done or pending', () => {
    expect(deriveUpdateStatus(['done', 'failed', 'done'])).toBe('failed');
    expect(deriveUpdateStatus(['failed', 'pending'])).toBe('failed');
  });

  it('S3: some pending and none failed → pending', () => {
    expect(deriveUpdateStatus(['done', 'pending', 'pending'])).toBe('pending');
    expect(deriveUpdateStatus(['pending'])).toBe('pending');
  });
});

describe('deriveAccommodationStatus', () => {
  it('S4: any pending update → pending, even if others failed', () => {
    expect(deriveAccommodationStatus(updates('failed', 'pending', 'synced'))).toBe('pending');
  });

  it('S5: none pending and the most recent failed → failed', () => {
    expect(deriveAccommodationStatus(updates('synced', 'failed'))).toBe('failed');
  });

  it('S6: an older failure followed by a newer success → synced', () => {
    expect(deriveAccommodationStatus(updates('failed', 'synced'))).toBe('synced');
  });

  it('S6: "most recent" means the highest updateId, whatever the input order', () => {
    const shuffled = [
      { updateId: 7, status: 'failed' as const },
      { updateId: 3, status: 'synced' as const },
    ];
    expect(deriveAccommodationStatus(shuffled)).toBe('failed');
    expect(deriveAccommodationStatus(shuffled.toReversed())).toBe('failed');
  });

  it('S7: no updates → null (the route answers 404)', () => {
    expect(deriveAccommodationStatus([])).toBeNull();
  });
});

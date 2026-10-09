import { describe, expect, it } from 'vitest';
import { addBusinessHours } from '../src/pipeline/sla.js';

const opts = {
  defaultHours: 24, timezone: 'UTC', businessHoursOnly: true,
  startHour: 9, endHour: 18,
};

describe('business-hours SLA', () => {
  it('adds plain hours when business hours are off', () => {
    const from = new Date('2026-10-09T10:00:00Z');
    const due = addBusinessHours(from, 24, { ...opts, businessHoursOnly: false });
    expect(due.toISOString()).toBe('2026-10-10T10:00:00.000Z');
  });

  it('stays inside the same day when there is room', () => {
    const from = new Date('2026-10-07T10:00:00Z'); // Wednesday 10:00
    const due = addBusinessHours(from, 4, opts);
    expect(due.toISOString()).toBe('2026-10-07T14:00:00.000Z');
  });

  it('rolls over to the next working day', () => {
    const from = new Date('2026-10-07T16:00:00Z'); // Wednesday 16:00, 2h left
    const due = addBusinessHours(from, 5, opts);   // 2h today + 3h tomorrow
    expect(due.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  it('skips the weekend', () => {
    const from = new Date('2026-10-09T16:00:00Z'); // Friday 16:00
    const due = addBusinessHours(from, 5, opts);   // 2h Friday + 3h Monday
    expect(due.getUTCDay()).toBe(1);
    expect(due.toISOString()).toBe('2026-10-12T12:00:00.000Z');
  });

  it('starts the clock at opening for mail that arrived overnight', () => {
    const from = new Date('2026-10-07T03:00:00Z'); // Wednesday 03:00
    const due = addBusinessHours(from, 2, opts);
    expect(due.toISOString()).toBe('2026-10-07T11:00:00.000Z');
  });

  it('pushes mail arriving after close to the next morning', () => {
    const from = new Date('2026-10-07T20:00:00Z'); // Wednesday 20:00
    const due = addBusinessHours(from, 1, opts);
    expect(due.toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });
});

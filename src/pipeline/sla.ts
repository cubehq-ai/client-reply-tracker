import { config } from '../lib/config.js';

/**
 * Adds business hours to a timestamp (SPEC 8). Weekends are skipped and only
 * the configured working window counts, evaluated in the org's timezone.
 */
export function addBusinessHours(from: Date, hours: number, opts = config.sla): Date {
  if (!opts.businessHoursOnly) return new Date(from.getTime() + hours * 3_600_000);

  const startHour = opts.startHour;
  const endHour = opts.endHour;
  const hoursPerDay = Math.max(1, endHour - startHour);

  let remaining = hours;
  let cursor = new Date(from.getTime());
  let guard = 0;

  while (remaining > 0 && guard < 2000) {
    guard += 1;
    const { hour, minute, weekday } = zonedParts(cursor, opts.timezone);

    // Weekend: jump to the next weekday opening.
    if (weekday === 0 || weekday === 6) {
      cursor = advanceToNextOpening(cursor, opts.timezone, startHour);
      continue;
    }
    const hourOfDay = hour + minute / 60;
    if (hourOfDay < startHour) {
      cursor = setZonedHour(cursor, opts.timezone, startHour);
      continue;
    }
    if (hourOfDay >= endHour) {
      cursor = advanceToNextOpening(cursor, opts.timezone, startHour);
      continue;
    }
    const availableToday = endHour - hourOfDay;
    if (remaining <= availableToday) {
      return new Date(cursor.getTime() + remaining * 3_600_000);
    }
    remaining -= availableToday;
    cursor = advanceToNextOpening(cursor, opts.timezone, startHour);
  }
  return cursor;
}

function zonedParts(d: Date, timeZone: string): { hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute ?? '0'),
    weekday: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** Offset between the zone and UTC at this instant, in minutes. */
function zoneOffsetMinutes(d: Date, timeZone: string): number {
  const asUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asZone = new Date(d.toLocaleString('en-US', { timeZone }));
  return (asZone.getTime() - asUtc.getTime()) / 60_000;
}

function setZonedHour(d: Date, timeZone: string, hour: number): Date {
  const { hour: h, minute: m } = zonedParts(d, timeZone);
  const deltaHours = hour - (h + m / 60);
  return new Date(d.getTime() + deltaHours * 3_600_000);
}

function advanceToNextOpening(d: Date, timeZone: string, startHour: number): Date {
  let next = setZonedHour(new Date(d.getTime() + 86_400_000), timeZone, startHour);
  let guard = 0;
  while (guard < 10) {
    const { weekday } = zonedParts(next, timeZone);
    if (weekday !== 0 && weekday !== 6) return next;
    next = new Date(next.getTime() + 86_400_000);
    guard += 1;
  }
  return next;
}

export { zoneOffsetMinutes };

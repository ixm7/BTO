/** Time-zone helpers built on Intl only (no library, no server). */

function partsInZone(d: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset of `timeZone` from UTC at instant `d`, in minutes (east positive). */
export function zoneOffsetMinutes(d: Date, timeZone: string): number {
  const p = partsInZone(d, timeZone);
  const asUtc = Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, p.hour as number, p.minute as number, p.second as number);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time ("2026-11-21T19:30") in an IANA zone to the UTC instant. */
export function zonedToUtc(wall: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) throw new Error(`Bad date/time: ${wall}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes handle daylight-saving boundaries.
  let utc = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  utc = naive - zoneOffsetMinutes(new Date(utc), timeZone) * 60000;
  return new Date(utc);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

/**
 * A tournament's start, as a player reads it: "Sat, Nov 14, 11 AM EST".
 *
 * No year, because everything on the list is within days — except over New
 * Year, when the year is the one thing that would be missed, so it is kept
 * for a date in another year. No minutes on the hour either: "11 AM" is how
 * somebody would say it, and the hours that are not on the hour stand out
 * better for it.
 */
export function formatInZone(d: Date, timeZone: string, locale?: string, now: number = Date.now()): string {
  const year = partsInZone(d, timeZone).year;
  const onTheHour = partsInZone(d, timeZone).minute === 0;
  return new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    ...(year === partsInZone(new Date(now), timeZone).year ? {} : { year: 'numeric' }),
    hour: 'numeric', ...(onTheHour ? {} : { minute: '2-digit' }), timeZoneName: 'short',
  }).format(d);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function allTimeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = f ? f('timeZone') : ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'];
  return list.includes('UTC') ? list : ['UTC', ...list];
}

/**
 * How long until a tournament starts, as [hh:mm]. A clock means different
 * things in different places; this means the same everywhere, so a player
 * need not work out what 7:30 PM Eastern is where they are. Only within a
 * day, since beyond that the date is the useful thing.
 */
export function countdown(startUtc: string, now: number = Date.now()): string | null {
  const left = Date.parse(startUtc) - now;
  if (!Number.isFinite(left) || left < 0 || left >= 24 * 3600_000) return null;
  const minutes = Math.floor(left / 60_000);
  return `[${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}]`;
}

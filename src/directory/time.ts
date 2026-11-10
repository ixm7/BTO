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

export function formatInZone(d: Date, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
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

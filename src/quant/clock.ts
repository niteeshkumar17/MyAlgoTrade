/**
 * India Standard Time helpers. NSE runs on IST (UTC+05:30, no daylight saving),
 * so all session logic works on the IST wall clock regardless of where the server runs.
 */

export const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export const SESSION_OPEN_MINUTE = 9 * 60 + 15;
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

export interface IstParts {
  dateStr: string; // YYYY-MM-DD
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
  minuteOfDay: number;
}

export function istParts(ms: number): IstParts {
  const d = new Date(ms + IST_OFFSET_MS);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    dateStr: d.toISOString().slice(0, 10),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour,
    minute,
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    minuteOfDay: hour * 60 + minute,
  };
}

/** Epoch ms for an IST wall-clock time on the given YYYY-MM-DD date. */
export function istToMs(dateStr: string, hour: number, minute: number, second = 0): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour, minute, second) - IST_OFFSET_MS;
}

export function isWeekday(ms: number): boolean {
  const wd = istParts(ms).weekday;
  return wd >= 1 && wd <= 5;
}

/** Weekday between 09:15 and 15:30 IST. Holidays are detected from the exchange feed, not from a calendar. */
export function isWithinSessionHours(ms: number): boolean {
  const p = istParts(ms);
  return (
    p.weekday >= 1 &&
    p.weekday <= 5 &&
    p.minuteOfDay >= SESSION_OPEN_MINUTE &&
    p.minuteOfDay < SESSION_CLOSE_MINUTE
  );
}

/** "YYYY-MM-DD HH:mm" in IST, the format Angel One's candle API expects. */
export function formatIstForAngel(ms: number): string {
  const p = istParts(ms);
  return `${p.dateStr} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function formatIstTime(ms: number): string {
  const p = istParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/** Angel One instrument-master expiry such as "23NOV2026" -> "2026-11-23". */
export function parseAngelExpiry(raw: string): string | null {
  const m = /^(\d{2})([A-Za-z]{3})(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1]}`;
}

/**
 * Angel One quote timestamps such as "02-Nov-2026 10:05:21" (IST) -> epoch ms.
 * Returns null for anything unparseable so callers treat the quote's age as unknown.
 */
export function parseAngelFeedTime(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  const dateStr = `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return istToMs(dateStr, Number(m[4]), Number(m[5]), Number(m[6]));
}

/** Whole calendar days from one YYYY-MM-DD date to another (negative if `to` is earlier). */
export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** End of an Angel One hourly bar: bars start at :15 and the last bar of the day (15:15) ends at 15:30. */
export function hourlyBarEndMs(barStartMs: number): number {
  const p = istParts(barStartMs);
  if (p.minuteOfDay >= 15 * 60 + 15) return istToMs(p.dateStr, 15, 30);
  return barStartMs + 3600_000;
}

/** Calendar date (YYYY-MM-DD, IST) of the given epoch ms. */
export function istDate(ms: number): string {
  return istParts(ms).dateStr;
}

/** Monday 00:00 IST of the week containing `ms`, used for weekly walk-forward folds. */
export function istWeekStartMs(ms: number): number {
  const p = istParts(ms);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return istToMs(p.dateStr, 0, 0) - daysSinceMonday * 86_400_000;
}

export function istMonthStartMs(ms: number): number {
  const p = istParts(ms);
  return istToMs(`${p.year}-${String(p.month).padStart(2, '0')}-01`, 0, 0);
}

export function istMonthKey(ms: number): string {
  const p = istParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

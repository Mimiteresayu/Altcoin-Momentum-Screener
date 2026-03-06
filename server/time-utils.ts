/**
 * time-utils.ts — Centralised HKT (UTC+8) time utilities for the Giiq Screener.
 *
 * Rule: internal storage stays UTC; all session classification,
 *       killzone checks, and user-facing labels use HKT (UTC+8).
 */

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000; // +8 hours in milliseconds
const HKT_OFFSET_HOURS = 8;

// ─── Core converters ────────────────────────────────────────────────────────

/** Return the current UTC Date. */
export function nowUtc(): Date {
  return new Date();
}

/**
 * Convert any Date to a *display-only* Date shifted by +8 hours.
 * WARNING: the returned Date object's UTC methods will show HKT values,
 * but it is NOT a real timezone-aware date.  Use only for formatting/comparison.
 */
export function toHkt(date: Date): Date {
  return new Date(date.getTime() + HKT_OFFSET_MS);
}

/** Get the current HKT hour (0-23) and minute (0-59). */
export function getHktHourMinute(date?: Date): { hour: number; minute: number } {
  const d = date ?? new Date();
  const totalMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + HKT_OFFSET_HOURS * 60;
  const hktTotalMinutes = ((totalMinutes % 1440) + 1440) % 1440; // mod 24h, handles negatives
  return {
    hour: Math.floor(hktTotalMinutes / 60),
    minute: hktTotalMinutes % 60,
  };
}

/** Get the current HKT hour (0-23) from a UTC Date. */
export function getHktHour(date?: Date): number {
  return getHktHourMinute(date).hour;
}

/**
 * Format a UTC Date as a HKT time string, e.g. "14:05 HKT".
 */
export function formatHktTime(date?: Date): string {
  const { hour, minute } = getHktHourMinute(date);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} HKT`;
}

/**
 * Format a UTC Date as a full HKT datetime string, e.g. "2026-03-06 14:05 HKT".
 */
export function formatHktDateTime(date?: Date): string {
  const d = date ?? new Date();
  const hkt = toHkt(d);
  const yyyy = hkt.getUTCFullYear();
  const mm = String(hkt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(hkt.getUTCDate()).padStart(2, "0");
  const HH = String(hkt.getUTCHours()).padStart(2, "0");
  const MM = String(hkt.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM} HKT`;
}

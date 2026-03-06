/**
 * session-config.ts — Session & Killzone definitions for the Giiq Screener.
 *
 * All times are defined in HKT (UTC+8).
 * The classifier converts a UTC Date → HKT, then matches against these windows.
 *
 * DST note:
 *   - London killzone shifts earlier in summer (after last Sunday of March).
 *   - US killzone shifts earlier in summer (after 2nd Sunday of March).
 *   - Asia killzone has NO DST shift.
 */

import { getHktHourMinute, formatHktTime } from "./time-utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionWindow {
  name: string;
  /** Short label for reports */
  label: string;
  /** Start hour in HKT (0-23) */
  startHour: number;
  /** Start minute in HKT (0-59) */
  startMinute: number;
  /** End hour in HKT (0-23). If < startHour, wraps past midnight. */
  endHour: number;
  /** End minute in HKT (0-59) */
  endMinute: number;
  /** Whether this window is a killzone (active trading window) */
  isKillzone: boolean;
}

export interface SessionClassification {
  sessionName: string;
  sessionLabel: string;
  isKillzone: boolean;
  hktTime: string;         // e.g. "13:55 HKT"
  hktHour: number;
  hktMinute: number;
}

// ─── Session Definitions (HKT) ─────────────────────────────────────────────

/** Asia Killzone: 08:00 – 09:30 HKT (no DST change) */
const ASIA_KILLZONE: SessionWindow = {
  name: "Asia Killzone",
  label: "Asia Session",
  startHour: 8,
  startMinute: 0,
  endHour: 9,
  endMinute: 30,
  isKillzone: true,
};

/** Asia Extended / Morning session: 09:30 – 12:00 HKT */
const ASIA_EXTENDED: SessionWindow = {
  name: "Asia Extended",
  label: "Asia Session",
  startHour: 9,
  startMinute: 30,
  endHour: 12,
  endMinute: 0,
  isKillzone: false,
};

/** London Killzone (Winter): 16:00 – 18:00 HKT (applies before last Sun of March) */
const LONDON_KILLZONE_WINTER: SessionWindow = {
  name: "London Killzone",
  label: "London Tea Time",
  startHour: 16,
  startMinute: 0,
  endHour: 18,
  endMinute: 0,
  isKillzone: true,
};

/** London Killzone (Summer/BST): 15:00 – 17:00 HKT (applies after last Sun of March) */
const LONDON_KILLZONE_SUMMER: SessionWindow = {
  name: "London Killzone",
  label: "London Tea Time",
  startHour: 15,
  startMinute: 0,
  endHour: 17,
  endMinute: 0,
  isKillzone: true,
};

/** US Killzone (Winter / EST): 22:30 – 00:00 HKT (applies before 2nd Sun of March) */
const US_KILLZONE_WINTER: SessionWindow = {
  name: "US Killzone",
  label: "Golden Tank (US)",
  startHour: 22,
  startMinute: 30,
  endHour: 0,  // wraps past midnight
  endMinute: 0,
  isKillzone: true,
};

/** US Killzone (Summer / EDT): 21:30 – 23:00 HKT (applies after 2nd Sun of March) */
const US_KILLZONE_SUMMER: SessionWindow = {
  name: "US Killzone",
  label: "Golden Tank (US)",
  startHour: 21,
  startMinute: 30,
  endHour: 23,
  endMinute: 0,
  isKillzone: true,
};

// ─── DST Helpers ────────────────────────────────────────────────────────────

/**
 * Is the given UTC date after the last Sunday of March in its year?
 * (UK BST starts last Sunday of March at 01:00 UTC)
 */
function isAfterUKDSTStart(utcDate: Date): boolean {
  const year = utcDate.getUTCFullYear();
  // Find last Sunday of March
  const marchEnd = new Date(Date.UTC(year, 2, 31)); // March 31
  const dayOfWeek = marchEnd.getUTCDay(); // 0=Sun
  const lastSunday = 31 - dayOfWeek;
  const dstStart = new Date(Date.UTC(year, 2, lastSunday, 1, 0, 0)); // 01:00 UTC
  return utcDate >= dstStart;
}

/**
 * Is US DST active? (2nd Sunday of March at 07:00 UTC to 1st Sunday of November)
 */
function isUSDSTActive(utcDate: Date): boolean {
  const year = utcDate.getUTCFullYear();
  // 2nd Sunday of March
  const march1 = new Date(Date.UTC(year, 2, 1));
  const march1Day = march1.getUTCDay();
  const secondSunday = march1Day === 0 ? 8 : (7 - march1Day) + 8;
  const dstStart = new Date(Date.UTC(year, 2, secondSunday, 7, 0, 0)); // 02:00 EST = 07:00 UTC

  // 1st Sunday of November
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const nov1Day = nov1.getUTCDay();
  const firstSundayNov = nov1Day === 0 ? 1 : (7 - nov1Day) + 1;
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNov, 6, 0, 0)); // 02:00 EDT = 06:00 UTC

  return utcDate >= dstStart && utcDate < dstEnd;
}

// ─── Time-in-window check ───────────────────────────────────────────────────

/** Convert hour:minute to minutes-since-midnight. */
function toMinutes(h: number, m: number): number {
  return h * 60 + m;
}

/** Check if (hour, minute) falls inside a session window (handles midnight wrap). */
function isInWindow(hour: number, minute: number, w: SessionWindow): boolean {
  const t = toMinutes(hour, minute);
  const start = toMinutes(w.startHour, w.startMinute);
  const end = toMinutes(w.endHour, w.endMinute);

  if (end > start) {
    // Normal range (e.g. 08:00 – 09:30)
    return t >= start && t < end;
  } else {
    // Wraps past midnight (e.g. 22:30 – 00:00)
    return t >= start || t < end;
  }
}

// ─── Main Classifier ────────────────────────────────────────────────────────

/**
 * Classify a UTC Date into a named session and killzone state.
 *
 * @param utcDate - A Date object (treated as UTC). Defaults to now.
 * @returns SessionClassification with name, label, killzone flag, and HKT time string.
 */
export function classifySession(utcDate?: Date): SessionClassification {
  const d = utcDate ?? new Date();
  const { hour, minute } = getHktHourMinute(d);
  const hktTimeStr = formatHktTime(d);

  // Pick DST-adjusted windows
  const londonKZ = isAfterUKDSTStart(d) ? LONDON_KILLZONE_SUMMER : LONDON_KILLZONE_WINTER;
  const usKZ = isUSDSTActive(d) ? US_KILLZONE_SUMMER : US_KILLZONE_WINTER;

  // Check killzones first (higher priority)
  const killzones: SessionWindow[] = [ASIA_KILLZONE, londonKZ, usKZ];
  for (const kz of killzones) {
    if (isInWindow(hour, minute, kz)) {
      return {
        sessionName: kz.name,
        sessionLabel: `${kz.label} (${String(kz.startHour).padStart(2, "0")}:${String(kz.startMinute).padStart(2, "0")} HKT)`,
        isKillzone: true,
        hktTime: hktTimeStr,
        hktHour: hour,
        hktMinute: minute,
      };
    }
  }

  // Check extended sessions
  if (isInWindow(hour, minute, ASIA_EXTENDED)) {
    return {
      sessionName: ASIA_EXTENDED.name,
      sessionLabel: `${ASIA_EXTENDED.label} (${String(ASIA_EXTENDED.startHour).padStart(2, "0")}:${String(ASIA_EXTENDED.startMinute).padStart(2, "0")} HKT)`,
      isKillzone: false,
      hktTime: hktTimeStr,
      hktHour: hour,
      hktMinute: minute,
    };
  }

  // Default: Off-Hours / Watch
  return {
    sessionName: "Off-Hours Watch",
    sessionLabel: "Off-Hours Watch",
    isKillzone: false,
    hktTime: hktTimeStr,
    hktHour: hour,
    hktMinute: minute,
  };
}

/**
 * Get the complete session schedule table (for the given UTC date's DST context).
 */
export function getSessionSchedule(utcDate?: Date): Array<{
  name: string;
  label: string;
  hktStart: string;
  hktEnd: string;
  utcStart: string;
  utcEnd: string;
  isKillzone: boolean;
}> {
  const d = utcDate ?? new Date();
  const londonKZ = isAfterUKDSTStart(d) ? LONDON_KILLZONE_SUMMER : LONDON_KILLZONE_WINTER;
  const usKZ = isUSDSTActive(d) ? US_KILLZONE_SUMMER : US_KILLZONE_WINTER;

  const windows = [ASIA_KILLZONE, ASIA_EXTENDED, londonKZ, usKZ];

  return windows.map((w) => {
    const utcStartH = ((w.startHour - 8) % 24 + 24) % 24;
    const utcEndH = ((w.endHour - 8) % 24 + 24) % 24;
    return {
      name: w.name,
      label: w.label,
      hktStart: `${String(w.startHour).padStart(2, "0")}:${String(w.startMinute).padStart(2, "0")}`,
      hktEnd: `${String(w.endHour).padStart(2, "0")}:${String(w.endMinute).padStart(2, "0")}`,
      utcStart: `${String(utcStartH).padStart(2, "0")}:${String(w.startMinute).padStart(2, "0")}`,
      utcEnd: `${String(utcEndH).padStart(2, "0")}:${String(w.endMinute).padStart(2, "0")}`,
      isKillzone: w.isKillzone,
    };
  });
}

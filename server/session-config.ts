/**
 * session-config.ts — ICT Killzone & Session definitions for the Giiq Screener.
 *
 * All times are defined in HKT (UTC+8).
 * The classifier converts a UTC Date → HKT, then matches against these windows.
 *
 * ICT Killzones are defined in New York local time, then converted to HKT:
 *   - Asia Kill Zone:   20:00–22:00 NY time
 *   - London Kill Zone: 02:00–05:00 NY time
 *   - NY AM Kill Zone:  07:00–10:00 NY time
 *   - NY PM Kill Zone:  13:00–15:00 NY time
 *
 * DST note (New York):
 *   - Winter (EST, UTC−5): HKT = NY time + 13 hours
 *   - Summer (EDT, UTC−4): HKT = NY time + 12 hours
 *   - US DST starts 2nd Sunday of March at 02:00 EST (07:00 UTC)
 *   - US DST ends   1st Sunday of November at 02:00 EDT (06:00 UTC)
 */

import { getHktHourMinute, formatHktTime } from "./time-utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export type KillzoneName = "Asia" | "London" | "NY_AM" | "NY_PM";
export type SessionName = "Asia" | "London" | "NewYork" | "Off-Hours";

export interface Killzone {
  name: KillzoneName;
  /** Display label for reports */
  displayLabel: string;
  /** Start hour in HKT (0-23) */
  hktStartHour: number;
  /** Start minute in HKT (0-59) */
  hktStartMinute: number;
  /** End hour in HKT (0-23). If < startHour, wraps past midnight. */
  hktEndHour: number;
  /** End minute in HKT (0-59) */
  hktEndMinute: number;
}

export interface SessionWindow {
  sessionName: SessionName;
  hktStartHour: number;
  hktStartMinute: number;
  hktEndHour: number;
  hktEndMinute: number;
  killzones: Killzone[];
}

export interface SessionClassification {
  sessionName: SessionName | string;
  sessionLabel: string;
  isKillzone: boolean;
  killzoneName: KillzoneName | null;
  hktTime: string;           // e.g. "14:19 HKT"
  hktHour: number;
  hktMinute: number;
}

// ─── US DST Detection ───────────────────────────────────────────────────────

/**
 * Is US DST (EDT) active for the given UTC date?
 * US DST: 2nd Sunday of March at 07:00 UTC → 1st Sunday of November at 06:00 UTC
 */
function isUSDSTActive(utcDate: Date): boolean {
  const year = utcDate.getUTCFullYear();

  // 2nd Sunday of March
  const march1 = new Date(Date.UTC(year, 2, 1));
  const march1Day = march1.getUTCDay(); // 0=Sun
  const secondSunday = march1Day === 0 ? 8 : (7 - march1Day) + 8;
  const dstStart = new Date(Date.UTC(year, 2, secondSunday, 7, 0, 0)); // 02:00 EST = 07:00 UTC

  // 1st Sunday of November
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const nov1Day = nov1.getUTCDay();
  const firstSundayNov = nov1Day === 0 ? 1 : (7 - nov1Day) + 1;
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNov, 6, 0, 0)); // 02:00 EDT = 06:00 UTC

  return utcDate >= dstStart && utcDate < dstEnd;
}

// ─── HKT Time-in-window check ──────────────────────────────────────────────

/** Convert hour:minute to minutes-since-midnight. */
function toMinutes(h: number, m: number): number {
  return h * 60 + m;
}

/** Check if (hour, minute) falls inside a window (handles midnight wrap). */
function isInWindow(hour: number, minute: number, startH: number, startM: number, endH: number, endM: number): boolean {
  const t = toMinutes(hour, minute);
  const start = toMinutes(startH, startM);
  const end = toMinutes(endH, endM);

  if (end > start) {
    // Normal range (e.g. 09:00 – 11:00)
    return t >= start && t < end;
  } else {
    // Wraps past midnight (e.g. 19:00 – 05:00)
    return t >= start || t < end;
  }
}

/** Format HH:MM from hour/minute numbers */
function fmtHM(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── ICT Killzone & Session Schedule Builder ────────────────────────────────

/**
 * Returns the complete session schedule for today's date, including
 * ICT killzones and broader sessions, all in HKT.
 *
 * During EST (winter, NY = UTC−5, HKT offset = +13):
 *   Asia Kill Zone   (20:00–22:00 EST) → 09:00–11:00 HKT (next day)
 *   London Kill Zone (02:00–05:00 EST) → 15:00–18:00 HKT
 *   NY AM Kill Zone  (07:00–10:00 EST) → 20:00–23:00 HKT
 *   NY PM Kill Zone  (13:00–15:00 EST) → 02:00–04:00 HKT (next day)
 *
 *   Asia Session:     08:00–17:00 HKT
 *   London Session:   15:00–00:00 HKT
 *   New York Session: 20:00–06:00 HKT (next day)
 *
 * During EDT (summer, NY = UTC−4, HKT offset = +12):
 *   Asia Kill Zone   (20:00–22:00 EDT) → 08:00–10:00 HKT (next day)
 *   London Kill Zone (02:00–05:00 EDT) → 14:00–17:00 HKT
 *   NY AM Kill Zone  (07:00–10:00 EDT) → 19:00–22:00 HKT
 *   NY PM Kill Zone  (13:00–15:00 EDT) → 01:00–03:00 HKT (next day)
 *
 *   Asia Session:     08:00–17:00 HKT
 *   London Session:   14:00–23:00 HKT
 *   New York Session: 19:00–05:00 HKT (next day)
 */
export function getSessionSchedule(utcDate?: Date): SessionWindow[] {
  const d = utcDate ?? new Date();
  const isDST = isUSDSTActive(d);

  if (isDST) {
    // ── EDT (summer) ──
    return [
      {
        sessionName: "Asia",
        hktStartHour: 8, hktStartMinute: 0,
        hktEndHour: 17, hktEndMinute: 0,
        killzones: [
          {
            name: "Asia",
            displayLabel: "Asia Kill Zone",
            hktStartHour: 8, hktStartMinute: 0,
            hktEndHour: 10, hktEndMinute: 0,
          },
        ],
      },
      {
        sessionName: "London",
        hktStartHour: 14, hktStartMinute: 0,
        hktEndHour: 23, hktEndMinute: 0,
        killzones: [
          {
            name: "London",
            displayLabel: "London Kill Zone",
            hktStartHour: 14, hktStartMinute: 0,
            hktEndHour: 17, hktEndMinute: 0,
          },
        ],
      },
      {
        sessionName: "NewYork",
        hktStartHour: 19, hktStartMinute: 0,
        hktEndHour: 5, hktEndMinute: 0, // wraps past midnight
        killzones: [
          {
            name: "NY_AM",
            displayLabel: "New York AM Kill Zone",
            hktStartHour: 19, hktStartMinute: 0,
            hktEndHour: 22, hktEndMinute: 0,
          },
          {
            name: "NY_PM",
            displayLabel: "New York PM Kill Zone",
            hktStartHour: 1, hktStartMinute: 0,
            hktEndHour: 3, hktEndMinute: 0,
          },
        ],
      },
    ];
  } else {
    // ── EST (winter) ──
    return [
      {
        sessionName: "Asia",
        hktStartHour: 8, hktStartMinute: 0,
        hktEndHour: 17, hktEndMinute: 0,
        killzones: [
          {
            name: "Asia",
            displayLabel: "Asia Kill Zone",
            hktStartHour: 9, hktStartMinute: 0,
            hktEndHour: 11, hktEndMinute: 0,
          },
        ],
      },
      {
        sessionName: "London",
        hktStartHour: 15, hktStartMinute: 0,
        hktEndHour: 0, hktEndMinute: 0, // wraps past midnight
        killzones: [
          {
            name: "London",
            displayLabel: "London Kill Zone",
            hktStartHour: 15, hktStartMinute: 0,
            hktEndHour: 18, hktEndMinute: 0,
          },
        ],
      },
      {
        sessionName: "NewYork",
        hktStartHour: 20, hktStartMinute: 0,
        hktEndHour: 6, hktEndMinute: 0, // wraps past midnight
        killzones: [
          {
            name: "NY_AM",
            displayLabel: "New York AM Kill Zone",
            hktStartHour: 20, hktStartMinute: 0,
            hktEndHour: 23, hktEndMinute: 0,
          },
          {
            name: "NY_PM",
            displayLabel: "New York PM Kill Zone",
            hktStartHour: 2, hktStartMinute: 0,
            hktEndHour: 4, hktEndMinute: 0,
          },
        ],
      },
    ];
  }
}

// ─── Main Classifier ────────────────────────────────────────────────────────

/**
 * Classify a UTC Date into a named session, killzone state, and labels.
 *
 * Sessions overlap (e.g. Asia 08–17 and London 15–00 overlap at 15–17).
 * Priority logic:
 *   1. Check ALL killzones across all sessions — killzone wins over non-killzone.
 *   2. If not in any killzone, pick the LATEST (most specific) session that matches.
 *      Order in schedule: [Asia, London, NewYork]. Later sessions take priority
 *      over earlier ones in overlap zones.
 *
 * @param utcDate - A Date object (treated as UTC). Defaults to now.
 * @returns SessionClassification with name, label, killzone flag/name, and HKT time string.
 */
export function classifySession(utcDate?: Date): SessionClassification {
  const d = utcDate ?? new Date();
  const { hour, minute } = getHktHourMinute(d);
  const hktTimeStr = formatHktTime(d);

  const schedule = getSessionSchedule(d);

  // ── Pass 1: Check killzones across ALL sessions (killzone has highest priority) ──
  for (const session of schedule) {
    for (const kz of session.killzones) {
      if (isInWindow(hour, minute, kz.hktStartHour, kz.hktStartMinute, kz.hktEndHour, kz.hktEndMinute)) {
        return {
          sessionName: session.sessionName,
          sessionLabel: `${kz.displayLabel} (${fmtHM(kz.hktStartHour, kz.hktStartMinute)}–${fmtHM(kz.hktEndHour, kz.hktEndMinute)} HKT)`,
          isKillzone: true,
          killzoneName: kz.name,
          hktTime: hktTimeStr,
          hktHour: hour,
          hktMinute: minute,
        };
      }
    }
  }

  // ── Pass 2: No killzone hit — find matching session (latest wins in overlap) ──
  let matchedSession: SessionWindow | null = null;
  for (const session of schedule) {
    if (isInWindow(hour, minute, session.hktStartHour, session.hktStartMinute, session.hktEndHour, session.hktEndMinute)) {
      matchedSession = session; // keep overwriting — last match wins
    }
  }

  if (matchedSession) {
    return {
      sessionName: matchedSession.sessionName,
      sessionLabel: `${matchedSession.sessionName === "NewYork" ? "New York" : matchedSession.sessionName} Session`,
      isKillzone: false,
      killzoneName: null,
      hktTime: hktTimeStr,
      hktHour: hour,
      hktMinute: minute,
    };
  }

  // Default: Off-Hours
  return {
    sessionName: "Off-Hours",
    sessionLabel: "Off-Hours Watch",
    isKillzone: false,
    killzoneName: null,
    hktTime: hktTimeStr,
    hktHour: hour,
    hktMinute: minute,
  };
}

// ─── Schedule Table Helper (for /api/session) ───────────────────────────────

/**
 * Get a flat schedule table for API responses and reports.
 */
export function getSessionScheduleTable(utcDate?: Date): Array<{
  name: string;
  type: "session" | "killzone";
  hktStart: string;
  hktEnd: string;
  utcStart: string;
  utcEnd: string;
}> {
  const d = utcDate ?? new Date();
  const schedule = getSessionSchedule(d);

  const rows: Array<{
    name: string;
    type: "session" | "killzone";
    hktStart: string;
    hktEnd: string;
    utcStart: string;
    utcEnd: string;
  }> = [];

  for (const session of schedule) {
    // Session row
    const sUtcStartH = ((session.hktStartHour - 8) % 24 + 24) % 24;
    const sUtcEndH = ((session.hktEndHour - 8) % 24 + 24) % 24;
    rows.push({
      name: `${session.sessionName === "NewYork" ? "New York" : session.sessionName} Session`,
      type: "session",
      hktStart: fmtHM(session.hktStartHour, session.hktStartMinute),
      hktEnd: fmtHM(session.hktEndHour, session.hktEndMinute),
      utcStart: fmtHM(sUtcStartH, session.hktStartMinute),
      utcEnd: fmtHM(sUtcEndH, session.hktEndMinute),
    });

    // Killzone rows
    for (const kz of session.killzones) {
      const kUtcStartH = ((kz.hktStartHour - 8) % 24 + 24) % 24;
      const kUtcEndH = ((kz.hktEndHour - 8) % 24 + 24) % 24;
      rows.push({
        name: `  └ ${kz.displayLabel}`,
        type: "killzone",
        hktStart: fmtHM(kz.hktStartHour, kz.hktStartMinute),
        hktEnd: fmtHM(kz.hktEndHour, kz.hktEndMinute),
        utcStart: fmtHM(kUtcStartH, kz.hktStartMinute),
        utcEnd: fmtHM(kUtcEndH, kz.hktEndMinute),
      });
    }
  }

  return rows;
}

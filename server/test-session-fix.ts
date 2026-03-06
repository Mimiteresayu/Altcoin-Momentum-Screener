/**
 * test-session-fix.ts — QA validation for ICT Killzone session configuration.
 *
 * Tests:
 * 1. Session & Killzone table for 2026-03-06 (EST winter)
 * 2. Point-in-time checks at specific HKT times
 * 3. Real-time sanity check (~14:19 HKT)
 * 4. Sample report labels
 * 5. DST transition (summer/EDT) checks
 */

import { classifySession, getSessionSchedule, getSessionScheduleTable } from "./session-config";
import type { SessionClassification } from "./session-config";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${msg}`);
}

/** Helper: create a UTC Date that corresponds to a given HKT hour:minute on a given date. */
function hktToUtc(year: number, month: number, day: number, hktH: number, hktM: number): Date {
  // HKT = UTC + 8, so UTC = HKT - 8
  let utcH = hktH - 8;
  let utcDay = day;
  let utcMonth = month;
  if (utcH < 0) {
    utcH += 24;
    utcDay -= 1;
    // Simple case: handle day wrap (good enough for testing)
    if (utcDay < 1) {
      utcMonth -= 1;
      if (utcMonth < 1) {
        utcMonth = 12;
        year -= 1;
      }
      // Use 28 for Feb simplicity, exact day doesn't matter for these tests
      const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      utcDay = daysInMonth[utcMonth];
    }
  }
  return new Date(Date.UTC(year, utcMonth - 1, utcDay, utcH, hktM, 0));
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Giiq Screener — ICT Killzone QA Report");
console.log("  Date: 2026-03-06 (EST / Winter — US DST not yet active)");
console.log("═══════════════════════════════════════════════════════════════\n");

// ─── 1. Session & Killzone Table ────────────────────────────────────────────

console.log("── 1. Session & Killzone Schedule Table (2026-03-06, EST) ──\n");

const testDate = new Date(Date.UTC(2026, 2, 6, 6, 19, 0)); // ~14:19 HKT
const table = getSessionScheduleTable(testDate);

console.log("| Name                          | HKT Start | HKT End | UTC Start | UTC End |");
console.log("|-------------------------------|-----------|---------|-----------|---------|");
for (const row of table) {
  console.log(`| ${row.name.padEnd(29)} | ${row.hktStart}     | ${row.hktEnd}   | ${row.utcStart}     | ${row.utcEnd}   |`);
}
console.log("");

// ─── 2. Point-in-time Checks ────────────────────────────────────────────────

console.log("── 2. Point-in-time Checks ──\n");

interface TestCase {
  label: string;
  hktH: number;
  hktM: number;
  expectedSession: string;
  expectedIsKillzone: boolean;
  expectedKillzoneName: string | null;
}

const pointTests: TestCase[] = [
  {
    label: "09:30 HKT → Asia Session, Asia Kill Zone",
    hktH: 9, hktM: 30,
    expectedSession: "Asia",
    expectedIsKillzone: true,
    expectedKillzoneName: "Asia",
  },
  {
    label: "15:30 HKT → London Session, London Kill Zone",
    hktH: 15, hktM: 30,
    expectedSession: "London",
    expectedIsKillzone: true,
    expectedKillzoneName: "London",
  },
  {
    label: "20:30 HKT → New York Session, NY AM Kill Zone",
    hktH: 20, hktM: 30,
    expectedSession: "NewYork",
    expectedIsKillzone: true,
    expectedKillzoneName: "NY_AM",
  },
  {
    label: "02:30 HKT (next day) → New York Session, NY PM Kill Zone",
    hktH: 2, hktM: 30,
    expectedSession: "NewYork",
    expectedIsKillzone: true,
    expectedKillzoneName: "NY_PM",
  },
];

for (const tc of pointTests) {
  // Use March 6 for standard times, March 7 for "next day" times (02:30)
  const day = tc.hktH < 8 ? 7 : 6;
  const utc = hktToUtc(2026, 3, day, tc.hktH, tc.hktM);
  const result = classifySession(utc);

  console.log(`  ${tc.label}`);
  console.log(`    UTC:          ${utc.toISOString()}`);
  console.log(`    sessionName:  ${result.sessionName}`);
  console.log(`    isKillzone:   ${result.isKillzone}`);
  console.log(`    killzoneName: ${result.killzoneName}`);
  console.log(`    sessionLabel: ${result.sessionLabel}`);
  console.log("");

  assert(result.sessionName === tc.expectedSession,
    `${tc.label} → sessionName = ${result.sessionName} (expected ${tc.expectedSession})`);
  assert(result.isKillzone === tc.expectedIsKillzone,
    `${tc.label} → isKillzone = ${result.isKillzone} (expected ${tc.expectedIsKillzone})`);
  assert(result.killzoneName === tc.expectedKillzoneName,
    `${tc.label} → killzoneName = ${result.killzoneName} (expected ${tc.expectedKillzoneName})`);
}

// ─── 3. Real-time Sanity (~14:19 HKT on 2026-03-06) ────────────────────────

console.log("\n── 3. Real-time Sanity Check ──\n");

const nowResult = classifySession(testDate);
console.log(`  HKT time:      ${nowResult.hktTime}`);
console.log(`  sessionName:   ${nowResult.sessionName}`);
console.log(`  isKillzone:    ${nowResult.isKillzone}`);
console.log(`  killzoneName:  ${nowResult.killzoneName}`);
console.log(`  sessionLabel:  ${nowResult.sessionLabel}`);
console.log("");

// 14:19 HKT is in Asia Session (08:00–17:00) during EST, but NOT in Asia Kill Zone (09:00–11:00)
assert(nowResult.sessionName === "Asia",
  `14:19 HKT → sessionName = ${nowResult.sessionName} (expected Asia)`);
assert(nowResult.isKillzone === false,
  `14:19 HKT → isKillzone = ${nowResult.isKillzone} (expected false)`);
assert(nowResult.killzoneName === null,
  `14:19 HKT → killzoneName = ${nowResult.killzoneName} (expected null)`);
assert(nowResult.sessionLabel === "Asia Session",
  `14:19 HKT → sessionLabel = "${nowResult.sessionLabel}" (expected "Asia Session")`);

// ─── 4. Sample Report Labels ────────────────────────────────────────────────

console.log("\n── 4. Sample Report Labels ──\n");

const labelTests = [
  { hktH: 9, hktM: 15, day: 6, expected: "Asia Kill Zone (09:00–11:00 HKT)" },
  { hktH: 16, hktM: 15, day: 6, expected: "London Kill Zone (15:00–18:00 HKT)" },
  { hktH: 21, hktM: 15, day: 6, expected: "New York AM Kill Zone (20:00–23:00 HKT)" },
];

for (const lt of labelTests) {
  const utc = hktToUtc(2026, 3, lt.day, lt.hktH, lt.hktM);
  const result = classifySession(utc);
  console.log(`  ${String(lt.hktH).padStart(2, "0")}:${String(lt.hktM).padStart(2, "0")} HKT → "${result.sessionLabel}"`);
  assert(result.sessionLabel === lt.expected,
    `Label at ${lt.hktH}:${lt.hktM} HKT = "${result.sessionLabel}" (expected "${lt.expected}")`);
}

// ─── 5. Non-killzone session labels ─────────────────────────────────────────

console.log("\n── 5. Non-killzone Session Labels ──\n");

const nonKzTests = [
  { hktH: 12, hktM: 0, day: 6, expectedSession: "Asia", expectedLabel: "Asia Session" },
  { hktH: 19, hktM: 0, day: 6, expectedSession: "London", expectedLabel: "London Session" },
  { hktH: 0, hktM: 30, day: 7, expectedSession: "NewYork", expectedLabel: "New York Session" },
  { hktH: 7, hktM: 0, day: 6, expectedSession: "Off-Hours", expectedLabel: "Off-Hours Watch" },
];

for (const t of nonKzTests) {
  const utc = hktToUtc(2026, 3, t.day, t.hktH, t.hktM);
  const result = classifySession(utc);
  console.log(`  ${String(t.hktH).padStart(2, "0")}:${String(t.hktM).padStart(2, "0")} HKT → sessionName="${result.sessionName}", label="${result.sessionLabel}"`);
  assert(result.sessionName === t.expectedSession,
    `${t.hktH}:${t.hktM} HKT → sessionName = ${result.sessionName} (expected ${t.expectedSession})`);
  assert(result.sessionLabel === t.expectedLabel,
    `${t.hktH}:${t.hktM} HKT → sessionLabel = "${result.sessionLabel}" (expected "${t.expectedLabel}")`);
  assert(result.isKillzone === false,
    `${t.hktH}:${t.hktM} HKT → isKillzone = ${result.isKillzone} (expected false)`);
}

// ─── 6. EDT (Summer) DST Check ──────────────────────────────────────────────

console.log("\n── 6. EDT (Summer) DST Validation ──\n");

// Use June 15, 2026 — well into EDT
const edtTests: TestCase[] = [
  {
    label: "08:30 HKT (EDT) → Asia Session, Asia Kill Zone",
    hktH: 8, hktM: 30,
    expectedSession: "Asia",
    expectedIsKillzone: true,
    expectedKillzoneName: "Asia",
  },
  {
    label: "14:30 HKT (EDT) → London Session, London Kill Zone",
    hktH: 14, hktM: 30,
    expectedSession: "London",
    expectedIsKillzone: true,
    expectedKillzoneName: "London",
  },
  {
    label: "19:30 HKT (EDT) → New York Session, NY AM Kill Zone",
    hktH: 19, hktM: 30,
    expectedSession: "NewYork",
    expectedIsKillzone: true,
    expectedKillzoneName: "NY_AM",
  },
  {
    label: "01:30 HKT (EDT) → New York Session, NY PM Kill Zone",
    hktH: 1, hktM: 30,
    expectedSession: "NewYork",
    expectedIsKillzone: true,
    expectedKillzoneName: "NY_PM",
  },
];

for (const tc of edtTests) {
  const day = tc.hktH < 8 ? 16 : 15; // June 15/16
  const utc = hktToUtc(2026, 6, day, tc.hktH, tc.hktM);
  const result = classifySession(utc);

  console.log(`  ${tc.label}`);
  console.log(`    UTC:          ${utc.toISOString()}`);
  console.log(`    sessionName:  ${result.sessionName}`);
  console.log(`    isKillzone:   ${result.isKillzone}`);
  console.log(`    killzoneName: ${result.killzoneName}`);
  console.log(`    sessionLabel: ${result.sessionLabel}`);
  console.log("");

  assert(result.sessionName === tc.expectedSession,
    `EDT ${tc.label} → sessionName = ${result.sessionName} (expected ${tc.expectedSession})`);
  assert(result.isKillzone === tc.expectedIsKillzone,
    `EDT ${tc.label} → isKillzone = ${result.isKillzone} (expected ${tc.expectedIsKillzone})`);
  assert(result.killzoneName === tc.expectedKillzoneName,
    `EDT ${tc.label} → killzoneName = ${result.killzoneName} (expected ${tc.expectedKillzoneName})`);
}

// ─── 7. EDT Schedule Table ──────────────────────────────────────────────────

console.log("\n── 7. EDT (Summer) Schedule Table ──\n");

const edtDate = new Date(Date.UTC(2026, 5, 15, 6, 0, 0)); // June 15 14:00 HKT
const edtTable = getSessionScheduleTable(edtDate);

console.log("| Name                          | HKT Start | HKT End | UTC Start | UTC End |");
console.log("|-------------------------------|-----------|---------|-----------|---------|");
for (const row of edtTable) {
  console.log(`| ${row.name.padEnd(29)} | ${row.hktStart}     | ${row.hktEnd}   | ${row.utcStart}     | ${row.utcEnd}   |`);
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  All tests passed! ✅");
console.log("═══════════════════════════════════════════════════════════════");

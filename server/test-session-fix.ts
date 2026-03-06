/**
 * test-session-fix.ts — Verification script for the HKT session/killzone fix.
 *
 * Run with: npx tsx server/test-session-fix.ts
 * (or compile and run with tsc + node)
 *
 * Tests:
 * 1. time-utils.ts functions
 * 2. session-config.ts classifier against known HKT times
 * 3. Edge cases (midnight wrap, DST transitions)
 * 4. Real-time sanity check for 2026-03-06 ~13:55 HKT
 */

import { nowUtc, toHkt, getHktHourMinute, getHktHour, formatHktTime, formatHktDateTime } from "./time-utils";
import { classifySession, getSessionSchedule } from "./session-config";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
}

console.log("═══════════════════════════════════════════════════════════");
console.log("  Giiq Screener — Session Time & Killzone Fix Verification");
console.log("═══════════════════════════════════════════════════════════");
console.log("");

// ─── Test 1: time-utils ────────────────────────────────────────────────────
console.log("── Test 1: time-utils.ts ──────────────────────────────────");

// 05:55 UTC = 13:55 HKT
const t1 = new Date("2026-03-06T05:55:00.000Z");
const hm1 = getHktHourMinute(t1);
assert(hm1.hour === 13 && hm1.minute === 55, `05:55 UTC → ${hm1.hour}:${hm1.minute} HKT (expect 13:55)`);

// 16:30 UTC = 00:30 HKT (midnight wrap)
const t2 = new Date("2026-03-06T16:30:00.000Z");
const hm2 = getHktHourMinute(t2);
assert(hm2.hour === 0 && hm2.minute === 30, `16:30 UTC → ${hm2.hour}:${hm2.minute} HKT (expect 00:30)`);

// 00:00 UTC = 08:00 HKT
const t3 = new Date("2026-03-06T00:00:00.000Z");
const hm3 = getHktHourMinute(t3);
assert(hm3.hour === 8 && hm3.minute === 0, `00:00 UTC → ${hm3.hour}:${hm3.minute} HKT (expect 08:00)`);

// 20:00 UTC = 04:00 HKT (next day)
const t4 = new Date("2026-03-06T20:00:00.000Z");
const hm4 = getHktHourMinute(t4);
assert(hm4.hour === 4 && hm4.minute === 0, `20:00 UTC → ${hm4.hour}:${hm4.minute} HKT (expect 04:00)`);

// formatHktTime
assert(formatHktTime(t1) === "13:55 HKT", `formatHktTime(05:55 UTC) = "${formatHktTime(t1)}" (expect "13:55 HKT")`);

// Bug #1 old code would produce: 20 + 8 = 28 instead of 4
const buggyResult = t4.getUTCHours() + 8;
const fixedResult = ((t4.getUTCHours() + 8) % 24);
assert(buggyResult === 28, `OLD buggy code: 20+8 = ${buggyResult} (confirming bug exists)`);
assert(fixedResult === 4, `NEW fixed code: (20+8)%24 = ${fixedResult} (correct)`);

console.log("");

// ─── Test 2: Session Classification ─────────────────────────────────────────
console.log("── Test 2: Session Classification ─────────────────────────");

// Asia Killzone: 08:00–09:30 HKT → UTC 00:00–01:30
const asiaKZ = new Date("2026-03-06T00:30:00.000Z"); // 08:30 HKT
const asiaResult = classifySession(asiaKZ);
assert(asiaResult.sessionName === "Asia Killzone", `08:30 HKT → ${asiaResult.sessionName} (expect Asia Killzone)`);
assert(asiaResult.isKillzone === true, `08:30 HKT → killzone=${asiaResult.isKillzone} (expect true)`);
assert(asiaResult.sessionLabel.includes("Asia Session"), `Label: "${asiaResult.sessionLabel}" contains "Asia Session"`);

// Asia Extended: 09:30–12:00 HKT → UTC 01:30–04:00
const asiaExt = new Date("2026-03-06T03:00:00.000Z"); // 11:00 HKT
const asiaExtResult = classifySession(asiaExt);
assert(asiaExtResult.sessionName === "Asia Extended", `11:00 HKT → ${asiaExtResult.sessionName} (expect Asia Extended)`);
assert(asiaExtResult.isKillzone === false, `11:00 HKT → killzone=${asiaExtResult.isKillzone} (expect false)`);

// Off-Hours: 13:55 HKT (between Asia and London)
const offHours = new Date("2026-03-06T05:55:00.000Z"); // 13:55 HKT
const offResult = classifySession(offHours);
assert(offResult.sessionName === "Off-Hours Watch", `13:55 HKT → ${offResult.sessionName} (expect Off-Hours Watch)`);
assert(offResult.isKillzone === false, `13:55 HKT → killzone=${offResult.isKillzone} (expect false)`);

// London Killzone (Winter, before March 29 2026): 16:00–18:00 HKT → UTC 08:00–10:00
// March 6 is before UK DST switch (last Sunday of March 2026 = March 29)
const londonKZ = new Date("2026-03-06T08:30:00.000Z"); // 16:30 HKT
const londonResult = classifySession(londonKZ);
assert(londonResult.sessionName === "London Killzone", `16:30 HKT → ${londonResult.sessionName} (expect London Killzone)`);
assert(londonResult.isKillzone === true, `16:30 HKT → killzone=${londonResult.isKillzone} (expect true)`);
assert(londonResult.sessionLabel.includes("London Tea Time"), `Label: "${londonResult.sessionLabel}" contains "London Tea Time"`);

// US Killzone (Winter / EST, before March 8 2026): 22:30–00:00 HKT → UTC 14:30–16:00
// March 6 is before US DST switch (2nd Sunday of March 2026 = March 8)
const usKZ = new Date("2026-03-06T15:00:00.000Z"); // 23:00 HKT
const usResult = classifySession(usKZ);
assert(usResult.sessionName === "US Killzone", `23:00 HKT → ${usResult.sessionName} (expect US Killzone)`);
assert(usResult.isKillzone === true, `23:00 HKT → killzone=${usResult.isKillzone} (expect true)`);
assert(usResult.sessionLabel.includes("Golden Tank"), `Label: "${usResult.sessionLabel}" contains "Golden Tank"`);

// US Killzone edge: 22:30 HKT exactly
const usKZEdge = new Date("2026-03-06T14:30:00.000Z"); // 22:30 HKT
const usEdgeResult = classifySession(usKZEdge);
assert(usEdgeResult.sessionName === "US Killzone", `22:30 HKT → ${usEdgeResult.sessionName} (expect US Killzone)`);

console.log("");

// ─── Test 3: DST Transitions ────────────────────────────────────────────────
console.log("── Test 3: DST Transitions ────────────────────────────────");

// After US DST (March 8 2026): US Killzone shifts to 21:30–23:00 HKT
const postUSDST = new Date("2026-03-09T13:45:00.000Z"); // 21:45 HKT, March 9 (after US DST)
const postUSDSTResult = classifySession(postUSDST);
assert(postUSDSTResult.sessionName === "US Killzone", `21:45 HKT (post-US-DST) → ${postUSDSTResult.sessionName} (expect US Killzone)`);

// After UK DST (March 29 2026): London Killzone shifts to 15:00–17:00 HKT
const postUKDST = new Date("2026-03-30T07:30:00.000Z"); // 15:30 HKT, March 30 (after UK DST)
const postUKDSTResult = classifySession(postUKDST);
assert(postUKDSTResult.sessionName === "London Killzone", `15:30 HKT (post-UK-DST) → ${postUKDSTResult.sessionName} (expect London Killzone)`);

// Pre-UK DST: 15:30 HKT should be Off-Hours (London doesn't start until 16:00)
const preUKDST = new Date("2026-03-06T07:30:00.000Z"); // 15:30 HKT, March 6 (before UK DST)
const preUKDSTResult = classifySession(preUKDST);
assert(preUKDSTResult.sessionName === "Off-Hours Watch", `15:30 HKT (pre-UK-DST) → ${preUKDSTResult.sessionName} (expect Off-Hours Watch)`);

console.log("");

// ─── Test 4: Real-Time Sanity (2026-03-06 ~13:55 HKT) ──────────────────────
console.log("── Test 4: Real-Time Sanity Check ─────────────────────────");

const realNow = new Date();
const realClassification = classifySession(realNow);
const realHm = getHktHourMinute(realNow);

console.log(`  Current UTC:    ${realNow.toISOString()}`);
console.log(`  Computed HKT:   ${realHm.hour}:${String(realHm.minute).padStart(2, '0')}`);
console.log(`  HKT formatted:  ${formatHktTime(realNow)}`);
console.log(`  HKT datetime:   ${formatHktDateTime(realNow)}`);
console.log(`  Session name:   ${realClassification.sessionName}`);
console.log(`  Session label:  ${realClassification.sessionLabel}`);
console.log(`  Is killzone:    ${realClassification.isKillzone}`);
console.log("");

// ─── Test 5: Session Schedule Table ─────────────────────────────────────────
console.log("── Test 5: Session Schedule Table (current DST context) ───");

const schedule = getSessionSchedule(realNow);
console.log("");
console.log("  | Session              | HKT Start | HKT End | UTC Start | UTC End | Killzone |");
console.log("  |----------------------|-----------|---------|-----------|---------|----------|");
for (const s of schedule) {
  console.log(`  | ${s.label.padEnd(20)} | ${s.hktStart.padEnd(9)} | ${s.hktEnd.padEnd(7)} | ${s.utcStart.padEnd(9)} | ${s.utcEnd.padEnd(7)} | ${s.isKillzone ? 'YES' : 'no '}      |`);
}
console.log("  | Off-Hours Watch      | (all other times)                                    |");
console.log("");

// ─── Summary ────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════════════════");

if (failed > 0) {
  process.exit(1);
}

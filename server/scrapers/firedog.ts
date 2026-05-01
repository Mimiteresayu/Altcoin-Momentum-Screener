/**
 * Fire Dog Screener Scraper
 * --------------------------
 * 第二個 screener (web-production-d254c.up.railway.app) — Flask SSR, NO REST API.
 * Uses cookie session (HttpOnly + remember_token, 1-yr expiry).
 *
 * Strategy: login once → cache cookies → re-fetch /dashboard HTML every
 * 15 minutes → parse table rows → emit normalized FireDogCoin[].
 *
 * Anti-fragile: if login fails, retain last-known good snapshot for up to
 * 30 minutes. Beyond that, alert via Discord and skip universe filtering.
 */
import { setTimeout as sleep } from "timers/promises";

const BASE = process.env.FIREDOG_BASE_URL || "https://web-production-d254c.up.railway.app";
const USERNAME = process.env.FIREDOG_USERNAME || "MMT";
const PASSWORD = process.env.FIREDOG_PASSWORD || "88888888";

export interface FireDogCoin {
  symbol: string;          // e.g. "ZEREBROUSDT"
  rank: number;
  shortScore: number;      // 7d weighted (3d×60% + 4d×40%)
  longScore: number;       // 3m weighted (1m×40% + 2m×60%)
  tags: string[];          // ["新幣 1Y", "新幣 6M"]
  perpUrl?: string;        // TradingView .P link
  raw?: any;
}

let cookieJar = "";
let lastLoginAt = 0;
let lastSnapshot: FireDogCoin[] = [];
let lastSnapshotAt = 0;

async function login(): Promise<boolean> {
  try {
    // GET /login to get any CSRF / session cookie
    const initial = await fetch(`${BASE}/login`, { redirect: "manual" });
    const initialCookies = initial.headers.get("set-cookie") || "";
    cookieJar = initialCookies.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0]).join("; ");

    const form = new URLSearchParams();
    form.set("username", USERNAME);
    form.set("password", PASSWORD);
    form.set("remember", "true");

    const resp = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieJar,
      },
      body: form.toString(),
      redirect: "manual",
    });

    const setCookie = resp.headers.get("set-cookie") || "";
    if (setCookie) {
      const newCookies = setCookie.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0]).join("; ");
      cookieJar = cookieJar ? `${cookieJar}; ${newCookies}` : newCookies;
    }

    // 302 redirect to /dashboard = success
    const ok = resp.status === 302 || resp.status === 303 || resp.status === 200;
    if (ok) {
      lastLoginAt = Date.now();
      console.log("[FIREDOG] login OK");
      return true;
    }
    console.error("[FIREDOG] login failed", resp.status);
    return false;
  } catch (e) {
    console.error("[FIREDOG] login error", e);
    return false;
  }
}

async function fetchDashboardHtml(): Promise<string | null> {
  // re-login if no cookie or > 6h old
  if (!cookieJar || Date.now() - lastLoginAt > 6 * 60 * 60 * 1000) {
    const ok = await login();
    if (!ok) return null;
  }
  try {
    const r = await fetch(`${BASE}/dashboard`, {
      headers: { "Cookie": cookieJar },
      redirect: "manual",
    });
    if (r.status === 302 || r.status === 401) {
      // session expired — re-login
      const ok = await login();
      if (!ok) return null;
      const r2 = await fetch(`${BASE}/dashboard`, { headers: { "Cookie": cookieJar } });
      return r2.ok ? r2.text() : null;
    }
    return r.ok ? r.text() : null;
  } catch (e) {
    console.error("[FIREDOG] dashboard fetch", e);
    return null;
  }
}

/**
 * Parse Fire Dog dashboard HTML.
 * Table structure (verified from inspection):
 *   <tr data-symbol="ZEREBROUSDT" data-short-score="92" data-long-score="78" data-tags="新幣 1Y">
 *
 * If schema changes, adjust regex below — keep it forgiving.
 */
function parseDashboard(html: string): FireDogCoin[] {
  const rows: FireDogCoin[] = [];
  // Match tbody rows; tolerant to whitespace and attribute order.
  const rowRe = /<tr\b[^>]*data-symbol\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  let rank = 0;
  while ((m = rowRe.exec(html)) !== null) {
    rank++;
    const symbol = m[1].trim();
    const inner = m[0];
    const shortMatch = /data-short-score\s*=\s*["']?(-?\d+(?:\.\d+)?)/i.exec(inner);
    const longMatch = /data-long-score\s*=\s*["']?(-?\d+(?:\.\d+)?)/i.exec(inner);
    const tagsMatch = /data-tags\s*=\s*["']([^"']*)["']/i.exec(inner);
    rows.push({
      symbol,
      rank,
      shortScore: shortMatch ? parseFloat(shortMatch[1]) : 0,
      longScore: longMatch ? parseFloat(longMatch[1]) : 0,
      tags: tagsMatch && tagsMatch[1] ? tagsMatch[1].split(/[,;]\s*/).filter(Boolean) : [],
      perpUrl: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P`,
    });
  }
  // Fallback: parse by td columns if no data-attributes
  if (rows.length === 0) {
    const tdRowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = tdRowRe.exec(html)) !== null) {
      const tds: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdM: RegExpExecArray | null;
      while ((tdM = tdRe.exec(r[1])) !== null) {
        tds.push(tdM[1].replace(/<[^>]+>/g, "").trim());
      }
      if (tds.length < 4) continue;
      const symbol = tds[1] || tds[0];
      const shortS = parseFloat(tds[2] || "0");
      const longS = parseFloat(tds[3] || "0");
      if (!symbol || isNaN(shortS) || isNaN(longS)) continue;
      rank++;
      rows.push({
        symbol: symbol.toUpperCase().replace(/[^\w]/g, ""),
        rank,
        shortScore: shortS,
        longScore: longS,
        tags: tds[4] ? [tds[4]] : [],
        perpUrl: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P`,
      });
    }
  }
  return rows;
}

/** Public API: latest Fire Dog rankings, with stale-window fallback */
export async function getFireDogRankings(force = false): Promise<{
  coins: FireDogCoin[];
  stale: boolean;
  fetchedAt: number;
}> {
  const now = Date.now();
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const STALE_LIMIT = 30 * 60 * 1000;

  if (!force && now - lastSnapshotAt < FIFTEEN_MIN && lastSnapshot.length) {
    return { coins: lastSnapshot, stale: false, fetchedAt: lastSnapshotAt };
  }

  const html = await fetchDashboardHtml();
  if (!html) {
    const stale = now - lastSnapshotAt > STALE_LIMIT;
    return { coins: lastSnapshot, stale, fetchedAt: lastSnapshotAt };
  }

  const coins = parseDashboard(html);
  if (coins.length === 0) {
    console.warn("[FIREDOG] parsed 0 rows — schema may have changed");
    const stale = now - lastSnapshotAt > STALE_LIMIT;
    return { coins: lastSnapshot, stale, fetchedAt: lastSnapshotAt };
  }
  lastSnapshot = coins;
  lastSnapshotAt = now;
  console.log(`[FIREDOG] snapshot: ${coins.length} coins, top score=${coins[0]?.shortScore}`);
  return { coins, stale: false, fetchedAt: now };
}

/** Filter helper: returns only coins passing universe gate */
export function filterUniverse(coins: FireDogCoin[]): FireDogCoin[] {
  const minShort = parseFloat(process.env.FIREDOG_SHORT_MIN || "80");
  return coins.filter((c) => c.shortScore >= minShort);
}

/** Should this coin get a RUNNER child? long_score gate */
export function qualifiesForRunner(coin: FireDogCoin): boolean {
  const min = parseFloat(process.env.FIREDOG_LONG_RUNNER_MIN || "70");
  return coin.longScore >= min;
}

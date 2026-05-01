/**
 * Cockpit Password Gate
 * ----------------------
 * Protects /cockpit page + private autotrade APIs behind a single password.
 *
 * Auth flow:
 *   1. User opens /cockpit (or /api/ai/* etc.)
 *   2. Middleware checks signed cookie `cockpit_auth=<token>`
 *   3. If missing/invalid -> redirect to /cockpit-login (HTML) or 401 (API)
 *   4. POST /cockpit-login with password sets the cookie (90-day expiry)
 *
 * Env: COCKPIT_PASSWORD (required) — if unset, gate is BYPASSED with a console
 * warning. This means dev/local works without setup, but production deploys
 * MUST set the var.
 *
 * Token = HMAC-SHA256(timestamp:password) using COCKPIT_PASSWORD as key.
 * Stateless — no session store needed.
 */
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const COOKIE_NAME = "cockpit_auth";
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function getPassword(): string | null {
  const p = process.env.COCKPIT_PASSWORD;
  if (!p || p.length < 4) return null;
  return p;
}

function sign(timestamp: number, password: string): string {
  return crypto.createHmac("sha256", password).update(String(timestamp)).digest("hex");
}

function makeToken(password: string): string {
  const ts = Date.now();
  const sig = sign(ts, password);
  return `${ts}.${sig}`;
}

function verifyToken(token: string, password: string): boolean {
  const [tsStr, sig] = token.split(".");
  const ts = parseInt(tsStr, 10);
  if (!ts || !sig) return false;
  if (Date.now() - ts > COOKIE_MAX_AGE_MS) return false;
  const expected = sign(ts, password);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseCookie(req: Request): string | null {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}

function isAuthed(req: Request): boolean {
  const password = getPassword();
  if (!password) return true; // bypass if not configured
  const token = parseCookie(req);
  if (!token) return false;
  return verifyToken(token, password);
}

/**
 * Express middleware — call on routes you want to protect.
 */
export function requireCockpitAuth(req: Request, res: Response, next: NextFunction) {
  const password = getPassword();
  if (!password) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[cockpit-auth] COCKPIT_PASSWORD not set — private routes are OPEN");
    }
    return next();
  }
  if (isAuthed(req)) return next();

  // API request -> 401 JSON
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "auth required", login: "/cockpit-login" });
    return;
  }
  // Page request -> redirect to login
  res.redirect(`/cockpit-login?next=${encodeURIComponent(req.originalUrl || "/cockpit")}`);
}

/**
 * GET /cockpit-login — minimal HTML login form
 */
export function getCockpitLogin(req: Request, res: Response) {
  const password = getPassword();
  if (!password) {
    res.status(503).send("Cockpit auth not configured. Set COCKPIT_PASSWORD env var.");
    return;
  }
  if (isAuthed(req)) {
    const next = String(req.query.next || "/cockpit");
    res.redirect(next);
    return;
  }
  const error = req.query.error ? `<div style="color:#f87171;font-size:13px;margin-top:8px">Wrong password</div>` : "";
  const next = String(req.query.next || "/cockpit");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cockpit · Login</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;background:#0b0b0f;color:#e4e4e7;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .box{max-width:360px;width:100%;background:#16161d;border:1px solid #27272a;border-radius:12px;padding:32px}
  h1{font-size:20px;margin:0 0 6px;font-weight:600}
  .sub{font-size:13px;color:#a1a1aa;margin-bottom:24px}
  label{display:block;font-size:12px;color:#a1a1aa;margin-bottom:6px}
  input{width:100%;padding:10px 12px;background:#0b0b0f;border:1px solid #3f3f46;border-radius:8px;color:#fff;font-size:14px;outline:none}
  input:focus{border-color:#6366f1}
  button{width:100%;margin-top:16px;padding:10px;background:#6366f1;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px}
  button:hover{background:#4f46e5}
  .foot{font-size:11px;color:#52525b;margin-top:20px;text-align:center}
</style>
</head><body>
<form class="box" method="POST" action="/cockpit-login">
  <h1>Altcoin Momentum + QMDJ</h1>
  <div class="sub">Private cockpit · Enter password to continue</div>
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <label>Password</label>
  <input type="password" name="password" autofocus required>
  <button type="submit">Unlock</button>
  ${error}
  <div class="foot">Session lasts 90 days on this browser</div>
</form>
</body></html>`);
}

/**
 * POST /cockpit-login — verify password, set cookie, redirect.
 */
export function postCockpitLogin(req: Request, res: Response) {
  const password = getPassword();
  if (!password) {
    res.status(503).send("Cockpit auth not configured.");
    return;
  }
  const submitted = String((req.body && req.body.password) || "");
  const next = String((req.body && req.body.next) || "/cockpit");
  if (submitted !== password) {
    res.redirect(`/cockpit-login?error=1&next=${encodeURIComponent(next)}`);
    return;
  }
  const token = makeToken(password);
  const isProd = process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(
      COOKIE_MAX_AGE_MS / 1000
    )}; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`
  );
  res.redirect(next);
}

/**
 * POST /cockpit-logout — clear cookie.
 */
export function postCockpitLogout(_req: Request, res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.redirect("/cockpit-login");
}

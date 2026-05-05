/**
 * Cockpit Auth — JSON API Gate
 * ----------------------------
 * Single-password gate for private cockpit routes.
 *
 * Spec (feat/yuth-confluence · password gate task):
 *   - Cookie:    cockpit_session  (httpOnly, secure in prod, sameSite=strict)
 *   - Max age:   30 days
 *   - Login:     POST /api/auth/login   { password }   → 200 + Set-Cookie  | 401
 *   - Logout:    POST /api/auth/logout                 → 200 + clear cookie
 *   - Guard:     requireAuth → 401 { error: "unauthorized" }
 *   - Limit:     5 attempts / 15min / IP on /api/auth/login (express-rate-limit)
 *   - Env:       COCKPIT_PASSWORD (required in prod; if unset → bypass + warn)
 *
 * Token format: <ts>.<hmac-sha256(ts, COCKPIT_PASSWORD)>
 *   - Stateless, no session store
 *   - Verified with crypto.timingSafeEqual to prevent timing leaks
 *   - Rotating COCKPIT_PASSWORD invalidates all existing cookies
 */
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const COOKIE_NAME = "cockpit_session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getPassword(): string | null {
  const p = process.env.COCKPIT_PASSWORD;
  if (!p || p.length < 4) return null;
  return p;
}

function sign(ts: number, password: string): string {
  return crypto.createHmac("sha256", password).update(String(ts)).digest("hex");
}

function makeToken(password: string): string {
  const ts = Date.now();
  return `${ts}.${sign(ts, password)}`;
}

function verifyToken(token: string, password: string): boolean {
  const [tsStr, sig] = token.split(".");
  const ts = parseInt(tsStr, 10);
  if (!ts || !sig) return false;
  if (Date.now() - ts > COOKIE_MAX_AGE_MS) return false;
  const expected = sign(ts, password);
  try {
    return (
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

function parseSessionCookie(req: Request): string | null {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}

function buildSetCookie(token: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const maxAgeSec = Math.floor(COOKIE_MAX_AGE_MS / 1000);
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isProd) flags.push("Secure");
  return flags.join("; ");
}

function buildClearCookie(): string {
  const isProd = process.env.NODE_ENV === "production";
  const flags = [`${COOKIE_NAME}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Strict"];
  if (isProd) flags.push("Secure");
  return flags.join("; ");
}

/**
 * isAuthed — true if request carries a valid session cookie OR password unset.
 */
export function isAuthed(req: Request): boolean {
  const password = getPassword();
  if (!password) return true; // bypass when not configured
  const token = parseSessionCookie(req);
  if (!token) return false;
  return verifyToken(token, password);
}

/**
 * requireAuth — Express middleware. 401 JSON if not authed.
 * Use on /api/cockpit/*, /api/confluence/*, /api/ai/*, /api/qimen/*, /api/thesis/*.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const password = getPassword();
  if (!password) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[auth] COCKPIT_PASSWORD not set — private routes are OPEN");
    }
    return next();
  }
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

/**
 * Rate limiter for /api/auth/login — 5 attempts / 15min / IP.
 * Returns 429 { error: "too_many_attempts" } when exceeded.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Allow exactly 5 failed attempts; the 6th is blocked.
  // express-rate-limit increments the counter BEFORE the handler, then
  // skipSuccessfulRequests rolls back successful ones. So with limit=5,
  // attempt 5 is blocked. limit=6 yields the desired "5 wrongs allowed".
  limit: 6,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_attempts" },
  skipSuccessfulRequests: true,
});

/**
 * POST /api/auth/login
 *   body: { password: string }
 *   200  → { ok: true } + Set-Cookie cockpit_session
 *   401  → { error: "unauthorized" }
 *   503  → { error: "auth_not_configured" }
 */
export function postLogin(req: Request, res: Response) {
  const password = getPassword();
  if (!password) {
    res.status(503).json({ error: "auth_not_configured" });
    return;
  }
  const submitted = String((req.body && req.body.password) || "");
  // Constant-time compare on the password itself
  let ok = false;
  try {
    const a = Buffer.from(submitted);
    const b = Buffer.from(password);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const token = makeToken(password);
  res.setHeader("Set-Cookie", buildSetCookie(token));
  res.status(200).json({ ok: true });
}

/**
 * POST /api/auth/logout — clear cookie. Always 200.
 */
export function postLogout(_req: Request, res: Response) {
  res.setHeader("Set-Cookie", buildClearCookie());
  res.status(200).json({ ok: true });
}

/**
 * GET /api/auth/status — lightweight probe for the frontend gate.
 *   200 { authed: true|false, configured: true|false }
 */
export function getStatus(req: Request, res: Response) {
  res.status(200).json({
    authed: isAuthed(req),
    configured: getPassword() !== null,
  });
}

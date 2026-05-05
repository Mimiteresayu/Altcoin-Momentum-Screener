/**
 * PasswordGate — frontend route guard.
 *
 * Wraps protected pages (/cockpit, /backtest, /signals) with a password modal.
 *
 * Behaviour:
 *   1. On mount: GET /api/auth/status to determine cookie validity
 *   2. If authed → render children
 *   3. If not authed (or auth not configured) → render password modal
 *   4. Submit posts to /api/auth/login. On 200 → reload page (cookie set)
 *   5. 5 wrong attempts → screen locks for 15 min (countdown)
 *   6. Logout icon (top-right) clears cookie, reloads
 *
 * Lockout state persists across reloads via localStorage so refresh can't
 * bypass the timer. Server-side rate limit (5/15min/IP) is the real enforcement.
 */
import { useEffect, useState, useRef, type ReactNode, type FormEvent } from "react";
import { LogOut, Lock, Loader2, ShieldAlert } from "lucide-react";

const LOCK_KEY = "cockpit_login_lock_until";
const ATTEMPTS_KEY = "cockpit_login_attempts";
const LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type Status = "checking" | "authed" | "locked_out" | "needs_login";

interface AuthStatus {
  authed: boolean;
  configured: boolean;
}

function readLockUntil(): number {
  try {
    const v = parseInt(localStorage.getItem(LOCK_KEY) || "0", 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function readAttempts(): number {
  try {
    return parseInt(localStorage.getItem(ATTEMPTS_KEY) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

function setAttempts(n: number) {
  try {
    localStorage.setItem(ATTEMPTS_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function setLock(untilMs: number) {
  try {
    localStorage.setItem(LOCK_KEY, String(untilMs));
  } catch {
    /* ignore */
  }
}

function clearLock() {
  try {
    localStorage.removeItem(LOCK_KEY);
    localStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    /* ignore */
  }
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* ignore */
    }
    clearLock();
    window.location.reload();
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Logout"
      aria-label="Logout"
      className="fixed top-3 right-3 z-50 p-2 rounded-md bg-card/80 backdrop-blur border border-white/10 text-muted-foreground hover:text-foreground hover:bg-card transition disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
    </button>
  );
}

interface PasswordGateProps {
  children: ReactNode;
}

export default function PasswordGate({ children }: PasswordGateProps) {
  const [status, setStatus] = useState<Status>("checking");
  const [configured, setConfigured] = useState<boolean>(true);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lockRemaining, setLockRemaining] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 1) On mount, probe /api/auth/status
  useEffect(() => {
    let cancelled = false;
    const lockUntil = readLockUntil();
    if (lockUntil > Date.now()) {
      setStatus("locked_out");
      setLockRemaining(lockUntil - Date.now());
      return;
    }
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: AuthStatus) => {
        if (cancelled) return;
        setConfigured(data.configured);
        if (data.authed) {
          setStatus("authed");
          clearLock();
        } else {
          setStatus("needs_login");
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Network failure → show login modal so user can retry
        setStatus("needs_login");
        setErrorMsg("Connection error. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Lock countdown
  useEffect(() => {
    if (status !== "locked_out") return;
    const tick = () => {
      const remaining = readLockUntil() - Date.now();
      if (remaining <= 0) {
        clearLock();
        setStatus("needs_login");
        setLockRemaining(0);
        return;
      }
      setLockRemaining(remaining);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  // Autofocus the input when login modal appears
  useEffect(() => {
    if (status === "needs_login") {
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
  }, [status]);

  if (status === "authed") {
    return (
      <>
        <LogoutButton />
        {children}
      </>
    );
  }

  if (status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (readLockUntil() > Date.now()) {
      setStatus("locked_out");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        clearLock();
        // Reload so cookie takes effect on initial server-rendered routes
        window.location.reload();
        return;
      }
      if (r.status === 429) {
        const until = Date.now() + LOCK_MS;
        setLock(until);
        setLockRemaining(LOCK_MS);
        setStatus("locked_out");
        setSubmitting(false);
        return;
      }
      // 401 or 503
      const next = readAttempts() + 1;
      setAttempts(next);
      if (next >= MAX_ATTEMPTS) {
        const until = Date.now() + LOCK_MS;
        setLock(until);
        setLockRemaining(LOCK_MS);
        setStatus("locked_out");
        setSubmitting(false);
        return;
      }
      if (r.status === 503) {
        setErrorMsg("Auth not configured on server.");
      } else {
        const remain = MAX_ATTEMPTS - next;
        setErrorMsg(`Wrong password. ${remain} attempt${remain === 1 ? "" : "s"} left.`);
      }
      setPassword("");
      setSubmitting(false);
    } catch {
      setErrorMsg("Connection error. Try again.");
      setSubmitting(false);
    }
  };

  // Modal UI
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm bg-card border border-white/10 rounded-xl p-7 shadow-xl">
        {status === "locked_out" ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="w-5 h-5 text-red-400" />
              <h1 className="text-lg font-semibold">Locked out</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Too many failed attempts. Try again in{" "}
              <span className="font-mono text-foreground">{formatRemaining(lockRemaining)}</span>.
            </p>
            <div className="text-xs text-muted-foreground/70">
              Server enforces a 5 / 15&nbsp;min rate limit per IP.
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <Lock className="w-5 h-5 text-primary" />
              <h1 className="text-lg font-semibold">Cockpit Locked</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              {configured
                ? "Enter password to continue."
                : "Auth not configured on this deployment."}
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                ref={inputRef}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting || !configured}
                placeholder="Password"
                className="w-full px-3 py-2 rounded-md bg-background border border-white/10 text-foreground text-sm outline-none focus:border-primary disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={submitting || !configured || password.length === 0}
                className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Unlock
              </button>
              {errorMsg ? (
                <div className="text-xs text-red-400 pt-1">{errorMsg}</div>
              ) : null}
            </form>
            <div className="text-[11px] text-muted-foreground/60 mt-5 text-center">
              Session lasts 30 days on this browser
            </div>
          </>
        )}
      </div>
    </div>
  );
}

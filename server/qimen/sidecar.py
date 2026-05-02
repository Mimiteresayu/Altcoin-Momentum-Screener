"""
Qimen 奇門遁甲 Sidecar (REAL — Yuth's CTC_KinQimen logic)
=========================================================
Ported verbatim from qmdj.ipynb (Yuth's notebook), with:
  - Longitude changed from Bangkok (100.03) to Hong Kong (114.17)
  - Path-bug workaround for kinqimen 0.0.6.6 (`import config`)

Run: python server/qimen/sidecar.py
Endpoints:
  GET /health              -> liveness + kinqimen import status
  GET /pan[?ts=ISO8601]    -> full 排盤 dict (no scoring)
  GET /score?symbol=XXX    -> { pan, yongshen_palace, raw } — NO numeric score

DESIGN CHOICE (important):
  This sidecar does NOT compute a 0–1 score. Per Yuth's method, the FULL pan
  must be fed into the LLM (DeepSeek), together with SMC structure + screener
  data, and the LLM produces the holistic judgment. Hardcoded weighting of
  individual elements (門/神/星/馬星/旬空) would lose 9-palace interaction
  context, which is the entire point of 奇門.

  We DO pre-compute a 用神宮 (deterministic per symbol via hash) so every
  consumer agrees which palace to focus on, but the *interpretation* of that
  palace + its relationships is delegated to the LLM.
"""
from __future__ import annotations
import datetime as dt
import http.server
import json
import math
import os
import sys
import traceback
from datetime import timedelta, timezone
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("QIMEN_SIDECAR_PORT", "8765"))
LON = float(os.environ.get("QIMEN_LON", "114.17"))   # Hong Kong default

# ---------------------------------------------------------------------------
# Try to import the real engine. If unavailable, expose a clear error rather
# than silently returning random scores.
#
# kinqimen 0.0.6.6 has a path bug: kinqimen.py does `import config` instead of
# `from . import config`, so on Python 3 the import fails. Workaround: add the
# kinqimen package directory itself onto sys.path so bare `import config`
# resolves to the package's own config.py. This is exactly what Yuth referenced
# as "這個組件有個 Bug，路徑問題".
# ---------------------------------------------------------------------------
# kinqimen 0.0.6.6 ships kinqimen.py and config.py both inside the kinqimen/
# package directory but its kinqimen.py uses bare `import config`, which only
# works if its own folder is on sys.path. We patch that AND we load the
# kinqimen.py file by direct importlib spec because `from kinqimen import
# kinqimen` fails (the package's __init__.py does not re-export it).
kinqimen = None
HAS_KINQIMEN = False
KINQIMEN_ERR = None
try:
    import importlib.util as _ilu
    import os as _os
    _spec = _ilu.find_spec("kinqimen")
    if _spec and _spec.submodule_search_locations:
        _pkg_dir = _spec.submodule_search_locations[0]
        if _pkg_dir not in sys.path:
            sys.path.insert(0, _pkg_dir)   # so bare `import config` resolves
        _kq_file = _os.path.join(_pkg_dir, "kinqimen.py")
        _kq_spec = _ilu.spec_from_file_location("_kinqimen_inner", _kq_file)
        kinqimen = _ilu.module_from_spec(_kq_spec)
        _kq_spec.loader.exec_module(kinqimen)   # type: ignore
        HAS_KINQIMEN = True
    else:
        raise ImportError("kinqimen package not found by importlib")
except Exception as e:
    KINQIMEN_ERR = f"{type(e).__name__}: {e}"
    print(f"[QIMEN] WARN — kinqimen not importable: {KINQIMEN_ERR}", file=sys.stderr)


# ---------------------------------------------------------------------------
# True Solar Time (真太陽時) calc — exactly as Yuth's notebook
# ---------------------------------------------------------------------------
def get_tst_dt(utc_dt: dt.datetime, lon: float = LON) -> dt.datetime:
    """Convert UTC -> True Solar Time at the given longitude."""
    lmt_dt = utc_dt + timedelta(hours=lon / 15.0)
    day_of_year = utc_dt.timetuple().tm_yday
    b = 2 * math.pi * (day_of_year - 81) / 365.0
    e_time = 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)
    return lmt_dt + timedelta(minutes=e_time)


def calc_pan(utc_dt: dt.datetime | None = None) -> dict:
    """Return the full kinqimen 排盤 dict for the given UTC time (or now)."""
    if utc_dt is None:
        utc_dt = dt.datetime.now(timezone.utc)
    if utc_dt.tzinfo is None:
        utc_dt = utc_dt.replace(tzinfo=timezone.utc)
    tst = get_tst_dt(utc_dt, LON)
    if not HAS_KINQIMEN:
        raise RuntimeError(f"kinqimen package not installed: {KINQIMEN_ERR}")
    res = kinqimen.Qimen(tst.year, tst.month, tst.day, tst.hour, tst.minute).pan(1)  # 1=拆補
    res["__tst__"] = tst.strftime("%Y-%m-%d %H:%M:%S")
    res["__lon__"] = LON
    return res


# ---------------------------------------------------------------------------
# 用神宮 selection — symbol → palace (deterministic, stable across runs)
# We exclude 中宮 (5) since 中 has no 門/神 layout. The LLM owns interpretation.
# ---------------------------------------------------------------------------
DIZHI_TO_PALACE = {
    "亥": 6, "戌": 6, "酉": 7, "申": 2, "未": 2,
    "午": 9, "巳": 4, "辰": 4, "卯": 3, "寅": 8, "丑": 8, "子": 1,
}
PALACE_TO_TRIGRAM = {4: "巽", 9: "離", 2: "坤", 3: "震", 5: "中",
                     7: "兌", 8: "艮", 1: "坎", 6: "乾"}
TRIGRAM_TO_PALACE = {v: k for k, v in PALACE_TO_TRIGRAM.items()}


def pick_yongshen_palace(symbol: str) -> str:
    """Deterministically map a coin symbol to one of 8 outer 用神 palaces.
    Hash is stable across runs so backtests reproduce."""
    h = sum(ord(c) for c in symbol.upper())
    palaces = [4, 9, 2, 3, 7, 8, 1, 6]   # exclude 5 (中)
    return PALACE_TO_TRIGRAM[palaces[h % len(palaces)]]


def extract_yongshen_cell(pan: dict, yong_trigram: str) -> dict:
    """Pull every element occupying the 用神宮 — for LLM context, NOT scoring."""
    return {
        "trigram": yong_trigram,
        "palace_num": TRIGRAM_TO_PALACE.get(yong_trigram),
        "door":    pan.get("門",   {}).get(yong_trigram, ""),
        "god":     pan.get("神",   {}).get(yong_trigram, ""),
        "star":    pan.get("星",   {}).get(yong_trigram, ""),
        "tian_gan": pan.get("天盤", {}).get(yong_trigram, ""),
        "di_gan":   pan.get("地盤", {}).get(yong_trigram, ""),
        "changsheng": pan.get("長生運", {}).get("天盤", {}).get(yong_trigram, {}),
    }


def score_symbol(symbol: str, utc_dt: dt.datetime | None = None) -> dict:
    """Return RAW pan + 用神 coordinates. NO numeric score — LLM owns judgment.

    Output shape (consumed by sidecar.ts → thesis-generator.ts):
      {
        symbol, yongshen_palace (trigram),
        yongshen_cell: { door, god, star, tian_gan, di_gan, ... },
        ganzhi, jieqi, pailu, zhifuzhishi, tianyi, mash, xunshou, xunkong,
        pan_raw: { 天盤, 地盤, 門, 星, 神, 長生運, ... full pan },
        meta: { tst, lon }
      }
    """
    pan = calc_pan(utc_dt)
    yong_trigram = pick_yongshen_palace(symbol)
    yong_cell = extract_yongshen_cell(pan, yong_trigram)

    # Strip the internal __tst__/__lon__ markers from pan_raw, surface them in meta.
    pan_raw = {k: v for k, v in pan.items() if not k.startswith("__")}

    return {
        "symbol": symbol,
        "yongshen_palace": yong_trigram,
        "yongshen_cell": yong_cell,
        "pailu":        pan.get("排局", ""),
        "ganzhi":       pan.get("干支", ""),
        "jieqi":        pan.get("節氣", ""),
        "zhifuzhishi":  pan.get("值符值使", ""),
        "tianyi":       pan.get("天乙", ""),
        "mash":         pan.get("馬星", {}),
        "xunshou":      pan.get("旬首", ""),
        "xunkong":      pan.get("旬空", {}),
        "pan_raw":      pan_raw,
        "meta": {
            "tst": pan.get("__tst__"),
            "lon": pan.get("__lon__"),
        },
    }


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/health":
                self._json({
                    "ok": True,
                    "kinqimen_loaded": HAS_KINQIMEN,
                    "kinqimen_err": KINQIMEN_ERR,
                    "lon": LON,
                })
                return
            if url.path == "/pan":
                pan = calc_pan()
                self._json(pan)
                return
            if url.path == "/score":
                qs = parse_qs(url.query)
                symbol = qs.get("symbol", ["BTCUSDT"])[0]
                result = score_symbol(symbol)
                self._json(result)
                return
            self._json({"error": "not found"}, status=404)
        except Exception as e:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr)
            self._json({"error": str(e), "trace": tb}, status=500)

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[QIMEN] sidecar listening on :{PORT}  "
          f"kinqimen_loaded={HAS_KINQIMEN}  lon={LON}")
    server.serve_forever()

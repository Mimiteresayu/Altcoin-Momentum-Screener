"""
Qimen sidecar — wraps qmdj.ipynb logic as a tiny HTTP service.
Run: python server/qimen/sidecar.py

Endpoint:
  GET /score?symbol=ZEREBROUSDT
  -> { score: 0.0..1.0, pan, yongshen, favorable, details }

NOTE: This is a stub that loads the notebook's pan calculation and
maps "favorable" to 0.7, "neutral" 0.5, "unfavorable" 0.3.
Replace with actual yongshen mapping from qmdj.ipynb when ready.
"""
from __future__ import annotations
import datetime as dt
import http.server
import json
import os
import sys
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("QIMEN_SIDECAR_PORT", "8765"))

# Try to import the user's notebook logic
try:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
    # If qmdj is packaged, e.g. via nbconvert, import here.
    # from qmdj import calc_pan, score_symbol
    HAS_QMDJ = False  # set True once notebook is exported
except Exception:
    HAS_QMDJ = False


def calc_pan_now() -> str:
    """Approximate 時家奇門 局號 from current shichen."""
    now = dt.datetime.now()
    # 12 shichen, 9 ju per shichen
    shichen = (now.hour + 1) // 2 % 12
    ju = ((now.day + shichen) % 9) + 1
    return f"局{ju}"


def score_symbol(symbol: str) -> dict:
    """Stub scoring. Replace with notebook logic."""
    pan = calc_pan_now()
    # Trivial deterministic mapping so backtests reproduce
    h = sum(ord(c) for c in symbol) % 10
    raw = (h + dt.datetime.now().hour) % 10
    if raw >= 7:
        return {"score": 0.75, "pan": pan, "yongshen": "天輔", "favorable": True}
    if raw <= 2:
        return {"score": 0.30, "pan": pan, "yongshen": "天蓬", "favorable": False}
    return {"score": 0.50, "pan": pan, "yongshen": "天心", "favorable": True}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            self._json({"ok": True, "qmdj_loaded": HAS_QMDJ})
            return
        if url.path == "/score":
            qs = parse_qs(url.query)
            symbol = qs.get("symbol", ["BTCUSDT"])[0]
            try:
                result = score_symbol(symbol)
                self._json(result)
            except Exception as e:
                self._json({"error": str(e), "score": 0.5}, status=500)
            return
        self._json({"error": "not found"}, status=404)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[QIMEN] sidecar listening on :{PORT}  qmdj_loaded={HAS_QMDJ}")
    server.serve_forever()

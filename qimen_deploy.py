"""
Qimen sidecar service — standalone FastAPI app deployable as a separate
Railway service. Based on Yuth's working notebook (qmdj.ipynb) CTC_KinQimen class.

Endpoints:
    GET /health             → {"kinqimen_loaded": true, "lon": 114.17, "version": ...}
    GET /pan/now            → run_structured(datetime.now(UTC))
    GET /pan?year=&month=&day=&hour=&minute=  → run_structured for that UTC time

Returns JSON-serialisable dict with full 9-palace pan + 三吉同宮 / 馬星 / 旬空 / dz patterns.
"""
from __future__ import annotations

import math
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

# ---- Tier-1 stub config (workaround for kinqimen 0.0.6.6 bare `import config` bug)
import types as _types
if "config" not in sys.modules:
    _stub = _types.ModuleType("config")
    _stub.LONGITUDE = 114.17
    _stub.LATITUDE = 22.32
    _stub.TIMEZONE = 8
    sys.modules["config"] = _stub

# ---- Load kinqimen (try multiple paths)
KINQIMEN_LOADED = False
KINQIMEN_VERSION: str | None = None
KINQIMEN_ERR: str | None = None
kinqimen_mod: Any = None

try:
    from kinqimen import kinqimen as kinqimen_mod  # type: ignore
    KINQIMEN_LOADED = True
except Exception as e:
    KINQIMEN_ERR = f"primary path: {type(e).__name__}: {e}"
    try:
        # Tier-2: importlib package-dir trick
        import importlib.util as _ilu
        _spec = _ilu.find_spec("kinqimen")
        if _spec and _spec.submodule_search_locations:
            _pkg_dir = _spec.submodule_search_locations[0]
            if _pkg_dir not in sys.path:
                sys.path.insert(0, _pkg_dir)
            _kq_file = os.path.join(_pkg_dir, "kinqimen.py")
            _kq_spec = _ilu.spec_from_file_location("_kinqimen_inner", _kq_file)
            kinqimen_mod = _ilu.module_from_spec(_kq_spec)
            _kq_spec.loader.exec_module(kinqimen_mod)  # type: ignore
            KINQIMEN_LOADED = True
            KINQIMEN_ERR = None
        else:
            raise ImportError("kinqimen package not found")
    except Exception as e2:
        KINQIMEN_ERR = f"{KINQIMEN_ERR} | tier2: {type(e2).__name__}: {e2}"

try:
    import kinqimen as _root_kq  # type: ignore
    KINQIMEN_VERSION = getattr(_root_kq, "__version__", "unknown")
except Exception:
    pass


# ---------------------------------------------------------------------------
# Palace mappings (from Yuth's notebook, faithfully preserved)
# ---------------------------------------------------------------------------
PALACE_MAP = {
    "巽": 4, "離": 9, "坤": 2,
    "震": 3, "中": 5, "兌": 7,
    "艮": 8, "坎": 1, "乾": 6,
}
TRIGRAM_NAMES = {4: "巽", 9: "离", 2: "坤", 3: "震", 5: "中",
                 7: "兑", 8: "艮", 1: "坎", 6: "乾"}
REV_MAP = {v: k for k, v in PALACE_MAP.items()}
GRID_ORDER = [4, 9, 2, 3, 5, 7, 8, 1, 6]
DZ_TO_PALACE = {
    "亥": 6, "戌": 6, "酉": 7, "申": 2, "未": 2, "午": 9,
    "巳": 4, "辰": 4, "卯": 3, "寅": 8, "丑": 8, "子": 1,
}

# 三吉同宮 detection — door/star/god 都吉 = 強勢入場信號
GOOD_DOORS = {"休", "生", "開"}
GOOD_STARS = {"心", "輔", "禽", "任"}      # 任 included for some traditions
GOOD_GODS = {"符", "陰", "合"}              # 值符 / 太陰 / 六合


# ---------------------------------------------------------------------------
# True Solar Time (真太陽時) — equation-of-time correction from notebook
# ---------------------------------------------------------------------------
def get_tst_dt(utc_dt: datetime, lon: float) -> datetime:
    """Convert UTC to True Solar Time at the given longitude (degrees)."""
    lmt_dt = utc_dt + timedelta(hours=lon / 15)
    day_of_year = utc_dt.timetuple().tm_yday
    b = 2 * math.pi * (day_of_year - 81) / 365
    e_time = 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)
    return lmt_dt + timedelta(minutes=e_time)


def detect_patterns(res: dict) -> list[dict]:
    """三吉同宮 + 馬星 + 旬空 pattern detection. Returns one entry per outer palace
    sorted by good_count desc.  Each: {trigram, palace_num, door, star, god,
    good_count, is_triple, has_maxing, is_shikong, tags}."""
    doors = res.get("門", {}) or {}
    stars = res.get("星", {}) or {}
    gods = res.get("神", {}) or {}
    shikong_branches = (res.get("旬空", {}) or {}).get("時空", []) or []
    maxing_branch = (res.get("馬星", {}) or {}).get("驛馬", "")

    maxing_palace = DZ_TO_PALACE.get(maxing_branch)
    shikong_palaces = {DZ_TO_PALACE.get(b) for b in shikong_branches if b in DZ_TO_PALACE}

    out = []
    for trigram, palace_num in PALACE_MAP.items():
        if palace_num == 5:
            continue
        d = doors.get(trigram, "")
        s = stars.get(trigram, "")
        g = gods.get(trigram, "")
        cnt = 0
        if any(gd in d for gd in GOOD_DOORS):
            cnt += 1
        if any(gs in s for gs in GOOD_STARS):
            cnt += 1
        if any(gg in g for gg in GOOD_GODS):
            cnt += 1
        has_maxing = palace_num == maxing_palace
        is_shikong = palace_num in shikong_palaces

        tags = []
        if cnt == 3:
            tags.append("三吉同宮")
        if has_maxing:
            tags.append("馬星")
        if is_shikong:
            tags.append("旬空")

        out.append({
            "trigram": trigram,
            "palace_num": palace_num,
            "door": d,
            "star": s,
            "god": g,
            "good_count": cnt,
            "is_triple": cnt == 3,
            "has_maxing": has_maxing,
            "is_shikong": is_shikong,
            "tags": tags,
        })
    out.sort(key=lambda x: (x["good_count"], x["has_maxing"], not x["is_shikong"]),
             reverse=True)
    return out


def run_structured(utc_dt: datetime, lon: float = 114.17) -> dict:
    """Compute Qimen pan for the given UTC datetime. JSON-serialisable.

    Output schema:
      {
        utc: ISO,
        tst: ISO,                   # True Solar Time
        lon: float,
        kinqimen_loaded: bool,
        ganzhi: str,                # 干支 (八字四柱)
        xunshou: str,               # 旬首
        paiju: str,                 # 排局
        jieqi: str,                 # 節氣
        palace: { trigram: {door,star,god,tianpan,dipan} },
        shikong: list[str],         # 旬空 branches
        maxing: str,                # 驛馬 branch
        patterns: list[...],        # 三吉同宮 / 馬星 / 旬空 detection
      }
    """
    if not KINQIMEN_LOADED or kinqimen_mod is None:
        return {
            "kinqimen_loaded": False,
            "error": KINQIMEN_ERR or "kinqimen not loaded",
            "utc": utc_dt.isoformat(),
            "lon": lon,
        }

    tst_dt = get_tst_dt(utc_dt, lon)
    res = kinqimen_mod.Qimen(tst_dt.year, tst_dt.month, tst_dt.day,
                              tst_dt.hour, tst_dt.minute).pan(1)

    # Build palace dict (excluding 中宮 for door/star/god which are not assigned)
    palace = {}
    doors = res.get("門", {}) or {}
    stars = res.get("星", {}) or {}
    gods = res.get("神", {}) or {}
    tianpan = res.get("天盤", {}) or {}
    dipan = res.get("地盤", {}) or {}
    for trigram, palace_num in PALACE_MAP.items():
        palace[trigram] = {
            "palace_num": palace_num,
            "door": doors.get(trigram, ""),
            "star": stars.get(trigram, ""),
            "god": gods.get(trigram, ""),
            "tianpan": tianpan.get(trigram, ""),
            "dipan": dipan.get(trigram, ""),
        }

    return {
        "kinqimen_loaded": True,
        "utc": utc_dt.isoformat(),
        "tst": tst_dt.isoformat(),
        "lon": lon,
        "ganzhi": res.get("干支", ""),
        "xunshou": res.get("旬首", ""),
        "paiju": res.get("排局", ""),
        "jieqi": res.get("節氣", ""),
        "palace": palace,
        "shikong": (res.get("旬空", {}) or {}).get("時空", []) or [],
        "maxing": (res.get("馬星", {}) or {}).get("驛馬", ""),
        "patterns": detect_patterns(res),
    }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

LON = float(os.environ.get("QIMEN_LON", "114.17"))
app = FastAPI(title="Qimen Sidecar", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False,
    allow_methods=["GET"], allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "kinqimen_loaded": KINQIMEN_LOADED,
        "kinqimen_version": KINQIMEN_VERSION,
        "kinqimen_error": KINQIMEN_ERR,
        "lon": LON,
    }


@app.get("/pan/now")
def pan_now():
    return run_structured(datetime.now(timezone.utc), lon=LON)


@app.get("/pan")
def pan_at(year: int, month: int, day: int, hour: int = 0, minute: int = 0):
    try:
        utc_dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"invalid datetime: {e}")
    return run_structured(utc_dt, lon=LON)


# ---------------------------------------------------------------------------
# Main — bind 0.0.0.0 (NOT 127.0.0.1) so Railway can reach it
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", os.environ.get("QIMEN_SIDECAR_PORT", 8765)))
    print(f"[qimen_deploy] starting on 0.0.0.0:{port} (kinqimen_loaded={KINQIMEN_LOADED}, lon={LON})",
          flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")

"""Shared helpers for the data pipeline: paths, HTTP with retries."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

BACKEND = Path(__file__).resolve().parents[1]
DATA = BACKEND / "data"
CACHE = DATA / "cache"

sys.path.insert(0, str(BACKEND))
from app.png import png_palette  # noqa: E402,F401  (shared PNG writer)

MARS_RADIUS_M = 3_396_190.0  # sphere used by the USGS/MSL Gale mosaics

# Study area: Curiosity's boxwork campaign on Mount Sharp plus about 1.5 km around it.
AOI = {"lat_min": -4.850, "lat_max": -4.780, "lon_min": 137.355, "lon_max": 137.420}

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; data-pipeline)"}


def http_get(url: str, byte_range: tuple[int, int] | None = None, timeout: int = 90, tries: int = 7) -> bytes:
    """GET a URL (optionally an inclusive byte range), retrying on any failure."""
    headers = dict(_HEADERS)
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    last_error: Exception | None = None
    for attempt in range(tries):
        try:
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                if byte_range is not None and response.status != 206:
                    raise IOError(f"server ignored the byte range (status {response.status})")
                data = response.read()
            if byte_range is not None and len(data) != byte_range[1] - byte_range[0] + 1:
                raise IOError(f"short read: {len(data)} bytes")
            return data
        except Exception as error:  # flaky network: back off and retry
            last_error = error
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"GET failed after {tries} tries: {url} ({last_error})")


def http_json(url: str, **kwargs):
    return json.loads(http_get(url, **kwargs).decode("utf-8"))


def write_json(path: Path, obj, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=2)
    path.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(BACKEND)} ({path.stat().st_size / 1024:.0f} KB)")

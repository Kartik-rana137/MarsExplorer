"""Shared helpers for the data pipeline: paths, HTTP with retries, tiny PNG writer."""
from __future__ import annotations

import json
import struct
import time
import zlib
from pathlib import Path
from urllib.request import Request, urlopen

BACKEND = Path(__file__).resolve().parents[1]
DATA = BACKEND / "data"
CACHE = DATA / "cache"

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


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def png_palette(indices, palette_rgba) -> bytes:
    """Encode a 2-D uint8 index array as a paletted PNG. palette_rgba: list of (r, g, b, a)."""
    import numpy as np

    indices = np.ascontiguousarray(indices, dtype=np.uint8)
    height, width = indices.shape
    rows = np.empty((height, width + 1), dtype=np.uint8)
    rows[:, 0] = 0  # filter type "none" for every scanline
    rows[:, 1:] = indices
    plte = b"".join(bytes(c[:3]) for c in palette_rgba)
    trns = bytes(c[3] for c in palette_rgba)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
        + _png_chunk(b"PLTE", plte)
        + _png_chunk(b"tRNS", trns)
        + _png_chunk(b"IDAT", zlib.compress(rows.tobytes(), 6))
        + _png_chunk(b"IEND", b"")
    )


def png_rgb(rgb) -> bytes:
    """Encode an (H, W, 3) uint8 array as a truecolour PNG."""
    import numpy as np

    rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
    height, width, _ = rgb.shape
    rows = np.empty((height, width * 3 + 1), dtype=np.uint8)
    rows[:, 0] = 0
    rows[:, 1:] = rgb.reshape(height, width * 3)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(rows.tobytes(), 6))
        + _png_chunk(b"IEND", b"")
    )

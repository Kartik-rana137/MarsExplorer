"""Minimal PNG writer for paletted map overlays (no imaging library needed)."""
from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def png_palette(indices: np.ndarray, palette_rgba: list[tuple[int, int, int, int]], level: int = 6) -> bytes:
    """Encode a 2-D array of palette indices (uint8) as a PNG with per-colour transparency."""
    indices = np.ascontiguousarray(indices, dtype=np.uint8)
    height, width = indices.shape
    rows = np.empty((height, width + 1), dtype=np.uint8)
    rows[:, 0] = 0  # filter type "none" on every scanline
    rows[:, 1:] = indices
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
        + _chunk(b"PLTE", b"".join(bytes(colour[:3]) for colour in palette_rgba))
        + _chunk(b"tRNS", bytes(colour[3] for colour in palette_rgba))
        + _chunk(b"IDAT", zlib.compress(rows.tobytes(), level))
        + _chunk(b"IEND", b"")
    )

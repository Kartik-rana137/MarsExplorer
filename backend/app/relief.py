"""Elevation for the 3-D map (terrain tiles) and for the drive mode (the whole grid).

The map library drapes imagery over a terrain mesh that it builds from "terrain-RGB" tiles: ordinary
256 x 256 Web Mercator map tiles whose pixel colours encode a height,

    height_m = -10000 + (R * 65536 + G * 256 + B) * 0.1

Heights are measured from `base_m`, a level just below the lowest ground served, so they are never negative.

The elevation grid only covers the study area. Outside it there is no data, so the ground is continued
along the area's overall tilt (a plane fitted to the grid) and blended into the real edge over a few hundred
metres. That avoids a cliff around the study area without inventing detail.
"""
from __future__ import annotations

import gzip
import math
from functools import lru_cache

import numpy as np

from .png import png_rgb
from .terrain import Terrain

TILE_PX = 256
MAX_ZOOM = 14          # about 5 m per pixel here, close to the grid's 4 m cells; the map stretches beyond this
BLEND_M = 250.0        # how quickly the real edge fades into the fitted plane outside the study area
EXTEND_M = 3000.0      # the plane is followed this far out, then held level


class ReliefTiles:
    def __init__(self, terrain: Terrain) -> None:
        self.terrain = terrain
        # Least-squares plane through the grid: elevation = a + b * row + c * col.
        step = 8
        rows, cols = np.mgrid[0:terrain.rows:step, 0:terrain.cols:step]
        sample = terrain.elev[::step, ::step].astype(np.float64)
        design = np.column_stack([np.ones(sample.size), rows.ravel(), cols.ravel()])
        self.plane, *_ = np.linalg.lstsq(design, sample.ravel(), rcond=None)
        self.pad_rows = EXTEND_M / terrain.dy
        self.pad_cols = EXTEND_M / terrain.dx
        corners = [self._plane(r, c)
                   for r in (-self.pad_rows, terrain.rows - 1 + self.pad_rows)
                   for c in (-self.pad_cols, terrain.cols - 1 + self.pad_cols)]
        lowest = min(float(terrain.elev.min()), float(min(corners)))
        self.base_m = math.floor(lowest / 50.0) * 50.0 - 50.0
        self.tile = lru_cache(maxsize=512)(self._tile)

    def _plane(self, row, col):
        a, b, c = self.plane
        return a + b * row + c * col

    def heights(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Ground elevation in metres at points given in degrees, inside or outside the study area."""
        t = self.terrain
        row = (t.lat_north - lat) / t.cell_deg - 0.5      # fractional grid position, measured from cell centres
        col = (lon - t.lon_west) / t.cell_deg - 0.5
        row_in = np.clip(row, 0.0, t.rows - 1.0)
        col_in = np.clip(col, 0.0, t.cols - 1.0)

        # Bilinear sample of the grid at the nearest position inside it.
        r0 = np.minimum(np.floor(row_in).astype(np.intp), t.rows - 2)
        c0 = np.minimum(np.floor(col_in).astype(np.intp), t.cols - 2)
        fr = row_in - r0
        fc = col_in - c0
        e = t.elev
        ground = ((e[r0, c0] * (1 - fc) + e[r0, c0 + 1] * fc) * (1 - fr)
                  + (e[r0 + 1, c0] * (1 - fc) + e[r0 + 1, c0 + 1] * fc) * fr)

        outside_m = np.hypot((row - row_in) * t.dy, (col - col_in) * t.dx)
        if not outside_m.any():
            return ground
        row_far = np.clip(row, -self.pad_rows, t.rows - 1 + self.pad_rows)
        col_far = np.clip(col, -self.pad_cols, t.cols - 1 + self.pad_cols)
        edge_offset = ground - self._plane(row_in, col_in)
        return self._plane(row_far, col_far) + edge_offset * np.exp(-outside_m / BLEND_M)

    def _tile(self, z: int, x: int, y: int) -> bytes:
        """PNG bytes of the terrain-RGB tile z/x/y (rows counted from the north, as in XYZ tiles)."""
        n = 2 ** z
        across = (x + (np.arange(TILE_PX) + 0.5) / TILE_PX) / n
        down = (y + (np.arange(TILE_PX) + 0.5) / TILE_PX) / n
        lon = across * 360.0 - 180.0
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * down))))
        heights = self.heights(lat[:, None], lon[None, :]) - self.base_m
        code = np.clip(np.rint((heights + 10000.0) * 10.0), 0, 2 ** 24 - 1).astype(np.uint32)
        pixels = np.stack([(code >> 16) & 255, (code >> 8) & 255, code & 255], axis=-1).astype(np.uint8)
        return png_rgb(pixels, level=4)

    @staticmethod
    def valid(z: int, x: int, y: int) -> bool:
        return 0 <= z <= MAX_ZOOM and 0 <= x < 2 ** z and 0 <= y < 2 ** z


def height_grid(terrain: Terrain) -> tuple[dict, bytes]:
    """The whole elevation grid for the drive mode, as gzip-compressed unsigned 16-bit integers (little-endian).

    height_m = offset_m + value * step_m. Row 0 is the northern edge, as in the terrain grid. The step is the finest
    that keeps the study area's height range inside 16 bits (2 cm here).
    """
    elev = terrain.elev.astype(np.float64)
    offset = math.floor(float(elev.min()))
    step = max(0.01, math.ceil((float(elev.max()) - offset) / 65_000.0 * 100.0) / 100.0)
    values = np.rint((elev - offset) / step)
    if values.max() > 65_535:
        raise ValueError("height range does not fit in 16 bits")
    data = gzip.compress(values.astype("<u2").tobytes(), compresslevel=6)
    info = {
        "rows": terrain.rows, "cols": terrain.cols,
        "lat_north": terrain.lat_north, "lon_west": terrain.lon_west, "cell_deg": terrain.cell_deg,
        "cell_east_m": terrain.dx, "cell_north_m": terrain.dy,
        "offset_m": offset, "step_m": step,
    }
    return info, data

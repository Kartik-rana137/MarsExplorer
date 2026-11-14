"""Terrain grid for the study area: elevation and slope per cell, plus coordinate helpers.

The grid is north-up. Row 0 is the northern edge, column 0 the western edge. A "node" is the flat index
row * cols + col. Because the source data is equirectangular, cells are evenly spaced in latitude and longitude.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class Terrain:
    def __init__(self, elev: np.ndarray, slope: np.ndarray, meta: dict) -> None:
        self.elev = np.asarray(elev, dtype=np.float32)
        self.slope = np.asarray(slope, dtype=np.float32)
        self.meta = meta
        self.rows, self.cols = self.elev.shape
        self.lat_north = float(meta["lat_north"])
        self.lon_west = float(meta["lon_west"])
        self.cell_deg = float(meta["cell_deg"])
        self.dx = float(meta["cell_east_m"])    # ground size of a cell east-west, metres
        self.dy = float(meta["cell_north_m"])   # ground size of a cell north-south, metres

    @classmethod
    def load(cls, data_dir: Path) -> "Terrain":
        meta = json.loads((data_dir / "terrain.json").read_text(encoding="utf-8"))
        arrays = np.load(data_dir / "terrain.npz")
        return cls(arrays["elev"], arrays["slope"], meta)

    @property
    def size(self) -> int:
        return self.rows * self.cols

    @property
    def bounds(self) -> list[list[float]]:
        """[[south, west], [north, east]] in degrees."""
        south = self.lat_north - self.rows * self.cell_deg
        east = self.lon_west + self.cols * self.cell_deg
        return [[south, self.lon_west], [self.lat_north, east]]

    def contains(self, lat: float, lon: float) -> bool:
        (south, west), (north, east) = self.bounds
        return south < lat < north and west < lon < east

    def node(self, lat: float, lon: float) -> int:
        """Flat index of the cell containing a point. Raises ValueError outside the study area."""
        if not self.contains(lat, lon):
            raise ValueError("point is outside the study area")
        row = min(int((self.lat_north - lat) / self.cell_deg), self.rows - 1)
        col = min(int((lon - self.lon_west) / self.cell_deg), self.cols - 1)
        return row * self.cols + col

    def latlon(self, nodes) -> tuple[np.ndarray, np.ndarray]:
        """Centre coordinates of cells."""
        nodes = np.asarray(nodes)
        rows, cols = np.divmod(nodes, self.cols)
        return self.lat_north - (rows + 0.5) * self.cell_deg, self.lon_west + (cols + 0.5) * self.cell_deg

    def xy_to_latlon(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Fractional (column, row) positions measured from cell centres -> degrees."""
        return self.lat_north - (y + 0.5) * self.cell_deg, self.lon_west + (x + 0.5) * self.cell_deg

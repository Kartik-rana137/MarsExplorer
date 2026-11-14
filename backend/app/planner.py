"""Walking-route search on the terrain grid.

Model
-----
* Ground steeper than the crew's slope limit is no-go.
* Walking speed depends on the grade along the direction of travel (Tobler's hiking function), scaled so
  that level ground gives the crew's planning speed. Uphill and downhill differ, so the way out and the
  way back are searched separately.
* Every search result is stored as "effort": the distance on level ground that would take the same time.
  Dividing effort by the level-ground speed gives seconds, so changing the speed needs no new search.
"""
from __future__ import annotations

import math
import threading
from collections import OrderedDict

import numpy as np
from contourpy import LineType, contour_generator
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from .terrain import Terrain

# The eight neighbours of a cell as (row step, column step), ordered by flat-index offset.
NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))

TOBLER_STEEPNESS = 3.5
TOBLER_OFFSET = 0.05  # walking is fastest on a slight downhill (grade -0.05)


def relative_speed(grade):
    """Walking speed relative to level ground for a path grade (rise over run)."""
    return np.exp(-TOBLER_STEEPNESS * np.abs(grade + TOBLER_OFFSET)) / math.exp(-TOBLER_STEEPNESS * TOBLER_OFFSET)


def trace(predecessors: np.ndarray, node: int) -> np.ndarray:
    """Follow a search tree from a node back to the search origin (inclusive)."""
    path = [node]
    while True:
        node = int(predecessors[node])
        if node < 0:
            break
        path.append(node)
    return np.asarray(path, dtype=np.int64)


def simplify(points: np.ndarray, tolerance: float) -> np.ndarray:
    """Douglas-Peucker line simplification."""
    count = len(points)
    if count < 3:
        return points
    keep = np.zeros(count, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, count - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        chord = points[b] - points[a]
        offsets = points[a + 1:b] - points[a]
        length = math.hypot(chord[0], chord[1])
        if length == 0.0:
            distance = np.hypot(offsets[:, 0], offsets[:, 1])
        else:
            distance = np.abs(chord[0] * offsets[:, 1] - chord[1] * offsets[:, 0]) / length
        worst = int(np.argmax(distance))
        if distance[worst] > tolerance:
            split = a + 1 + worst
            keep[split] = True
            stack.append((a, split))
            stack.append((split, b))
    return points[keep]


class Planner:
    def __init__(self, terrain: Terrain, max_fields: int = 24) -> None:
        self.terrain = terrain
        self.lock = threading.RLock()  # searches are memory-heavy: run one at a time
        self._graphs: OrderedDict[tuple[float, bool], csr_matrix] = OrderedDict()
        self._fields: OrderedDict[tuple[float, int, bool], tuple[np.ndarray, np.ndarray]] = OrderedDict()
        self._max_fields = max_fields

    # ---- terrain masks -------------------------------------------------------------------------------

    def passable(self, max_slope: float) -> np.ndarray:
        terrain = self.terrain
        return np.isfinite(terrain.elev) & (terrain.slope <= max_slope)

    def snap(self, lat: float, lon: float, max_slope: float, radius_m: float = 40.0) -> tuple[int, float]:
        """Nearest walkable cell to a point: (node, distance moved in metres). Raises ValueError if none is near."""
        terrain = self.terrain
        node = terrain.node(lat, lon)
        row, col = divmod(node, terrain.cols)
        passable = self.passable(max_slope)
        if passable[row, col]:
            return node, 0.0
        reach = int(math.ceil(radius_m / min(terrain.dx, terrain.dy)))
        r0, r1 = max(0, row - reach), min(terrain.rows, row + reach + 1)
        c0, c1 = max(0, col - reach), min(terrain.cols, col + reach + 1)
        rows, cols = np.nonzero(passable[r0:r1, c0:c1])
        if rows.size == 0:
            raise ValueError("no walkable ground nearby (too steep)")
        distance = np.hypot((rows + r0 - row) * terrain.dy, (cols + c0 - col) * terrain.dx)
        best = int(np.argmin(distance))
        if distance[best] > radius_m:
            raise ValueError("no walkable ground nearby (too steep)")
        return int((rows[best] + r0) * terrain.cols + cols[best] + c0), float(distance[best])

    # ---- graph and searches --------------------------------------------------------------------------

    def _graph(self, max_slope: float, reverse: bool) -> csr_matrix:
        key = (round(max_slope, 1), reverse)
        if key in self._graphs:
            self._graphs.move_to_end(key)
            return self._graphs[key]
        terrain = self.terrain
        rows, cols = terrain.rows, terrain.cols
        elev = terrain.elev.astype(np.float64)
        passable = self.passable(max_slope)
        weights = np.full((rows, cols, 8), np.inf)
        for k, (dr, dc) in enumerate(NEIGHBOURS):
            r0, r1 = max(0, -dr), rows - max(0, dr)
            c0, c1 = max(0, -dc), cols - max(0, dc)
            run = math.hypot(dr * terrain.dy, dc * terrain.dx)
            rise = elev[r0 + dr:r1 + dr, c0 + dc:c1 + dc] - elev[r0:r1, c0:c1]
            if reverse:  # the edge a->b of the reversed graph stands for walking b->a
                rise = -rise
            allowed = passable[r0:r1, c0:c1] & passable[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
            if dr and dc:  # do not cut diagonally past a no-go corner
                allowed &= passable[r0 + dr:r1 + dr, c0:c1] & passable[r0:r1, c0 + dc:c1 + dc]
            with np.errstate(invalid="ignore"):
                effort = run / relative_speed(rise / run)
            weights[r0:r1, c0:c1, k] = np.where(allowed, effort, np.inf)
        count = rows * cols
        weights = weights.reshape(count, 8)
        mask = np.isfinite(weights)
        steps = np.array([dr * cols + dc for dr, dc in NEIGHBOURS], dtype=np.int32)
        targets = (np.arange(count, dtype=np.int32)[:, None] + steps[None, :])[mask]
        pointers = np.concatenate(([0], np.cumsum(mask.sum(axis=1)))).astype(np.int32)
        graph = csr_matrix((weights[mask], targets, pointers), shape=(count, count))
        self._graphs[key] = graph
        while len(self._graphs) > 2:  # keep only one slope limit's pair of graphs in memory
            self._graphs.popitem(last=False)
        return graph

    def field(self, max_slope: float, node: int, reverse: bool = False) -> tuple[np.ndarray, np.ndarray]:
        """Effort between `node` and every cell, plus the search tree.

        reverse=False: effort to walk from `node` to each cell.
        reverse=True:  effort to walk from each cell back to `node`.
        Unreachable cells are infinite.
        """
        key = (round(max_slope, 1), int(node), reverse)
        with self.lock:
            if key in self._fields:
                self._fields.move_to_end(key)
                return self._fields[key]
            effort, predecessors = dijkstra(self._graph(max_slope, reverse), directed=True, indices=int(node),
                                            return_predecessors=True)
            result = (effort.astype(np.float32), predecessors.astype(np.int32))
            self._fields[key] = result
            while len(self._fields) > self._max_fields:
                self._fields.popitem(last=False)
            return result

    # ---- measuring a path ----------------------------------------------------------------------------

    def measure(self, nodes: np.ndarray) -> dict[str, np.ndarray]:
        """Per-step ground distance, climb and effort along a sequence of cells."""
        terrain = self.terrain
        rows, cols = np.divmod(nodes, terrain.cols)
        run = np.hypot(np.diff(rows) * terrain.dy, np.diff(cols) * terrain.dx)
        elev = terrain.elev.ravel()[nodes].astype(np.float64)
        rise = np.diff(elev)
        grade = np.divide(rise, run, out=np.zeros_like(rise), where=run > 0)
        return {"run": run, "rise": rise, "effort": run / relative_speed(grade), "elev": elev}

    # ---- contour lines of a field --------------------------------------------------------------------

    def contours(self, values: np.ndarray, levels: list[float], min_length_m: float = 60.0) -> dict[float, list[list[list[float]]]]:
        """Contour lines of a per-cell field as lists of [lat, lon] points, one list of lines per level."""
        terrain = self.terrain
        grid = np.ma.masked_invalid(values.reshape(terrain.rows, terrain.cols).astype(np.float64))
        generator = contour_generator(z=grid, line_type=LineType.Separate, corner_mask=True)
        out: dict[float, list[list[list[float]]]] = {}
        for level in levels:
            lines = []
            for line in generator.lines(level):
                if len(line) < 2:
                    continue
                length = float(np.hypot(np.diff(line[:, 0]) * terrain.dx, np.diff(line[:, 1]) * terrain.dy).sum())
                if length < min_length_m:
                    continue
                line = simplify(line, 0.4)  # line coordinates are in cells: tolerance of 0.4 cells
                lat, lon = terrain.xy_to_latlon(line[:, 0], line[:, 1])
                lines.append(np.round(np.column_stack([lat, lon]), 6).tolist())
            out[level] = lines
        return out

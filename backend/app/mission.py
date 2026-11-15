"""EVA plan assembly: time limit, route through the science stops, turn-back analysis, storm exposure and
the safe-return envelope around base camp.

Time conventions: all durations are real (Earth) minutes. Clock times are Mars local clock times, whose
minutes are 2.75% longer than real minutes.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict

import numpy as np

from .conditions import CLOCK_STRETCH, Conditions, clock
from .planner import Planner, trace
from .png import png_palette

RING_MINUTES = (15, 30, 60)   # walk-back time rings drawn around base camp
TIGHT_SPARE_MIN = 20          # less spare time than this is reported as "marginal"
MAX_PROFILE_POINTS = 700

# Shading for ground outside the safe-return area: index 0 inside (clear), 1 outside (dim veil).
REACH_PALETTE = [(0, 0, 0, 0), (9, 12, 22, 135)]


class PlanError(ValueError):
    """The request cannot be planned at all (for example base camp on a cliff)."""


class OverlayStore:
    """Small in-memory store of generated overlay images, addressed by a content key."""

    def __init__(self, limit: int = 24) -> None:
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._limit = limit

    def put(self, key: str, image: bytes) -> None:
        self._items[key] = image
        self._items.move_to_end(key)
        while len(self._items) > self._limit:
            self._items.popitem(last=False)

    def get(self, key: str) -> bytes | None:
        return self._items.get(key)

    def __contains__(self, key: str) -> bool:
        return key in self._items


def time_limit(params, cond: dict) -> dict:
    """How long the crew may be outside: the tighter of life support and daylight."""
    usable = params.life_support_h * 60 - params.reserve_min
    daylight = (cond["sunset_min"] - params.start_clock_min) * CLOCK_STRETCH - params.sunset_buffer_min
    limit = min(usable, daylight)
    notes = []
    if params.start_clock_min < cond["sunrise_min"]:
        notes.append(f"The EVA starts before sunrise ({cond['sunrise']}).")
    return {
        "usable_life_support_min": round(usable, 1),
        "daylight_min": round(daylight, 1),
        "limit_min": round(max(limit, 0.0), 1),
        "limited_by": "life support" if usable <= daylight else "daylight",
        "start_clock": clock(params.start_clock_min),
        "back_by_clock": clock(params.start_clock_min + max(limit, 0.0) / CLOCK_STRETCH),
        "sunset_clock": cond["sunset"],
        "notes": notes,
    }


def _smooth(lat: np.ndarray, lon: np.ndarray) -> list[list[float]]:
    """Soften the staircase look of a grid path for display; the ends stay exactly in place."""
    if len(lat) >= 7:
        kernel = np.array([1.0, 2.0, 3.0, 2.0, 1.0]) / 9.0
        for values in (lat, lon):
            padded = np.concatenate(([values[0]] * 2, values, [values[-1]] * 2))
            values[1:-1] = np.convolve(padded, kernel, mode="valid")[1:-1]
    return np.round(np.column_stack([lat, lon]), 6).tolist()


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    """Index ranges [start, end] of consecutive True values."""
    padded = np.concatenate(([False], flags, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(a), int(b) - 1) for a, b in zip(edges[::2], edges[1::2])]


def _span(minutes: float) -> str:
    """A length of time in everyday words: 46 -> "46 min", 286 -> "4 h 46 min"."""
    total = int(round(abs(minutes)))
    hours, rest = divmod(total, 60)
    if hours == 0:
        return f"{rest} min"
    return f"{hours} h" if rest == 0 else f"{hours} h {rest} min"


def build_plan(planner: Planner, conditions: Conditions, overlays: OverlayStore, camp, stops, params, sol) -> dict:
    terrain = planner.terrain
    speed = params.flat_speed
    max_slope = params.max_slope
    cond = conditions.for_sol(sol)
    limit = time_limit(params, cond)
    limit_min = limit["limit_min"]
    problems: list[str] = []
    if limit_min <= 0:
        problems.append("No time for a walk: it starts too late in the day, or the safety reserve uses up the suit's supply.")

    try:
        camp_node, camp_moved = planner.snap(camp.lat, camp.lon, max_slope)
    except ValueError as error:
        raise PlanError(f"Base camp: {error}") from error
    out_effort, out_tree = planner.field(max_slope, camp_node, reverse=False)
    back_effort, back_tree = planner.field(max_slope, camp_node, reverse=True)
    flat_elev = terrain.elev.ravel()
    flat_slope = terrain.slope.ravel()
    camp_lat, camp_lon = terrain.latlon(camp_node)

    # ---- science stops -------------------------------------------------------------------------------
    reports = []
    valid: list[tuple[dict, int]] = []
    for number, stop in enumerate(stops, start=1):
        label = stop.name.strip() or f"Stop {number}"
        report = {"name": label, "lat": stop.lat, "lon": stop.lon, "work_min": stop.work_min, "ok": False, "problem": None}
        reports.append(report)
        try:
            node, moved = planner.snap(stop.lat, stop.lon, max_slope)
        except ValueError as error:
            report["problem"] = str(error)
            problems.append(f"{label}: {error}.")
            continue
        if not (np.isfinite(out_effort[node]) and np.isfinite(back_effort[node])):
            report["problem"] = "can't be reached on foot: the ground around it is too steep"
            problems.append(f"{label} {report['problem']}.")
            continue
        report.update(ok=True, snapped_m=round(moved, 1), elev_m=round(float(flat_elev[node]), 1),
                      slope_deg=round(float(flat_slope[node]), 1),
                      return_min=round(float(back_effort[node]) / speed / 60, 1))
        valid.append((report, node))

    # ---- route: base camp -> stops in order -> base camp ---------------------------------------------
    route = None
    work_total = sum(report["work_min"] for report, _ in valid)
    if valid:
        sequence = [camp_node] + [node for _, node in valid] + [camp_node]
        names = ["Base camp"] + [report["name"] for report, _ in valid] + ["Base camp"]
        node_parts, time_parts, dist_parts, line = [], [], [], []
        legs = []
        elapsed = 0.0  # seconds
        walked = 0.0   # metres
        for i in range(len(sequence) - 1):
            a, b = sequence[i], sequence[i + 1]
            if i == 0:
                path = trace(out_tree, b)[::-1]
            elif i == len(sequence) - 2:
                path = trace(back_tree, a)
            else:
                _, tree = planner.field(max_slope, a, reverse=False)
                path = trace(tree, b)[::-1]
            measured = planner.measure(path)
            leg_time = np.concatenate(([0.0], np.cumsum(measured["effort"]))) / speed
            leg_dist = np.concatenate(([0.0], np.cumsum(measured["run"])))
            rise = measured["rise"]
            node_parts.append(path)
            time_parts.append(elapsed + leg_time)
            dist_parts.append(walked + leg_dist)
            lat, lon = terrain.latlon(path)
            line.extend(_smooth(lat.copy(), lon.copy()))
            legs.append({
                "from": names[i], "to": names[i + 1],
                "dist_m": round(float(leg_dist[-1])), "walk_min": round(float(leg_time[-1]) / 60, 1),
                "ascent_m": round(float(rise[rise > 0].sum())), "descent_m": round(float(-rise[rise < 0].sum())),
                "max_slope_deg": round(float(flat_slope[path].max()), 1),
            })
            elapsed += float(leg_time[-1])
            walked += float(leg_dist[-1])
            if i < len(valid):
                report = valid[i][0]
                report["arrive_min"] = round(elapsed / 60, 1)
                report["arrive_clock"] = clock(params.start_clock_min + elapsed / 60 / CLOCK_STRETCH)
                elapsed += report["work_min"] * 60
                report["depart_min"] = round(elapsed / 60, 1)

        nodes = np.concatenate(node_parts)
        minutes = np.concatenate(time_parts) / 60
        dist = np.concatenate(dist_parts)
        back_min = back_effort[nodes].astype(np.float64) / speed / 60
        spare = limit_min - minutes - back_min

        for report, node in valid:
            latest_departure = limit_min - report["return_min"]
            report["leave_by_min"] = round(latest_departure, 1)
            report["leave_by_clock"] = clock(params.start_clock_min + max(latest_departure, 0) / CLOCK_STRETCH)
            report["spare_min"] = round(latest_departure - report["depart_min"], 1)

        # Turn-back point: the first moment after which walking straight back would break the limit.
        turn_back = None
        negative = np.flatnonzero(spare < 0)
        if negative.size:
            k = int(negative[0])
            if k == 0:
                fraction, k0 = 0.0, 0
            else:
                k0 = k - 1
                fraction = float(spare[k0] / (spare[k0] - spare[k])) if spare[k0] != spare[k] else 0.0
            k1 = min(k0 + 1, len(nodes) - 1)
            lat0, lon0 = terrain.latlon(nodes[k0])
            lat1, lon1 = terrain.latlon(nodes[k1])
            at_minute = float(minutes[k0] + fraction * (minutes[k1] - minutes[k0]))
            waiting = nodes[k0] == nodes[k1] and k0 != k1
            at_stop = next((report["name"] for report, node in valid if node == nodes[k0]), None) if waiting else None
            turn_back = {
                "lat": round(float(lat0 + fraction * (lat1 - lat0)), 6),
                "lon": round(float(lon0 + fraction * (lon1 - lon0)), 6),
                "elapsed_min": round(at_minute, 1),
                "clock": clock(params.start_clock_min + at_minute / CLOCK_STRETCH),
                "dist_m": round(float(dist[k0] + fraction * (dist[k1] - dist[k0]))),
                "at_stop": at_stop,
            }

        # Storm exposure: time spent farther from shelter than the storm warning allows.
        warning = params.storm_warning_min
        beyond = back_min > warning
        step_minutes = np.diff(minutes)
        beyond_min = float(np.sum(step_minutes * (beyond[1:].astype(float) + beyond[:-1].astype(float)) / 2))
        beyond_lines = []
        for start, end in _runs(beyond):
            if end > start:
                lat, lon = terrain.latlon(nodes[start:end + 1])
                beyond_lines.append(np.round(np.column_stack([lat, lon]), 6).tolist())

        # Profile for charts and the position slider, thinned but always keeping the stops.
        count = len(nodes)
        step = max(1, count // MAX_PROFILE_POINTS)
        keep = set(range(0, count, step)) | {count - 1}
        boundary = np.cumsum([len(part) for part in node_parts])
        for edge in boundary[:-1]:
            keep.update((int(edge) - 1, int(edge)))
        index = np.array(sorted(keep))
        lat, lon = terrain.latlon(nodes[index])
        profile = {
            "lat": np.round(lat, 6).tolist(), "lon": np.round(lon, 6).tolist(),
            "dist_m": np.round(dist[index]).tolist(),
            "elapsed_min": np.round(minutes[index], 2).tolist(),
            "elev_m": np.round(flat_elev[nodes[index]].astype(float), 1).tolist(),
            "return_min": np.round(back_min[index], 2).tolist(),
            "spare_min": np.round(spare[index], 2).tolist(),
        }

        eva_min = float(minutes[-1])
        min_spare = float(spare.min())
        radiation = cond["radiation"]
        totals = {
            "dist_m": round(walked), "walk_min": round(sum(leg["walk_min"] for leg in legs), 1),
            "work_min": round(work_total, 1), "eva_min": round(eva_min, 1),
            "ascent_m": sum(leg["ascent_m"] for leg in legs), "descent_m": sum(leg["descent_m"] for leg in legs),
            "max_slope_deg": max(leg["max_slope_deg"] for leg in legs),
            "farthest_return_min": round(float(back_min.max()), 1),
            "min_spare_min": round(min_spare, 1),
            "finish_clock": clock(params.start_clock_min + eva_min / CLOCK_STRETCH),
            "dose_ugy": round(radiation["dose_ugy_h"] * eva_min / 60, 1) if radiation else None,
            "dose_usv": round(radiation["dose_usv_h"] * eva_min / 60, 1) if radiation else None,
        }
        route = {
            "line": line, "legs": legs, "totals": totals, "profile": profile, "turn_back": turn_back,
            "storm": {
                "warning_min": warning, "beyond_min": round(beyond_min, 1),
                "beyond_share": round(beyond_min / eva_min, 3) if eva_min > 0 else 0.0,
                "beyond_lines": beyond_lines,
            },
        }

    # ---- verdict (plain words: this sentence is the first thing a non-expert reads) -------------------
    deadline = "before dark" if limit["limited_by"] == "daylight" else "before the suit runs low"
    if problems:
        verdict, text = "no-go", problems[0]
    elif route is None:
        verdict, text = "none", "Click the map to add a place to visit."
    elif route["turn_back"]:
        tb = route["turn_back"]
        over = -route["totals"]["min_spare_min"]
        where = f"while working at {tb['at_stop']}" if tb["at_stop"] else f"{tb['dist_m'] / 1000:.1f} km into the walk"
        verdict = "no-go"
        text = (f"This walk is {_span(over)} too long to be back {deadline}. "
                f"Turn back by {tb['clock']} ({where}).")
    elif route["totals"]["min_spare_min"] < TIGHT_SPARE_MIN:
        verdict = "marginal"
        text = (f"Possible, but only {_span(route['totals']['min_spare_min'])} to spare. "
                f"Back at base camp by {route['totals']['finish_clock']}.")
    else:
        verdict = "go"
        text = (f"Back at base camp by {route['totals']['finish_clock']}, "
                f"with {_span(route['totals']['min_spare_min'])} to spare {deadline}.")

    return {
        "verdict": verdict,
        "verdict_text": text,
        "problems": problems,
        "limit": limit,
        "conditions": cond,
        "camp": {"lat": round(float(camp_lat), 6), "lon": round(float(camp_lon), 6), "snapped_m": round(camp_moved, 1),
                 "elev_m": round(float(flat_elev[camp_node]), 1), "slope_deg": round(float(flat_slope[camp_node]), 1)},
        "stops": [{k: v for k, v in report.items()} for report in reports],
        "route": route,
        "envelope": build_envelope(planner, overlays, camp_node, out_effort, back_effort, params, limit_min, work_total),
    }


def build_envelope(planner: Planner, overlays: OverlayStore, camp_node: int, out_effort: np.ndarray,
                   back_effort: np.ndarray, params, limit_min: float, work_min: float) -> dict:
    """Lines and shading that show how far the crew can go and still get back."""
    terrain = planner.terrain
    speed = params.flat_speed
    per_minute = 60.0 * speed  # effort metres walked per minute
    round_trip = out_effort.astype(np.float64) + back_effort
    walk_budget_min = limit_min - work_min

    warning = params.storm_warning_min
    ring_minutes = [m for m in RING_MINUTES if abs(m - warning) > 1e-6]
    lines = planner.contours(back_effort, [m * per_minute for m in ring_minutes] + [warning * per_minute])
    rings = [{"minutes": m, "lines": lines[m * per_minute]} for m in ring_minutes]
    cell_km2 = terrain.dx * terrain.dy / 1e6
    reachable = np.isfinite(round_trip)

    envelope = {
        "bounds": terrain.bounds,
        "rings": rings,
        "storm_line": {"minutes": warning, "lines": lines[warning * per_minute]},
        "storm_safe_km2": round(float(np.count_nonzero(back_effort <= warning * per_minute)) * cell_km2, 2),
        "reachable_km2": round(float(np.count_nonzero(reachable)) * cell_km2, 2),
        "walk_budget_min": round(walk_budget_min, 1),
        "work_min": round(work_min, 1),
        "turn_back_line": [],
        "inside_km2": 0.0,
        "covers_all_reachable": False,
        "overlay_url": None,
    }
    if walk_budget_min <= 0:
        inside = np.zeros(terrain.size, dtype=bool)
    else:
        level = walk_budget_min * per_minute
        inside = round_trip <= level
        envelope["turn_back_line"] = planner.contours(round_trip, [level])[level]
        envelope["inside_km2"] = round(float(np.count_nonzero(inside)) * cell_km2, 2)
        envelope["covers_all_reachable"] = bool(np.count_nonzero(inside) == np.count_nonzero(reachable))

    key = hashlib.sha1(f"{camp_node}|{params.max_slope:.1f}|{round(walk_budget_min * per_minute, -1)}".encode()).hexdigest()[:16]
    if key not in overlays:
        classes = np.where(inside, 0, 1).astype(np.uint8).reshape(terrain.rows, terrain.cols)
        overlays.put(key, png_palette(classes, REACH_PALETTE, level=3))
    envelope["overlay_url"] = f"/api/overlay/{key}.png"
    return envelope


def build_escape(planner: Planner, conditions: Conditions, camp, position, params, lead_min: float | None = None) -> dict:
    """Fastest walk from a position back to base camp, judged against the storm warning time."""
    terrain = planner.terrain
    try:
        camp_node, _ = planner.snap(camp.lat, camp.lon, params.max_slope)
        node, _ = planner.snap(position.lat, position.lon, params.max_slope, radius_m=80.0)
    except ValueError as error:
        raise PlanError(str(error)) from error
    back_effort, back_tree = planner.field(params.max_slope, camp_node, reverse=True)
    if not np.isfinite(back_effort[node]):
        raise PlanError("there is no walkable way back to base camp from this position")
    path = trace(back_tree, node)
    lat, lon = terrain.latlon(path)
    measured = planner.measure(path)
    return_min = float(back_effort[node]) / params.flat_speed / 60
    warning = params.storm_warning_min if lead_min is None else lead_min
    late_min = max(0.0, return_min - warning)
    storm = conditions.storm_summary()
    out = {
        "line": _smooth(lat.copy(), lon.copy()),
        "return_min": round(return_min, 1),
        "dist_m": round(float(measured["run"].sum())),
        "warning_min": warning,
        "late_min": round(late_min, 1),
        "in_time": late_min <= 0,
        "storm_dose_ugy": None,
        "storm_label": storm["label"] if storm else None,
    }
    if storm:
        # Dose picked up while still outside after the particles arrive, using the measured 2024 storm profile.
        out["storm_dose_ugy"] = round(conditions.storm_dose(0.0, late_min / 60), 1)
        out["sheltered_dose_note"] = "Dose is what an unshielded person outdoors would receive; time inside shelter is not counted."
    return out

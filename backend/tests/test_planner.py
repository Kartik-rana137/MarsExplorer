"""Tests for the planning engine.

The first group uses a small made-up terrain where the right answer is known. The second group runs against
the real study-area data and is skipped if that has not been built.

Run from the repository root:  backend/.venv/Scripts/python -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.conditions import CLOCK_STRETCH, Conditions  # noqa: E402
from app.forecast import MARS_YEAR_SOLS, Forecast, backtest  # noqa: E402
from app.mission import OverlayStore, PlanError, build_escape, build_plan, time_limit  # noqa: E402
from app.planner import Planner, relative_speed, simplify, trace  # noqa: E402
from app.png import png_rgb  # noqa: E402
from app.relief import MAX_ZOOM, TILE_PX, ReliefTiles, height_grid  # noqa: E402
from app.site import ROVER  # noqa: E402
from app.terrain import Terrain  # noqa: E402

DATA = BACKEND / "data"
CELL = 4.0
CELL_DEG = 6.748e-5


def make_terrain(elev: np.ndarray, slope: np.ndarray) -> Terrain:
    meta = {"lat_north": 0.0, "lon_west": 100.0, "cell_deg": CELL_DEG, "cell_east_m": CELL, "cell_north_m": CELL}
    return Terrain(elev, slope, meta)


def params(**overrides) -> SimpleNamespace:
    base = dict(flat_speed=1.0, max_slope=20.0, life_support_h=8.0, reserve_min=60.0, start_clock_min=600.0,
                sunset_buffer_min=60.0, storm_warning_min=30.0)
    base.update(overrides)
    return SimpleNamespace(**base)


class WalkingModel(unittest.TestCase):
    def test_level_ground_is_the_reference_speed(self):
        self.assertAlmostEqual(float(relative_speed(0.0)), 1.0)

    def test_uphill_and_steep_downhill_are_slower_gentle_downhill_faster(self):
        self.assertLess(float(relative_speed(0.2)), 1.0)
        self.assertLess(float(relative_speed(-0.4)), 1.0)
        self.assertGreater(float(relative_speed(-0.05)), 1.0)
        self.assertLess(float(relative_speed(0.2)), float(relative_speed(-0.2)))  # climbing costs more than descending


class FlatWithWall(unittest.TestCase):
    """A flat 40 x 60 plain crossed by a steep wall with one gap."""

    def setUp(self):
        elev = np.zeros((40, 60), dtype=np.float32)
        slope = np.zeros((40, 60), dtype=np.float32)
        slope[:, 30] = 45.0      # wall down column 30
        slope[35, 30] = 0.0      # gap near the bottom
        self.terrain = make_terrain(elev, slope)
        self.planner = Planner(self.terrain)
        self.start = 5 * 60 + 10   # row 5, col 10
        self.goal = 5 * 60 + 50    # row 5, col 50

    def test_flat_effort_equals_distance(self):
        effort, _ = self.planner.field(20.0, self.start)
        self.assertAlmostEqual(float(effort[5 * 60 + 20]), 10 * CELL, places=3)

    def test_route_goes_through_the_gap_not_the_wall(self):
        effort, tree = self.planner.field(20.0, self.start)
        path = trace(tree, self.goal)[::-1]
        self.assertEqual(path[0], self.start)
        self.assertEqual(path[-1], self.goal)
        rows, cols = np.divmod(path, 60)
        crossing = rows[cols == 30]
        self.assertTrue(len(crossing) == 1 and crossing[0] == 35)
        self.assertTrue(np.all(self.terrain.slope.ravel()[path] <= 20.0))
        self.assertGreater(float(effort[self.goal]), 40 * CELL)  # longer than the straight line

    def test_a_looser_slope_limit_allows_the_straight_line(self):
        effort, _ = self.planner.field(50.0, self.start)
        self.assertAlmostEqual(float(effort[self.goal]), 40 * CELL, places=3)

    def test_closed_wall_makes_the_far_side_unreachable(self):
        self.terrain.slope[35, 30] = 45.0
        effort, _ = Planner(self.terrain).field(20.0, self.start)
        self.assertTrue(np.isinf(effort[self.goal]))

    def test_snap_moves_a_point_off_the_wall(self):
        lat, lon = self.terrain.latlon(5 * 60 + 30)
        node, moved = self.planner.snap(float(lat), float(lon), 20.0)
        self.assertNotEqual(node % 60, 30)
        self.assertAlmostEqual(moved, CELL, places=3)

    def test_contour_of_flat_field_is_at_the_right_distance(self):
        effort, _ = self.planner.field(50.0, self.start)
        lines = self.planner.contours(effort, [20.0], min_length_m=0)[20.0]
        self.assertTrue(lines)
        lat0, lon0 = self.terrain.latlon(self.start)
        for line in lines:
            points = np.asarray(line)
            radius = np.hypot((points[:, 0] - lat0) / CELL_DEG * CELL, (points[:, 1] - lon0) / CELL_DEG * CELL)
            self.assertTrue(np.all(np.abs(radius - 20.0) < 2.5))


class Ramp(unittest.TestCase):
    """A uniform 10% ramp: walking up it must cost more than walking down."""

    def setUp(self):
        elev = np.tile(np.arange(50, dtype=np.float32) * CELL * 0.10, (20, 1))
        self.terrain = make_terrain(elev, np.full((20, 50), 5.7, dtype=np.float32))
        self.planner = Planner(self.terrain)
        self.low = 10 * 50 + 5
        self.high = 10 * 50 + 45

    def test_out_and_back_differ(self):
        up, _ = self.planner.field(20.0, self.low)                     # from the low point to everywhere
        back, _ = self.planner.field(20.0, self.low, reverse=True)     # from everywhere back to the low point
        distance = 40 * CELL
        self.assertAlmostEqual(float(up[self.high]), distance / float(relative_speed(0.10)), delta=1.0)
        self.assertAlmostEqual(float(back[self.high]), distance / float(relative_speed(-0.10)), delta=1.0)
        self.assertGreater(float(up[self.high]), float(back[self.high]))

    def test_measure_matches_the_search(self):
        up, tree = self.planner.field(20.0, self.low)
        path = trace(tree, self.high)[::-1]
        measured = self.planner.measure(path)
        self.assertAlmostEqual(float(measured["effort"].sum()), float(up[self.high]), delta=0.5)
        self.assertAlmostEqual(float(measured["rise"].sum()), 40 * CELL * 0.10, places=2)


class Helpers(unittest.TestCase):
    def test_simplify_keeps_corners_and_drops_collinear_points(self):
        line = np.array([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]], dtype=float)
        self.assertEqual(simplify(line, 0.1).tolist(), [[0, 0], [3, 0], [3, 2]])

    def test_time_limit_takes_the_tighter_of_life_support_and_daylight(self):
        cond = {"sunset_min": 1100, "sunrise_min": 400, "sunrise": "06:40", "sunset": "18:20"}
        early = time_limit(params(start_clock_min=480), cond)
        self.assertEqual(early["limited_by"], "life support")
        self.assertAlmostEqual(early["limit_min"], 8 * 60 - 60)
        late = time_limit(params(start_clock_min=900), cond)
        self.assertEqual(late["limited_by"], "daylight")
        self.assertAlmostEqual(late["limit_min"], (1100 - 900) * CLOCK_STRETCH - 60, places=1)


class RoverSpec(unittest.TestCase):
    """The base rover used by the drive mode: a crew of three, with its mass the sum of the listed parts."""

    def test_mass_is_the_sum_of_the_buildup_and_carries_three_crew(self):
        self.assertEqual(ROVER["crew"], 3)
        self.assertEqual(ROVER["mass_kg"], sum(part["kg"] for part in ROVER["mass_buildup"]))
        self.assertTrue(4000 <= ROVER["mass_kg"] <= 8000)  # between the 2-crew SEV and much larger concepts

    def test_mars_gravity_and_the_grip_it_allows(self):
        self.assertAlmostEqual(ROVER["gravity_m_s2"], 3.73, places=2)
        grip = ROVER["traction_coefficient"] * ROVER["gravity_m_s2"]       # best braking or cornering, m/s^2
        self.assertLess(grip, 0.4 * ROVER["traction_coefficient"] * 9.81)  # under 40 % of the same tyres on Earth


def decode_png_rgb(data: bytes) -> np.ndarray:
    """Pixels of a truecolour PNG written by app.png.png_rgb (one IDAT chunk), undoing the row filters as a PNG
    reader would (none, sub and up are supported)."""
    import struct
    import zlib
    width, height = struct.unpack(">II", data[16:24])
    start = data.index(b"IDAT")
    length = struct.unpack(">I", data[start - 4:start])[0]
    raw = np.frombuffer(zlib.decompress(data[start + 4:start + 4 + length]), dtype=np.uint8).reshape(height, width * 3 + 1)
    out = np.zeros((height, width * 3), dtype=np.uint8)
    for y in range(height):
        kind, line = raw[y, 0], raw[y, 1:]
        if kind == 0:
            out[y] = line
        elif kind == 1:  # sub: add the byte one pixel to the left
            row = line.astype(np.int64)
            for x in range(3, width * 3):
                row[x] = (row[x] + row[x - 3]) % 256
            out[y] = row
        elif kind == 2:  # up: add the byte above
            out[y] = line + (out[y - 1] if y else 0)
        else:
            raise AssertionError(f"row filter {kind} not expected")
    return out.reshape(height, width, 3)


def decode_terrain_png(data: bytes) -> np.ndarray:
    """Heights in metres from a terrain-RGB PNG written by app.png.png_rgb."""
    rgb = decode_png_rgb(data).astype(np.int64)
    return -10000.0 + (rgb[..., 0] * 65536 + rgb[..., 1] * 256 + rgb[..., 2]) * 0.1


class ReliefOnARamp(unittest.TestCase):
    """Elevation tiles for the 3-D map, checked on a uniform ramp that rises 0.4 m per cell eastward."""

    def setUp(self):
        elev = np.tile(np.arange(50, dtype=np.float32) * CELL * 0.10, (40, 1))
        self.terrain = make_terrain(elev, np.zeros((40, 50), dtype=np.float32))
        self.relief = ReliefTiles(self.terrain)

    def test_heights_match_the_grid_at_cell_centres(self):
        lat, lon = self.terrain.latlon(np.array([10 * 50 + 5, 30 * 50 + 44]))
        self.assertTrue(np.allclose(self.relief.heights(lat, lon), [5 * 0.4, 44 * 0.4], atol=1e-3))

    def test_ground_outside_the_grid_continues_the_slope_without_a_step(self):
        lat, lon = self.terrain.latlon(np.array([10 * 50 + 0]))
        just_outside = self.relief.heights(lat, lon - 1.0 * CELL_DEG)   # one cell west of the westernmost cell centre
        far_outside = self.relief.heights(lat, lon - 100.0 * CELL_DEG)
        self.assertAlmostEqual(float(just_outside[0]), -0.4, delta=0.05)  # the ramp simply carries on
        self.assertAlmostEqual(float(far_outside[0]), -40.0, delta=0.5)

    def test_tile_encodes_the_same_heights_and_never_goes_negative(self):
        lat, lon = self.terrain.latlon(np.array([20 * 50 + 25]))
        n = 2 ** MAX_ZOOM
        x = int((float(lon[0]) + 180.0) / 360.0 * n)
        y = int((1.0 - np.arcsinh(np.tan(np.radians(float(lat[0])))) / np.pi) / 2.0 * n)
        heights = decode_terrain_png(self.relief.tile(MAX_ZOOM, x, y))
        self.assertGreaterEqual(float(heights.min()), 0.0)
        # The centre pixel of the tile, recomputed directly.
        centre = (np.array([x, y]) + (TILE_PX // 2 + 0.5) / TILE_PX) / n
        centre_lon = centre[0] * 360.0 - 180.0
        centre_lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * centre[1]))))
        expected = float(self.relief.heights(np.array([centre_lat]), np.array([centre_lon]))[0]) - self.relief.base_m
        self.assertAlmostEqual(float(heights[TILE_PX // 2, TILE_PX // 2]), expected, delta=0.06)

    def test_height_grid_round_trips_within_one_step(self):
        import gzip
        info, data = height_grid(self.terrain)
        values = np.frombuffer(gzip.decompress(data), dtype="<u2").reshape(info["rows"], info["cols"])
        decoded = info["offset_m"] + values * info["step_m"]
        self.assertLessEqual(float(np.abs(decoded - self.terrain.elev).max()), info["step_m"] / 2 + 1e-6)
        self.assertEqual((info["lat_north"], info["lon_west"]), (self.terrain.lat_north, self.terrain.lon_west))

    def test_only_real_tile_addresses_are_served(self):
        self.assertTrue(ReliefTiles.valid(MAX_ZOOM, 0, 0))
        self.assertFalse(ReliefTiles.valid(MAX_ZOOM + 1, 0, 0))
        self.assertFalse(ReliefTiles.valid(3, 8, 0))

    def test_png_pixels_round_trip_exactly(self):
        rng = np.random.default_rng(7)
        smooth = np.dstack([np.add.outer(np.arange(40), np.arange(50)) % 256] * 3).astype(np.uint8)
        noisy = rng.integers(0, 256, (40, 50, 3), dtype=np.uint8)  # differences wrap around 256
        for pixels in (smooth, noisy):
            self.assertTrue(np.array_equal(decode_png_rgb(png_rgb(pixels)), pixels))


class SearchDirections(unittest.TestCase):
    def test_the_way_back_matches_a_search_from_every_cell(self):
        # Rough made-up ground with no-go cells. The reversed search (from base camp, over the transposed graph) must
        # give the same effort to walk back from any cell as a forward search started at that cell.
        rng = np.random.default_rng(3)
        elev = np.cumsum(rng.normal(0.0, 0.8, (14, 16)), axis=1) + np.cumsum(rng.normal(0.0, 0.8, (14, 16)), axis=0)
        slope = rng.uniform(0.0, 26.0, (14, 16))
        slope[7, 8] = 0.0  # base camp stands on walkable ground
        planner = Planner(make_terrain(elev, slope))
        camp = 7 * 16 + 8
        back, _ = planner.field(20.0, camp, reverse=True)
        self.assertGreater(int(np.isfinite(back).sum()), 50)  # most of the ground is reachable, so the check means something
        for start in range(14 * 16):
            there, _ = planner.field(20.0, start, reverse=False)
            if np.isinf(back[start]):
                self.assertTrue(np.isinf(there[camp]))
            else:
                self.assertAlmostEqual(float(back[start]), float(there[camp]), delta=1e-3 * max(1.0, float(there[camp])))


@unittest.skipUnless((DATA / "terrain.npz").exists() and (DATA / "weather.json").exists(), "study-area data not built")
class RealSite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planner = Planner(Terrain.load(DATA))
        cls.conditions = Conditions(DATA)
        cls.camp = SimpleNamespace(lat=-4.79985, lon=137.38354)
        cls.stops = [SimpleNamespace(name="Nevado Sajama", lat=-4.8080317, lon=137.3809929, work_min=60.0),
                     SimpleNamespace(name="Antofagasta", lat=-4.8142672, lon=137.3817063, work_min=60.0)]

    def plan(self, **overrides):
        return build_plan(self.planner, self.conditions, OverlayStore(), self.camp, self.stops, params(**overrides), None)

    def test_default_plan_is_consistent(self):
        plan = self.plan(start_clock_min=600)
        route = plan["route"]
        totals = route["totals"]
        self.assertEqual(plan["verdict"], "go")
        self.assertAlmostEqual(totals["eva_min"], totals["walk_min"] + totals["work_min"], delta=0.3)
        self.assertAlmostEqual(totals["dist_m"], sum(leg["dist_m"] for leg in route["legs"]), delta=2)
        self.assertLessEqual(totals["max_slope_deg"], 20.0)
        profile = route["profile"]
        self.assertTrue(all(b >= a for a, b in zip(profile["elapsed_min"], profile["elapsed_min"][1:])))
        self.assertAlmostEqual(profile["return_min"][0], 0.0, places=1)   # starts and ends at shelter
        self.assertAlmostEqual(profile["return_min"][-1], 0.0, places=1)
        self.assertAlmostEqual(profile["spare_min"][-1], plan["limit"]["limit_min"] - totals["eva_min"], delta=0.2)

    def test_slower_walking_takes_proportionally_longer(self):
        fast = self.plan(flat_speed=1.0, start_clock_min=600)["route"]["totals"]["walk_min"]
        slow = self.plan(flat_speed=0.5, start_clock_min=600)["route"]["totals"]["walk_min"]
        self.assertAlmostEqual(slow, 2 * fast, delta=0.3)

    def test_late_start_gives_a_turn_back_point_before_the_limit(self):
        plan = self.plan(start_clock_min=16 * 60)
        self.assertEqual(plan["verdict"], "no-go")
        turn_back = plan["route"]["turn_back"]
        self.assertIsNotNone(turn_back)
        self.assertLess(turn_back["elapsed_min"], plan["limit"]["limit_min"])
        self.assertEqual(plan["limit"]["limited_by"], "daylight")

    def test_short_storm_warning_flags_exposure(self):
        relaxed = self.plan(storm_warning_min=60, start_clock_min=600)["route"]["storm"]
        strict = self.plan(storm_warning_min=10, start_clock_min=600)["route"]["storm"]
        self.assertEqual(relaxed["beyond_min"], 0.0)
        self.assertGreater(strict["beyond_min"], 60.0)
        self.assertTrue(strict["beyond_lines"])

    def test_envelope_shrinks_with_less_time(self):
        roomy = self.plan(start_clock_min=600)["envelope"]
        tight = self.plan(start_clock_min=15 * 60)["envelope"]
        self.assertGreater(roomy["inside_km2"], tight["inside_km2"])
        self.assertLessEqual(roomy["inside_km2"], roomy["reachable_km2"])

    def test_escape_time_matches_the_plan(self):
        plan = self.plan(start_clock_min=600)
        stop = plan["stops"][1]
        escape = build_escape(self.planner, self.conditions, self.camp, SimpleNamespace(lat=stop["lat"], lon=stop["lon"]), params())
        self.assertAlmostEqual(escape["return_min"], stop["return_min"], delta=0.2)
        self.assertTrue(escape["in_time"])

    def test_camp_outside_the_area_is_rejected(self):
        with self.assertRaises((PlanError, ValueError)):
            build_plan(self.planner, self.conditions, OverlayStore(), SimpleNamespace(lat=10.0, lon=137.38), [], params(), None)

    def test_storm_dose_grows_with_time_outside(self):
        if not self.conditions.radiation:
            self.skipTest("radiation data not built")
        self.assertEqual(self.conditions.storm_dose(0.0, 0.0), 0.0)
        self.assertGreater(self.conditions.storm_dose(0.0, 1.0), self.conditions.storm_dose(0.0, 0.25))

    def test_a_future_day_is_planned_and_marked_as_an_estimate(self):
        future = self.conditions.latest_sol + 300
        plan = build_plan(self.planner, self.conditions, OverlayStore(), self.camp, self.stops, params(start_clock_min=600), future)
        self.assertTrue(plan["conditions"]["estimated"])
        self.assertEqual(plan["conditions"]["sol"], future)
        self.assertTrue(any("estimate" in note for note in plan["limit"]["notes"]))
        self.assertIn(plan["verdict"], ("go", "marginal", "no-go"))
        measured = build_plan(self.planner, self.conditions, OverlayStore(), self.camp, self.stops, params(start_clock_min=600), None)
        self.assertFalse(measured["conditions"]["estimated"])
        self.assertIsNone(measured["conditions"]["estimate"])

    def test_estimates_stop_two_mars_years_ahead(self):
        self.conditions.for_sol(self.conditions.forecast_until)
        with self.assertRaises(ValueError):
            self.conditions.for_sol(self.conditions.forecast_until + 1)


def periodic_weather(last_sol: int) -> dict:
    """A made-up record with seasons that repeat exactly every Mars year."""
    sols = list(range(1, last_sol + 1))
    phase = [2 * np.pi * s / MARS_YEAR_SOLS for s in sols]
    return {
        "sol": sols,
        "date": [None] * 10 + [str(np.datetime64("2012-08-06") + np.timedelta64(int(round(s * 1.0275)), "D")) for s in sols[10:]],
        "ls": [(s * 360.0 / MARS_YEAR_SOLS) % 360 for s in sols],
        "air_min_c": [-70 + 10 * np.sin(p) for p in phase],
        "air_max_c": [-10 + 10 * np.sin(p) for p in phase],
        "ground_min_c": [-80 + 10 * np.sin(p) for p in phase],
        "ground_max_c": [5 + 10 * np.sin(p) for p in phase],
        "pressure_pa": [800 + 80 * np.cos(p) for p in phase],
        "uv": ["Moderate"] * len(sols),
        "sunrise_min": [int(round(360 + 30 * np.sin(p))) for p in phase],
        "sunset_min": [int(round(1080 - 30 * np.sin(p))) for p in phase],
    }


class Estimates(unittest.TestCase):
    def test_repeating_seasons_are_carried_forward(self):
        forecast = Forecast(periodic_weather(2700), None)
        for sol in (2750, 3100, 3600, forecast.until_sol):
            values, estimate = forecast.weather(sol)
            phase = 2 * np.pi * sol / MARS_YEAR_SOLS
            self.assertAlmostEqual(values["air_min_c"], -70 + 10 * np.sin(phase), delta=0.6)
            self.assertAlmostEqual(values["sunrise_min"], 360 + 30 * np.sin(phase), delta=2)
            self.assertAlmostEqual(values["pressure_pa"], 800 + 80 * np.cos(phase), delta=6)
            low, high = estimate["ranges"]["air_min_c"]
            self.assertLessEqual(low, values["air_min_c"])
            self.assertGreaterEqual(high, values["air_min_c"])
            self.assertGreaterEqual(estimate["years_used"], 3)
            self.assertTrue(estimate["warnings"])

    def test_dates_and_sols_convert_both_ways(self):
        forecast = Forecast(periodic_weather(2700), None)
        import datetime
        day = datetime.date.fromisoformat(forecast.date_of(3000))
        self.assertLessEqual(abs(forecast.sol_on(day) - 3000), 1)

    def test_measured_days_are_not_estimated(self):
        forecast = Forecast(periodic_weather(2700), None)
        with self.assertRaises(ValueError):
            forecast.weather(2700)

    def test_estimates_from_the_real_record_match_what_followed(self):
        if not (DATA / "weather.json").exists():
            self.skipTest("weather data not built")
        import json
        weather = json.loads((DATA / "weather.json").read_text(encoding="utf-8"))
        radiation_file = DATA / "radiation.json"
        radiation = json.loads(radiation_file.read_text(encoding="utf-8")) if radiation_file.exists() else None
        result = backtest(weather, radiation)
        error, inside = result["typical_error"], result["share_inside_range"]
        self.assertLess(error["sunset_min"], 2.0)       # minutes
        self.assertLess(error["air_min_c"], 4.0)        # degrees
        self.assertLess(error["air_max_c"], 5.0)
        self.assertGreater(inside["air_min_c"], 0.75)   # the likely range holds most real days
        if radiation:
            self.assertLess(error["radiation_ugy_h"], 1.5)
            self.assertGreater(inside["radiation_ugy_h"], 0.75)

    def test_radiation_estimate_starts_at_the_last_reading(self):
        conditions = Conditions(DATA)
        if not conditions.radiation:
            self.skipTest("radiation data not built")
        last = int(conditions.radiation["background"]["sol"][-1])
        reading = conditions.radiation["background"]["smooth"][-1]
        dose = conditions.background_dose(last + 2)
        self.assertTrue(dose["estimated"])
        self.assertAlmostEqual(dose["dose_ugy_h"], reading, delta=1.0)
        low, high = dose["range_ugy_h"]
        self.assertLess(low, dose["dose_ugy_h"])
        self.assertGreater(high, dose["dose_ugy_h"])
        self.assertFalse(conditions.background_dose(last - 50)["estimated"])


if __name__ == "__main__":
    unittest.main()

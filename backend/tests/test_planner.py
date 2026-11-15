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
from app.mission import OverlayStore, PlanError, build_escape, build_plan, time_limit  # noqa: E402
from app.planner import Planner, relative_speed, simplify, trace  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()

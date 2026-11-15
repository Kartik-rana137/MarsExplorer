// Checks of the drive mode's physics on made-up ground where the right answer is known.
// Each Mars result is compared with the same rover under Earth gravity, so the effect of gravity is tested,
// not assumed. Run with:  npm test   (Node 23.6 or newer runs TypeScript directly)
import assert from "node:assert/strict";
import { test } from "node:test";
import { RoverPhysics, TerrainGrid, type Controls, type GridInfo, type VehicleSpec } from "../src/rover-physics.ts";

// The backend's base rover (backend/app/site.py).
const MARS_ROVER: VehicleSpec = {
  crew: 3, mass_kg: 5915, gravity_m_s2: 3.73, air_density_kg_m3: 0.016,
  length_m: 6, width_m: 3, height_m: 3.2, wheelbase_m: 3.8, track_m: 2.8, wheel_radius_m: 0.6, suspension_travel_m: 0.35,
  drive_power_w: 60_000, max_drive_force_n: 15_000, top_speed_m_s: 12.5, reverse_speed_m_s: 3, max_steer_deg: 28,
  traction_coefficient: 0.6, rolling_resistance: 0.06, drag_area_m2: 7,
};
const ON_EARTH: VehicleSpec = { ...MARS_ROVER, gravity_m_s2: 9.81, air_density_kg_m3: 1.2 };

const CELL = 4;
const EAST = Math.PI / 2;

/** A grid 4 m per cell whose height is a function of distance east (x, metres). */
function ground(cols: number, rows: number, heightAt: (x: number) => number): TerrainGrid {
  const info: GridInfo = { rows, cols, lat_north: 0, lon_west: 0, cell_deg: 1e-4, cell_east_m: CELL, cell_north_m: CELL, offset_m: 0, step_m: 0.01 };
  const heights = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = heightAt((c + 0.5) * CELL);
  return new TerrainGrid(info, heights);
}

const IDLE: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const GAS: Controls = { ...IDLE, throttle: 1 };
const BRAKE: Controls = { ...IDLE, brake: 1 };
const middle = -20 * CELL; // y of the grid's middle row, so the rover never meets the north or south edge

function run(rover: RoverPhysics, controls: Controls, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) rover.update(controls, 1 / 60);
}

test("the packed grid decodes to heights, sampled between cell centres", () => {
  const info: GridInfo = { rows: 2, cols: 2, lat_north: 0, lon_west: 0, cell_deg: 1e-4, cell_east_m: 4, cell_north_m: 4, offset_m: -100, step_m: 0.5 };
  const grid = TerrainGrid.decode(info, new Uint16Array([0, 4, 8, 12]).buffer);
  assert.deepEqual([...grid.heights], [-100, -98, -96, -94]);
  assert.equal(grid.height(2, -2), -100);                 // centre of the north-west cell
  assert.equal(grid.height(4, -4), -97);                  // halfway between all four
});

test("braking takes about 2.6 times as far on Mars as on Earth", () => {
  const flat = ground(400, 40, () => 0);
  const stoppingDistance = (spec: VehicleSpec) => {
    const rover = new RoverPhysics(spec, flat, 100, middle, EAST);
    rover.vx = 12;
    const start = rover.x;
    // Brake until nearly stopped (holding S any longer would start reversing), then let the parking brake hold.
    for (let t = 0; t < 20 && rover.forwardSpeed > 0.3; t += 1 / 60) rover.update(BRAKE, 1 / 60);
    run(rover, IDLE, 2);
    assert.ok(Math.abs(rover.forwardSpeed) < 0.05, "stopped");
    return rover.x - start;
  };
  const mars = stoppingDistance(MARS_ROVER);
  const earth = stoppingDistance(ON_EARTH);
  // Expected v^2 / (2 (mu + rolling) g): 29.3 m on Mars, 11.1 m on Earth.
  assert.ok(Math.abs(mars - 29.3) < 2.5, `Mars: ${mars.toFixed(1)} m`);
  assert.ok(Math.abs(earth - 11.1) < 1.5, `Earth: ${earth.toFixed(1)} m`);
});

test("acceleration is limited by grip, then by power, and the limiter holds 45 km/h", () => {
  const flat = ground(1500, 40, () => 0);
  const rover = new RoverPhysics(MARS_ROVER, flat, 100, middle, EAST);
  run(rover, GAS, 1);
  // Grip allows 0.6 * 3.73 = 2.24 m/s^2, less rolling resistance 0.22; the throttle takes a moment to come in.
  assert.ok(rover.forwardSpeed > 1.6 && rover.forwardSpeed < 2.05, `after 1 s: ${rover.forwardSpeed.toFixed(2)} m/s`);
  run(rover, GAS, 60);
  assert.ok(Math.abs(rover.forwardSpeed - 12.5) < 0.1, `top speed: ${rover.forwardSpeed.toFixed(2)} m/s`);
  assert.equal(rover.state, "limit");
});

test("the parking brake holds on a slope gentler than the grip, and slides on a steeper one", () => {
  const travelled = (gradient: number) => {
    const slope = ground(200, 40, (x) => gradient * x);
    const rover = new RoverPhysics(MARS_ROVER, slope, 400, middle, 0);  // parked facing north, across the slope
    run(rover, IDLE, 10);
    return { distance: Math.hypot(rover.x - 400, rover.y - middle), state: rover.state };
  };
  const gentle = travelled(0.4);   // 22 degrees: friction 0.6 is enough
  const steep = travelled(0.8);    // 39 degrees: more than tan-1(0.6) = 31 degrees
  assert.ok(gentle.distance < 0.5, `held on 22 degrees, moved ${gentle.distance.toFixed(2)} m`);
  assert.ok(steep.distance > 5, `slid on 39 degrees, moved ${steep.distance.toFixed(2)} m`);
  assert.equal(steep.state, "slide");
});

test("driving off an edge at 12 m/s, the rover flies on Mars but not on Earth", () => {
  // A plateau that drops away at 1 in 2 beyond x = 200 m. The 4 m grid and the 3.8 m wheelbase round the edge
  // off over several metres, so the drop is gentle enough for Earth gravity to keep the wheels down.
  const edge = ground(400, 40, (x) => (x < 200 ? 0 : -0.5 * (x - 200)));
  const flight = (spec: VehicleSpec) => {
    const rover = new RoverPhysics(spec, edge, 120, middle, EAST);
    rover.vx = 12;
    let longest = 0;
    for (let t = 0; t < 12; t += 1 / 60) {
      rover.update(GAS, 1 / 60);
      for (const event of rover.takeEvents()) if (event.type === "landing") longest = Math.max(longest, event.airTime);
    }
    return longest;
  };
  const mars = flight(MARS_ROVER);
  const earth = flight(ON_EARTH);
  assert.ok(mars > 0.5, `Mars air time ${mars.toFixed(2)} s`);
  assert.equal(earth, 0, `Earth air time ${earth.toFixed(2)} s`);
});

test("a turn needing 4 m/s^2 of grip slides on Mars (2.2 available) and holds on Earth (5.9)", () => {
  const flat = ground(400, 120, () => 0);
  const slip = (spec: VehicleSpec) => {
    const rover = new RoverPhysics(spec, flat, 400, -240, EAST);
    rover.vx = 10;
    let worst = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      // Half steering at 10 m/s asks for a turn of about 0.4 rad/s, which needs 4 m/s^2 sideways.
      rover.update({ ...IDLE, throttle: 0.3, steer: 0.5 }, 1 / 60);
      worst = Math.max(worst, Math.abs(rover.sidewaysSpeed));
    }
    return worst;
  };
  const mars = slip(MARS_ROVER);
  const earth = slip(ON_EARTH);
  assert.ok(mars > 0.5, `Mars sideways speed ${mars.toFixed(2)} m/s`);
  assert.ok(earth < mars / 3, `Earth sideways speed ${earth.toFixed(2)} m/s`);
});

test("the rover cannot leave the mapped area", () => {
  const flat = ground(100, 40, () => 0);
  const rover = new RoverPhysics(MARS_ROVER, flat, 30, middle, -EAST);  // heading west, towards the edge
  run(rover, GAS, 10);
  assert.ok(rover.x >= 8, `x = ${rover.x.toFixed(1)}`);
  assert.ok(rover.takeEvents().some((event) => event.type === "edge"));
});

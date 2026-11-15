// Driving physics for the base rover on real Mars ground. No drawing here, so it can be tested on its own.
//
// The rover is a rigid body sliding over the elevation grid. Everything that moves it is a real force: motor
// force (limited by power and by grip), rolling resistance, thin-air drag, and gravity along the slope. Grip is
// a friction circle: the tyres can push the rover by at most mu * g * cos(slope) in any combination of
// accelerating, braking and turning. On Mars, g is 3.73 m/s^2, so that budget is 38 % of what the same tyres
// would have on Earth: braking takes longer, corners slide, and the rover leaves the ground over crests.
//
// Frame: x metres east and y metres north of the grid's north-west corner (y is negative inside the grid),
// z metres of height. Heading is a compass bearing in radians (0 = north, clockwise).
//
// (Written without TypeScript-only constructs such as enums, so Node can run the tests in tests/ directly.)

export interface VehicleSpec {
  crew: number;
  mass_kg: number;
  gravity_m_s2: number;
  air_density_kg_m3: number;
  length_m: number;
  width_m: number;
  height_m: number;
  wheelbase_m: number;
  track_m: number;
  wheel_radius_m: number;
  suspension_travel_m: number;
  drive_power_w: number;
  max_drive_force_n: number;
  top_speed_m_s: number;
  reverse_speed_m_s: number;
  max_steer_deg: number;
  traction_coefficient: number;
  rolling_resistance: number;
  drag_area_m2: number;
}

export interface GridInfo {
  rows: number;
  cols: number;
  lat_north: number;
  lon_west: number;
  cell_deg: number;
  cell_east_m: number;
  cell_north_m: number;
  offset_m: number;
  step_m: number;
}

/** The study area's elevation, sampled bilinearly between cell centres. */
export class TerrainGrid {
  readonly info: GridInfo;
  readonly heights: Float32Array;
  /** Size of the grid in metres, east-west and north-south. */
  readonly widthM: number;
  readonly depthM: number;

  constructor(info: GridInfo, heights: Float32Array) {
    if (heights.length !== info.rows * info.cols) throw new Error("elevation grid has the wrong size");
    this.info = info;
    this.heights = heights;
    this.widthM = info.cols * info.cell_east_m;
    this.depthM = info.rows * info.cell_north_m;
  }

  /** From the backend's packed form: unsigned 16-bit steps above an offset. */
  static decode(info: GridInfo, buffer: ArrayBuffer): TerrainGrid {
    const values = new Uint16Array(buffer);
    const heights = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) heights[i] = info.offset_m + values[i] * info.step_m;
    return new TerrainGrid(info, heights);
  }

  /** Ground height in metres at (x east, y north). Points outside are held at the nearest edge. */
  height(x: number, y: number): number {
    const { rows, cols, cell_east_m, cell_north_m } = this.info;
    const col = Math.min(Math.max(x / cell_east_m - 0.5, 0), cols - 1.001);
    const row = Math.min(Math.max(-y / cell_north_m - 0.5, 0), rows - 1.001);
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const fc = col - c0;
    const fr = row - r0;
    const i = r0 * cols + c0;
    const h = this.heights;
    return (h[i] * (1 - fc) + h[i + 1] * fc) * (1 - fr) + (h[i + cols] * (1 - fc) + h[i + cols + 1] * fc) * fr;
  }

  /** Whether a point is inside the grid with some room to spare. */
  contains(x: number, y: number, marginM = 0): boolean {
    return x >= marginM && x <= this.widthM - marginM && -y >= marginM && -y <= this.depthM - marginM;
  }

  toLngLat(x: number, y: number): { lon: number; lat: number } {
    const { lat_north, lon_west, cell_deg, cell_east_m, cell_north_m } = this.info;
    return { lon: lon_west + (x / cell_east_m) * cell_deg, lat: lat_north + (y / cell_north_m) * cell_deg };
  }

  fromLngLat(lon: number, lat: number): { x: number; y: number } {
    const { lat_north, lon_west, cell_deg, cell_east_m, cell_north_m } = this.info;
    return { x: ((lon - lon_west) / cell_deg) * cell_east_m, y: ((lat - lat_north) / cell_deg) * cell_north_m };
  }
}

/** What the driver is doing, each between 0 and 1 (steer -1 left to +1 right). */
export interface Controls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

/** How the tyres are doing: holding, sliding sideways, off the ground, sliding down a slope, or at the speed limit. */
export type GripState = "grip" | "drift" | "air" | "slide" | "limit";

export type DriveEvent =
  | { type: "takeoff" }
  | { type: "landing"; airTime: number; impact: number }
  | { type: "edge" };

const STEP_S = 1 / 120;
const EDGE_MARGIN_M = 8;
const DEG = Math.PI / 180;

export class RoverPhysics {
  readonly spec: VehicleSpec;
  readonly grid: TerrainGrid;
  x: number;
  y: number;
  z: number;
  /** Velocity in metres per second: east, north, up. */
  vx = 0;
  vy = 0;
  vz = 0;
  heading: number;
  /** Front-wheel angle in radians (the rear axle turns the other way). */
  steerAngle = 0;
  /** How far the wheels have turned, radians, for drawing. */
  wheelTurn = 0;
  airborne = false;
  airTime = 0;
  odometer = 0;
  state: GripState = "grip";
  /** Ground under the rover: slope along and across it, as tangents (positive = nose up, right side up). */
  pitchSlope = 0;
  rollSlope = 0;
  /** Smoothed accelerations in the rover's own frame, m/s^2, for the body's lean when drawing. */
  accelForward = 0;
  accelRight = 0;
  private readonly events: DriveEvent[] = [];
  private leftover = 0;
  private throttle = 0;

  constructor(spec: VehicleSpec, grid: TerrainGrid, x: number, y: number, heading: number) {
    this.spec = spec;
    this.grid = grid;
    this.x = x;
    this.y = y;
    this.heading = heading;
    this.z = this.groundUnder(x, y, heading).height;
  }

  /** Speed along the rover's heading (negative when reversing), m/s. */
  get forwardSpeed(): number {
    return this.vx * Math.sin(this.heading) + this.vy * Math.cos(this.heading);
  }

  /** Sideways speed, positive to the right, m/s. */
  get sidewaysSpeed(): number {
    return this.vx * Math.cos(this.heading) - this.vy * Math.sin(this.heading);
  }

  get groundSpeed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /** Steepest slope of the ground under the rover, degrees. */
  get slopeDeg(): number {
    return Math.atan(Math.hypot(this.pitchSlope, this.rollSlope)) / DEG;
  }

  /** Events since the last call (take-offs, landings, reaching the edge of the mapped area). */
  takeEvents(): DriveEvent[] {
    return this.events.splice(0);
  }

  /** Advance by `dt` seconds of real time, in fixed small steps so the result does not depend on frame rate. */
  update(controls: Controls, dt: number): void {
    this.leftover += Math.min(dt, 0.1);
    while (this.leftover >= STEP_S) {
      this.step(controls, STEP_S);
      this.leftover -= STEP_S;
    }
  }

  /**
   * Height and slope of the ground under the rover, from its four corners (half the wheelbase forward and back,
   * half the track to each side). Averaging over the footprint acts like the suspension smoothing small bumps.
   */
  groundUnder(x: number, y: number, heading: number): { height: number; along: number; across: number } {
    const { wheelbase_m: L, track_m: T } = this.spec;
    const fx = Math.sin(heading), fy = Math.cos(heading);   // forward
    const rx = Math.cos(heading), ry = -Math.sin(heading);  // right
    const at = (forward: number, right: number) => this.grid.height(x + fx * forward + rx * right, y + fy * forward + ry * right);
    const fl = at(L / 2, -T / 2), fr = at(L / 2, T / 2), bl = at(-L / 2, -T / 2), br = at(-L / 2, T / 2);
    return { height: (fl + fr + bl + br) / 4, along: (fl + fr - bl - br) / (2 * L), across: (fr + br - fl - bl) / (2 * T) };
  }

  private step(controls: Controls, dt: number): void {
    const s = this.spec;
    const g = s.gravity_m_s2;
    const before = { forward: this.forwardSpeed, right: this.sidewaysSpeed };

    // Pedal and steering feel: the throttle ramps in, and the wheels turn at a steering-rack speed. The steering
    // limit falls with speed, as on any car built to be driven fast.
    this.throttle += (controls.throttle - this.throttle) * Math.min(1, dt / 0.18);
    const steerLimit = (s.max_steer_deg * DEG) / (1 + Math.abs(before.forward) / 5);
    const steerTarget = controls.steer * steerLimit;
    const steerRate = (controls.steer === 0 ? 3.5 : 2.2) * dt;
    this.steerAngle += Math.max(-steerRate, Math.min(steerRate, steerTarget - this.steerAngle));

    let ground = this.groundUnder(this.x, this.y, this.heading);
    if (this.airborne) {
      this.flyStep(dt, g);
    } else {
      this.driveStep(controls, dt, g, ground);
    }

    // Move, staying inside the mapped area.
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (!this.grid.contains(this.x, this.y, EDGE_MARGIN_M)) {
      const x = Math.min(Math.max(this.x, EDGE_MARGIN_M), this.grid.widthM - EDGE_MARGIN_M);
      const y = -Math.min(Math.max(-this.y, EDGE_MARGIN_M), this.grid.depthM - EDGE_MARGIN_M);
      if (x !== this.x) this.vx *= -0.2;
      if (y !== this.y) this.vy *= -0.2;
      this.x = x;
      this.y = y;
      this.events.push({ type: "edge" });
    }
    this.odometer += Math.hypot(this.vx, this.vy) * dt;
    this.wheelTurn += (this.airborne ? 0 : this.forwardSpeed * dt) / s.wheel_radius_m;

    // Height. The ground can push the rover up but cannot pull it down: where the ground drops away faster than
    // Mars gravity pulls, the body carries on in a free-fall arc while the wheels hang on the suspension, and
    // once the gap is more than the suspension can stretch, the rover is off the ground.
    ground = this.groundUnder(this.x, this.y, this.heading);
    if (this.airborne) {
      if (this.z <= ground.height) this.land(ground.height, dt);
    } else {
      const falling = this.z + this.vz * dt - 0.5 * g * dt * dt;
      if (falling <= ground.height) {
        this.vz = (ground.height - this.z) / dt;  // carried along the ground
        this.z = ground.height;
      } else {
        this.vz -= g * dt;                        // the ground fell away
        this.z = falling;
        if (falling - ground.height > s.suspension_travel_m && this.groundSpeed > 2) {
          this.airborne = true;
          this.airTime = 0;
          this.state = "air";
          this.events.push({ type: "takeoff" });
        }
      }
      this.pitchSlope = ground.along;
      this.rollSlope = ground.across;
    }

    // Lean of the body (for drawing), from how fast the rover's own speeds changed this step.
    const ease = Math.min(1, dt / 0.25);
    this.accelForward += ((this.forwardSpeed - before.forward) / dt - this.accelForward) * ease;
    this.accelRight += ((this.sidewaysSpeed - before.right) / dt + this.forwardSpeed * this.yawRate() - this.accelRight) * ease;
  }

  private yawRate(): number {
    return (this.forwardSpeed * 2 * Math.tan(this.steerAngle)) / this.spec.wheelbase_m;
  }

  private flyStep(dt: number, g: number): void {
    this.airTime += dt;
    this.vz -= g * dt;
    this.z += this.vz * dt;
    this.applyDrag(dt);
  }

  private land(groundHeight: number, dt: number): void {
    const groundRate = (groundHeight - this.z) / dt;  // how fast the ground is rising under the rover
    const impact = Math.max(0, -this.vz);
    this.events.push({ type: "landing", airTime: this.airTime, impact });
    this.airborne = false;
    this.z = groundHeight;
    this.vz = Math.max(0, groundRate);
    if (impact > 3) {  // a hard landing scrubs off speed
      this.vx *= 0.85;
      this.vy *= 0.85;
    }
  }

  private applyDrag(dt: number): void {
    const s = this.spec;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed === 0) return;
    const drag = (0.5 * s.air_density_kg_m3 * s.drag_area_m2 * speed * speed) / s.mass_kg;
    const keep = Math.max(0, 1 - (drag * dt) / speed);
    this.vx *= keep;
    this.vy *= keep;
  }

  private driveStep(controls: Controls, dt: number, g: number, ground: { along: number; across: number }): void {
    const s = this.spec;
    const fx = Math.sin(this.heading), fy = Math.cos(this.heading);
    const rx = Math.cos(this.heading), ry = -Math.sin(this.heading);

    // Gravity along the slope. The ground plane's gradient, in east/north components:
    const gx = fx * ground.along + rx * ground.across;
    const gy = fy * ground.along + ry * ground.across;
    const tan2 = gx * gx + gy * gy;
    const cos = 1 / Math.sqrt(1 + tan2);
    this.vx -= (g * gx / (1 + tan2)) * dt;
    this.vy -= (g * gy / (1 + tan2)) * dt;
    this.applyDrag(dt);

    // Turn. All-wheel steering: the rear axle turns opposite to the front, which halves the turning circle.
    // The heading can swing a little faster than grip allows (that is what a slide feels like), more so with
    // the handbrake on.
    let u = this.vx * fx + this.vy * fy;
    const grip = s.traction_coefficient * g * cos;  // the most the tyres can push, m/s^2
    const yawLimit = (grip * (controls.handbrake ? 2.4 : 1.3)) / Math.max(Math.abs(u), 1);
    this.heading += Math.max(-yawLimit, Math.min(yawLimit, this.yawRate())) * dt;

    // Speeds along and across the new heading.
    const nfx = Math.sin(this.heading), nfy = Math.cos(this.heading);
    const nrx = Math.cos(this.heading), nry = -Math.sin(this.heading);
    u = this.vx * nfx + this.vy * nfy;
    let w = this.vx * nrx + this.vy * nry;

    // Rolling resistance always slows the rover, but never pushes it backwards.
    const rolling = s.rolling_resistance * g * cos * dt;
    u = Math.sign(u) * Math.max(0, Math.abs(u) - rolling);

    // What the driver asks of the tyres, as changes of speed this step.
    const motor = (speed: number) => Math.min(s.max_drive_force_n, s.drive_power_w / Math.max(Math.abs(speed), 0.5)) / s.mass_kg;
    let du = 0;
    let limited = false;
    const stopping = controls.throttle === 0 && controls.brake === 0;
    if (controls.brake > 0 && u > 0.3) {
      du = -Math.min(u, grip * dt * controls.brake);                  // brakes
    } else if (controls.brake > 0) {
      if (u > -s.reverse_speed_m_s) du = -motor(u) * 0.5 * controls.brake * dt;  // reverse, gently
    } else if (this.throttle > 0.01) {
      if (u < s.top_speed_m_s) du = Math.min(motor(u) * this.throttle * dt, s.top_speed_m_s - u);
      limited = u > s.top_speed_m_s - 0.1;
    }
    if (u > s.top_speed_m_s + 0.3) du = -(u - s.top_speed_m_s);       // the speed limiter brakes downhill
    if (stopping) {
      // Coasting: the motors recover a little energy, and the parking brake holds the rover once it is slow.
      du = Math.abs(u) < 0.4 ? -u : -Math.sign(u) * Math.min(Math.abs(u), 0.25 * dt);
    }
    if (controls.handbrake) du = -Math.sign(u) * Math.min(Math.abs(u), grip * 0.6 * dt);
    let dw = -w;  // the tyres try to stop all sideways sliding

    // Friction circle: together, the changes cannot exceed what grip allows this step. Grip acts along the
    // ground, so on a slope only cos(slope) of it works horizontally; with gravity's push of g sin cos, the rover
    // then slides exactly when the slope is steeper than tan-1(mu).
    const budget = grip * cos * dt;
    const sideBudget = budget * (controls.handbrake ? 0.3 : 1);
    const demand = Math.hypot(du / budget, dw / sideBudget);
    const sliding = demand > 1;
    if (sliding) {
      du /= demand;
      dw /= demand;
    }
    u += du;
    w += dw;
    this.vx = nfx * u + nrx * w;
    this.vy = nfy * u + nry * w;

    // Name what is happening, for the dashboard.
    const slipDeg = Math.atan2(Math.abs(w), Math.max(Math.abs(u), 0.1)) / DEG;
    const slopeTooSteep = Math.sqrt(tan2) > s.traction_coefficient;
    if (slopeTooSteep && (sliding || stopping)) this.state = "slide";
    else if (Math.abs(u) > 3 && slipDeg > 6) this.state = "drift";
    else if (limited) this.state = "limit";
    else this.state = "grip";
  }
}

// Drive mode: the crew's pressurised base rover in 3D, driven with the keyboard over the real terrain to choose
// where base camp goes. It plays like a racing game because Mars makes it one: gravity is 38 % of Earth's, so the
// tyres grip at 38 % too, and the rover slides through corners, takes long to stop and flies off crests.
//
// The rover is drawn with three.js inside the map (a custom map layer), so hills in front of it hide it. The
// physics is in rover-physics.ts. This file is loaded only when someone starts driving.
import { MercatorCoordinate } from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as GlMap } from "maplibre-gl";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Camera,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  Points,
  Scene,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { h } from "./dom";
import { RoverPhysics, type Controls, type GripState, type TerrainGrid } from "./rover-physics";
import type { Vehicle } from "./types";

export interface DriveSetup {
  map: GlMap;
  /** The element the dashboard is drawn into (the map's container). */
  container: HTMLElement;
  grid: TerrainGrid;
  vehicle: Vehicle;
  start: { lat: number; lon: number };
  /** Compass bearing to face at the start, radians. */
  heading: number;
  /** Steepest ground the crew may step out onto: the rover can only be parked on gentler ground. */
  maxParkSlopeDeg: number;
  /** Map metres per Mars metre (the map is drawn on an Earth-sized sphere). */
  mapScale: number;
  /** The map draws heights this much taller than life. */
  reliefStretch: number;
  /** Heights in the map's terrain tiles are measured from this level. */
  terrainBase: number;
}

/** Where the rover was parked, or null if the drive was cancelled. */
export type DriveResult = { lat: number; lon: number } | null;

const DEG = Math.PI / 180;
const CHASE = { pitch: 74, zoomStill: 20.4, zoomFast: 19.7 };
const OVERVIEW = { pitch: 60, zoom: 17.9 };
const READY_S = 1.1;

/** Start driving. Resolves when the crew parks (with the spot) or cancels. */
export function drive(setup: DriveSetup): Promise<DriveResult> {
  return new Promise((resolve, reject) => {
    try {
      new DriveSession(setup, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

// ---- the rover model ------------------------------------------------------------------------------------
// Built from simple shapes, in Mars metres, nose towards -z, wheels resting on y = 0. Modelled on NASA's
// Space Exploration Vehicle: a white pressurised cabin with a bubble window at the front and suitports at the
// back, where the crew's spacesuits stay docked outside, on six wheels that all steer.

interface Wheel {
  steer: Group;
  spin: Group;
  axle: 0 | 1 | 2;     // front, middle, rear
  side: -1 | 1;        // left, right
  forward: number;     // metres ahead of the rover's centre
}

interface RoverModel {
  root: Group;         // placed on the ground, turned to the heading and the slope
  body: Group;         // the sprung part, which leans
  wheels: Wheel[];
  shadow: Group;       // lies on the ground under the rover, turned like the ground
  shadowDisc: Mesh;
}

function roundedRect(width: number, height: number, radius: number): Shape {
  const x = -width / 2, r = radius;
  const shape = new Shape();
  shape.moveTo(x + r, 0);
  shape.lineTo(x + width - r, 0);
  shape.quadraticCurveTo(x + width, 0, x + width, r);
  shape.lineTo(x + width, height - r);
  shape.quadraticCurveTo(x + width, height, x + width - r, height);
  shape.lineTo(x + r, height);
  shape.quadraticCurveTo(x, height, x, height - r);
  shape.lineTo(x, r);
  shape.quadraticCurveTo(x, 0, x + r, 0);
  return shape;
}

function buildRover(v: Vehicle): RoverModel {
  const paint = (color: number, roughness: number, metalness = 0.1) => new MeshStandardMaterial({ color, roughness, metalness });
  const white = paint(0xebe7df, 0.5);
  const trim = paint(0xd9682b, 0.45);
  const dark = paint(0x33363b, 0.7, 0.4);
  const glass = paint(0x15202a, 0.12, 0.7);
  const tyreRubber = new MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.95, flatShading: true });
  const metal = paint(0xa9abae, 0.35, 0.8);
  const solar = paint(0x1c3062, 0.3, 0.5);
  const lamp = new MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 2.2 });
  const tailLamp = new MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2a1f, emissiveIntensity: 1.2 });
  const box = (w: number, hgt: number, d: number, material: MeshStandardMaterial, x: number, y: number, z: number) => {
    const mesh = new Mesh(new BoxGeometry(w, hgt, d), material);
    mesh.position.set(x, y, z);
    return mesh;
  };

  const r = v.wheel_radius_m;
  const root = new Group();
  root.rotation.order = "YXZ"; // turn to the heading first, then pitch, then roll
  const body = new Group();
  root.add(body);

  // Chassis and cabin.
  const cabinWidth = v.width_m * 0.9, cabinHeight = 2.0, cabinBottom = r + 0.55;
  const cabinLength = v.length_m * 0.76, cabinFront = -v.length_m * 0.42;
  body.add(box(v.width_m * 0.78, 0.35, v.length_m * 0.86, dark, 0, r + 0.38, 0));
  const shell = new ExtrudeGeometry(roundedRect(cabinWidth, cabinHeight, 0.55), { depth: cabinLength, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 2, curveSegments: 8 });
  shell.translate(0, cabinBottom, cabinFront);
  body.add(new Mesh(shell, white));
  const bubble = new Mesh(new SphereGeometry(1, 28, 18), glass);
  bubble.scale.set(1.2, 0.82, 0.62);
  bubble.position.set(0, cabinBottom + 1.0, cabinFront + 0.05);
  body.add(bubble);
  for (const side of [-1, 1]) body.add(box(0.05, 0.42, 2.6, glass, side * (cabinWidth / 2 + 0.06), cabinBottom + 1.42, cabinFront + 1.7));
  body.add(box(cabinWidth + 0.14, 0.13, cabinLength + 0.1, trim, 0, cabinBottom + 0.85, cabinFront + cabinLength / 2));

  // Three suitports at the back, each with a spacesuit's backpack docked on it.
  const rearZ = cabinFront + cabinLength + 0.1;
  for (const across of [-0.82, 0, 0.82]) {
    const ring = new Mesh(new TorusGeometry(0.36, 0.06, 10, 24), metal);
    ring.position.set(across, cabinBottom + 1.05, rearZ);
    body.add(ring, box(0.6, 0.78, 0.28, white, across, cabinBottom + 1.05, rearZ + 0.16));
  }

  // Roof: solar panel and radiator, light bar, radio mast.
  const roof = cabinBottom + cabinHeight + 0.1;
  body.add(box(cabinWidth * 0.82, 0.06, cabinLength * 0.6, solar, 0, roof, cabinFront + cabinLength * 0.56));
  body.add(box(1.5, 0.14, 0.22, lamp, 0, roof, cabinFront + 0.55));
  const mast = new Mesh(new CylinderGeometry(0.05, 0.05, 1.2, 8), metal);
  mast.position.set(-cabinWidth * 0.35, roof + 0.6, rearZ - 0.6);
  const dish = new Mesh(new SphereGeometry(0.28, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal);
  dish.position.set(-cabinWidth * 0.35, roof + 1.2, rearZ - 0.6);
  body.add(mast, dish);

  // Lights.
  for (const side of [-1, 1]) {
    body.add(box(0.42, 0.2, 0.08, lamp, side * 0.85, r + 0.45, -v.length_m * 0.43 - 0.06));
    body.add(box(0.3, 0.14, 0.06, tailLamp, side * 1.05, r + 0.5, rearZ + 0.02));
  }

  // Six wheels on three axles. Each wheel is a steering group holding a spinning group, so it can do both.
  const wheels: Wheel[] = [];
  const axles = [v.wheelbase_m / 2, 0, -v.wheelbase_m / 2];
  axles.forEach((forward, axle) => {
    for (const side of [-1, 1] as const) {
      const steer = new Group();
      steer.position.set((side * v.track_m) / 2, r, -forward);
      const spin = new Group();
      steer.add(spin);
      const tyre = new Mesh(new CylinderGeometry(r, r, 0.46, 22), tyreRubber);
      tyre.rotation.z = Math.PI / 2;
      const hub = new Mesh(new CylinderGeometry(r * 0.55, r * 0.55, 0.48, 16), metal);
      hub.rotation.z = Math.PI / 2;
      spin.add(tyre, hub);
      for (let k = 0; k < 3; k++) {
        const spoke = box(0.06, r * 1.7, 0.1, dark, side * 0.25, 0, 0);
        spoke.rotation.x = (k * Math.PI) / 3;
        spin.add(spoke);
      }
      root.add(steer);
      body.add(box(0.55, 0.1, 1.5, white, (side * v.track_m) / 2, 2 * r + 0.18, -forward)); // mudguard
      wheels.push({ steer, spin, axle: axle as 0 | 1 | 2, side, forward });
    }
  });

  // A soft shadow on the ground, which stays on the ground when the rover is in the air.
  const shadowDisc = new Mesh(new CircleGeometry(1, 36), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
  shadowDisc.rotation.x = -Math.PI / 2; // the disc is drawn upright; lay it flat
  shadowDisc.renderOrder = -1;
  const shadow = new Group();
  shadow.rotation.order = "YXZ";
  shadow.position.y = 0.04;
  shadow.add(shadowDisc);
  return { root, body, wheels, shadow, shadowDisc };
}

// ---- dust ---------------------------------------------------------------------------------------------------
// Thrown up by the wheels and falling back under Mars gravity, which makes the long, slow arcs familiar from
// rover footage. Each grain is tracked in true metres and drawn relative to the rover.

const DUST_VERTEX = `
attribute float alpha;
attribute float size;
uniform float uPxPerM;
varying float vAlpha;
void main() {
  vAlpha = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * uPxPerM, 1.0, 96.0);
}`;
const DUST_FRAGMENT = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - d * 2.0));
}`;

class Dust {
  private readonly count = 700;
  private readonly px = new Float32Array(this.count);
  private readonly py = new Float32Array(this.count);
  private readonly pz = new Float32Array(this.count);
  private readonly vx = new Float32Array(this.count);
  private readonly vy = new Float32Array(this.count);
  private readonly vz = new Float32Array(this.count);
  private readonly age = new Float32Array(this.count);
  private readonly life = new Float32Array(this.count);
  private readonly grain = new Float32Array(this.count);
  private next = 0;
  private readonly positions = new Float32Array(this.count * 3);
  private readonly alphas = new Float32Array(this.count);
  private readonly sizes = new Float32Array(this.count);
  private readonly geometry = new BufferGeometry();
  readonly material = new ShaderMaterial({
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    uniforms: { uPxPerM: { value: 10 }, uColor: { value: new Color(0xf2dfc6) } }, // lifted dust catches the light: paler than the ground
    transparent: true,
    depthWrite: false,
  });
  readonly points: Points;

  constructor() {
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("alpha", new BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute("size", new BufferAttribute(this.sizes, 1));
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, grain: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.grain[i] = grain;
  }

  /** Move every grain, then write its position relative to the rover (scene metres, heights stretched like the map's). */
  update(dt: number, g: number, grid: TerrainGrid, rover: { x: number; y: number; ground: number }, stretch: number): void {
    const air = Math.exp(-0.6 * dt); // thin air still slows the finest dust a little
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0 || this.age[i] >= this.life[i]) {
        this.alphas[i] = 0;
        continue;
      }
      this.age[i] += dt;
      this.vz[i] -= g * dt;
      this.vx[i] *= air; this.vy[i] *= air; this.vz[i] *= air;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      const floor = grid.height(this.px[i], this.py[i]);
      if (this.pz[i] < floor) {
        this.pz[i] = floor;
        this.vz[i] = 0;
        this.vx[i] *= 0.4; this.vy[i] *= 0.4;
      }
      const t = this.age[i] / this.life[i];
      this.alphas[i] = 0.8 * (1 - t) * Math.min(1, this.age[i] * 8);
      this.sizes[i] = this.grain[i] * (0.4 + 1.6 * t);
      this.positions[i * 3] = this.px[i] - rover.x;
      this.positions[i * 3 + 1] = (this.pz[i] - rover.ground) * stretch;
      this.positions[i * 3 + 2] = -(this.py[i] - rover.y);
    }
    for (const name of ["position", "alpha", "size"]) (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---- the map layer that draws the rover ------------------------------------------------------------------------

class RoverLayer implements CustomLayerInterface {
  readonly id = "drive-rover";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  readonly scene = new Scene();
  /** Where the scene's origin is: the rover's spot on the ground, at the map's drawn height there. */
  origin = { lon: 0, lat: 0, altitude: 0 };
  private renderer: WebGLRenderer | null = null;
  private readonly camera = new Camera();
  private readonly mapScale: number;
  private readonly onPixelsPerMetre: (value: number) => void;

  constructor(mapScale: number, onPixelsPerMetre: (value: number) => void) {
    this.mapScale = mapScale;
    this.onPixelsPerMetre = onPixelsPerMetre;
    this.scene.add(new HemisphereLight(0xfff0e0, 0x6b4a33, 1.6));
    const sun = new DirectionalLight(0xfff2e2, 2.6);
    sun.position.set(-0.6, 1, 0.35);
    this.scene.add(sun);
  }

  onAdd(map: GlMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.renderer) return;
    // Scene units are Mars metres: x east, y up, z south. They are placed at the rover's spot and scaled to the map.
    const at = MercatorCoordinate.fromLngLat([this.origin.lon, this.origin.lat], this.origin.altitude);
    const scale = at.meterInMercatorCoordinateUnits() * this.mapScale;
    const place = new Matrix4()
      .makeTranslation(at.x, at.y, at.z ?? 0)
      .scale(new Vector3(scale, -scale, scale))
      .multiply(new Matrix4().makeRotationX(Math.PI / 2));
    const projection = new Matrix4().fromArray(Array.from(args.defaultProjectionData.mainMatrix)).multiply(place);
    this.camera.projectionMatrix.copy(projection);
    this.camera.projectionMatrixInverse.copy(projection).invert();

    // How many screen pixels one metre covers at the rover, for sizing the dust.
    const toScreen = (x: number, y: number, z: number) => {
      const p = new Vector4(x, y, z, 1).applyMatrix4(projection);
      return [(p.x / p.w) * gl.drawingBufferWidth * 0.5, (p.y / p.w) * gl.drawingBufferHeight * 0.5];
    };
    const [x0, y0] = toScreen(0, 0, 0);
    const [x1, y1] = toScreen(1, 0, 0);
    const [x2, y2] = toScreen(0, 0, 1);
    this.onPixelsPerMetre(Math.max(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0)));

    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.render(this.scene, this.camera);
  }

  onRemove(): void {
    this.scene.traverse((object: Object3D) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.renderer?.dispose();
    this.renderer = null;
  }
}

// ---- engine sound ---------------------------------------------------------------------------------------------
// Six electric hub motors: a whine that rises with speed, and the crunch of the wheels on gravel. (On Mars the
// thin air carries little sound; this is what the crew would hear through the rover's frame.)

class EngineSound {
  private readonly context: AudioContext | null;
  private readonly master: GainNode | null = null;
  private readonly whine: OscillatorNode[] = [];
  private readonly whineFilter: BiquadFilterNode | null = null;
  private readonly crunch: GainNode | null = null;
  muted = false;

  constructor() {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.context = Context ? new Context() : null;
    const ctx = this.context;
    if (!ctx) return;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.whineFilter = ctx.createBiquadFilter();
    this.whineFilter.type = "lowpass";
    this.whineFilter.Q.value = 3;
    this.whineFilter.connect(this.master);
    for (const [type, detune] of [["sawtooth", 0], ["square", 702]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      const level = ctx.createGain();
      level.gain.value = type === "square" ? 0.25 : 0.5;
      osc.connect(level).connect(this.whineFilter);
      osc.start();
      this.whine.push(osc);
    }
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 900;
    band.Q.value = 0.8;
    this.crunch = ctx.createGain();
    this.crunch.gain.value = 0;
    source.connect(band).connect(this.crunch).connect(this.master);
    source.start();
  }

  update(speed: number, throttle: number, state: GripState): void {
    const ctx = this.context;
    if (!ctx || !this.master || !this.whineFilter || !this.crunch) return;
    const now = ctx.currentTime;
    const pitch = 70 + Math.abs(speed) * 34 + throttle * 25;
    for (const osc of this.whine) osc.frequency.setTargetAtTime(pitch, now, 0.05);
    this.whineFilter.frequency.setTargetAtTime(300 + Math.abs(speed) * 90 + throttle * 500, now, 0.05);
    const onGround = state !== "air";
    const crunch = onGround ? Math.min(1, Math.abs(speed) / 10) * 0.35 + (state === "drift" || state === "slide" ? 0.35 : 0) : 0;
    this.crunch.gain.setTargetAtTime(crunch, now, 0.08);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.07 + throttle * 0.05, now, 0.1);
  }

  close(): void {
    void this.context?.close();
  }
}

// ---- the dashboard ------------------------------------------------------------------------------------------

const STATE_LABEL: Record<GripState, string> = { grip: "Grip", drift: "Drifting", air: "Airborne", slide: "Sliding", limit: "Speed limit" };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const GAUGE_SWEEP = 240; // degrees of arc for 0 to top speed

function arcPath(radius: number, fromDeg: number, toDeg: number): string {
  const point = (deg: number) => {
    const a = (deg - 90) * DEG;
    return `${(60 + radius * Math.cos(a)).toFixed(2)} ${(60 + radius * Math.sin(a)).toFixed(2)}`;
  };
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${point(fromDeg)} A ${radius} ${radius} 0 ${large} 1 ${point(toDeg)}`;
}

class Dashboard {
  readonly root: HTMLElement;
  readonly speed = h("span", { class: "drive-speed-value" }, "0");
  readonly state = h("span", { class: "drive-state" }, STATE_LABEL.grip);
  readonly park: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly sound: HTMLButtonElement;
  readonly view: HTMLButtonElement;
  readonly countdown = h("div", { class: "drive-countdown" }, "Ready");
  private readonly toastBox = h("div", { class: "drive-toast", role: "status", "aria-live": "polite" });
  private readonly arc: SVGPathElement;
  private readonly arcLength: number;
  private readonly stats: Record<"slope" | "heading" | "height" | "air" | "distance" | "time", HTMLElement>;
  private toastTimer = 0;

  constructor(v: Vehicle, maxParkSlopeDeg: number) {
    const ns = "http://www.w3.org/2000/svg";
    const svgEl = document.createElementNS(ns, "svg");
    svgEl.setAttribute("viewBox", "0 0 120 120");
    svgEl.setAttribute("class", "drive-gauge");
    svgEl.setAttribute("aria-hidden", "true");
    const start = -GAUGE_SWEEP / 2, end = GAUGE_SWEEP / 2;
    const track = document.createElementNS(ns, "path");
    track.setAttribute("d", arcPath(50, start, end));
    track.setAttribute("class", "drive-gauge-track");
    this.arc = document.createElementNS(ns, "path");
    this.arc.setAttribute("d", arcPath(50, start, end));
    this.arc.setAttribute("class", "drive-gauge-value");
    this.arcLength = (GAUGE_SWEEP / 360) * 2 * Math.PI * 50;
    this.arc.style.strokeDasharray = `0 ${this.arcLength}`;
    svgEl.append(track, this.arc);
    for (let kmh = 0; kmh <= 45; kmh += 15) {
      const deg = start + (kmh / 45) * GAUGE_SWEEP;
      const a = (deg - 90) * DEG;
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", (60 + 38 * Math.cos(a)).toFixed(1));
      label.setAttribute("y", (63 + 38 * Math.sin(a)).toFixed(1));
      label.setAttribute("class", "drive-gauge-tick");
      label.setAttribute("text-anchor", "middle");
      label.textContent = String(kmh);
      svgEl.append(label);
    }

    const stat = (name: string) => {
      const value = h("span", { class: "drive-stat-value" }, "–");
      return { row: h("div", { class: "drive-stat" }, h("span", {}, name), value), value };
    };
    const slope = stat("Ground slope"), heading = stat("Heading"), height = stat("Height"), air = stat("Longest jump"), distance = stat("Driven"), time = stat("Time");
    this.stats = { slope: slope.value, heading: heading.value, height: height.value, air: air.value, distance: distance.value, time: time.value };

    const g = v.gravity_m_s2;
    const grip = v.traction_coefficient * g;
    const earthKg = (v.mass_kg * g) / 9.81;
    const kg = (value: number) => `${Math.round(value).toLocaleString("en-GB")} kg`;
    const key = (label: string) => h("kbd", {}, label);
    this.park = h("button", { type: "button", class: "drive-park" }, "Park here");
    this.cancel = h("button", { type: "button", class: "drive-cancel" }, "Cancel");
    this.sound = h("button", { type: "button", class: "drive-small", "aria-pressed": "true", title: "Sound on or off (M)" }, "Sound on");
    this.view = h("button", { type: "button", class: "drive-small", title: "Close behind or high above (C)" }, "Higher view");

    this.root = h(
      "div",
      { class: "drive-hud" },
      h(
        "div",
        { class: "drive-banner" },
        h("strong", {}, "Drive the base rover"),
        h("span", {}, `Find a good spot for base camp and park there. The ground must be gentler than ${maxParkSlopeDeg}° for the crew to step out.`),
      ),
      h(
        "div",
        { class: "drive-keys" },
        h("span", {}, key("W"), key("A"), key("S"), key("D"), " drive"),
        h("span", {}, key("Space"), " handbrake"),
        h("span", {}, key("Enter"), " park"),
        h("span", {}, key("Esc"), " cancel"),
        h("span", {}, key("C"), " view"),
        h("span", {}, key("M"), " sound"),
      ),
      this.countdown,
      this.toastBox,
      h("div", { class: "drive-panel drive-panel-left" }, slope.row, heading.row, height.row, air.row, distance.row, time.row),
      h(
        "div",
        { class: "drive-panel drive-panel-right" },
        h("strong", {}, "Why it slides"),
        h("div", { class: "drive-stat" }, h("span", {}, "Mars gravity"), h("span", { class: "drive-stat-value" }, `${g.toFixed(2)} m/s² (${Math.round((g / 9.81) * 100)}% of Earth)`)),
        h("div", { class: "drive-stat" }, h("span", {}, `Rover, crew of ${v.crew}`), h("span", { class: "drive-stat-value" }, kg(v.mass_kg))),
        h("div", { class: "drive-stat" }, h("span", {}, "Weighs like, on Earth"), h("span", { class: "drive-stat-value" }, kg(earthKg))),
        h("div", { class: "drive-stat" }, h("span", {}, "Most grip"), h("span", { class: "drive-stat-value" }, `${grip.toFixed(1)} m/s² (Earth ${(v.traction_coefficient * 9.81).toFixed(1)})`)),
        h("p", {}, "Less weight presses the tyres down, so they grip less: corners slide, stopping takes longer, and crests throw the rover into the air."),
      ),
      h("div", { class: "drive-dash" }, svgEl, h("div", { class: "drive-speed" }, this.speed, h("span", { class: "drive-speed-unit" }, "km/h")), this.state),
      h("div", { class: "drive-actions" }, this.park, this.cancel, this.view, this.sound),
    );
  }

  update(p: RoverPhysics, elapsed: number, bestAir: number, parkBlock: string | null): void {
    const kmh = Math.abs(p.forwardSpeed) * 3.6;
    this.speed.textContent = String(Math.round(kmh));
    const fraction = Math.min(1, kmh / 45);
    this.arc.style.strokeDasharray = `${(fraction * this.arcLength).toFixed(1)} ${this.arcLength}`;
    this.arc.classList.toggle("is-limit", p.state === "limit");
    const reversing = !p.airborne && p.forwardSpeed < -0.3;
    this.state.textContent = reversing ? "Reverse" : p.state === "air" ? `${STATE_LABEL.air} ${p.airTime.toFixed(1)} s` : STATE_LABEL[p.state];
    this.state.dataset.state = reversing ? "reverse" : p.state;
    const compass = COMPASS[Math.round((((p.heading / DEG) % 360) + 360) % 360 / 45) % 8];
    this.stats.slope.textContent = `${Math.round(p.slopeDeg)}°`;
    this.stats.heading.textContent = `${compass} ${Math.round((((p.heading / DEG) % 360) + 360) % 360)}°`;
    this.stats.height.textContent = `${Math.round(p.z).toLocaleString("en-GB")} m`;
    this.stats.air.textContent = bestAir > 0 ? `${bestAir.toFixed(1)} s` : "–";
    this.stats.distance.textContent = p.odometer >= 1000 ? `${(p.odometer / 1000).toFixed(2)} km` : `${Math.round(p.odometer)} m`;
    this.stats.time.textContent = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
    this.park.disabled = parkBlock !== null;
    this.park.textContent = parkBlock ?? "Park here: set base camp";
  }

  toast(text: string, tone: "good" | "warn" | "info" = "info"): void {
    this.toastBox.textContent = text;
    this.toastBox.dataset.tone = tone;
    this.toastBox.classList.add("is-shown");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove("is-shown"), 1800);
  }
}

// ---- the session: input, physics, camera, drawing ---------------------------------------------------------------

const KEYS: Record<string, "up" | "down" | "left" | "right" | "handbrake"> = {
  KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right", Space: "handbrake",
};

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

class DriveSession {
  private readonly setup: DriveSetup;
  private readonly finish: (result: DriveResult) => void;
  private readonly physics: RoverPhysics;
  private readonly model: RoverModel;
  private readonly dust = new Dust();
  private readonly layer: RoverLayer;
  private readonly hud: Dashboard;
  private readonly sound = new EngineSound();
  private readonly held = new Set<string>();
  private readonly cleanups: (() => void)[] = [];
  private readonly camera: { lon: number; lat: number; bearing: number; pitch: number; zoom: number };
  private overview = false;
  private elapsed = 0;
  private sinceStart = 0;
  private bestAir = 0;
  private shake = 0;
  private lastEdgeToast = -10;
  private dustDebt = 0;
  private running = true;
  private frame = 0;
  private last = performance.now();

  constructor(setup: DriveSetup, finish: (result: DriveResult) => void) {
    this.setup = setup;
    this.finish = finish;
    const { map, grid, vehicle } = setup;
    const start = grid.fromLngLat(setup.start.lon, setup.start.lat);
    this.physics = new RoverPhysics(vehicle, grid, start.x, start.y, setup.heading);

    this.model = buildRover(vehicle);
    this.layer = new RoverLayer(setup.mapScale, (pxPerM) => (this.dust.material.uniforms.uPxPerM.value = pxPerM));
    this.layer.scene.add(this.model.root, this.model.shadow, this.dust.points);
    this.layer.scene.traverse((object) => (object.frustumCulled = false));
    this.placeRover();
    map.addLayer(this.layer);

    this.hud = new Dashboard(vehicle, setup.maxParkSlopeDeg);
    setup.container.append(this.hud.root);
    this.hud.park.addEventListener("click", () => this.tryPark());
    this.hud.cancel.addEventListener("click", () => this.end(null));
    this.hud.sound.addEventListener("click", () => this.toggleSound());
    this.hud.view.addEventListener("click", () => this.toggleView());
    if (window.matchMedia("(pointer: coarse)").matches) this.hud.root.append(this.touchControls());

    const center = map.getCenter();
    this.camera = { lon: center.lng, lat: center.lat, bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom() };
    map.setPadding({ top: map.getCanvas().clientHeight * 0.36, bottom: 0, left: 0, right: 0 });

    const down = (event: KeyboardEvent) => this.onKey(event, true);
    const up = (event: KeyboardEvent) => this.onKey(event, false);
    const blur = () => this.held.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    this.cleanups.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    });
    this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private onKey(event: KeyboardEvent, pressed: boolean): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const control = KEYS[event.code];
    if (control) {
      event.preventDefault();
      if (pressed) this.held.add(control);
      else this.held.delete(control);
      return;
    }
    if (!pressed || event.repeat) return;
    if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault();
      this.tryPark();
    } else if (event.code === "Escape") {
      event.preventDefault();
      this.end(null);
    } else if (event.code === "KeyM") {
      this.toggleSound();
    } else if (event.code === "KeyC") {
      this.toggleView();
    }
  }

  private controls(): Controls {
    if (this.sinceStart < READY_S) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
    return {
      throttle: this.held.has("up") ? 1 : 0,
      brake: this.held.has("down") ? 1 : 0,
      steer: (this.held.has("right") ? 1 : 0) - (this.held.has("left") ? 1 : 0),
      handbrake: this.held.has("handbrake"),
    };
  }

  private toggleSound(): void {
    this.sound.muted = !this.sound.muted;
    this.hud.sound.textContent = this.sound.muted ? "Sound off" : "Sound on";
    this.hud.sound.setAttribute("aria-pressed", String(!this.sound.muted));
  }

  private toggleView(): void {
    this.overview = !this.overview;
    this.hud.view.textContent = this.overview ? "Close view" : "Higher view";
  }

  /** Why the rover cannot be parked here, or null if it can. */
  private parkBlock(): string | null {
    const p = this.physics;
    if (p.airborne) return "Land first";
    if (p.groundSpeed > 1) return "Stop to park";
    if (p.slopeDeg > this.setup.maxParkSlopeDeg) return `Too steep to park (${Math.round(p.slopeDeg)}°)`;
    return null;
  }

  private tryPark(): void {
    const reason = this.parkBlock();
    if (reason) {
      this.hud.toast(reason, "warn");
      return;
    }
    const { lon, lat } = this.setup.grid.toLngLat(this.physics.x, this.physics.y);
    this.end({ lat, lon });
  }

  private end(result: DriveResult): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.cleanups.forEach((cleanup) => cleanup());
    this.sound.close();
    this.hud.root.remove();
    if (this.setup.map.getLayer(this.layer.id)) this.setup.map.removeLayer(this.layer.id);
    this.dust.dispose();
    this.finish(result);
  }

  private tick(now: number): void {
    if (!this.running) return;
    // Game time advances by at most 1/20 s a frame, so a slow frame cannot throw the rover through a hill; the
    // countdown runs on real time, so a slow computer still gets to drive.
    const real = (now - this.last) / 1000;
    const dt = Math.min(0.05, real);
    this.last = now;
    this.sinceStart += real;
    const p = this.physics;
    const controls = this.controls();

    if (this.sinceStart < READY_S) {
      this.hud.countdown.textContent = this.sinceStart < READY_S * 0.55 ? "Ready" : "Set";
    } else {
      if (!this.hud.countdown.classList.contains("is-go")) {
        this.hud.countdown.textContent = "Go!";
        this.hud.countdown.classList.add("is-go");
        window.setTimeout(() => this.hud.countdown.remove(), 700);
      }
      this.elapsed += dt;
      p.update(controls, dt);
    }

    for (const event of p.takeEvents()) {
      if (event.type === "landing") {
        this.bestAir = Math.max(this.bestAir, event.airTime);
        if (event.airTime > 0.6) this.hud.toast(`Big air! ${event.airTime.toFixed(1)} s off the ground`, "good");
        if (event.impact > 3) {
          this.hud.toast(`Hard landing: ${event.impact.toFixed(1)} m/s`, "warn");
          this.shake = Math.min(1, event.impact / 6);
        }
        this.burst(18 + event.impact * 10);
      } else if (event.type === "edge" && this.elapsed - this.lastEdgeToast > 3) {
        this.lastEdgeToast = this.elapsed;
        this.hud.toast("Edge of the mapped area", "warn");
      }
    }

    this.kickDust(dt, controls);
    this.placeRover();
    this.moveCamera(dt);
    this.hud.update(p, this.elapsed, this.bestAir, this.parkBlock());
    this.sound.update(p.forwardSpeed, controls.throttle, p.state);
    this.setup.map.triggerRepaint();
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  /** Put the model where the physics says, on the map's drawn ground, with the wheels following the ground. */
  private placeRover(): void {
    const { map, grid, mapScale, reliefStretch, terrainBase } = this.setup;
    const p = this.physics;
    const s = reliefStretch;
    const ground = p.groundUnder(p.x, p.y, p.heading);
    const { lon, lat } = grid.toLngLat(p.x, p.y);
    const drawn = map.queryTerrainElevation([lon, lat]);
    this.layer.origin = { lon, lat, altitude: drawn ?? (ground.height - terrainBase) * mapScale * s };

    const { root, body, wheels, shadow } = this.model;
    const gap = Math.max(0, p.z - ground.height);
    // Slopes are drawn steeper than life (like the map's relief), so the rover sits flat on what is drawn.
    const groundPitch = Math.atan(s * ground.along);
    const groundRoll = Math.atan(s * ground.across);
    root.position.y = gap * s;
    root.rotation.y = -p.heading;
    if (p.airborne) {
      // In the air the nose follows the flight path, gently.
      const flight = Math.atan2(p.vz * s, Math.max(Math.abs(p.forwardSpeed), 1)) * 0.6;
      root.rotation.x += (flight - root.rotation.x) * 0.08;
      root.rotation.z *= 0.97;
    } else {
      root.rotation.x = groundPitch;
      root.rotation.z = groundRoll;
    }
    // The body leans back when accelerating and outwards in turns.
    body.rotation.x = Math.max(-0.08, Math.min(0.08, p.accelForward * 0.018));
    body.rotation.z = Math.max(-0.08, Math.min(0.08, p.accelRight * 0.02));

    // Each wheel: steering (rear axle opposite to front), spin, and suspension reaching for the ground below it.
    const fx = Math.sin(p.heading), fy = Math.cos(p.heading), rx = Math.cos(p.heading), ry = -Math.sin(p.heading);
    const travel = this.setup.vehicle.suspension_travel_m;
    for (const wheel of wheels) {
      wheel.steer.rotation.y = wheel.axle === 0 ? -p.steerAngle : wheel.axle === 2 ? p.steerAngle : 0;
      wheel.spin.rotation.x = -p.wheelTurn;
      const across = (wheel.side * this.setup.vehicle.track_m) / 2;
      const under = grid.height(p.x + fx * wheel.forward + rx * across, p.y + fy * wheel.forward + ry * across);
      const plane = ground.height + ground.along * wheel.forward + ground.across * across;
      const reach = p.airborne ? -travel : Math.max(-travel, Math.min(travel, (under - plane) * s));
      wheel.steer.position.y = this.setup.vehicle.wheel_radius_m + reach;
    }

    shadow.rotation.set(groundPitch, -p.heading, groundRoll);
    const spread = 1 + gap * 0.05; // the shadow blurs out as the rover rises
    (this.model.shadowDisc.material as MeshBasicMaterial).opacity = 0.32 * Math.max(0, 1 - gap / 12);
    this.model.shadowDisc.scale.set(this.setup.vehicle.width_m * 0.62 * spread, this.setup.vehicle.length_m * 0.56 * spread, 1);
  }

  /** Throw dust up from the middle and rear wheels, more at speed and in slides. */
  private kickDust(dt: number, controls: Controls): void {
    const p = this.physics;
    const v = this.setup.vehicle;
    const g = v.gravity_m_s2;
    this.dust.update(dt, g, this.setup.grid, { x: p.x, y: p.y, ground: p.groundUnder(p.x, p.y, p.heading).height }, this.setup.reliefStretch);
    if (p.airborne) return;
    const speed = p.groundSpeed;
    if (speed < 1.2) return;
    const sliding = p.state === "drift" || p.state === "slide" || controls.handbrake;
    this.dustDebt += dt * (speed * 5 + (sliding ? 40 : 0) + (controls.brake && p.forwardSpeed > 1 ? 20 : 0));
    const fx = Math.sin(p.heading), fy = Math.cos(p.heading), rx = Math.cos(p.heading), ry = -Math.sin(p.heading);
    while (this.dustDebt >= 1) {
      this.dustDebt -= 1;
      const back = Math.random() < 0.5 ? 0 : -v.wheelbase_m / 2;
      const side = (Math.random() < 0.5 ? -1 : 1) * v.track_m * 0.5;
      const x = p.x + fx * back + rx * side, y = p.y + fy * back + ry * side;
      const kick = 0.25 + Math.random() * 0.35;
      const spread = (Math.random() - 0.5) * 2.2;
      this.dust.emit(
        x, y, this.setup.grid.height(x, y) + 0.2,
        p.vx * 0.3 - fx * speed * kick + rx * spread, p.vy * 0.3 - fy * speed * kick + ry * spread,
        0.8 + Math.random() * 1.6 + speed * 0.08,
        1.8 + Math.random() * 1.6, 0.35 + Math.random() * 0.5,
      );
    }
  }

  /** A cloud of dust from every wheel, for landings. */
  private burst(amount: number): void {
    const p = this.physics;
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 2.5;
      const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
      this.dust.emit(x, y, this.setup.grid.height(x, y) + 0.1, Math.cos(a) * (1 + Math.random() * 2) + p.vx * 0.3, Math.sin(a) * (1 + Math.random() * 2) + p.vy * 0.3, 0.6 + Math.random() * 1.8, 2 + Math.random() * 1.5, 0.5 + Math.random() * 0.6);
    }
  }

  /** A chase camera behind the rover: it swings round after the rover, pulls back with speed and shakes on hard landings. */
  private moveCamera(dt: number): void {
    const p = this.physics;
    const cam = this.camera;
    const speed = p.groundSpeed;
    let aim = p.heading;
    if (speed > 3) aim += angleDiff(Math.atan2(p.vx, p.vy), p.heading) * 0.35; // show the slide
    const intro = this.sinceStart < READY_S;
    const follow = 1 - Math.exp(-dt * (intro ? 2.6 : 7));
    const turn = 1 - Math.exp(-dt * (intro ? 2.2 : 3.2));
    const { lon, lat } = this.setup.grid.toLngLat(p.x, p.y);
    cam.lon += (lon - cam.lon) * follow;
    cam.lat += (lat - cam.lat) * follow;
    cam.bearing += (angleDiff(aim, cam.bearing * DEG) / DEG) * turn;
    const pitchTarget = this.overview ? OVERVIEW.pitch : CHASE.pitch;
    const zoomTarget = this.overview ? OVERVIEW.zoom : CHASE.zoomStill - (CHASE.zoomStill - CHASE.zoomFast) * Math.min(1, speed / 12.5);
    cam.pitch += (pitchTarget - cam.pitch) * turn;
    cam.zoom += (zoomTarget - cam.zoom) * turn;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const wobble = this.shake * Math.sin(this.sinceStart * 45);
    this.setup.map.jumpTo({ center: [cam.lon, cam.lat], bearing: cam.bearing + wobble * 1.5, pitch: cam.pitch + wobble, zoom: cam.zoom });
  }

  /** On touch screens: steering and pedals as buttons. */
  private touchControls(): HTMLElement {
    const pad = (label: string, control: string) => {
      const button = h("button", { type: "button", class: "drive-pad", "aria-label": label }, label);
      const press = (on: boolean) => (event: Event) => {
        event.preventDefault();
        if (on) this.held.add(control);
        else this.held.delete(control);
      };
      button.addEventListener("pointerdown", press(true));
      for (const name of ["pointerup", "pointercancel", "pointerleave"]) button.addEventListener(name, press(false));
      return button;
    };
    return h(
      "div",
      { class: "drive-pads" },
      h("div", {}, pad("◀", "left"), pad("▶", "right")),
      h("div", {}, pad("Brake", "down"), pad("Go", "up")),
    );
  }
}

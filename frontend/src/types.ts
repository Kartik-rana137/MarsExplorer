// Shapes of the backend API responses (see backend/app/main.py and mission.py).
import type { GridInfo, VehicleSpec } from "./rover-physics";

export type LatLon = [number, number];

/** The base rover (backend/app/site.py): the numbers the physics uses, plus how they were arrived at. */
export interface Vehicle extends VehicleSpec {
  name: string;
  mass_buildup: { what: string; kg: number; basis: string }[];
  reference: { name: string; url: string };
  mars_source: { name: string; url: string };
}
export type Bounds = [LatLon, LatLon]; // [[south, west], [north, east]]

export type ParamName =
  | "flat_speed"
  | "max_slope"
  | "life_support_h"
  | "reserve_min"
  | "start_clock_min"
  | "sunset_buffer_min"
  | "storm_warning_min";
export type Params = Record<ParamName, number>;

export interface ParameterInfo {
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface TileLayerInfo {
  label: string;
  url: string;
  tms: boolean;
  min_zoom: number;
  max_native_zoom: number;
  bounds: Bounds;
  attribution: string;
}

export interface Target {
  sol: number;
  until_sol: number;
  stay_sols: number;
  lat: number;
  lon: number;
  elev: number;
  name: string;
  note: string;
  source: string | null;
}

export interface StormSummary {
  label: string;
  utc_start: string;
  baseline_ugy_h: number;
  peak_ugy_h: number;
  peak_ratio: number;
  hours_to_peak: number;
  duration_h: number;
  excess_dose_ugy: number;
  hours: number[];
  dose: number[];
}

export interface StopInput {
  name: string;
  lat: number;
  lon: number;
  work_min: number;
}

export interface Validation {
  stops_compared: number;
  elevation_difference_m: { median: number; std: number };
  rover_tilt_deg: { median: number; p90: number; max: number };
  grid_slope_at_stops_deg: { median: number; p90: number; max: number };
  slope_tilt_correlation: number;
  note: string;
}

export interface Source {
  what: string;
  kind: string;
  name: string;
  by: string;
  url: string;
}

export interface Site {
  name: string;
  summary: string;
  science_goal: string;
  bounds: Bounds;
  grid: { rows: number; cols: number; cell_m: number; elev_min: number; elev_max: number };
  tiles: Record<"context" | "basemap" | "labels", TileLayerInfo>;
  /** Elevation as terrain-RGB map tiles, for the 3-D ground surface. Heights in the tiles are above `base_m`. */
  terrain_tiles: { url: string; max_zoom: number; encoding: "mapbox"; base_m: number };
  /** The whole elevation grid as packed 16-bit heights, for the drive mode's physics. */
  elevation_grid: GridInfo & { url: string };
  /** The pressurised base rover the crew drives in the drive mode. */
  vehicle: Vehicle;
  slope_layer: { url: string; bounds: Bounds; classes_deg: number[]; colours: string[]; method: string };
  validation: Validation | null;
  default_camp: { lat: number; lon: number; name: string; note: string };
  default_stops: StopInput[];
  default_work_min: number;
  parameters: Record<ParamName, ParameterInfo>;
  targets: Target[];
  rover: {
    path: LatLon[][];
    latest: { sol: number; lat: number; lon: number; odometer_m: number };
    fetched: string;
    stops: { sol: number; lat: number; lon: number }[];
  };
  /** Sols after `latest` are estimates, up to `forecast_until`. `today` is the sol it is now on Mars. */
  sols: { first: number; latest: number; forecast_until: number; today: number };
  forecast: { check: ForecastCheck | null };
  storm: StormSummary | null;
  sources: Source[];
  model_notes: string[];
}

export interface Radiation {
  dose_ugy_h: number;
  dose_usv_h: number;
  dose_ugy_sol: number;
  quality_factor: number;
  extrapolated: boolean;
  /** True after the last radiation reading: estimated from the solar cycle, with a likely range. */
  estimated: boolean;
  range_ugy_h: [number, number] | null;
  last_measured_sol: number;
}

export type EstimatedValue = "air_min_c" | "air_max_c" | "ground_min_c" | "ground_max_c" | "pressure_pa";

/** How a future day's conditions were estimated (backend/app/forecast.py). */
export interface Estimate {
  years_used: number;
  same_season_sols: number[];
  /** Likely range of each value: what 8 in 10 of the matching past days fell within. */
  ranges: Partial<Record<EstimatedValue, [number, number]>>;
  method: string;
  warnings: string[];
}

/** How the estimates did when tried on Curiosity's last measured Mars year (backend/pipeline/check_forecast.py). */
export interface ForecastCheck {
  tested_sols: [number, number];
  typical_error: Partial<Record<"sunrise_min" | "sunset_min" | "air_min_c" | "air_max_c" | "pressure_pa" | "radiation_ugy_h", number>>;
  share_inside_range: Partial<Record<"air_min_c" | "air_max_c" | "pressure_pa" | "radiation_ugy_h", number>>;
  note: string;
}

export interface Conditions {
  sol: number;
  requested_sol: number;
  date: string;
  ls: number | null;
  season: string | null;
  dust_season: boolean;
  air_min_c: number | null;
  air_max_c: number | null;
  ground_min_c: number | null;
  ground_max_c: number | null;
  pressure_pa: number | null;
  uv: string | null;
  sunrise_min: number;
  sunset_min: number;
  sunrise: string;
  sunset: string;
  daylight_h: number;
  radiation: Radiation | null;
  /** True for a day after Curiosity's record: every value above is an estimate. */
  estimated: boolean;
  estimate: Estimate | null;
}

export interface History {
  weather: { sol: number[]; date: string[]; air_min_c: (number | null)[]; air_max_c: (number | null)[] };
  radiation: { sol: number[]; date: string[]; dose_ugy_h: number[]; unit: string } | null;
  /** Estimated dose rate from the last reading to the last sol that can be estimated. */
  radiation_estimate: { sol: number[]; date: string[]; dose_ugy_h: number[]; low: number[]; high: number[] } | null;
}

export interface TimeLimit {
  usable_life_support_min: number;
  daylight_min: number;
  limit_min: number;
  limited_by: "life support" | "daylight";
  start_clock: string;
  back_by_clock: string;
  sunset_clock: string;
  notes: string[];
}

export interface StopReport {
  name: string;
  lat: number;
  lon: number;
  work_min: number;
  ok: boolean;
  problem: string | null;
  snapped_m?: number;
  elev_m?: number;
  slope_deg?: number;
  return_min?: number;
  arrive_min?: number;
  arrive_clock?: string;
  depart_min?: number;
  leave_by_min?: number;
  leave_by_clock?: string;
  spare_min?: number;
}

export interface Leg {
  from: string;
  to: string;
  dist_m: number;
  walk_min: number;
  ascent_m: number;
  descent_m: number;
  max_slope_deg: number;
}

export interface Profile {
  lat: number[];
  lon: number[];
  dist_m: number[];
  elapsed_min: number[];
  elev_m: number[];
  return_min: number[];
  spare_min: number[];
}

export interface TurnBack {
  lat: number;
  lon: number;
  elapsed_min: number;
  clock: string;
  dist_m: number;
  at_stop: string | null;
}

export interface Route {
  line: LatLon[];
  legs: Leg[];
  totals: {
    dist_m: number;
    walk_min: number;
    work_min: number;
    eva_min: number;
    ascent_m: number;
    descent_m: number;
    max_slope_deg: number;
    farthest_return_min: number;
    min_spare_min: number;
    finish_clock: string;
    dose_ugy: number | null;
    dose_usv: number | null;
  };
  profile: Profile;
  turn_back: TurnBack | null;
  storm: { warning_min: number; beyond_min: number; beyond_share: number; beyond_lines: LatLon[][] };
}

export interface Envelope {
  bounds: Bounds;
  rings: { minutes: number; lines: LatLon[][] }[];
  storm_line: { minutes: number; lines: LatLon[][] };
  storm_safe_km2: number;
  reachable_km2: number;
  walk_budget_min: number;
  work_min: number;
  turn_back_line: LatLon[][];
  inside_km2: number;
  covers_all_reachable: boolean;
  overlay_url: string | null;
}

export type Verdict = "go" | "marginal" | "no-go" | "none";

export interface Plan {
  verdict: Verdict;
  verdict_text: string;
  problems: string[];
  limit: TimeLimit;
  conditions: Conditions;
  camp: { lat: number; lon: number; snapped_m: number; elev_m: number; slope_deg: number };
  stops: StopReport[];
  route: Route | null;
  envelope: Envelope;
}

export interface Escape {
  line: LatLon[];
  return_min: number;
  dist_m: number;
  warning_min: number;
  late_min: number;
  in_time: boolean;
  storm_dose_ugy: number | null;
  storm_label: string | null;
}

export interface Photo {
  url: string;
  camera: string;
  sol: number;
  azimuth: number;
  elevation: number;
  compass: string;
  taken_utc: string;
}

export interface PhotoResult {
  stop: { sol: number; lat: number; lon: number; elev: number; site: number; drive: number } | null;
  distance_m: number;
  photos: Photo[];
  error: string | null;
}

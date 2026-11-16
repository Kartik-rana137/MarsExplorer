// The plan being edited is mirrored into the page address (after the #), so a plan can be bookmarked or
// sent to a crewmate. Everything read back from the address is checked against the site's limits.
import type { ParamName, Params, Site, StopInput } from "./types";

export interface PlanState {
  camp: { lat: number; lon: number };
  stops: StopInput[];
  params: Params;
  sol: number;
}

const KEY = "plan=";
const MAX_STOPS = 12;
const ROUTE_FILE_FORMAT = "mars-eva-planner-route";
const ROUTE_FILE_VERSION = 1;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function defaults(site: Site): PlanState {
  const names = Object.keys(site.parameters) as ParamName[];
  return {
    camp: { lat: site.default_camp.lat, lon: site.default_camp.lon },
    stops: site.default_stops.map((stop) => ({ ...stop })),
    params: Object.fromEntries(names.map((name) => [name, site.parameters[name].default])) as Params,
    sol: site.sols.latest,
  };
}

export function loadState(site: Site): PlanState {
  const state = defaults(site);
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(KEY)) return state;
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(decodeURIComponent(hash.slice(KEY.length)));
  } catch {
    return state;
  }
  const [[south, west], [north, east]] = site.bounds;
  const inside = (lat: unknown, lon: unknown): boolean => isNumber(lat) && isNumber(lon) && lat > south && lat < north && lon > west && lon < east;

  const camp = saved.camp as { lat?: unknown; lon?: unknown } | undefined;
  if (camp && inside(camp.lat, camp.lon)) state.camp = { lat: camp.lat as number, lon: camp.lon as number };

  if (Array.isArray(saved.stops)) {
    state.stops = [];
    for (const item of saved.stops.slice(0, MAX_STOPS) as Record<string, unknown>[]) {
      if (!item || !inside(item.lat, item.lon)) continue;
      state.stops.push({
        name: typeof item.name === "string" ? item.name.slice(0, 60) : "",
        lat: item.lat as number,
        lon: item.lon as number,
        work_min: isNumber(item.work_min) ? clamp(item.work_min, 0, 300) : site.default_work_min,
      });
    }
  }

  const params = (saved.params ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(site.parameters) as ParamName[]) {
    const value = params[name];
    if (isNumber(value)) state.params[name] = clamp(value, site.parameters[name].min, site.parameters[name].max);
  }
  if (isNumber(saved.sol)) state.sol = Math.round(clamp(saved.sol, site.sols.first, site.sols.forecast_until));
  return state;
}

function compactState(state: PlanState): PlanState {
  return {
    camp: { lat: +state.camp.lat.toFixed(6), lon: +state.camp.lon.toFixed(6) },
    stops: state.stops.map((stop) => ({ name: stop.name, lat: +stop.lat.toFixed(6), lon: +stop.lon.toFixed(6), work_min: stop.work_min })),
    params: state.params,
    sol: state.sol,
  };
}

export function saveState(state: PlanState): void {
  window.history.replaceState(null, "", `#${KEY}${encodeURIComponent(JSON.stringify(compactState(state)))}`);
}

export function serializeRouteFile(state: PlanState): string {
  return JSON.stringify({ format: ROUTE_FILE_FORMAT, version: ROUTE_FILE_VERSION, plan: compactState(state) }, null, 2);
}

export function parseRouteFile(contents: string, site: Site): PlanState {
  let saved: unknown;
  try {
    saved = JSON.parse(contents);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!isRecord(saved) || saved.format !== ROUTE_FILE_FORMAT) {
    throw new Error("This is not a Mars EVA Planner route file.");
  }
  if (saved.version !== ROUTE_FILE_VERSION) {
    throw new Error(`Unsupported route file version: ${String(saved.version)}.`);
  }
  const plan = saved.plan;
  if (!isRecord(plan)) throw new Error("The route file is missing its plan.");

  const [[south, west], [north, east]] = site.bounds;
  const inside = (point: unknown): point is Record<string, unknown> & { lat: number; lon: number } => {
    if (!isRecord(point) || !isNumber(point.lat) || !isNumber(point.lon)) return false;
    return point.lat > south && point.lat < north && point.lon > west && point.lon < east;
  };
  const camp = plan.camp;
  if (!inside(camp)) {
    throw new Error("The route file has invalid base camp coordinates.");
  }
  if (!Array.isArray(plan.stops)) throw new Error("The route file is missing its stops.");
  if (plan.stops.length > MAX_STOPS) {
    throw new Error(`The route file must contain at most ${MAX_STOPS} stops.`);
  }
  const stops: StopInput[] = plan.stops.map((item, index) => {
    if (!inside(item)) {
      throw new Error(`Stop ${index + 1} has invalid coordinates.`);
    }
    if (typeof item.name !== "string" || item.name.length > 60) {
      throw new Error(`Stop ${index + 1} has an invalid name.`);
    }
    if (!isNumber(item.work_min) || item.work_min < 0 || item.work_min > 300) {
      throw new Error(`Stop ${index + 1} has an invalid work duration.`);
    }
    return { name: item.name, lat: item.lat, lon: item.lon, work_min: item.work_min };
  });

  if (!isRecord(plan.params)) throw new Error("The route file is missing its walk settings.");
  const params = {} as Params;
  for (const name of Object.keys(site.parameters) as ParamName[]) {
    const value = plan.params[name];
    const limits = site.parameters[name];
    if (!isNumber(value) || value < limits.min || value > limits.max) {
      throw new Error(`The route file has an invalid value for ${name}.`);
    }
    params[name] = value;
  }
  if (!isNumber(plan.sol) || !Number.isInteger(plan.sol) || plan.sol < site.sols.first || plan.sol > site.sols.forecast_until) {
    throw new Error("The route file has an invalid sol.");
  }

  return {
    camp: { lat: camp.lat, lon: camp.lon },
    stops,
    params,
    sol: plan.sol,
  };
}

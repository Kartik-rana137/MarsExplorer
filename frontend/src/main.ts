// App wiring: holds the editable plan (base camp, stops, settings, sol), asks the backend to plan it,
// and hands the result to the map and panels.
import { api, ApiError } from "./api";
import { byId } from "./dom";
import { clockAfter } from "./format";
import { MissionMap } from "./map";
import { buildAbout, buildCrewPanel, buildMapKey, ConditionsPanel, PhotosPanel, PlanPanel, ProfilePanel, showVerdict, StormPanel } from "./panels";
import { loadState, saveState } from "./permalink";
import type { Params, Plan, Site, StopInput } from "./types";
import "./style.css";

const PLAN_DELAY_MS = 180;

async function start(): Promise<void> {
  let site: Site;
  try {
    site = await api.site();
  } catch (error) {
    showVerdict("no-go", error instanceof ApiError ? error.message : "The planner could not start.");
    return;
  }

  // ---- the editable plan (restored from the page address when it holds one) --------------------------
  const saved = loadState(site);
  const camp = saved.camp;
  const stops: StopInput[] = saved.stops;
  const params: Params = saved.params;
  let sol = saved.sol;
  let plan: Plan | null = null;
  let drillIndex: number | null = null;
  // The storm test always has an answer in its panel, but its crew marker and way-back line are only
  // drawn on the map once someone uses the test, so the plain route stays easy to read.
  let drillOnMap = false;

  // ---- views -----------------------------------------------------------------------------------------
  const photos = new PhotosPanel();
  const showPhotos = async (lat: number, lon: number, where: string) => {
    photos.loading(where);
    byId("photos").scrollIntoView({ behavior: "smooth", block: "nearest" });
    try {
      photos.show(where, await api.photos(lat, lon));
    } catch (error) {
      photos.show(where, { stop: null, distance_m: 0, photos: [], error: error instanceof Error ? error.message : "Photo lookup failed" });
    }
  };

  const map = new MissionMap(byId("map"), site, {
    onAddStop: (lat, lon, name) => {
      stops.push({ name: name ?? "", lat, lon, work_min: site.default_work_min });
      stopsChanged();
    },
    onMoveCamp: (lat, lon) => {
      camp.lat = lat;
      camp.lon = lon;
      map.setCamp(lat, lon);
      schedulePlan();
    },
    onMoveStop: (index, lat, lon) => {
      stops[index] = { ...stops[index], lat, lon };
      stopsChanged();
    },
    onRemoveStop: (index) => {
      stops.splice(index, 1);
      stopsChanged();
    },
    onPhotos: showPhotos,
  });

  const conditions = new ConditionsPanel(site, sol, (value) => {
    sol = value;
    schedulePlan();
  });
  buildCrewPanel(site, params, schedulePlan);
  const setStormKey = buildMapKey(site, map);
  setStormKey(params.storm_warning_min);
  buildAbout(site);

  const planPanel = new PlanPanel({
    onWork: (index, minutes) => {
      stops[index] = { ...stops[index], work_min: Math.min(300, Math.max(0, minutes || 0)) };
      schedulePlan();
    },
    onMove: (index, delta) => {
      const other = index + delta;
      if (other < 0 || other >= stops.length) return;
      [stops[index], stops[other]] = [stops[other], stops[index]];
      stopsChanged();
    },
    onRemove: (index) => {
      stops.splice(index, 1);
      stopsChanged();
    },
    onPhotos: (index) => showPhotos(stops[index].lat, stops[index].lon, stops[index].name || `stop ${index + 1}`),
  });

  const profilePanel = new ProfilePanel(
    (index) => {
      // Hovering the charts moves the crew marker; leaving puts it back on the storm-test position, if shown.
      const shown = index ?? (drillOnMap ? drillIndex : null);
      const profile = plan?.route?.profile;
      map.setCursor(profile && shown !== null && shown < profile.lat.length ? { lat: profile.lat[shown], lon: profile.lon[shown] } : null);
    },
    (index) => setDrill(index, true),
  );
  const stormPanel = new StormPanel(site, (index) => setDrill(index, true));

  api.history().then((history) => conditions.setHistory(history)).catch(() => undefined);
  new ResizeObserver(() => map.invalidate()).observe(byId("map"));

  // ---- planning --------------------------------------------------------------------------------------
  let timer: number | undefined;
  let planAbort: AbortController | null = null;
  let escapeAbort: AbortController | null = null;
  let escapeTimer: number | undefined;

  function stopsChanged(): void {
    map.setStops(stops);
    schedulePlan();
  }

  function schedulePlan(): void {
    saveState({ camp, stops, params, sol });
    window.clearTimeout(timer);
    timer = window.setTimeout(runPlan, PLAN_DELAY_MS);
  }

  async function runPlan(): Promise<void> {
    planAbort?.abort();
    planAbort = new AbortController();
    document.body.classList.add("is-loading");  // keep the last result on screen, dimmed, while replanning
    try {
      plan = await api.plan(camp, stops, params, sol, planAbort.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      document.body.classList.remove("is-loading");
      showVerdict("no-go", error instanceof Error ? error.message : "Planning failed.");
      return;
    }
    document.body.classList.remove("is-loading");
    showVerdict(plan.verdict, plan.verdict_text);
    conditions.update(plan.conditions);
    map.showPlan(plan);
    setStormKey(plan.envelope.storm_line.minutes);
    planPanel.update(plan, stops);
    profilePanel.update(plan, params.start_clock_min);
    stormPanel.update(plan);

    // Storm drill starts at the point farthest from shelter.
    const profile = plan.route?.profile;
    if (profile) {
      let farthest = 0;
      profile.return_min.forEach((value, i) => {
        if (value > profile.return_min[farthest]) farthest = i;
      });
      setDrill(farthest);
    } else {
      drillIndex = null;
      profilePanel.pin(null);
      map.setCursor(null);
      map.showEscape(null);
      stormPanel.showEscape(null);
    }
  }

  /** Place the crew for the storm test. `byUser` is true when someone moved it, which also shows it on the map. */
  function setDrill(index: number, byUser = false): void {
    const profile = plan?.route?.profile;
    if (!profile) return;
    if (byUser) drillOnMap = true;
    drillIndex = Math.min(Math.max(0, index), profile.lat.length - 1);
    const position = { lat: profile.lat[drillIndex], lon: profile.lon[drillIndex] };
    profilePanel.pin(drillIndex);
    stormPanel.showPosition(drillIndex, clockAfter(params.start_clock_min, profile.elapsed_min[drillIndex]));
    map.setCursor(drillOnMap ? position : null);
    window.clearTimeout(escapeTimer);
    escapeTimer = window.setTimeout(async () => {
      escapeAbort?.abort();
      escapeAbort = new AbortController();
      try {
        const escape = await api.escape(camp, position, params, escapeAbort.signal);
        map.showEscape(drillOnMap ? escape.line : null);
        stormPanel.showEscape(escape);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        map.showEscape(null);
        stormPanel.showEscape(null, error instanceof Error ? error.message : "Could not compute the way back.");
      }
    }, 90);
  }

  map.setStops(stops);
  await runPlan();
}

// Surface unexpected failures in the status bar instead of failing silently.
window.addEventListener("error", (event) => showVerdict("no-go", `Unexpected error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => showVerdict("no-go", `Unexpected error: ${String(event.reason)}`));

void start();

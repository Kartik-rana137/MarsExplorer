// App wiring: holds the editable plan (base camp, stops, settings, sol), asks the backend to plan it,
// and hands the result to the map and the floating panel.
import { api, ApiError } from "./api";
import { byId, icon } from "./dom";
import { clockAfter } from "./format";
import { MissionMap } from "./map";
import {
  addChip,
  addSection,
  buildAbout,
  buildLayers,
  buildWalkSettings,
  ConditionsPanel,
  openSection,
  PhotosPanel,
  PlanPanel,
  RoutePanel,
  showVerdict,
  StormPanel,
} from "./panels";
import { loadState, saveState } from "./permalink";
import type { Params, Plan, Site, StopInput } from "./types";
import "./style.css";

const PLAN_DELAY_MS = 180;
const PHONE_WIDTH = 760; // below this the panel is a sheet under the map instead of floating over it

function setupThemeToggle(): void {
  const button = byId<HTMLButtonElement>("theme-toggle");
  let theme: "light" | "dark" = localStorage.getItem("mars-eva-theme") === "dark" ? "dark" : "light";

  const render = () => {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    button.replaceChildren(icon(dark ? "sun" : "moon", 18));
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(dark));
  };

  button.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    render();
    localStorage.setItem("mars-eva-theme", theme);
  });
  render();
}

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
  // The storm test always has an answer in its section, but its crew marker and way-back line are only
  // drawn on the map once someone uses the test, so the plain route stays easy to read.
  let drillOnMap = false;

  // ---- panel: hide and show --------------------------------------------------------------------------
  const app = byId("app");
  const panel = byId("panel");
  const toggle = byId("panel-toggle");
  toggle.append(icon("chevronLeft", 20));
  /** Hide or show the panel, and let the map re-centre on the part of it that is left visible. */
  const setPanelHidden = (hidden: boolean) => {
    if (app.classList.contains("panel-hidden") === hidden) return;
    app.classList.toggle("panel-hidden", hidden);
    toggle.setAttribute("aria-expanded", String(!hidden));
    toggle.title = hidden ? "Show the panel" : "Hide the panel";
    toggle.setAttribute("aria-label", toggle.title);
    map.updateInsets();
  };
  toggle.addEventListener("click", () => setPanelHidden(!app.classList.contains("panel-hidden")));
  /** Part of the map covered by the panel (left) and the chips (top). */
  const insets = () => {
    const floating = window.innerWidth > PHONE_WIDTH && !app.classList.contains("panel-hidden");
    return { left: floating ? panel.offsetLeft + panel.offsetWidth : 0, top: 52 };
  };

  // ---- views -----------------------------------------------------------------------------------------
  const photos = new PhotosPanel();
  const showPhotos = async (lat: number, lon: number, where: string) => {
    setPanelHidden(false);
    photos.loading(where);
    try {
      photos.show(where, await api.photos(lat, lon));
    } catch (error) {
      photos.show(where, { stop: null, distance_m: 0, photos: [], error: error instanceof Error ? error.message : "Photo lookup failed" });
    }
  };

  const map = new MissionMap(byId("map"), site, {
    insets,
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

  // Details that open on request, in the order a newcomer is likely to want them.
  const walkSection = addSection("walk", "Walk settings");
  const daySection = addSection("calendar", "Day on Mars");
  const stormSection = addSection("bolt", "Solar storm test");
  const routeSection = addSection("chart", "Route details");

  // Chips over the map are shortcuts into those sections.
  const openFromChip = (section: typeof daySection) => {
    setPanelHidden(false);
    openSection(section);
  };
  const dayChip = addChip("calendar", "Day on Mars", () => openFromChip(daySection));
  addChip("bolt", "Solar storm test", () => openFromChip(stormSection));

  buildWalkSettings(walkSection, site, params, schedulePlan);
  const conditions = new ConditionsPanel(daySection, dayChip, site, sol, (value) => {
    sol = value;
    schedulePlan();
  });
  const stormPanel = new StormPanel(stormSection, site, (index) => setDrill(index, true));
  const routePanel = new RoutePanel(
    routeSection,
    (index) => {
      // Moving over the charts moves the crew marker; leaving puts it back on the storm-test position, if shown.
      const shown = index ?? (drillOnMap ? drillIndex : null);
      const profile = plan?.route?.profile;
      map.setCursor(profile && shown !== null && shown < profile.lat.length ? { lat: profile.lat[shown], lon: profile.lon[shown] } : null);
    },
    (index) => setDrill(index, true),
  );
  const setStormKey = buildLayers(site, map);
  setStormKey(params.storm_warning_min);
  buildAbout(site);

  api.history().then((history) => conditions.setHistory(history)).catch(() => undefined);
  new ResizeObserver(() => {
    map.invalidate();
    map.updateInsets(); // the panel floats over the map on wide screens and sits under it on phones
  }).observe(byId("map"));

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
    routePanel.update(plan, params.start_clock_min);
    stormPanel.update(plan);

    // The storm test starts at the point farthest from shelter.
    const profile = plan.route?.profile;
    if (profile) {
      let farthest = 0;
      profile.return_min.forEach((value, i) => {
        if (value > profile.return_min[farthest]) farthest = i;
      });
      setDrill(farthest);
    } else {
      drillIndex = null;
      routePanel.pin(null);
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
    routePanel.pin(drillIndex);
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

// Surface unexpected failures in the verdict card instead of failing silently.
window.addEventListener("error", (event) => showVerdict("no-go", `Unexpected error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => showVerdict("no-go", `Unexpected error: ${String(event.reason)}`));

setupThemeToggle();
void start();

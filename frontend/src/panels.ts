// The floating panel. It shows the least needed to decide (verdict, total time, the list of stops) and
// keeps everything else in sections that open on request. Wording is aimed at someone with no space
// background. Each piece is built once and then updated with backend results.
import { LineChart, type Band, type Tick } from "./charts";
import { byId, clear, h, icon, type IconName } from "./dom";
import { clock, clockAfter, CLOCK_STRETCH, distance, duration, fixed, label, temperatureRange } from "./format";
import { MAP_COLOURS, type LayerName, type MissionMap } from "./map";
import type { Conditions, Escape, History, ParamName, Params, PhotoResult, Plan, Site, StopInput, Verdict } from "./types";

const VERDICT_LABEL: Record<Verdict, string> = { go: "Safe to go", marginal: "Tight", "no-go": "Not safe", none: "No route yet" };
const VERDICT_ICON: Record<Verdict, string> = { go: "✓", marginal: "!", "no-go": "✕", none: "–" };

/** Natural background radiation on Earth, world average 2.4 mSv a year (UNSCEAR), per hour and per day. */
const EARTH_USV_PER_HOUR = 2400 / 8766;
const EARTH_USV_PER_DAY = 2400 / 365.25;

function tile(name: string, value: string, note = ""): HTMLElement {
  return h("div", { class: "tile" }, h("span", { class: "tile-label" }, name), h("span", { class: "tile-value" }, value), note ? h("span", { class: "tile-note" }, note) : null);
}

/** A small "show more" disclosure inside a section. */
function more(title: string, ...children: (Node | string | null)[]): HTMLDetailsElement {
  return h("details", { class: "more" }, h("summary", {}, title), ...children);
}

function prettyDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ---- panel structure -----------------------------------------------------------------------------------

/** A row in the panel that opens to show detail. `value` is the one-line answer shown while it is closed. */
export interface Section {
  details: HTMLDetailsElement;
  body: HTMLElement;
  value: HTMLElement;
}

export function addSection(iconName: IconName, title: string): Section {
  const value = h("span", { class: "sec-value" });
  const body = h("div", { class: "sec-body" });
  const details = h(
    "details",
    { class: "sec" },
    h("summary", {}, h("span", { class: "sec-icon" }, icon(iconName)), h("span", { class: "sec-text" }, h("span", { class: "sec-title" }, title), value), h("span", { class: "sec-chevron" }, icon("expand"))),
    body,
  );
  byId("sections").append(details);
  return { details, body, value };
}

/** Switch the panel between the walk and the photos of a place. */
export function showView(name: "walk" | "place"): void {
  byId("view-walk").hidden = name !== "walk";
  byId("view-place").hidden = name !== "place";
}

export function openSection(section: Section): void {
  showView("walk");
  section.details.open = true;
  section.details.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** A pill button floating over the map. Returns the element holding its text so it can be updated. */
export function addChip(iconName: IconName, text: string, onClick: () => void): HTMLElement {
  const labelText = h("span", {}, text);
  byId("chips").append(h("button", { type: "button", class: "chip-button", onclick: onClick }, icon(iconName, 18), labelText));
  return labelText;
}

// ---- verdict -------------------------------------------------------------------------------------------

export function showVerdict(verdict: Verdict, text: string): void {
  const box = byId("verdict");
  clear(box);
  box.className = `verdict verdict-${verdict}`;
  box.append(
    h("span", { class: "verdict-icon", "aria-hidden": "true" }, VERDICT_ICON[verdict]),
    h("div", { class: "verdict-body" }, h("strong", {}, VERDICT_LABEL[verdict]), h("p", {}, text)),
  );
}

// ---- the walk: totals and the list of stops ------------------------------------------------------------

export interface StopActions {
  onWork: (index: number, minutes: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (index: number) => void;
  onPhotos: (index: number) => void;
}

export class PlanPanel {
  private readonly trip = h("div", { class: "trip" });
  private readonly list = h("ol", { class: "way" });

  constructor(private readonly actions: StopActions) {
    byId("plan").append(this.trip, this.list);
  }

  update(plan: Plan, stops: StopInput[]): void {
    const route = plan.route;
    clear(this.trip);
    if (route) {
      const t = route.totals;
      const spare = t.min_spare_min < 0 ? `${duration(-t.min_spare_min)} too long` : `${duration(t.min_spare_min)} to spare`;
      this.trip.append(
        h("div", { class: "trip-main" }, h("span", { class: "trip-time" }, duration(t.eva_min)), h("span", { class: "trip-distance" }, distance(t.dist_m))),
        h("div", { class: "trip-sub" }, `${duration(t.walk_min)} walking, ${duration(t.work_min)} at stops · ${spare}`),
      );
    }

    clear(this.list);
    const legs = route?.legs ?? [];
    let leg = 0;
    // The walk between two rows of the list, taken from the route's legs in order.
    const addLeg = () => {
      const part = legs[leg++];
      if (part) this.list.append(h("li", { class: "way-leg" }, `${duration(part.walk_min)} walk · ${distance(part.dist_m)}`));
    };
    const button = (name: IconName, title: string, target: string, handler: () => void, disabled = false) =>
      h("button", { type: "button", class: "icon-button", title, "aria-label": `${title}: ${target}`, disabled, onclick: handler }, icon(name, 18));

    this.list.append(
      h(
        "li",
        { class: "way-row" },
        h("span", { class: "way-mark way-mark-camp" }, icon("home", 16)),
        h("div", { class: "way-text" }, h("span", { class: "way-name" }, "Base camp"), h("span", { class: "way-sub" }, "Your rover and shelter")),
        h("span", { class: "way-time" }, `Leave ${plan.limit.start_clock}`),
      ),
    );

    stops.forEach((stop, index) => {
      const report = plan.stops[index];
      const name = stop.name || `Stop ${index + 1}`;
      const stay = h("input", { type: "number", min: 0, max: 300, step: 5, value: stop.work_min, "aria-label": `Minutes at ${name}` });
      stay.addEventListener("change", () => this.actions.onWork(index, Number(stay.value)));
      // `report` is missing for a moment when a stop was just added and its plan has not come back yet.
      const ok = Boolean(report && report.ok && report.arrive_clock);
      const late = ok && (report.spare_min ?? 0) < 0;
      if (ok) addLeg();
      this.list.append(
        h(
          "li",
          { class: `way-row${late || report?.problem ? " way-bad" : ""}` },
          h("span", { class: "way-mark way-mark-stop" }, String(index + 1)),
          h(
            "div",
            { class: "way-text" },
            h("span", { class: "way-name" }, name),
            ok
              ? h("span", { class: late ? "way-sub problem" : "way-sub" }, late ? `Too late: leave by ${report.leave_by_clock}` : `Leave by ${report.leave_by_clock} at the latest`)
              : report?.problem
                ? h("span", { class: "way-sub problem" }, `This spot ${report.problem}`)
                : h("span", { class: "way-sub" }, "Working out the route…"),
            h(
              "div",
              { class: "way-controls" },
              h("label", {}, "Stay ", stay, " min"),
              button("camera", "See photos", name, () => this.actions.onPhotos(index)),
              button("up", "Visit earlier", name, () => this.actions.onMove(index, -1), index === 0),
              button("down", "Visit later", name, () => this.actions.onMove(index, 1), index === stops.length - 1),
              button("close", "Remove", name, () => this.actions.onRemove(index)),
            ),
          ),
          h("span", { class: "way-time" }, ok ? report.arrive_clock! : ""),
        ),
      );
    });

    if (route) {
      addLeg();
      this.list.append(
        h(
          "li",
          { class: "way-row" },
          h("span", { class: "way-mark way-mark-camp" }, icon("home", 16)),
          h("div", { class: "way-text" }, h("span", { class: "way-name" }, "Back at base camp"), h("span", { class: "way-sub" }, `Latest safe time ${plan.limit.back_by_clock}`)),
          h("span", { class: "way-time" }, route.totals.finish_clock),
        ),
      );
    }
    this.list.append(h("li", { class: "way-add" }, h("span", { class: "way-mark way-mark-add" }, icon("add", 16)), h("span", {}, "Click the map to add a place to visit")));
  }
}

// ---- section: walk settings ----------------------------------------------------------------------------

function pace(speed: number): string {
  const word = speed < 0.65 ? "slow" : speed < 1.0 ? "steady" : "brisk";
  return `${(speed * 3.6).toFixed(1)} km/h, ${word}`;
}

const PARAM_TEXT: Record<ParamName, { name: string; hint: string; format: (value: number) => string }> = {
  start_clock_min: { name: "Leave base camp at", hint: "Mars local time.", format: (v) => clock(v) },
  flat_speed: { name: "Walking pace on flat ground", hint: "In a spacesuit, carrying tools. Hills slow this down.", format: pace },
  life_support_h: { name: "Suit air and power", hint: "", format: (v) => `${v} h` },
  max_slope: { name: "Steepest ground allowed", hint: "Steeper ground is treated as off limits.", format: (v) => `${v.toFixed(0)}°` },
  reserve_min: { name: "Suit supply kept in reserve", hint: "Never planned to be used.", format: (v) => duration(v) },
  sunset_buffer_min: { name: "Be back before sunset by", hint: "", format: (v) => duration(v) },
  storm_warning_min: { name: "Storm warning time", hint: "How long the crew has to reach shelter after a solar storm alarm.", format: (v) => `${v.toFixed(0)} min` },
};
const MAIN_PARAMS: ParamName[] = ["start_clock_min", "flat_speed", "life_support_h"];
const SAFETY_PARAMS: ParamName[] = ["max_slope", "reserve_min", "sunset_buffer_min", "storm_warning_min"];

export function buildWalkSettings(section: Section, site: Site, params: Params, onChange: () => void): void {
  const describe = () => {
    section.value.textContent = `Leave ${clock(params.start_clock_min)} · ${(params.flat_speed * 3.6).toFixed(1)} km/h · ${params.life_support_h} h suit`;
  };
  const slider = (name: ParamName) => {
    const info = site.parameters[name];
    const text = PARAM_TEXT[name];
    const value = h("output", {}, text.format(params[name]));
    const input = h("input", { type: "range", min: info.min, max: info.max, step: info.step, value: params[name], "aria-label": text.name });
    input.addEventListener("input", () => {
      params[name] = Number(input.value);
      value.textContent = text.format(params[name]);
      describe();
      onChange();
    });
    return h("div", { class: "slider" }, h("div", { class: "slider-head" }, h("span", {}, text.name), value), input, text.hint ? h("span", { class: "hint" }, text.hint) : null);
  };
  section.body.append(...MAIN_PARAMS.map(slider), more("Safety margins", ...SAFETY_PARAMS.map(slider)));
  describe();
}

// ---- section: the day ----------------------------------------------------------------------------------

export class ConditionsPanel {
  private readonly tiles = h("div", { class: "tiles" });
  private readonly extraTiles = h("div", { class: "tiles" });
  private readonly dateLine = h("output", { class: "sol-date" });
  private readonly solRange: HTMLInputElement;
  private readonly details: HTMLDetailsElement;
  private chart: LineChart | null = null;
  private history: History | null = null;

  /** `chip` is the text of the day chip on the map, kept in step with the chosen day. */
  constructor(private readonly section: Section, private readonly chip: HTMLElement, site: Site, sol: number, private readonly onSol: (sol: number) => void) {
    const { first, latest } = site.sols;
    this.solRange = h("input", { type: "range", min: first, max: latest, value: sol, "aria-label": "Mars day" });
    this.solRange.addEventListener("input", () => this.pick(Number(this.solRange.value), false));
    this.solRange.addEventListener("change", () => this.pick(Number(this.solRange.value), true));
    const preset = (text: string, value: number) => h("button", { type: "button", class: "chip", onclick: () => this.pick(value, true) }, text);
    this.details = more("More about this day", this.extraTiles);
    section.body.append(
      h("p", { class: "hint" }, "The planner uses the real weather and radiation NASA's Curiosity rover measured here on that day."),
      h("div", { class: "chips" }, preset("Latest", latest), preset("Quiet Sun, 2020", 2700), preset("Solar storm, May 2024", 4190)),
      this.solRange,
      this.dateLine,
      this.tiles,
      this.details,
    );
  }

  private pick(sol: number, commit: boolean): void {
    if (!Number.isFinite(sol)) return;
    this.solRange.value = String(sol);
    this.dateLine.textContent = `Mars day (sol) ${sol}`;
    this.pinSol(sol);
    if (commit) this.onSol(sol);
  }

  setHistory(history: History): void {
    this.history = history;
    const series = history.radiation;
    if (!series) return;
    const yearTicks = (): Tick[] => {
      const ticks: Tick[] = [];
      let lastYear = "";
      series.date.forEach((date, i) => {
        const year = date.slice(0, 4);
        if (year !== lastYear && Number(year) % 3 === 0) ticks.push({ value: series.sol[i], label: year });
        lastYear = year;
      });
      return ticks;
    };
    const dateOf = (sol: number) => series.date[nearestIndex(series.sol, sol)];
    this.chart = new LineChart(this.details, {
      title: "Radiation at the surface over the years, µGy per hour",
      plotHeight: 86,
      formatX: (sol) => `sol ${Math.round(sol)}, ${prettyDate(dateOf(sol))}`,
      formatY: (value) => value.toFixed(1),
      formatTick: (value) => value.toFixed(0),
      xTicks: yearTicks,
      tableHeaders: ["Sol", "µGy per hour"],
      onPick: (index) => this.pick(series.sol[index], true),
    });
    this.chart.setData(series.sol, series.dose_ugy_h);
    this.pinSol(Number(this.solRange.value));
    this.details.append(
      h("p", { class: "hint" }, "Radiation from deep space is highest when the Sun is quiet (2020), because the Sun's wind then shields the planets less. Click the chart to pick a day."),
    );
  }

  private pinSol(sol: number): void {
    const series = this.history?.radiation;
    if (series && this.chart) this.chart.setPinned(nearestIndex(series.sol, sol));
  }

  update(cond: Conditions): void {
    this.solRange.value = String(cond.sol);
    this.pinSol(cond.sol);
    const date = prettyDate(cond.date);
    const season = cond.season ? `, ${cond.season}${cond.dust_season ? " (dusty season)" : ""}` : "";
    this.dateLine.textContent = `${date} on Earth · Mars day ${cond.sol}${season}`;
    this.chip.textContent = date;
    this.section.value.textContent = `${date} · ${temperatureRange(cond.air_min_c, cond.air_max_c)}`;
    const rad = cond.radiation;
    clear(this.tiles);
    this.tiles.append(
      tile("Temperature", temperatureRange(cond.air_min_c, cond.air_max_c), "coldest to warmest"),
      tile("Daylight", `${cond.sunrise} to ${cond.sunset}`, `${cond.daylight_h.toFixed(1)} hours`),
      tile(
        "Radiation",
        rad ? `${rad.dose_ugy_h.toFixed(1)} µGy/h` : "no data",
        rad ? `about ${Math.round(rad.dose_usv_h / EARTH_USV_PER_HOUR)}× Earth's natural level` : "",
      ),
      tile("Sunburn risk (UV)", label(cond.uv)),
    );
    clear(this.extraTiles);
    this.extraTiles.append(
      tile("Ground temperature", temperatureRange(cond.ground_min_c, cond.ground_max_c)),
      tile("Air pressure", fixed(cond.pressure_pa, 0, " Pa"), "under 1% of Earth's"),
    );
    if (rad?.extrapolated) this.extraTiles.append(tile("Radiation measured", `sol ${rad.last_measured_sol}`, "latest reading available"));
  }
}

function nearestIndex(values: number[], target: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  return best;
}

// ---- section: solar storm test -------------------------------------------------------------------------

export class StormPanel {
  private readonly summary = h("p", { class: "storm-summary" });
  private readonly slider = h("input", { type: "range", min: 0, max: 0, value: 0, "aria-label": "Where the crew is when the alarm goes off" });
  private readonly where = h("output", {});
  private readonly result = h("div", { class: "drill-result" });

  constructor(private readonly section: Section, site: Site, private readonly onPosition: (index: number) => void) {
    const root = section.body;
    this.slider.addEventListener("input", () => this.onPosition(Number(this.slider.value)));
    const storm = site.storm;
    root.append(
      h(
        "p",
        { class: "hint" },
        storm
          ? `The Sun can suddenly flood Mars with radiation. In May 2024 Curiosity measured it jump ${storm.peak_ratio.toFixed(0)} times higher in under an hour, so the crew must be able to get back to shelter quickly.`
          : "The Sun can suddenly flood Mars with radiation, so the crew must be able to get back to shelter quickly.",
      ),
      this.summary,
      h("div", { class: "slider" }, h("div", { class: "slider-head" }, h("span", {}, "Alarm goes off at"), this.where), this.slider, h("span", { class: "hint" }, "Slide to move the crew along the route. The green line on the map is their fastest way back.")),
      this.result,
    );
    if (storm) {
      const details = more("See the May 2024 storm Curiosity measured");
      root.append(details);
      const from = storm.hours.findIndex((hour) => hour >= -1);
      const to = storm.hours.findIndex((hour) => hour > 12);
      new LineChart(details, {
        title: "Radiation during the storm, µGy per hour",
        plotHeight: 78,
        formatX: (hour) => (hour < 0 ? `${Math.round(-hour * 60)} min before it began` : `${hour.toFixed(1)} h after it began`),
        formatY: (value) => value.toFixed(0),
        xTicks: () => [0, 3, 6, 9, 12].map((value) => ({ value, label: value === 0 ? "start" : `+${value} h` })),
        includeZero: true,
        tableHeaders: ["Time", "µGy per hour"],
      }).setData(storm.hours.slice(from, to), storm.dose.slice(from, to));
      details.append(
        h(
          "p",
          { class: "hint" },
          `Measured by Curiosity's radiation detector. Radiation rose from ${storm.baseline_ugy_h.toFixed(1)} to ${storm.peak_ugy_h.toFixed(0)} µGy per hour within ${Math.round(storm.hours_to_peak * 60)} minutes. Over ${storm.duration_h.toFixed(0)} hours the storm added about ${(storm.excess_dose_ugy / 1000).toFixed(1)} mGy, as much as ${(storm.excess_dose_ugy / (storm.baseline_ugy_h * 24.66)).toFixed(0)} normal Mars days.`,
        ),
      );
    }
  }

  update(plan: Plan): void {
    const route = plan.route;
    if (!route) {
      this.section.value.textContent = "Plan a walk first";
      this.summary.textContent = "Plan a walk first, then test it here.";
      this.slider.max = "0";
      this.where.textContent = "";
      clear(this.result);
      return;
    }
    const storm = route.storm;
    this.slider.max = String(route.profile.elapsed_min.length - 1);
    if (storm.beyond_min > 0) {
      this.section.value.textContent = `${duration(storm.beyond_min)} too far from shelter`;
      this.summary.textContent = `For ${duration(storm.beyond_min)} of this walk the crew is more than ${storm.warning_min} min from shelter (pink on the map).`;
    } else {
      this.section.value.textContent = `Shelter always within ${storm.warning_min} min`;
      this.summary.textContent = `The whole walk stays within ${storm.warning_min} min of shelter. The farthest point is ${duration(route.totals.farthest_return_min)} away.`;
    }
  }

  showPosition(index: number, clockText: string): void {
    this.slider.value = String(index);
    this.where.textContent = clockText;
  }

  showEscape(escape: Escape | null, error = ""): void {
    clear(this.result);
    if (!escape) {
      this.result.className = "drill-result";
      if (error) this.result.append(h("p", { class: "problem" }, error));
      return;
    }
    const good = escape.in_time;
    this.result.className = `drill-result ${good ? "drill-good" : "drill-bad"}`;
    this.result.append(
      h("strong", {}, good ? "✓ Safe in shelter in time" : "✕ Caught outside"),
      h(
        "p",
        {},
        good
          ? `The way back takes ${duration(escape.return_min)} (${distance(escape.dist_m)}), ${duration(escape.warning_min - escape.return_min)} before the warning time runs out.`
          : `The way back takes ${duration(escape.return_min)} (${distance(escape.dist_m)}), ${duration(escape.late_min)} longer than the warning allows.`,
      ),
    );
    if (!good && escape.storm_dose_ugy !== null) {
      this.result.append(h("p", {}, `In a storm like May 2024 the crew would pick up about ${escape.storm_dose_ugy.toFixed(0)} µGy before reaching shelter.`));
    }
  }
}

// ---- section: route details (limits, radiation, charts along the route, each leg) -----------------------

export class RoutePanel {
  private readonly charts: LineChart[];
  private readonly limitLine = h("p", {});
  private readonly doseLine = h("p", {});
  private readonly readout = h("p", { class: "hint" });
  private readonly legs = h("tbody");
  private plan: Plan | null = null;
  private startClock = 0;

  constructor(private readonly section: Section, private readonly onHover: (index: number | null) => void, onPick: (index: number) => void) {
    const grid = h("div", { class: "profile-grid" });
    section.body.append(
      this.limitLine,
      this.doseLine,
      this.readout,
      grid,
      more(
        "Each part of the route",
        h("div", { class: "table-scroll" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Part", "Distance", "Walk", "Up / down", "Steepest"].map((t) => h("th", {}, t)))), this.legs)),
      ),
    );
    // Ticks sit on round Mars clock times; positions are converted back to elapsed real minutes.
    const timeTicks = (min: number, max: number): Tick[] => {
      const first = this.startClock + min / CLOCK_STRETCH;
      const last = this.startClock + max / CLOCK_STRETCH;
      const step = [10, 15, 30, 60, 120].find((s) => (last - first) / s <= 5) ?? 180;
      const ticks: Tick[] = [];
      for (let at = Math.ceil(first / step) * step; at <= last; at += step) ticks.push({ value: (at - this.startClock) * CLOCK_STRETCH, label: clock(at) });
      return ticks;
    };
    const formatX = (minutes: number) => clockAfter(this.startClock, minutes);
    const shared = { plotHeight: 70, formatX, xTicks: timeTicks, ownTooltip: false, onHover: (index: number | null) => this.hover(index), onPick };
    this.charts = [
      new LineChart(grid, { ...shared, title: "Height of the ground, m", formatY: (v) => v.toFixed(0), area: true, tableHeaders: ["Time", "Height, m"] }),
      new LineChart(grid, { ...shared, title: "Minutes on foot back to camp", formatY: (v) => v.toFixed(0), includeZero: true, tableHeaders: ["Time", "Walk back, min"] }),
      new LineChart(grid, { ...shared, title: "Minutes to spare", formatY: (v) => v.toFixed(0), includeZero: true, tableHeaders: ["Time", "Spare, min"] }),
    ];
  }

  update(plan: Plan, startClockMin: number): void {
    this.plan = plan;
    this.startClock = startClockMin;
    const route = plan.route;
    const limit = plan.limit;
    this.limitLine.textContent =
      limit.limited_by === "daylight"
        ? `The crew must be back by ${limit.back_by_clock} to stay well ahead of sunset (${limit.sunset_clock}).`
        : `The crew must be back by ${limit.back_by_clock}, while the suits still have their reserve.`;

    clear(this.legs);
    for (const leg of route?.legs ?? []) {
      this.legs.append(
        h("tr", {}, h("td", {}, `${leg.from} → ${leg.to}`), h("td", {}, distance(leg.dist_m)), h("td", {}, duration(leg.walk_min)), h("td", {}, `${leg.ascent_m} / ${leg.descent_m} m`), h("td", {}, `${leg.max_slope_deg.toFixed(0)}°`)),
      );
    }

    if (!route) {
      this.section.value.textContent = "Add a place to visit first";
      this.doseLine.textContent = "";
      this.charts.forEach((chart) => chart.setData([], []));
      this.readout.textContent = "";
      return;
    }
    const t = route.totals;
    this.section.value.textContent = `${t.ascent_m} m uphill · charts along the route`;
    if (t.dose_usv !== null) {
      const days = t.dose_usv / EARTH_USV_PER_DAY;
      this.doseLine.textContent = `Radiation picked up: about ${t.dose_usv.toFixed(0)} µSv, the same as ${days < 1.5 ? "a day" : `${days.toFixed(0)} days`} of natural radiation on Earth.`;
    } else {
      this.doseLine.textContent = "";
    }

    // Time spent at stops, labelled with the stop number shown on the map.
    const profile = route.profile;
    const bands: Band[] = [];
    plan.stops.forEach((stop, index) => {
      if (stop.ok && stop.arrive_min !== undefined && stop.depart_min !== undefined && stop.depart_min > stop.arrive_min) {
        bands.push({ from: stop.arrive_min, to: stop.depart_min, label: String(index + 1) });
      }
    });
    const x = profile.elapsed_min;
    const warning = route.storm.warning_min;
    this.charts[0].setData(x, profile.elev_m, { bands });
    this.charts[1].setData(x, profile.return_min, { bands: bands.map((b) => ({ ...b, label: "" })), threshold: { value: warning, label: `storm warning ${warning} min`, danger: "above" } });
    this.charts[2].setData(x, profile.spare_min, { bands: bands.map((b) => ({ ...b, label: "" })), threshold: { value: 0, label: "out of time", danger: "below" } });
    this.describe(null);
  }

  /** Mark the crew position used by the storm test. */
  pin(index: number | null): void {
    this.charts.forEach((chart) => chart.setPinned(index));
  }

  private hover(index: number | null): void {
    this.charts.forEach((chart) => chart.setHover(index));
    this.describe(index);
    this.onHover(index);
  }

  private describe(index: number | null): void {
    const profile = this.plan?.route?.profile;
    if (!profile) return;
    if (index === null || index >= profile.elapsed_min.length) {
      this.readout.textContent = "Move over a chart to see where the crew is at that time. Grey bands are time at the numbered stops.";
      return;
    }
    this.readout.textContent = `${clockAfter(this.startClock, profile.elapsed_min[index])} · ${distance(profile.dist_m[index])} walked so far.`;
  }
}

// ---- layers and map key, on the map ---------------------------------------------------------------------

/** Builds the Layers control on the map. Returns a function that updates the storm row when the warning time changes. */
export function buildLayers(site: Site, map: MissionMap): (stormMinutes: number) => void {
  const line = (colour: string, dashed = false) => h("span", { class: `key-line${dashed ? " key-dashed" : ""}`, style: `--key:${colour}` });
  const text = (title: string, note: HTMLElement | null) => h("span", { class: "layer-text" }, title, note);
  const small = (note: string) => h("small", {}, note);
  const toggle = (name: LayerName, title: string, key: HTMLElement | null, note: HTMLElement | null = null) => {
    const input = h("input", { type: "checkbox" });
    input.checked = map.isLayerVisible(name);
    input.addEventListener("change", () => map.setLayerVisible(name, input.checked));
    return h("label", { class: "layer" }, input, key ?? h("span"), text(title, note));
  };
  const fixedRow = (key: HTMLElement, title: string) => h("div", { class: "layer" }, h("span"), key, text(title, null));

  const classes = site.slope_layer.classes_deg;
  const slopeKey = h("span", { class: "key-ramp" });
  site.slope_layer.colours.forEach((colour, i) => {
    if (i > 0) slopeKey.append(h("span", { style: `background:${colour}` })); // the first class is drawn transparent
  });
  const stormNote = h("small", {});
  const box = h(
    "details",
    { class: "map-key" },
    h("summary", { title: "Map layers and what the lines mean" }, icon("layers", 18), "Layers"),
    h(
      "div",
      { class: "map-key-body" },
      fixedRow(line(MAP_COLOURS.route), "Your route"),
      toggle("reach", "Turn-back line", line(MAP_COLOURS.turnBack), small("Go no farther: past it you can't get back in time")),
      toggle("storm", "Storm limit", line(MAP_COLOURS.storm, true), stormNote),
      toggle("slope", "Steep ground", slopeKey, small(`Yellow is steep (over ${classes[0]}°), purple is steepest`)),
      toggle("rover", "Curiosity's path and sites", h("span", { class: "key-site" }), small("Click a ◇ to visit it")),
      toggle("rings", "Walking-time rings", line(MAP_COLOURS.ring), small("Minutes on foot back to camp")),
      toggle("labels", "Place names", null),
      fixedRow(line(MAP_COLOURS.escape, true), "Fastest way back in a storm"),
    ),
  );
  map.addKey(box);
  return (minutes) => {
    stormNote.textContent = `Past it, shelter is more than ${minutes} min away`;
  };
}

// ---- place view: ground photos -------------------------------------------------------------------------

export class PhotosPanel {
  private readonly root = byId("view-place");

  private start(where: string): void {
    clear(this.root);
    const title = where.charAt(0).toUpperCase() + where.slice(1);
    this.root.append(
      h("button", { type: "button", class: "back-button", onclick: () => showView("walk") }, icon("back", 18), "Back to your walk"),
      h("h2", { class: "place-title" }, title),
    );
    showView("place");
    this.root.scrollTop = 0;
  }

  loading(where: string): void {
    this.start(where);
    this.root.append(h("p", { class: "hint" }, "Looking up the photos Curiosity took nearby…"));
  }

  show(where: string, result: PhotoResult): void {
    this.start(where);
    if (result.error) {
      this.root.append(h("p", { class: "problem" }, `${result.error}. Try again in a moment.`));
      return;
    }
    if (!result.photos.length || !result.stop) {
      this.root.append(h("p", { class: "hint" }, `Curiosity has no usable photos close to ${where}. The nearest place it stopped is ${distance(result.distance_m)} away.`));
      return;
    }
    const standing = result.distance_m < 5 ? "standing right here" : `standing ${distance(result.distance_m)} away`;
    this.root.append(h("p", { class: "photo-caption" }, `What Curiosity saw on Mars day ${result.stop.sol}, ${standing}. Each label says which way the camera faced.`));
    const grid = h("div", { class: "photo-grid" });
    for (const photo of result.photos) {
      grid.append(
        h(
          "a",
          { href: photo.url, target: "_blank", rel: "noopener", class: "photo", title: `${photo.camera}, sol ${photo.sol}, looking ${photo.compass} (${photo.azimuth}°)` },
          h("img", { src: photo.url, loading: "lazy", alt: `${photo.camera} view looking ${photo.compass} from Curiosity's stop on sol ${photo.sol}` }),
          h("span", {}, `Looking ${photo.compass}`),
        ),
      );
    }
    this.root.append(grid, h("p", { class: "hint" }, "Images: NASA/JPL-Caltech. Click one to open it full size."));
  }
}

// ---- how it works --------------------------------------------------------------------------------------

export function buildAbout(site: Site): void {
  const dialog = byId<HTMLDialogElement>("about");
  const v = site.validation;
  const body = h(
    "div",
    {},
    h("h2", {}, "How it works"),
    h("p", {}, `This is a planning screen for astronauts about to walk out from their rover on Mars, at ${site.name}. ${site.summary}`),
    h(
      "ol",
      {},
      h("li", {}, "Click the map to add places to visit. The planner finds the quickest route that avoids steep ground."),
      h("li", {}, "Read the verdict at the top of the panel. The turn-back line on the map shows how far the crew can go and still get back in time."),
      h("li", {}, "Open \"Walk settings\" to change when the crew leaves, how fast they walk and how long their suits last."),
      h("li", {}, "Open \"Day on Mars\" to pick a day. The planner loads the temperature, daylight and radiation Curiosity measured then."),
      h("li", {}, "Open \"Solar storm test\" to see if the crew could reach shelter from anywhere on the route."),
    ),
    h("p", {}, `Science goal: ${site.science_goal}`),
    h("h3", {}, "NASA data in this tool"),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Used for"), h("th", {}, "Dataset"), h("th", {}, "From"))),
      h("tbody", {}, ...site.sources.map((s) => h("tr", {}, h("td", {}, s.what), h("td", {}, h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.name)), h("td", {}, s.by)))),
    ),
    h("h3", {}, "The method in detail"),
    h("ul", {}, ...site.model_notes.map((note) => h("li", {}, note))),
    v
      ? h(
          "p",
          {},
          `Checked against the rover: at Curiosity's ${v.stops_compared} stops in this area the terrain grid differs from the rover's own elevation by ${Math.abs(v.elevation_difference_m.median).toFixed(2)} m on average, and grid slope there (median ${v.grid_slope_at_stops_deg.median}°) matches the tilt the rover recorded (median ${v.rover_tilt_deg.median}°).`,
        )
      : null,
    h("form", { method: "dialog" }, h("button", { class: "text-button" }, "Close")),
  );
  dialog.append(body);
  const button = byId("about-button");
  button.append(icon("help", 22));
  button.addEventListener("click", () => dialog.showModal());
}

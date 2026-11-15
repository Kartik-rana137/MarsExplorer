// A small single-series line chart in SVG: hairline grid, 2px line, crosshair with tooltip, keyboard
// stepping, an optional threshold with the part beyond it drawn in the "critical" status colour, and a
// table view of the same numbers. Colours come from CSS custom properties (see style.css).
import { clear, h, svg } from "./dom";
import { niceTicks } from "./format";

export interface Tick {
  value: number;
  label: string;
}

export interface Band {
  from: number;
  to: number;
  label: string;
}

export interface Threshold {
  value: number;
  label: string;
  /** Which side of the threshold is the problem side. */
  danger: "above" | "below";
}

export interface ChartOptions {
  /** Names what is plotted; with one series this replaces a legend. */
  title: string;
  plotHeight: number;
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  /** Format of y-axis tick labels; defaults to formatY. */
  formatTick?: (y: number) => string;
  /** Tick positions and labels for the x axis. */
  xTicks: (min: number, max: number) => Tick[];
  tableHeaders: [string, string];
  area?: boolean;
  includeZero?: boolean;
  /** Stacked charts that share one x axis hide it on all but the last. */
  showXAxis?: boolean;
  /** Show this chart's own tooltip. Grouped charts turn it off and share one. */
  ownTooltip?: boolean;
  onHover?: (index: number | null) => void;
  onPick?: (index: number) => void;
}

const MARGIN = { left: 46, right: 10, top: 6 };
const X_AXIS_BAND = 18;
const MAX_TABLE_ROWS = 24;

export class LineChart {
  readonly root: HTMLElement;
  private readonly options: ChartOptions;
  private readonly readout: HTMLElement;
  private readonly plot: SVGSVGElement;
  private readonly overlay: SVGGElement;
  private readonly tooltip: HTMLElement;
  private readonly tableBody: HTMLElement;
  private x: number[] = [];
  private y: number[] = [];
  private threshold: Threshold | null = null;
  private bands: Band[] = [];
  private pinned: number | null = null;
  private hover: number | null = null;
  private width = 320;
  private scaleX: (value: number) => number = () => 0;
  private scaleY: (value: number) => number = () => 0;

  constructor(parent: HTMLElement, options: ChartOptions) {
    this.options = options;
    this.readout = h("span", { class: "chart-readout" });
    this.plot = svg("svg", { class: "chart-plot", tabindex: 0, role: "img" });
    this.overlay = svg("g");
    this.tooltip = h("div", { class: "chart-tooltip", hidden: true });
    this.tableBody = h("tbody");
    const table = h(
      "details",
      { class: "chart-table" },
      h("summary", {}, "Table"),
      h(
        "div",
        { class: "table-scroll" },
        h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, options.tableHeaders[0]), h("th", {}, options.tableHeaders[1]))), this.tableBody),
      ),
    );
    this.root = h(
      "figure",
      { class: "chart" },
      h("figcaption", {}, h("span", { class: "chart-title" }, options.title), this.readout),
      h("div", { class: "chart-body" }, this.plot, this.tooltip),
      table,
    );
    parent.append(this.root);

    new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      if (width > 0 && width !== this.width) {
        this.width = width;
        this.render();
      }
    }).observe(this.root);

    this.plot.addEventListener("pointermove", (event) => this.setHoverFromPointer(event));
    this.plot.addEventListener("pointerleave", () => this.emitHover(null));
    this.plot.addEventListener("click", (event) => {
      const index = this.indexAt(event);
      if (index !== null) this.options.onPick?.(index);
    });
    this.plot.addEventListener("keydown", (event) => {
      if (!this.x.length) return;
      const current = this.hover ?? this.pinned ?? 0;
      if (event.key === "ArrowRight") this.emitHover(Math.min(this.x.length - 1, current + 1));
      else if (event.key === "ArrowLeft") this.emitHover(Math.max(0, current - 1));
      else if (event.key === "Enter" && this.hover !== null) this.options.onPick?.(this.hover);
      else if (event.key === "Escape") this.emitHover(null);
      else return;
      event.preventDefault();
    });
    this.plot.addEventListener("blur", () => this.emitHover(null));
  }

  setData(x: number[], y: number[], extras: { threshold?: Threshold | null; bands?: Band[] } = {}): void {
    this.x = x;
    this.y = y;
    this.threshold = extras.threshold ?? null;
    this.bands = extras.bands ?? [];
    this.hover = null;
    if (this.pinned !== null && this.pinned >= x.length) this.pinned = null;
    this.render();
    this.renderTable();
  }

  /** Mark one data point permanently (for example the selected sol or the crew's position). */
  setPinned(index: number | null): void {
    this.pinned = index;
    this.renderOverlay();
  }

  /** Show the crosshair at an index chosen elsewhere (a sibling chart or the map). */
  setHover(index: number | null): void {
    this.hover = index;
    this.renderOverlay();
  }

  private emitHover(index: number | null): void {
    if (index === this.hover) return;
    this.setHover(index);
    this.options.onHover?.(index);
  }

  private indexAt(event: MouseEvent): number | null {
    if (!this.x.length) return null;
    const box = this.plot.getBoundingClientRect();
    const px = event.clientX - box.left;
    const plotWidth = this.width - MARGIN.left - MARGIN.right;
    const fraction = Math.min(1, Math.max(0, (px - MARGIN.left) / plotWidth));
    const target = this.x[0] + fraction * (this.x[this.x.length - 1] - this.x[0]);
    let low = 0;
    let high = this.x.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.x[mid] < target) low = mid;
      else high = mid;
    }
    return target - this.x[low] <= this.x[high] - target ? low : high;
  }

  private setHoverFromPointer(event: PointerEvent): void {
    this.emitHover(this.indexAt(event));
  }

  private isDanger(value: number): boolean {
    if (!this.threshold) return false;
    return this.threshold.danger === "above" ? value > this.threshold.value : value < this.threshold.value;
  }

  private render(): void {
    const { plotHeight, showXAxis = true } = this.options;
    const height = MARGIN.top + plotHeight + (showXAxis ? X_AXIS_BAND : 4);
    clear(this.plot);
    this.plot.setAttribute("viewBox", `0 0 ${this.width} ${height}`);
    this.plot.setAttribute("width", String(this.width));
    this.plot.setAttribute("height", String(height));
    this.plot.setAttribute("aria-label", `${this.options.title}. Use the arrow keys to read values.`);
    if (this.x.length < 2) {
      this.plot.append(svg("text", { x: this.width / 2, y: height / 2, class: "chart-empty", "text-anchor": "middle" }, "No route yet"));
      this.readout.textContent = "";
      return;
    }

    const x0 = this.x[0];
    const x1 = this.x[this.x.length - 1];
    let yMin = Math.min(...this.y);
    let yMax = Math.max(...this.y);
    if (this.threshold) {
      yMin = Math.min(yMin, this.threshold.value);
      yMax = Math.max(yMax, this.threshold.value);
    }
    if (this.options.includeZero) {
      yMin = Math.min(yMin, 0);
      yMax = Math.max(yMax, 0);
    }
    if (yMax === yMin) yMax = yMin + 1;
    const pad = (yMax - yMin) * 0.08;
    const top = yMax + pad;
    const bottom = this.options.includeZero && yMin === 0 ? 0 : yMin - pad;
    const left = MARGIN.left;
    const right = this.width - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = MARGIN.top + plotHeight;
    this.scaleX = (value) => left + ((value - x0) / (x1 - x0)) * (right - left);
    this.scaleY = (value) => plotBottom - ((value - bottom) / (top - bottom)) * (plotBottom - plotTop);

    // Bands (time spent working at a stop) sit behind everything.
    for (const band of this.bands) {
      const a = this.scaleX(band.from);
      const b = this.scaleX(band.to);
      this.plot.append(svg("rect", { x: a, y: plotTop, width: Math.max(1, b - a), height: plotHeight, class: "chart-band" }));
      if (band.label && b - a > 26) {
        this.plot.append(svg("text", { x: a + 4, y: plotTop + 11, class: "chart-band-label" }, band.label));
      }
    }

    // Grid and y axis: solid hairlines with round numbers.
    for (const tick of niceTicks(bottom, top, 3)) {
      const y = this.scaleY(tick);
      this.plot.append(svg("line", { x1: left, x2: right, y1: y, y2: y, class: "chart-grid" }));
      this.plot.append(svg("text", { x: left - 6, y: y + 3.5, class: "chart-tick", "text-anchor": "end" }, (this.options.formatTick ?? this.options.formatY)(tick)));
    }
    if (showXAxis) {
      this.plot.append(svg("line", { x1: left, x2: right, y1: plotBottom, y2: plotBottom, class: "chart-axis" }));
      for (const tick of this.options.xTicks(x0, x1)) {
        const x = this.scaleX(tick.value);
        if (x < left - 0.5 || x > right + 0.5) continue;
        const anchor = x > right - 16 ? "end" : x < left + 16 ? "start" : "middle";
        this.plot.append(svg("text", { x, y: plotBottom + 13, class: "chart-tick", "text-anchor": anchor }, tick.label));
      }
    }

    // The series: optional soft area, then the line, then the part beyond the threshold in the status colour.
    const points = this.x.map((value, i) => `${this.scaleX(value).toFixed(1)},${this.scaleY(this.y[i]).toFixed(1)}`);
    if (this.options.area) {
      const base = this.scaleY(bottom).toFixed(1);
      this.plot.append(svg("path", { d: `M${this.scaleX(x0).toFixed(1)},${base} L${points.join(" L")} L${this.scaleX(x1).toFixed(1)},${base} Z`, class: "chart-area" }));
    }
    this.plot.append(svg("path", { d: `M${points.join(" L")}`, class: "chart-line" }));
    if (this.threshold) {
      let run: string[] = [];
      const flush = () => {
        if (run.length > 1) this.plot.append(svg("path", { d: `M${run.join(" L")}`, class: "chart-line chart-line-danger" }));
        run = [];
      };
      this.y.forEach((value, i) => (this.isDanger(value) ? run.push(points[i]) : flush()));
      flush();
      const y = this.scaleY(this.threshold.value);
      this.plot.append(svg("line", { x1: left, x2: right, y1: y, y2: y, class: "chart-threshold" }));
      const above = y - plotTop > 14;
      this.plot.append(svg("text", { x: right - 2, y: above ? y - 4 : y + 11, class: "chart-threshold-label", "text-anchor": "end" }, this.threshold.label));
    }

    this.plot.append(this.overlay);
    this.renderOverlay();
  }

  private renderOverlay(): void {
    clear(this.overlay);
    this.tooltip.hidden = true;
    if (this.x.length < 2) return;
    const plotTop = MARGIN.top;
    const plotBottom = MARGIN.top + this.options.plotHeight;
    const dot = (index: number, cls: string) =>
      svg("circle", { cx: this.scaleX(this.x[index]), cy: this.scaleY(this.y[index]), r: 4.5, class: cls });

    if (this.pinned !== null && this.pinned < this.x.length) {
      const x = this.scaleX(this.x[this.pinned]);
      this.overlay.append(svg("line", { x1: x, x2: x, y1: plotTop, y2: plotBottom, class: "chart-pin-line" }));
      this.overlay.append(dot(this.pinned, "chart-dot chart-dot-pinned"));
    }
    const shown = this.hover ?? this.pinned;
    if (shown !== null && shown < this.x.length) {
      this.readout.textContent = this.options.formatY(this.y[shown]);
      this.readout.classList.toggle("is-danger", this.isDanger(this.y[shown]));
    } else {
      this.readout.textContent = "";
    }
    if (this.hover === null || this.hover >= this.x.length) return;
    const x = this.scaleX(this.x[this.hover]);
    this.overlay.append(svg("line", { x1: x, x2: x, y1: plotTop, y2: plotBottom, class: "chart-crosshair" }));
    this.overlay.append(dot(this.hover, "chart-dot"));
    if (this.options.ownTooltip !== false) {
      clear(this.tooltip);
      this.tooltip.append(
        h("strong", {}, this.options.formatY(this.y[this.hover])),
        h("span", {}, this.options.formatX(this.x[this.hover])),
      );
      this.tooltip.hidden = false;
      const flip = x > this.width * 0.6;
      this.tooltip.style.left = flip ? "" : `${x + 10}px`;
      this.tooltip.style.right = flip ? `${this.width - x + 10}px` : "";
      this.tooltip.style.top = `${plotTop}px`;
    }
  }

  private renderTable(): void {
    clear(this.tableBody);
    const step = Math.max(1, Math.ceil(this.x.length / MAX_TABLE_ROWS));
    for (let i = 0; i < this.x.length; i += step) {
      this.tableBody.append(h("tr", {}, h("td", {}, this.options.formatX(this.x[i])), h("td", {}, this.options.formatY(this.y[i]))));
    }
  }
}

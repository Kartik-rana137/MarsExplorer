// The 3-D map (MapLibre GL): NASA imagery draped over a ground surface built from the backend's elevation
// tiles, with the backend's safety layers and the editable plan (base camp, stops) on top. It can be tilted
// and turned like a globe viewer. It only draws what the backend returns and reports user edits upward.
import { Map as GlMap, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource, IControl, ImageSource, LayerSpecification, LineLayerSpecification, LngLatLike, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// The map library does its heavy lifting (terrain, line geometry) in a background worker that lives in a
// separate file. The bundler cannot find that file by itself, so it is bundled here and its address handed over.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { backendUrl } from "./api";
import { h } from "./dom";
import type { LatLon, Plan, Site, StopInput, Target, TileLayerInfo } from "./types";

setWorkerUrl(workerUrl);

const MARS_RADIUS_M = 3_396_190;
const EARTH_RADIUS_M = 6_378_137;

/** Heights are drawn this much taller than life so low ridges are easy to see. */
export const RELIEF_STRETCH = 1.5;
// The map library assumes a planet the size of Earth, so every horizontal distance comes out larger than it is
// on Mars by the ratio of the radii. Heights are scaled by the same ratio to keep slopes true, then stretched.
const EXAGGERATION = (EARTH_RADIUS_M / MARS_RADIUS_M) * RELIEF_STRETCH;

/** The tilted view the map opens in, and returns to from the 3D button. */
const VIEW_3D = { pitch: 58, bearing: -18 };

// Map symbol colours, chosen to stand out against orange-brown Mars imagery.
export const MAP_COLOURS = {
  route: "#1a73e8",       // blue with a white edge, as in a consumer maps app; the white edge keeps it readable on Mars
  routeEdge: "#ffffff",
  casing: "#101010",
  storm: "#ff5fa2",
  turnBack: "#4dd9e8",
  ring: "#b7d3f6",
  rover: "#e6dfd2",
  escape: "#b8f35a",
} as const;

export type LayerName = "slope" | "reach" | "rings" | "storm" | "rover" | "labels";

/** Map layers (drawn on the ground) that each switch in the Layers list turns on and off. */
const LAYER_IDS: Record<LayerName, string[]> = {
  slope: ["slope"],
  reach: ["reach", "turnback-casing", "turnback"],
  rings: ["rings"],
  storm: ["storm-casing", "storm"],
  rover: ["rover-path"],
  labels: ["labels"],
};

export interface MapHandlers {
  /** Pixels of the map covered by floating interface on the left and top, so content is fitted beside it. */
  insets: () => { left: number; top: number };
  onAddStop: (lat: number, lon: number, name?: string) => void;
  onMoveCamp: (lat: number, lon: number) => void;
  onMoveStop: (index: number, lat: number, lon: number) => void;
  onRemoveStop: (index: number) => void;
  onPhotos: (lat: number, lon: number, label: string) => void;
}

type GeoData = Exclude<Parameters<GeoJSONSource["setData"]>[0], string>;

/** Backend paths as full addresses: map tiles are fetched from a background worker, which needs them absolute. */
function absolute(path: string): string {
  const url = backendUrl(path);
  return /^https?:\/\//.test(url) ? url : window.location.origin + url;
}

const lngLat = ([lat, lon]: LatLon): [number, number] => [lon, lat];

/** One or more lines as map data. The backend sends [lat, lon]; the map wants [lon, lat]. */
function lines(parts: LatLon[][]): GeoData {
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: parts.filter((part) => part.length > 1).map((part) => part.map(lngLat)) } };
}

// ---- markers ---------------------------------------------------------------------------------------------
// The map places a marker by setting a CSS transform on its outer element, so that element must carry no
// transform of its own. All styling, rotation and zoom scaling live on an inner ".pin-body" element.

const PIN_W = 30;
const PIN_H = 40;

function pin(width: number, height: number, body: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "pin";
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.innerHTML = body; // static markup and numbers only, never user text
  return element;
}

/** Teardrop location pin whose tip sits exactly on the point. `inner` is static markup or a number. */
function teardrop(kind: "camp" | "stop", inner: string): HTMLElement {
  const shape = `<svg class="pin-shape" viewBox="0 0 ${PIN_W} ${PIN_H}" width="${PIN_W}" height="${PIN_H}" aria-hidden="true"><path d="M15 39C15 39 3 25.5 3 15a12 12 0 0 1 24 0c0 10.5-12 24-12 24z"/></svg>`;
  return pin(PIN_W, PIN_H, `<div class="pin-body pin-tear pin-${kind}">${shape}<span class="pin-label">${inner}</span></div>`);
}

/** Round or diamond symbol centred on the point. */
function dot(kind: string, size: number, inner = ""): HTMLElement {
  return pin(size, size, `<div class="pin-body pin-dot pin-${kind}">${inner}</div>`);
}

/** A text label centred on a point. */
function textLabel(text: string, className: string): HTMLElement {
  const element = pin(0, 0, "");
  element.classList.add("pin-text");
  element.append(h("span", { class: `map-label ${className}` }, text));
  return element;
}

/** Symbols shrink when zoomed out so they don't swamp the map, and reach full size when zoomed in. */
function pinScale(zoom: number): number {
  return Math.min(1, Math.max(0.55, 0.55 + 0.15 * (zoom - 11)));
}

function campGlyph(): string {
  // A small shelter symbol; static markup, no user data.
  return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 19h18M5 19v-6a7 7 0 0 1 14 0v6M10 19v-4h4v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/** Wrap a plain element as a map control. */
function control(element: HTMLElement): IControl {
  element.classList.add("maplibregl-ctrl");
  return { onAdd: () => element, onRemove: () => element.remove() };
}

// ---- map style: sources and layers, bottom to top ----------------------------------------------------------

function rasterSource(info: TileLayerInfo): StyleSpecification["sources"][string] {
  const [[south, west], [north, east]] = info.bounds;
  return { type: "raster", tiles: [info.url], tileSize: 256, scheme: info.tms ? "tms" : "xyz", minzoom: info.min_zoom, maxzoom: info.max_native_zoom, bounds: [west, south, east, north], attribution: info.attribution };
}

function buildStyle(site: Site, visible: Record<LayerName, boolean>): StyleSpecification {
  const [[south, west], [north, east]] = site.bounds;
  const corners: [[number, number], [number, number], [number, number], [number, number]] = [[west, north], [east, north], [east, south], [west, south]];
  const empty: GeoData = { type: "FeatureCollection", features: [] };
  const shown = (name: LayerName) => (visible[name] ? "visible" : "none");
  const line = (id: string, source: string, colour: string, width: number, layer: LayerName | null, dash?: number[]): LineLayerSpecification => ({
    id,
    type: "line",
    source,
    layout: { "line-cap": dash ? "butt" : "round", "line-join": "round", visibility: layer ? shown(layer) : "visible" },
    paint: { "line-color": colour, "line-width": width, ...(dash ? { "line-dasharray": dash } : {}) },
  });
  // There is no terrain data outside the study area: dim it and draw the frame.
  const frame = [[west, south], [east, south], [east, north], [west, north], [west, south]];
  const far = [[west - 3, south - 3], [west - 3, north + 3], [east + 3, north + 3], [east + 3, south - 3], [west - 3, south - 3]];

  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": "#1c1512" } },
    { id: "context", type: "raster", source: "context", paint: { "raster-fade-duration": 0 } },
    { id: "basemap", type: "raster", source: "basemap", paint: { "raster-fade-duration": 0 } },
    { id: "slope", type: "raster", source: "slope", layout: { visibility: shown("slope") }, paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 } },
    { id: "reach", type: "raster", source: "reach", layout: { visibility: shown("reach") }, paint: { "raster-fade-duration": 0 } },
    { id: "outside", type: "fill", source: "outside", paint: { "fill-color": "#090c16", "fill-opacity": 0.53 } },
    line("frame", "frame", MAP_COLOURS.rover, 1, null, [3, 5]),
    { id: "labels", type: "raster", source: "labels", layout: { visibility: shown("labels") }, paint: { "raster-fade-duration": 0 } },
    line("rover-path", "rover-path", MAP_COLOURS.rover, 1.5, "rover", [1, 3]),
    line("rings", "rings", MAP_COLOURS.ring, 1.5, "rings"),
    line("turnback-casing", "turnback", MAP_COLOURS.casing, 6, "reach"),
    line("turnback", "turnback", MAP_COLOURS.turnBack, 3, "reach"),
    line("storm-casing", "storm", MAP_COLOURS.casing, 5, "storm"),
    line("storm", "storm", MAP_COLOURS.storm, 2.5, "storm", [3, 2.4]),
    line("route-edge", "route", MAP_COLOURS.routeEdge, 8.5, null),
    line("route", "route", MAP_COLOURS.route, 5, null),
    line("route-beyond", "route-beyond", MAP_COLOURS.storm, 5, null),
    line("escape-casing", "escape", MAP_COLOURS.casing, 6, null),
    line("escape", "escape", MAP_COLOURS.escape, 3, null, [1, 2]),
  ];

  return {
    version: 8,
    sources: {
      context: rasterSource(site.tiles.context),
      basemap: rasterSource(site.tiles.basemap),
      labels: rasterSource(site.tiles.labels),
      terrain: { type: "raster-dem", tiles: [absolute(site.terrain_tiles.url)], tileSize: 256, maxzoom: site.terrain_tiles.max_zoom, encoding: "mapbox" },
      slope: { type: "image", url: absolute(site.slope_layer.url), coordinates: corners },
      reach: { type: "image", url: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", coordinates: corners },
      outside: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [far, frame] } } },
      frame: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: frame } } },
      "rover-path": { type: "geojson", data: lines(site.rover.path) },
      rings: { type: "geojson", data: empty },
      turnback: { type: "geojson", data: empty },
      storm: { type: "geojson", data: empty },
      route: { type: "geojson", data: empty },
      "route-beyond": { type: "geojson", data: empty },
      escape: { type: "geojson", data: empty },
    },
    layers,
    terrain: { source: "terrain", exaggeration: EXAGGERATION },
    // A dusty Mars sky above the horizon, with haze where the ground meets it.
    sky: { "sky-color": "#b99a78", "horizon-color": "#e3cdb0", "fog-color": "#d6bd9e", "sky-horizon-blend": 0.7, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.35, "atmosphere-blend": 0 },
  };
}

export class MissionMap {
  private readonly map: GlMap;
  private readonly site: Site;
  private readonly handlers: MapHandlers;
  private readonly campMarker: Marker;
  private stopMarkers: Marker[] = [];
  private turnBackMarker: Marker | null = null;
  private cursor: Marker | null = null;
  private popup: Popup | null = null;
  private key: HTMLDetailsElement | null = null;
  private reachUrl: string | null = null;
  /** Markers that belong to a switchable layer: Curiosity's sites, and the labels on lines. */
  private readonly layerMarkers: Record<LayerName, Marker[]> = { slope: [], reach: [], rings: [], storm: [], rover: [], labels: [] };
  private readonly visible: Record<LayerName, boolean> = { slope: true, reach: true, rings: false, storm: true, rover: true, labels: false };
  // The map's drawing data loads a moment after the map is created; work that needs it waits here.
  private ready = false;
  private readonly waiting: (() => void)[] = [];

  constructor(element: HTMLElement, site: Site, handlers: MapHandlers) {
    this.site = site;
    this.handlers = handlers;
    const [[south, west], [north, east]] = site.bounds;
    const roomLon = (east - west) * 1.5;
    const roomLat = (north - south) * 1.5;
    this.map = new GlMap({
      container: element,
      style: buildStyle(site, this.visible),
      bounds: [[west, south], [east, north]],
      minZoom: 10,
      maxZoom: 19.5,
      maxPitch: 78,
      maxBounds: [[west - roomLon, south - roomLat], [east + roomLon, north + roomLat]],
      renderWorldCopies: false,
      attributionControl: { compact: false },
    });
    this.map.on("load", () => {
      this.ready = true;
      this.waiting.splice(0).forEach((work) => work());
    });
    // A missing imagery tile is normal at the edge of NASA's coverage; anything else is worth seeing.
    this.map.on("error", (event) => {
      const status = (event.error as { status?: number } | undefined)?.status;
      if (status !== 404) console.warn("map:", event.error?.message ?? event);
    });

    this.buildRoverMarkers();
    this.campMarker = this.draggable(teardrop("camp", campGlyph()), "Base camp (your rover and shelter): drag to move", 9, [site.default_camp.lon, site.default_camp.lat], {
      onDrop: (lat, lon) => this.handlers.onMoveCamp(lat, lon),
    });

    this.map.on("click", (event) => {
      // Only a click on the ground itself counts: markers handle their own clicks, and the map's buttons are not the map.
      if (event.originalEvent.target !== this.map.getCanvas()) return;
      this.closePopup();
      this.openPointMenu(event.lngLat.lat, event.lngLat.lng);
    });

    this.fit();
    this.map.addControl(control(this.buildScaleBar()), "bottom-right");
    this.map.addControl(new NavigationControl({ visualizePitch: true }), "bottom-right");
    this.map.addControl(control(this.buildTiltButton()), "bottom-right");
    this.showViewHint(element);

    const scalePins = () => element.style.setProperty("--pin-scale", pinScale(this.map.getZoom()).toFixed(3));
    this.map.on("zoom", scalePins);
    scalePins();
  }

  /** Run now if the map's drawing data is loaded, otherwise as soon as it is. */
  private whenReady(work: () => void): void {
    if (this.ready) work();
    else this.waiting.push(work);
  }

  private setLines(source: string, parts: LatLon[][]): void {
    this.whenReady(() => (this.map.getSource(source) as GeoJSONSource | undefined)?.setData(lines(parts)));
  }

  /** Open on the study area beside the panel, tilted, and a little closer in so the relief reads at once. */
  private fit(): void {
    const [[south, west], [north, east]] = this.site.bounds;
    this.map.setPadding(this.cover());
    this.map.fitBounds([[west, south], [east, north]], {
      padding: { left: 12, top: this.handlers.insets().top + 12, right: 56, bottom: 28 }, // on top of the cover above
      pitch: VIEW_3D.pitch,
      bearing: VIEW_3D.bearing,
      animate: false,
    });
    this.map.setZoom(this.map.getZoom() + 0.7);
  }

  /** The part of the map hidden under the panel. The view is centred, zoomed and turned about what is left. */
  private cover(): { left: number; top: number; right: number; bottom: number } {
    return { left: this.handlers.insets().left, top: 0, right: 0, bottom: 0 };
  }

  /** Call when the panel is shown, hidden or resized, so the view's centre follows the visible part of the map. */
  updateInsets(): void {
    this.map.easeTo({ padding: this.cover(), duration: 250 });
  }

  /** A marker that can be dragged to a new place, with an optional click action. */
  private draggable(element: HTMLElement, title: string, zIndex: number, position: LngLatLike, actions: { onDrop: (lat: number, lon: number) => void; onClick?: (marker: Marker) => void }): Marker {
    element.title = title;
    element.style.zIndex = String(zIndex);
    const marker = new Marker({ element, anchor: "bottom", draggable: true }).setLngLat(position).addTo(this.map);
    let dragged = false;
    marker.on("dragstart", () => {
      dragged = true;
      this.closePopup();
    });
    marker.on("dragend", () => {
      const at = marker.getLngLat();
      // Report after the browser has finished the mouse click that ends the drag.
      window.setTimeout(() => actions.onDrop(at.lat, at.lng), 0);
    });
    element.addEventListener("click", (event) => {
      event.stopPropagation(); // not a click on the map
      if (dragged) {
        dragged = false;
        return;
      }
      actions.onClick?.(marker);
    });
    return marker;
  }

  /** Put the Layers control on the map (top right). */
  addKey(element: HTMLDetailsElement): void {
    this.map.addControl(control(element), "top-right");
    this.key = element;
    element.addEventListener("toggle", () => this.closePopup()); // an open menu could end up underneath it
  }

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  /** Open a small menu at a point, then nudge the map if needed so it clears the panel, the chips and the key. */
  private openMenu(position: LngLatLike, content: HTMLElement, liftPx: number): void {
    this.closePopup();
    const popup = new Popup({ offset: liftPx, maxWidth: "280px", closeOnClick: false, focusAfterOpen: false }).setLngLat(position).setDOMContent(content).addTo(this.map);
    this.popup = popup;
    popup.on("close", () => {
      if (this.popup === popup) this.popup = null;
    });
    requestAnimationFrame(() => {
      const box = popup.getElement()?.getBoundingClientRect();
      if (!box || this.popup !== popup) return;
      const frame = this.map.getContainer().getBoundingClientRect();
      const inset = this.handlers.insets();
      const keyOpen = this.key !== null && this.key.open && frame.width > 700;
      const left = frame.left + inset.left + 8;
      const top = frame.top + inset.top + 8;
      const right = frame.right - (keyOpen ? this.key!.offsetWidth + 22 : 60);
      const bottom = frame.bottom - 8;
      const dx = box.left < left ? box.left - left : box.right > right ? box.right - right : 0;
      const dy = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
      if (dx !== 0 || dy !== 0) this.map.panBy([dx, dy], { duration: 250 });
    });
  }

  /** How far above its point a teardrop pin's head is at the current zoom. */
  private pinLift(): number {
    return Math.round((PIN_H - 6) * pinScale(this.map.getZoom()));
  }

  /** The map needs to be told when its container changes size. */
  invalidate(): void {
    this.map.resize();
  }

  setLayerVisible(name: LayerName, visible: boolean): void {
    this.visible[name] = visible;
    this.whenReady(() => {
      for (const id of LAYER_IDS[name]) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    });
    for (const marker of this.layerMarkers[name]) {
      if (visible) marker.addTo(this.map);
      else marker.remove();
    }
  }

  isLayerVisible(name: LayerName): boolean {
    return this.visible[name];
  }

  setCamp(lat: number, lon: number): void {
    this.campMarker.setLngLat([lon, lat]);
  }

  setStops(stops: StopInput[]): void {
    this.stopMarkers.forEach((marker) => marker.remove());
    this.stopMarkers = stops.map((stop, index) => {
      const name = stop.name || `Stop ${index + 1}`;
      return this.draggable(teardrop("stop", String(index + 1)), `${name}: drag to move`, 8, [stop.lon, stop.lat], {
        onDrop: (lat, lon) => this.handlers.onMoveStop(index, lat, lon),
        onClick: (marker) => {
          const menu = h(
            "div",
            { class: "map-menu" },
            h("strong", {}, `${index + 1}. ${name}`),
            h("button", { type: "button", onclick: () => { this.closePopup(); this.handlers.onPhotos(stop.lat, stop.lon, stop.name || `stop ${index + 1}`); } }, "See photos from here"),
            h("button", { type: "button", onclick: () => { this.closePopup(); this.handlers.onRemoveStop(index); } }, "Remove this stop"),
          );
          this.openMenu(marker.getLngLat(), menu, this.pinLift());
        },
      });
    });
  }

  /** Replace the markers of a switchable layer, showing them only if the layer is on. */
  private setLayerMarkers(name: LayerName, markers: Marker[]): void {
    this.layerMarkers[name].forEach((marker) => marker.remove());
    this.layerMarkers[name] = markers;
    if (this.visible[name]) markers.forEach((marker) => marker.addTo(this.map));
  }

  /** A text label at the middle of the longest of some lines. */
  private labelOn(parts: LatLon[][], text: string, className: string): Marker {
    const longest = parts.reduce((best, part) => (part.length > best.length ? part : best), parts[0]);
    const element = textLabel(text, className);
    element.style.zIndex = "3";
    return new Marker({ element, anchor: "center" }).setLngLat(lngLat(longest[Math.floor(longest.length / 2)]));
  }

  /** Draw everything the backend returned for a plan. */
  showPlan(plan: Plan): void {
    const envelope = plan.envelope;
    this.setCamp(plan.camp.lat, plan.camp.lon);

    // Safe-return shading and the turn-back line.
    if (envelope.overlay_url && envelope.overlay_url !== this.reachUrl) {
      const url = envelope.overlay_url;
      this.reachUrl = url;
      const [[south, west], [north, east]] = this.site.bounds;
      this.whenReady(() => (this.map.getSource("reach") as ImageSource | undefined)?.updateImage({ url: absolute(url), coordinates: [[west, north], [east, north], [east, south], [west, south]] }));
    }
    this.setLines("turnback", envelope.turn_back_line);
    this.setLayerMarkers("reach", envelope.turn_back_line.length ? [this.labelOn(envelope.turn_back_line, "turn-back line", "turnback-line-label")] : []);

    // Walk-back time rings with a label on the longest piece of each.
    const rings = envelope.rings.filter((ring) => ring.lines.length);
    this.setLines("rings", rings.flatMap((ring) => ring.lines));
    this.setLayerMarkers("rings", rings.map((ring) => this.labelOn(ring.lines, `${ring.minutes} min`, "ring-label")));
    const storm = envelope.storm_line;
    this.setLines("storm", storm.lines);
    this.setLayerMarkers("storm", storm.lines.length ? [this.labelOn(storm.lines, `storm limit · ${storm.minutes} min walk`, "storm-label")] : []);

    // The route, with the part beyond the storm limit marked.
    const route = plan.route;
    this.setLines("route", route ? [route.line] : []);
    this.setLines("route-beyond", route ? route.storm.beyond_lines : []);
    this.turnBackMarker?.remove();
    this.turnBackMarker = null;
    if (route?.turn_back) {
      const element = dot("turnback", 26, "!");
      element.classList.add("pin-noclick");
      element.style.zIndex = "10";
      element.append(h("span", { class: "turnback-label" }, `Turn back by ${route.turn_back.clock}`));
      this.turnBackMarker = new Marker({ element, anchor: "center" }).setLngLat([route.turn_back.lon, route.turn_back.lat]).addTo(this.map);
    }
  }

  /** Crew position on the route (moving over the charts, or the storm test). */
  setCursor(position: { lat: number; lon: number } | null): void {
    if (!position) {
      this.cursor?.remove();
      this.cursor = null;
      return;
    }
    if (!this.cursor) {
      const element = dot("crew", 18);
      element.classList.add("pin-noclick");
      element.style.zIndex = "11";
      this.cursor = new Marker({ element, anchor: "center" }).setLngLat([position.lon, position.lat]).addTo(this.map);
    } else {
      this.cursor.setLngLat([position.lon, position.lat]);
    }
  }

  /** Storm test: the fastest way back from where the crew is. */
  showEscape(line: LatLon[] | null): void {
    this.setLines("escape", line && line.length > 1 ? [line] : []);
  }

  private buildRoverMarkers(): void {
    const rover = this.site.rover;
    const markers = this.site.targets.map((target) => {
      const element = dot("site", 16);
      element.title = target.name;
      element.style.zIndex = "5";
      const marker = new Marker({ element, anchor: "center" }).setLngLat([target.lon, target.lat]);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openMenu(marker.getLngLat(), this.targetMenu(target), 8);
      });
      return marker;
    });
    const here = dot("rover", 16);
    here.title = "Curiosity rover is here today";
    here.classList.add("pin-noclick");
    here.style.zIndex = "5";
    markers.push(new Marker({ element: here, anchor: "center" }).setLngLat([rover.latest.lon, rover.latest.lat]));
    this.setLayerMarkers("rover", markers);
  }

  private targetMenu(target: Target): HTMLElement {
    const close = () => this.closePopup();
    return h(
      "div",
      { class: "map-menu" },
      h("strong", {}, target.name),
      h("p", {}, `${target.note} Curiosity studied this spot on Mars days (sols) ${target.sol} to ${target.until_sol}.`),
      target.source ? h("a", { href: target.source, target: "_blank", rel: "noopener" }, "Read NASA's blog post") : null,
      h("button", { type: "button", onclick: () => { close(); this.handlers.onAddStop(target.lat, target.lon, target.name); } }, "Add to my walk"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onPhotos(target.lat, target.lon, target.name); } }, "See photos from here"),
    );
  }

  private openPointMenu(lat: number, lon: number): void {
    const [[south, west], [north, east]] = this.site.bounds;
    if (lat <= south || lat >= north || lon <= west || lon >= east) return;
    const close = () => this.closePopup();
    const menu = h(
      "div",
      { class: "map-menu" },
      h("strong", {}, "This spot"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onAddStop(lat, lon); } }, "Add to my walk"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onMoveCamp(lat, lon); } }, "Move base camp here"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onPhotos(lat, lon, "this spot"); } }, "See photos near here"),
      h("small", {}, `${Math.abs(lat).toFixed(4)}° S, ${lon.toFixed(4)}° E`),
    );
    this.openMenu([lon, lat], menu, 0);
  }

  /** The map library's own scale bar assumes Earth; this one uses the radius of Mars. */
  private buildScaleBar(): HTMLElement {
    const bar = h("div", { class: "scale-bar" });
    const update = () => {
      const lat = this.map.getCenter().lat;
      const metresPerPixel = (2 * Math.PI * MARS_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, this.map.getZoom()));
      const target = metresPerPixel * 110;
      const power = Math.pow(10, Math.floor(Math.log10(target)));
      const length = [5, 2, 1].map((m) => m * power).find((m) => m <= target) ?? power;
      bar.style.width = `${length / metresPerPixel}px`;
      bar.textContent = length >= 1000 ? `${length / 1000} km` : `${length} m`;
    };
    this.map.on("move", update);
    update();
    return bar;
  }

  /** A button that switches between looking straight down (2D) and the tilted view (3D). */
  private buildTiltButton(): HTMLElement {
    const button = h("button", { type: "button", class: "tilt-button" });
    const tilted = () => this.map.getPitch() > 8;
    const update = () => {
      button.textContent = tilted() ? "2D" : "3D";
      button.title = tilted() ? "Look straight down, north up" : "Tilt the view to see the terrain in 3D";
      button.setAttribute("aria-label", button.title);
    };
    button.addEventListener("click", () => {
      this.map.easeTo(tilted() ? { pitch: 0, bearing: 0, duration: 900 } : { ...VIEW_3D, duration: 900 });
    });
    this.map.on("pitch", update);
    update();
    return h("div", { class: "maplibregl-ctrl-group" }, button);
  }

  /** A short note on how to tilt and turn the view. It goes away once the view has been turned, or after a while. */
  private showViewHint(container: HTMLElement): void {
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const hint = h("div", { class: "view-hint" }, touch ? "Drag with two fingers to tilt and turn the view" : "Right-drag, or hold Ctrl and drag, to tilt and turn the view");
    container.append(hint);
    const dismiss = () => hint.remove();
    this.map.once("rotatestart", dismiss);
    this.map.once("pitchstart", dismiss);
    window.setTimeout(dismiss, 14000);
  }
}

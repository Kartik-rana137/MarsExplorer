// The Leaflet map: NASA imagery, the backend's terrain and safety layers, and the editable plan
// (base camp, science stops). It only draws what the backend returns and reports user edits upward.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { backendUrl } from "./api";
import { h } from "./dom";
import type { LatLon, Plan, Site, StopInput, Target, TileLayerInfo } from "./types";

const MARS_RADIUS_M = 3_396_190;

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

// ---- markers ---------------------------------------------------------------------------------------------
// Leaflet positions a marker by setting a CSS transform on its outer element, so that element must carry no
// transform of its own. All styling, rotation and zoom scaling live on an inner ".pin-body" element.

const PIN_W = 30;
const PIN_H = 40;

/** Teardrop location pin whose tip sits exactly on the point. `inner` is static markup or a number. */
function teardrop(kind: "camp" | "stop", inner: string): L.DivIcon {
  const shape = `<svg class="pin-shape" viewBox="0 0 ${PIN_W} ${PIN_H}" width="${PIN_W}" height="${PIN_H}" aria-hidden="true"><path d="M15 39C15 39 3 25.5 3 15a12 12 0 0 1 24 0c0 10.5-12 24-12 24z"/></svg>`;
  return L.divIcon({
    className: "pin",
    html: `<div class="pin-body pin-tear pin-${kind}">${shape}<span class="pin-label">${inner}</span></div>`,
    iconSize: [PIN_W, PIN_H],
    iconAnchor: [PIN_W / 2, PIN_H - 1],
  });
}

/** Round or diamond symbol centred on the point. */
function dot(kind: string, size: number, inner = ""): L.DivIcon {
  return L.divIcon({
    className: "pin",
    html: `<div class="pin-body pin-dot pin-${kind}">${inner}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Symbols shrink when zoomed out so they don't swamp the map, and reach full size from zoom 15. */
function pinScale(zoom: number): number {
  return Math.min(1, Math.max(0.55, 0.55 + 0.15 * (zoom - 12)));
}

export type LayerName = "slope" | "reach" | "rings" | "storm" | "rover" | "labels";

export interface MapHandlers {
  /** Pixels of the map covered by floating interface on the left and top, so content is fitted beside it. */
  insets: () => { left: number; top: number };
  onAddStop: (lat: number, lon: number, name?: string) => void;
  onMoveCamp: (lat: number, lon: number) => void;
  onMoveStop: (index: number, lat: number, lon: number) => void;
  onRemoveStop: (index: number) => void;
  onPhotos: (lat: number, lon: number, label: string) => void;
}

function tileLayer(info: TileLayerInfo, pane?: string): L.TileLayer {
  return L.tileLayer(info.url, {
    tms: info.tms,
    minZoom: info.min_zoom,
    maxNativeZoom: info.max_native_zoom,
    maxZoom: 21,
    bounds: info.bounds,
    attribution: info.attribution,
    ...(pane ? { pane } : {}),
  });
}

function cased(points: LatLon[] | LatLon[][], colour: string, weight: number, extra: L.PolylineOptions = {}): L.Layer {
  return L.layerGroup([
    L.polyline(points, { color: MAP_COLOURS.casing, weight: weight + 3, opacity: 0.55, interactive: false, lineCap: "round", lineJoin: "round" }),
    L.polyline(points, { color: colour, weight, interactive: false, lineCap: "round", lineJoin: "round", ...extra }),
  ]);
}

export class MissionMap {
  private readonly map: L.Map;
  private readonly site: Site;
  private readonly handlers: MapHandlers;
  private readonly layers: Record<LayerName, L.Layer>;
  private readonly reachOverlay: L.ImageOverlay;
  private readonly rings = L.layerGroup();
  private readonly stormLine = L.layerGroup();
  private readonly turnBackLine = L.layerGroup();
  private readonly routeLayer = L.layerGroup();
  private readonly stopLayer = L.layerGroup();
  private readonly drillLayer = L.layerGroup();
  private readonly campMarker: L.Marker;
  private cursor: L.Marker | null = null;
  private key: HTMLDetailsElement | null = null;
  private reachUrl: string | null = null;
  private readonly visible: Record<LayerName, boolean> = { slope: true, reach: true, rings: false, storm: true, rover: true, labels: false };

  constructor(element: HTMLElement, site: Site, handlers: MapHandlers) {
    this.site = site;
    this.handlers = handlers;
    const bounds = L.latLngBounds(site.bounds);
    this.map = L.map(element, {
      minZoom: 11,
      maxZoom: 20,
      zoomSnap: 0.25,
      maxBounds: bounds.pad(0.9),
      attributionControl: true,
      zoomControl: false, // added below, bottom right
    });
    this.map.attributionControl.setPrefix(false);
    for (const [name, z] of [["slope", 350], ["reach", 360], ["labels", 370]] as const) {
      this.map.createPane(name).style.zIndex = String(z);
      this.map.getPane(name)!.style.pointerEvents = "none";
    }

    tileLayer(site.tiles.context).addTo(this.map);
    tileLayer(site.tiles.basemap).addTo(this.map);
    const slope = L.imageOverlay(backendUrl(site.slope_layer.url), site.slope_layer.bounds, { pane: "slope", opacity: 0.75 });
    this.reachOverlay = L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", site.bounds, { pane: "reach" });
    this.layers = {
      slope,
      reach: L.layerGroup([this.reachOverlay, this.turnBackLine]),
      rings: this.rings,
      storm: this.stormLine,
      rover: this.buildRoverLayer(),
      labels: tileLayer(site.tiles.labels, "labels"),
    };
    for (const name of Object.keys(this.layers) as LayerName[]) {
      if (this.visible[name]) this.layers[name].addTo(this.map);
    }
    // There is no terrain data outside the study area: dim it and draw the frame.
    const [[south, west], [north, east]] = site.bounds;
    const world: LatLon[] = [[-85, -179], [85, -179], [85, 179], [-85, 179]];
    const frame: LatLon[] = [[south, west], [south, east], [north, east], [north, west]];
    L.polygon([world, frame], { pane: "reach", stroke: false, fillColor: "#090c16", fillOpacity: 0.53, interactive: false }).addTo(this.map);
    L.rectangle(site.bounds, { pane: "reach", color: MAP_COLOURS.rover, weight: 1, opacity: 0.55, fill: false, dashArray: "3 5", interactive: false }).addTo(this.map);
    this.routeLayer.addTo(this.map);
    this.drillLayer.addTo(this.map);
    this.stopLayer.addTo(this.map);

    this.campMarker = L.marker([site.default_camp.lat, site.default_camp.lon], {
      draggable: true,
      zIndexOffset: 900,
      title: "Base camp (your rover and shelter): drag to move",
      icon: teardrop("camp", campGlyph()),
    }).addTo(this.map);
    this.campMarker.on("dragend", () => {
      const position = this.campMarker.getLatLng();
      this.handlers.onMoveCamp(position.lat, position.lng);
    });

    this.map.on("click", (event: L.LeafletMouseEvent) => this.openPointMenu(event.latlng));
    const inset = handlers.insets();
    this.map.fitBounds(bounds, { paddingTopLeft: [inset.left + 12, inset.top + 12], paddingBottomRight: [56, 28] });
    this.addScaleBar(); // needs the view to be set first
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    const scalePins = (zoom: number) => element.style.setProperty("--pin-scale", pinScale(zoom).toFixed(3));
    this.map.on("zoomanim", (event: L.ZoomAnimEvent) => scalePins(event.zoom));
    this.map.on("zoomend", () => scalePins(this.map.getZoom()));
    scalePins(this.map.getZoom());
  }

  /** Put the map key on the map (top right) without letting clicks on it reach the map. */
  addKey(element: HTMLDetailsElement): void {
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
    const control = new L.Control({ position: "topright" });
    control.onAdd = () => element;
    control.addTo(this.map);
    this.key = element;
  }

  /** Open a small menu at a point. The map pans if needed so the menu clears the panel, the chips and the key. */
  private openMenu(position: L.LatLngExpression, content: HTMLElement, liftPx: number): void {
    const keyOpen = this.key !== null && this.key.open && this.map.getSize().x > 700;
    const inset = this.handlers.insets();
    L.popup({
      maxWidth: 260,
      offset: [0, -liftPx],
      autoPanPaddingTopLeft: [inset.left + 8, inset.top + 8],
      autoPanPaddingBottomRight: [keyOpen ? this.key!.offsetWidth + 22 : 56, 8],
    })
      .setLatLng(position)
      .setContent(content)
      .openOn(this.map);
  }

  /** How far above its point a teardrop pin's head is at the current zoom. */
  private pinLift(): number {
    return Math.round((PIN_H - 6) * pinScale(this.map.getZoom()));
  }

  /** Leaflet needs to be told when its container changes size. */
  invalidate(): void {
    this.map.invalidateSize();
  }

  setLayerVisible(name: LayerName, visible: boolean): void {
    this.visible[name] = visible;
    if (visible) this.layers[name].addTo(this.map);
    else this.layers[name].remove();
  }

  isLayerVisible(name: LayerName): boolean {
    return this.visible[name];
  }

  setCamp(lat: number, lon: number): void {
    this.campMarker.setLatLng([lat, lon]);
  }

  setStops(stops: StopInput[]): void {
    this.stopLayer.clearLayers();
    stops.forEach((stop, index) => {
      const marker = L.marker([stop.lat, stop.lon], {
        draggable: true,
        zIndexOffset: 800,
        title: `${stop.name || `Stop ${index + 1}`}: drag to move`,
        icon: teardrop("stop", String(index + 1)),
      });
      marker.on("dragend", () => {
        const position = marker.getLatLng();
        this.handlers.onMoveStop(index, position.lat, position.lng);
      });
      marker.on("click", () => {
        const menu = h(
          "div",
          { class: "map-menu" },
          h("strong", {}, `${index + 1}. ${stop.name || `Stop ${index + 1}`}`),
          h("button", { type: "button", onclick: () => { this.map.closePopup(); this.handlers.onPhotos(stop.lat, stop.lon, stop.name || `stop ${index + 1}`); } }, "See photos from here"),
          h("button", { type: "button", onclick: () => { this.map.closePopup(); this.handlers.onRemoveStop(index); } }, "Remove this stop"),
        );
        this.openMenu(marker.getLatLng(), menu, this.pinLift());
      });
      marker.addTo(this.stopLayer);
    });
  }

  /** Draw everything the backend returned for a plan. */
  showPlan(plan: Plan): void {
    const envelope = plan.envelope;
    this.setCamp(plan.camp.lat, plan.camp.lon);

    // Safe-return shading and the turn-back line.
    if (envelope.overlay_url && envelope.overlay_url !== this.reachUrl) {
      this.reachUrl = envelope.overlay_url;
      this.reachOverlay.setUrl(backendUrl(envelope.overlay_url));
    }
    this.turnBackLine.clearLayers();
    if (envelope.turn_back_line.length) {
      cased(envelope.turn_back_line, MAP_COLOURS.turnBack, 3).addTo(this.turnBackLine);
      this.labelLine(envelope.turn_back_line, "turn-back line", "turnback-line-label").addTo(this.turnBackLine);
    }

    // Walk-back time rings with a label on the longest piece of each.
    this.rings.clearLayers();
    for (const ring of envelope.rings) {
      if (!ring.lines.length) continue;
      L.polyline(ring.lines, { color: MAP_COLOURS.ring, weight: 1.5, opacity: 0.9, interactive: false }).addTo(this.rings);
      this.labelLine(ring.lines, `${ring.minutes} min`, "ring-label").addTo(this.rings);
    }
    this.stormLine.clearLayers();
    if (envelope.storm_line.lines.length) {
      cased(envelope.storm_line.lines, MAP_COLOURS.storm, 2, { dashArray: "7 6" }).addTo(this.stormLine);
      this.labelLine(envelope.storm_line.lines, `storm limit · ${envelope.storm_line.minutes} min walk`, "ring-label storm-label").addTo(this.stormLine);
    }

    // The route, with the part beyond the storm line marked.
    this.routeLayer.clearLayers();
    const route = plan.route;
    if (route) {
      const round = { interactive: false, lineCap: "round", lineJoin: "round" } as const;
      L.polyline(route.line, { ...round, color: MAP_COLOURS.routeEdge, weight: 8.5 }).addTo(this.routeLayer);
      L.polyline(route.line, { ...round, color: MAP_COLOURS.route, weight: 5 }).addTo(this.routeLayer);
      if (route.storm.beyond_lines.length) {
        L.polyline(route.storm.beyond_lines, { ...round, color: MAP_COLOURS.storm, weight: 5 }).addTo(this.routeLayer);
      }
      if (route.turn_back) {
        L.marker([route.turn_back.lat, route.turn_back.lon], {
          zIndexOffset: 950,
          interactive: true,
          icon: dot("turnback", 26, "!"),
        })
          .bindTooltip(`Turn back by ${route.turn_back.clock}`, { permanent: true, direction: "right", offset: [12, 0], className: "turnback-label" })
          .addTo(this.routeLayer);
      }
    }
  }

  /** Crew position on the route (hover on the profile, or the storm drill). */
  setCursor(position: { lat: number; lon: number } | null): void {
    if (!position) {
      this.cursor?.remove();
      this.cursor = null;
      return;
    }
    if (!this.cursor) {
      this.cursor = L.marker([position.lat, position.lon], {
        interactive: false,
        zIndexOffset: 1000,
        icon: dot("crew", 18),
      }).addTo(this.map);
    } else {
      this.cursor.setLatLng([position.lat, position.lon]);
    }
  }

  /** Storm drill: the fastest way back from where the crew is. */
  showEscape(line: LatLon[] | null): void {
    this.drillLayer.clearLayers();
    if (line && line.length > 1) cased(line, MAP_COLOURS.escape, 3, { dashArray: "2 7" }).addTo(this.drillLayer);
  }

  private labelLine(lines: LatLon[][], text: string, className: string): L.Layer {
    const longest = lines.reduce((best, line) => (line.length > best.length ? line : best), lines[0]);
    const anchor = longest[Math.floor(longest.length / 2)];
    const label = h("span", { class: `map-label ${className}` }, text);
    return L.marker(anchor, { interactive: false, icon: L.divIcon({ className: "pin", html: label, iconSize: [0, 0] }) });
  }

  private buildRoverLayer(): L.Layer {
    const group = L.layerGroup();
    const rover = this.site.rover;
    L.polyline(rover.path, { color: MAP_COLOURS.rover, weight: 1.5, opacity: 0.7, dashArray: "1 5", interactive: false }).addTo(group);
    for (const target of this.site.targets) {
      const marker = L.marker([target.lat, target.lon], {
        title: target.name,
        zIndexOffset: 500,
        icon: dot("site", 16),
      });
      marker.on("click", () => this.openMenu(marker.getLatLng(), this.targetMenu(target), 8));
      marker.addTo(group);
    }
    L.marker([rover.latest.lat, rover.latest.lon], {
      title: `Curiosity, sol ${rover.latest.sol}`,
      zIndexOffset: 520,
      icon: dot("rover", 16),
    })
      .bindTooltip("Curiosity rover is here today", { direction: "top", offset: [0, -8] })
      .addTo(group);
    return group;
  }

  private targetMenu(target: Target): HTMLElement {
    const close = () => this.map.closePopup();
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

  private openPointMenu(position: L.LatLng): void {
    const [[south, west], [north, east]] = this.site.bounds;
    if (position.lat <= south || position.lat >= north || position.lng <= west || position.lng >= east) return;
    const close = () => this.map.closePopup();
    const menu = h(
      "div",
      { class: "map-menu" },
      h("strong", {}, "This spot"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onAddStop(position.lat, position.lng); } }, "Add to my walk"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onMoveCamp(position.lat, position.lng); } }, "Move base camp here"),
      h("button", { type: "button", onclick: () => { close(); this.handlers.onPhotos(position.lat, position.lng, "this spot"); } }, "See photos near here"),
      h("small", {}, `${Math.abs(position.lat).toFixed(4)}° S, ${position.lng.toFixed(4)}° E`),
    );
    this.openMenu(position, menu, 0);
  }

  /** Leaflet's own scale bar assumes Earth; this one uses the radius of Mars. */
  private addScaleBar(): void {
    const bar = h("div", { class: "scale-bar" });
    const control = new L.Control({ position: "bottomright" });
    control.onAdd = () => bar;
    control.addTo(this.map);
    const update = () => {
      const lat = this.map.getCenter().lat;
      const metresPerPixel = (2 * Math.PI * MARS_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, this.map.getZoom()));
      const target = metresPerPixel * 110;
      const power = Math.pow(10, Math.floor(Math.log10(target)));
      const length = [5, 2, 1].map((m) => m * power).find((m) => m <= target) ?? power;
      bar.style.width = `${length / metresPerPixel}px`;
      bar.textContent = length >= 1000 ? `${length / 1000} km` : `${length} m`;
    };
    this.map.on("zoomend moveend", update);
    update();
  }
}

function campGlyph(): string {
  // A small shelter symbol; static markup, no user data.
  return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 19h18M5 19v-6a7 7 0 0 1 14 0v6M10 19v-4h4v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

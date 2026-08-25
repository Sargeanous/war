/*
 * tactical.ts - tactical map graphics helpers for a Leaflet-based
 * operational map. Every function receives the Leaflet namespace as
 * "L: any" (Leaflet is loaded from a CDN as window.L).
 */

import { affiliationOf, frameColor } from "./milsym";

export interface LatLngLike {
  lat: number;
  lng: number;
}

// Recreated SVG paths restart their CSS animation at phase 0; anchoring the
// delay to wall-clock time keeps dashes/pulses continuous across overlay
// rebuilds (the map redraws its overlay every poll tick).
function anchorAnimation(layer: any, periodMs: number): void {
  const el = layer.getElement && layer.getElement();
  if (el && el.style) el.style.animationDelay = "-" + (Date.now() % periodMs) + "ms";
}

/* ------------------------------------------------------------------ */
/* Graticule                                                           */
/* ------------------------------------------------------------------ */

const GRAT_LINE_COLOR = "rgba(148,190,210,0.22)";

function fmtDegLabel(value: number, posSuffix: string, negSuffix: string): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const txt = Number.isInteger(abs) ? String(abs) : String(Math.round(abs * 100) / 100);
  return txt + (value > 0 ? posSuffix : negSuffix);
}

/**
 * Adds a lat/lng graticule to the map with small edge labels.
 * Creates dedicated panes so lines sit under markers and labels sit
 * just above the lines. Labels are viewport-limited and refreshed on
 * "moveend" and "zoomend". Returns { layer, destroy() }.
 */
export function addGraticule(L: any, map: any, intervalDeg?: number): any {
  const interval = intervalDeg && intervalDeg > 0 ? intervalDeg : 1;

  if (!map.getPane("graticulePane")) {
    const pane = map.createPane("graticulePane");
    pane.style.zIndex = "330";
    pane.style.pointerEvents = "none";
  }
  if (!map.getPane("graticuleLabelPane")) {
    const pane = map.createPane("graticuleLabelPane");
    pane.style.zIndex = "332";
    pane.style.pointerEvents = "none";
  }

  const lineLayer = L.layerGroup();
  const labelLayer = L.layerGroup();
  lineLayer.addTo(map);
  labelLayer.addTo(map);

  const snap = (v: number) => Math.ceil(v / interval) * interval;

  // Extent the lines currently cover; onMove redraws when the view leaves it.
  let coverage: { south: number; north: number; west: number; east: number } | null = null;

  function drawLines(): void {
    lineLayer.clearLayers();
    const bounds = map.getBounds();
    const pad = 3;
    const south = Math.max(-90, bounds.getSouth() - pad);
    const north = Math.min(90, bounds.getNorth() + pad);
    const west = bounds.getWest() - pad;
    const east = bounds.getEast() + pad;
    coverage = { south, north, west, east };

    const lineOpts = {
      color: GRAT_LINE_COLOR,
      weight: 1,
      interactive: false,
      pane: "graticulePane",
    };

    for (let lat = snap(south); lat <= north; lat += interval) {
      lineLayer.addLayer(
        L.polyline(
          [
            { lat: lat, lng: west },
            { lat: lat, lng: east },
          ],
          lineOpts
        )
      );
    }
    for (let lng = snap(west); lng <= east; lng += interval) {
      lineLayer.addLayer(
        L.polyline(
          [
            { lat: south, lng: lng },
            { lat: north, lng: lng },
          ],
          lineOpts
        )
      );
    }
  }

  function makeLabel(lat: number, lng: number, text: string): any {
    return L.marker(
      { lat: lat, lng: lng },
      {
        icon: L.divIcon({
          className: "grat-label",
          html: text,
          iconSize: null,
        }),
        pane: "graticuleLabelPane",
        interactive: false,
        keyboard: false,
      }
    );
  }

  function refreshLabels(): void {
    labelLayer.clearLayers();
    const view = map.getBounds();
    const south = view.getSouth();
    const north = view.getNorth();
    const west = view.getWest();
    const east = view.getEast();
    const spanLat = north - south;
    const spanLng = east - west;

    // Latitude labels hug the west edge of the current view.
    const labelLng = west + spanLng * 0.012;
    for (let lat = snap(south); lat <= north; lat += interval) {
      labelLayer.addLayer(makeLabel(lat, labelLng, fmtDegLabel(lat, "N", "S")));
    }

    // Longitude labels hug the north edge of the current view.
    const labelLat = north - spanLat * 0.03;
    for (let lng = snap(west); lng <= east; lng += interval) {
      labelLayer.addLayer(makeLabel(labelLat, lng, fmtDegLabel(lng, "E", "W")));
    }
  }

  function onMove(): void {
    const view = map.getBounds();
    const out =
      !coverage ||
      view.getSouth() < coverage.south + 0.5 ||
      view.getNorth() > coverage.north - 0.5 ||
      view.getWest() < coverage.west + 0.5 ||
      view.getEast() > coverage.east - 0.5;
    if (out) drawLines();
    refreshLabels();
  }

  drawLines();
  refreshLabels();
  map.on("moveend", onMove);
  map.on("zoomend", onMove);

  return {
    layer: lineLayer,
    destroy: function (): void {
      map.off("moveend", onMove);
      map.off("zoomend", onMove);
      lineLayer.clearLayers();
      labelLayer.clearLayers();
      map.removeLayer(lineLayer);
      map.removeLayer(labelLayer);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Engagements                                                         */
/* ------------------------------------------------------------------ */

/**
 * Draws fire lines and impact markers for engagement events onto the
 * provided layer group. Non-engagement events, events without a
 * position, and events whose actor has no known position are skipped.
 */
export function drawEngagements(
  L: any,
  layer: any,
  events: Array<{
    id: string;
    type: string;
    actorId?: string;
    targetId?: string;
    position?: LatLngLike;
  }>,
  unitPositions: Record<string, LatLngLike>
): void {
  for (const ev of events) {
    if (ev.type !== "engagement") continue;
    if (!ev.position) continue;
    if (!ev.actorId) continue;
    const from = unitPositions[ev.actorId];
    if (!from) continue;

    const line = L.polyline([from, ev.position], {
      className: "tac-fire-line",
      color: "#ff8a5c",
      weight: 1.5,
      opacity: 0.85,
      dashArray: "6 6",
      interactive: false,
    });
    layer.addLayer(line);
    anchorAnimation(line, 1200);
    const impact = L.circleMarker(ev.position, {
      radius: 7,
      className: "tac-impact",
      color: "#ff8a5c",
      weight: 2,
      fillOpacity: 0.12,
      interactive: false,
    });
    layer.addLayer(impact);
    anchorAnimation(impact, 1400);
  }
}

/* ------------------------------------------------------------------ */
/* Heading vectors                                                     */
/* ------------------------------------------------------------------ */

const HEADING_LENGTH_KM: Record<string, number> = {
  air: 14,
  sea: 8,
  land: 3,
};

/**
 * Draws a short heading vector from a unit position. Length defaults
 * by domain (air 14 km, sea 8 km, land 3 km, otherwise 6 km).
 */
export function drawHeadingVector(
  L: any,
  layer: any,
  unit: { position: LatLngLike; headingDeg: number; side: string; domain?: string },
  lengthKm?: number
): void {
  const domainDefault =
    unit.domain && HEADING_LENGTH_KM[unit.domain] !== undefined
      ? HEADING_LENGTH_KM[unit.domain]
      : 6;
  const lenKm = lengthKm !== undefined ? lengthKm : domainDefault;

  const lat = unit.position.lat;
  const theta = (unit.headingDeg * Math.PI) / 180;
  const dLat = (lenKm / 111) * Math.cos(theta);
  const dLng = (lenKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(theta);

  const end: LatLngLike = { lat: lat + dLat, lng: unit.position.lng + dLng };

  const color = frameColor(affiliationOf(unit.side));

  layer.addLayer(
    L.polyline([unit.position, end], {
      className: "tac-heading",
      color: color,
      weight: 1.5,
      opacity: 0.65,
      interactive: false,
    })
  );
}

/* ------------------------------------------------------------------ */
/* Objectives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Draws an objective area as a dashed circle colored by side, with an
 * "OBJ <TITLE>" label pinned to the top edge of the circle. Objectives
 * without an area are ignored.
 */
export function drawObjective(
  L: any,
  layer: any,
  objective: {
    id: string;
    side: string;
    title: string;
    area?: { center: LatLngLike; radiusKm: number };
  }
): void {
  if (!objective.area) return;
  const area = objective.area;

  const color =
    objective.side === "blue" || objective.side === "red"
      ? frameColor(affiliationOf(objective.side))
      : "#d9c26a";

  layer.addLayer(
    L.circle(area.center, {
      radius: area.radiusKm * 1000,
      color: color,
      weight: 1.5,
      dashArray: "10 8",
      fillOpacity: 0.04,
      interactive: false,
    })
  );

  const labelText = "OBJ " + objective.title.toUpperCase().slice(0, 22);
  // Leaflet overwrites the icon root's inline transform to position the marker,
  // so the centering transform must live on an inner element.
  layer.addLayer(
    L.marker(
      { lat: area.center.lat + area.radiusKm / 111, lng: area.center.lng },
      {
        icon: L.divIcon({
          className: "tac-obj-label",
          html: '<span class="tac-obj-label-inner">' + labelText + "</span>",
          iconSize: null,
        }),
        interactive: false,
        keyboard: false,
      }
    )
  );
}

/* ------------------------------------------------------------------ */
/* Environment tint                                                    */
/* ------------------------------------------------------------------ */

/**
 * Returns the CSS class applied to the map container for the current
 * weather/daylight state, or "" when no tint is needed.
 */
export function tintClass(weather: string | undefined, daylight: boolean): string {
  if (weather === "storm") return "map-tint-storm";
  if (!daylight) return "map-tint-night";
  return "";
}

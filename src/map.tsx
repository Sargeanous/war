// TheaterMap, the shared operational map for SANDTABLE.
// Uses Leaflet from the CDN (window.L) with dark tiles; degrades to a pure SVG
// plot when Leaflet is unavailable (offline). The theater is fictional: island
// polygons sit in international waters of the Gulf of Oman / NW Arabian Sea; every
// named place and force remains fictional.
//
// Wargame board grammar: an optional hex-grid layer (terrain classified from the
// island/shoal polygons) and NATO-style unit counters. Fog of war renders only
// what one side can see (own units + detected enemies).

import { useEffect, useMemo, useRef, useState } from "react";
import type { LatLng, Objective, SimEvent, TheaterFeature, Unit } from "./types";
import { sideColors } from "./data";
import { affiliationOf, frameColor, milSymbolHtml } from "./milsym";
import { addGraticule, drawEngagements, drawHeadingVector, drawObjective, tintClass } from "./tactical";
import "./map-extras.css";

declare global {
  interface Window {
    L?: any;
  }
}

// Tactical palette (MIL-STD-2525 style), sourced from the symbol generator so
// trails, rings and vectors always match the unit counters.
const TAC_COLORS: Record<string, string> = {
  blue: frameColor(affiliationOf("blue")),
  red: frameColor(affiliationOf("red")),
  neutral: frameColor(affiliationOf("neutral")),
};

export interface MapUnit
  extends Pick<Unit, "id" | "side" | "name" | "domain" | "position" | "headingDeg" | "status" | "strength"> {
  detectedByEnemy?: boolean;
  classId?: string; // ontology class, drives the symbol icon when present
}

export interface TheaterMapProps {
  center: LatLng;
  zoom: number;
  units: MapUnit[];
  theater: TheaterFeature[];
  objectives?: Objective[];
  selectedUnitId?: string | null;
  onSelectUnit?: (id: string) => void;
  onMapClick?: (pos: LatLng) => void;
  trails?: Record<string, LatLng[]>; // unitId -> historical positions
  events?: SimEvent[]; // recent events with positions rendered as pulses
  sensorRingsFor?: string[]; // unit ids whose sensor range rings to draw
  sensorRanges?: Record<string, number>; // unitId -> rangeKm
  showHexGrid?: boolean; // wargame board layer over the chart
  fogSide?: "blue" | "red" | null; // when set, render only what this side sees
  weather?: string; // live environment, tints the display (storm)
  daylight?: boolean; // false dims the display like a night watch
  showLabels?: boolean; // permanent unit designation labels beside symbols
  height?: number;
}

// --- Hex board -----------------------------------------------------------------

type HexTerrain = "land" | "coast" | "shallow" | "sea";

interface HexCell {
  col: number;
  row: number;
  center: LatLng;
  vertices: LatLng[];
  terrain: HexTerrain;
}

const HEX_R = 0.145; // circumradius in longitude degrees (visual units)

function pointInPolygon(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].lat;
    const xi = poly[i].lng;
    const yj = poly[j].lat;
    const xj = poly[j].lng;
    const hit = yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Pointy-top axial grid. Latitude steps are scaled by cos(centerLat) so hexes
// look regular on the mercator tiles at theater latitude.
function buildHexGrid(theater: TheaterFeature[], center: LatLng): HexCell[] {
  const latScale = Math.cos((center.lat * Math.PI) / 180);
  const islands = theater.filter((f) => f.kind === "island").map((f) => f.polygon);
  const shoals = theater.filter((f) => f.kind === "shoal").map((f) => f.polygon);

  let minLat = center.lat - 1.9;
  let maxLat = center.lat + 1.9;
  let minLng = center.lng - 2.9;
  let maxLng = center.lng + 2.9;
  for (const feature of theater) {
    if (feature.kind === "zone") continue;
    for (const p of feature.polygon) {
      minLat = Math.min(minLat, p.lat - 0.4);
      maxLat = Math.max(maxLat, p.lat + 0.4);
      minLng = Math.min(minLng, p.lng - 0.4);
      maxLng = Math.max(maxLng, p.lng + 0.4);
    }
  }

  const colStep = Math.sqrt(3) * HEX_R;
  const rowStep = 1.5 * HEX_R * latScale;
  const rows = Math.ceil((maxLat - minLat) / rowStep);
  const cols = Math.ceil((maxLng - minLng) / colStep);
  const cells: HexCell[] = [];

  for (let row = 0; row <= rows; row++) {
    const lat = maxLat - row * rowStep;
    const offset = row % 2 === 1 ? colStep / 2 : 0;
    for (let col = 0; col <= cols; col++) {
      const lng = minLng + col * colStep + offset;
      const c: LatLng = { lat, lng };
      const vertices: LatLng[] = [];
      for (let k = 0; k < 6; k++) {
        const angle = ((60 * k + 30) * Math.PI) / 180;
        vertices.push({ lat: lat + HEX_R * Math.sin(angle) * latScale, lng: lng + HEX_R * Math.cos(angle) });
      }
      let terrain: HexTerrain = "sea";
      if (islands.some((poly) => pointInPolygon(c, poly))) terrain = "land";
      else if (vertices.some((v) => islands.some((poly) => pointInPolygon(v, poly)))) terrain = "coast";
      else if (shoals.some((poly) => pointInPolygon(c, poly))) terrain = "shallow";
      cells.push({ col, row, center: c, vertices, terrain });
    }
  }
  return cells;
}

const hexStyles: Record<HexTerrain, { color: string; opacity: number; fillColor: string; fillOpacity: number }> = {
  land: { color: "#93a56f", opacity: 0.4, fillColor: "#5d6b3f", fillOpacity: 0.4 },
  coast: { color: "#7fa3ad", opacity: 0.32, fillColor: "#41616a", fillOpacity: 0.28 },
  shallow: { color: "#5e8ea0", opacity: 0.28, fillColor: "#2c4c58", fillOpacity: 0.26 },
  sea: { color: "#5e7f96", opacity: 0.17, fillColor: "#0f1e29", fillOpacity: 0.1 },
};

// Variant for the pale "Nautical chart" base layer, where the dark-tuned
// styles above wash out to invisibility.
const hexStylesLight: Record<HexTerrain, { color: string; opacity: number; fillColor: string; fillOpacity: number }> = {
  land: { color: "#55663a", opacity: 0.55, fillColor: "#6f8148", fillOpacity: 0.45 },
  coast: { color: "#2f6b7a", opacity: 0.5, fillColor: "#7fb4c0", fillOpacity: 0.3 },
  shallow: { color: "#2d6c86", opacity: 0.45, fillColor: "#8fc6da", fillOpacity: 0.28 },
  sea: { color: "#3d637a", opacity: 0.3, fillColor: "#b9d3e2", fillOpacity: 0.12 },
};

function hexLabel(cell: HexCell): string {
  return `${String(cell.col).padStart(2, "0")}${String(cell.row).padStart(2, "0")}`;
}

// --- Fog of war ------------------------------------------------------------------

function visibleUnitsFor(units: MapUnit[], fogSide?: "blue" | "red" | null): MapUnit[] {
  if (!fogSide) return units;
  return units.filter((u) => u.side === fogSide || u.detectedByEnemy || u.status === "destroyed");
}

// Unit symbols are rendered by ./milsym.ts (APP-6/2525-style frames and icons).

// Counter size tracks the zoom level so zoomed-out views declutter instead of
// piling full-size symbols into a clump. Below 20 the symbol itself simplifies.
function symbolSizeForZoom(z: number): number {
  if (z >= 10) return 32;
  if (z >= 9) return 30;
  if (z >= 8) return 27;
  if (z >= 7) return 24;
  if (z >= 6) return 18;
  if (z >= 5) return 14;
  return 11;
}

export default function TheaterMap({
  center,
  zoom,
  units,
  theater,
  objectives,
  selectedUnitId,
  onSelectUnit,
  onMapClick,
  trails,
  events,
  sensorRingsFor,
  sensorRanges,
  showHexGrid,
  fogSide,
  weather,
  daylight,
  showLabels,
  height = 420,
}: TheaterMapProps) {
  const hasLeaflet = typeof window !== "undefined" && Boolean(window.L);
  if (!hasLeaflet) {
    return (
      <SvgTheaterMap
        center={center}
        units={units}
        theater={theater}
        objectives={objectives}
        selectedUnitId={selectedUnitId}
        onSelectUnit={onSelectUnit}
        showHexGrid={showHexGrid}
        fogSide={fogSide}
        height={height}
      />
    );
  }
  return (
    <LeafletTheaterMap
      center={center}
      zoom={zoom}
      units={units}
      theater={theater}
      objectives={objectives}
      selectedUnitId={selectedUnitId}
      onSelectUnit={onSelectUnit}
      onMapClick={onMapClick}
      trails={trails}
      events={events}
      sensorRingsFor={sensorRingsFor}
      sensorRanges={sensorRanges}
      showHexGrid={showHexGrid}
      fogSide={fogSide}
      weather={weather}
      daylight={daylight}
      showLabels={showLabels}
      height={height}
    />
  );
}

function LeafletTheaterMap(props: TheaterMapProps) {
  const {
    center,
    zoom,
    units,
    theater,
    objectives,
    selectedUnitId,
    onSelectUnit,
    onMapClick,
    trails,
    events,
    sensorRingsFor,
    sensorRanges,
    showHexGrid,
    fogSide,
    weather,
    daylight,
    showLabels,
    height,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const hexLayerRef = useRef<any>(null);
  const hexLabelsRef = useRef<any>(null);
  const graticuleRef = useRef<{ destroy: () => void } | null>(null);
  const overlaySigRef = useRef<string>("");
  const clickRef = useRef(onMapClick);
  const selectRef = useRef(onSelectUnit);
  clickRef.current = onMapClick;
  selectRef.current = onSelectUnit;
  // True while the pale "Nautical chart" base layer is active.
  const [baseLight, setBaseLight] = useState(false);
  // Live zoom level (user pan/zoom included), drives counter sizing.
  const [mapZoom, setMapZoom] = useState(zoom);

  const visibleUnits = useMemo(() => visibleUnitsFor(units, fogSide), [units, fogSide]);
  const hexes = useMemo(
    () => (showHexGrid ? buildHexGrid(theater, center) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showHexGrid, theater, center.lat, center.lng]
  );

  useEffect(() => {
    const L = window.L;
    if (!L || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [center.lat, center.lng],
      zoom,
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: true,
    });
    // Base layers: satellite imagery (default), a bathymetric nautical chart, and
    // a low-light layer for darkened ops rooms. All keyless public tile services.
    const satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 13, minZoom: 4 }
    );
    const chart = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 10, maxZoom: 13, minZoom: 4 }
    );
    const lowLight = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 13,
      minZoom: 4,
    });
    satellite.addTo(map);
    L.control
      .layers({ Satellite: satellite, "Nautical chart": chart, "Low light": lowLight }, undefined, {
        position: "topleft",
        collapsed: true,
      })
      .addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    graticuleRef.current = addGraticule(L, map, 1);
    // Dedicated panes: theater polygons under the hex board, board under the
    // tactical overlay (default overlayPane, z 400).
    map.createPane("theaterPane").style.zIndex = "340";
    map.createPane("hexPane").style.zIndex = "350";
    map.createPane("hexLabelPane").style.zIndex = "360";
    map.on("click", (e: any) => {
      if (clickRef.current) clickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    map.on("baselayerchange", (e: any) => setBaseLight(e.name === "Nautical chart"));
    // Permanent unit labels pile into an unreadable stack once the board
    // shrinks below its design zoom; gate them the way hex labels are gated.
    // The same handler tracks the live zoom for counter sizing.
    const syncZoomUi = () => {
      if (containerRef.current) containerRef.current.classList.toggle("map-labels-off", map.getZoom() < 7);
      setMapZoom(map.getZoom());
    };
    syncZoomUi();
    map.on("zoomend", syncZoomUi);
    mapRef.current = map;
    overlayRef.current = L.layerGroup().addTo(map);
    overlaySigRef.current = ""; // fresh overlay group, force the first draw
    if ((import.meta as any).env?.DEV) (window as any).__sandtableMap = map; // browser-QA hook, dev builds only
    return () => {
      if (graticuleRef.current) {
        graticuleRef.current.destroy();
        graticuleRef.current = null;
      }
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      hexLayerRef.current = null;
      hexLabelsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setView([center.lat, center.lng], zoom, { animate: false });
  }, [center.lat, center.lng, zoom]);

  // Hex board layer, static per theater, lives outside the per-tick overlay.
  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (!L || !map) return;
    if (hexLayerRef.current) {
      map.removeLayer(hexLayerRef.current);
      hexLayerRef.current = null;
    }
    if (hexLabelsRef.current) {
      map.removeLayer(hexLabelsRef.current);
      hexLabelsRef.current = null;
    }
    if (!showHexGrid || hexes.length === 0) return;

    const styleTable = baseLight ? hexStylesLight : hexStyles;
    const layer = L.layerGroup();
    for (const cell of hexes) {
      L.polygon(
        cell.vertices.map((v) => [v.lat, v.lng]),
        { ...styleTable[cell.terrain], weight: 1, pane: "hexPane", interactive: false }
      ).addTo(layer);
    }
    layer.addTo(map);
    hexLayerRef.current = layer;

    const labels = L.layerGroup();
    const refreshLabels = () => {
      labels.clearLayers();
      if (map.getZoom() < 8) return;
      const bounds = map.getBounds().pad(0.1);
      for (const cell of hexes) {
        if (!bounds.contains([cell.center.lat, cell.center.lng])) continue;
        labels.addLayer(
          L.marker([cell.center.lat, cell.center.lng], {
            pane: "hexLabelPane",
            interactive: false,
            keyboard: false,
            icon: L.divIcon({ className: "hex-coord-label", html: hexLabel(cell), iconSize: [34, 10], iconAnchor: [17, 5] }),
          })
        );
      }
    };
    refreshLabels();
    map.on("zoomend moveend", refreshLabels);
    labels.addTo(map);
    hexLabelsRef.current = labels;

    return () => {
      map.off("zoomend moveend", refreshLabels);
      if (hexLayerRef.current) {
        map.removeLayer(hexLayerRef.current);
        hexLayerRef.current = null;
      }
      if (hexLabelsRef.current) {
        map.removeLayer(hexLabelsRef.current);
        hexLabelsRef.current = null;
      }
    };
  }, [hexes, showHexGrid, baseLight]);

  useEffect(() => {
    const L = window.L;
    const overlay = overlayRef.current;
    if (!L || !overlay) return;

    const symbolSize = symbolSizeForZoom(mapZoom);

    // Pollers hand this effect fresh object identities every tick even when
    // nothing moved; skip the rebuild when the rendered content is unchanged
    // so open tooltips and running animations survive idle ticks.
    const signature = JSON.stringify([
      fogSide,
      selectedUnitId,
      showLabels,
      symbolSize,
      theater.map((f) => f.name),
      objectives?.map((o) => [o.id, o.side, o.title, o.area?.center.lat, o.area?.center.lng, o.area?.radiusKm]),
      visibleUnits.map((u) => [u.id, u.position.lat, u.position.lng, u.headingDeg, u.status, u.strength, u.classId]),
      trails ? Object.entries(trails).map(([id, p]) => [id, p.length, p[p.length - 1]?.lat, p[p.length - 1]?.lng]) : null,
      events?.map((e) => e.id),
      sensorRingsFor,
      sensorRanges,
    ]);
    if (signature === overlaySigRef.current) return;
    overlaySigRef.current = signature;
    overlay.clearLayers();

    for (const feature of theater) {
      const latlngs = feature.polygon.map((p) => [p.lat, p.lng]);
      if (feature.kind === "island") {
        // Coastline glow under the landmass reads like chart cartography.
        L.polygon(latlngs, { color: "#cfdcb0", weight: 5, opacity: 0.16, fill: false, interactive: false, pane: "theaterPane" }).addTo(overlay);
        L.polygon(latlngs, { color: "#cfdcb0", weight: 1.2, opacity: 0.85, fillColor: "#66784f", fillOpacity: 0.92, pane: "theaterPane" })
          .bindTooltip(feature.name, { direction: "center", className: "map-feature-label" })
          .addTo(overlay);
        continue;
      }
      const style =
        feature.kind === "shoal"
          ? { color: "#6fc7d6", weight: 1, dashArray: "4 4", fillColor: "#2a5b66", fillOpacity: 0.4 }
          : { color: "#8a7b3f", weight: 1, dashArray: "6 4", fillOpacity: 0.06, fillColor: "#8a7b3f" };
      L.polygon(latlngs, { ...style, pane: "theaterPane" })
        .bindTooltip(feature.name, { direction: "center", className: "map-feature-label" })
        .addTo(overlay);
    }

    if (objectives) {
      for (const objective of objectives) {
        drawObjective(L, overlay, objective);
      }
    }

    if (trails) {
      for (const [unitId, path] of Object.entries(trails)) {
        if (path.length < 2) continue;
        const unit = visibleUnits.find((u) => u.id === unitId);
        if (!unit && fogSide) continue; // no trails for units this side cannot see
        L.polyline(
          path.map((p) => [p.lat, p.lng]),
          { color: unit ? TAC_COLORS[unit.side] : "#888", weight: 1.5, opacity: 0.5, dashArray: "2 5", interactive: false }
        ).addTo(overlay);
      }
    }

    if (sensorRingsFor && sensorRanges) {
      for (const unitId of sensorRingsFor) {
        const unit = visibleUnits.find((u) => u.id === unitId);
        const rangeKm = sensorRanges[unitId];
        if (!unit || !rangeKm) continue;
        L.circle([unit.position.lat, unit.position.lng], {
          radius: rangeKm * 1000,
          color: TAC_COLORS[unit.side],
          weight: 1,
          opacity: 0.45,
          fillOpacity: 0.03,
          interactive: false,
        }).addTo(overlay);
      }
    }

    for (const unit of visibleUnits) {
      const sym = milSymbolHtml({
        side: unit.side,
        domain: unit.domain,
        classId: unit.classId,
        status: unit.status,
        strength: unit.strength,
        selected: unit.id === selectedUnitId,
        size: symbolSize,
      });
      const icon = L.divIcon({
        className: "map-unit-icon",
        html: sym.html,
        iconSize: [sym.width, sym.height],
        iconAnchor: [sym.anchorX, sym.anchorY],
      });
      const marker = L.marker([unit.position.lat, unit.position.lng], { icon });
      if (showLabels) {
        const short = unit.name.length > 22 ? `${unit.name.slice(0, 21)}…` : unit.name;
        marker.bindTooltip(short, {
          permanent: true,
          direction: "right",
          offset: [Math.round(sym.width / 2) + 3, 0],
          className: "unit-label",
          opacity: 1,
        });
      } else {
        marker.bindTooltip(
          `<strong>${unit.name}</strong><br/>${unit.status.toUpperCase()} · str ${Math.round(unit.strength)}%`,
          { direction: "top", offset: [0, -14] }
        );
      }
      marker.on("click", () => {
        if (selectRef.current) selectRef.current(unit.id);
      });
      marker.addTo(overlay);
      if (unit.status === "active" || unit.status === "damaged") {
        drawHeadingVector(L, overlay, unit);
      }
    }

    // Fire lines from shooter to impact for recent engagements; other event types
    // keep their pulse markers.
    const unitPositions: Record<string, LatLng> = {};
    for (const u of visibleUnits) unitPositions[u.id] = u.position;
    drawEngagements(L, overlay, events ?? [], unitPositions);
    if (events) {
      for (const event of events) {
        if (!event.position || event.type === "engagement") continue;
        const color = event.type === "destroyed" ? "#e5484d" : "#7cc4ff";
        const pulse = L.circleMarker([event.position.lat, event.position.lng], {
          radius: 9,
          color,
          weight: 2,
          fillOpacity: 0.15,
          className: "map-event-pulse",
        }).bindTooltip(event.title, { direction: "top" });
        pulse.addTo(overlay);
        // Keep the pulse phase continuous across overlay rebuilds.
        const el = pulse.getElement && pulse.getElement();
        if (el && el.style) el.style.animationDelay = `-${Date.now() % 1600}ms`;
      }
    }
  }, [visibleUnits, fogSide, theater, objectives, selectedUnitId, trails, events, sensorRingsFor, sensorRanges, showLabels, mapZoom]);

  const tint = tintClass(weather, daylight ?? true);
  return (
    <div className={`theater-map-wrap${tint ? ` ${tint}` : ""}${baseLight ? " map-base-light" : ""}`} style={{ height }}>
      <div ref={containerRef} className="theater-map" />
      <div className="map-north" aria-hidden="true">
        <svg viewBox="0 0 24 38" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 30 L12 9" />
          <path d="M7 14 L12 4 L17 14 Z" fill="currentColor" stroke="none" />
          <text x="12" y="37" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none" fontFamily="monospace">
            N
          </text>
        </svg>
      </div>
      <div className="map-attrib">Imagery: Esri, Maxar | © Carto</div>
    </div>
  );
}

// --- SVG fallback (offline) ---------------------------------------------------

function SvgTheaterMap({
  center,
  units,
  theater,
  objectives,
  selectedUnitId,
  onSelectUnit,
  showHexGrid,
  fogSide,
  height = 420,
}: Pick<
  TheaterMapProps,
  "center" | "units" | "theater" | "objectives" | "selectedUnitId" | "onSelectUnit" | "showHexGrid" | "fogSide" | "height"
>) {
  const bounds = useMemo(() => {
    const spanLat = 3.4;
    const spanLng = 5.2;
    return {
      minLat: center.lat - spanLat / 2,
      maxLat: center.lat + spanLat / 2,
      minLng: center.lng - spanLng / 2,
      maxLng: center.lng + spanLng / 2,
    };
  }, [center.lat, center.lng]);

  const W = 900;
  const H = 560;
  const px = (p: LatLng) => ({
    x: ((p.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * W,
    y: ((bounds.maxLat - p.lat) / (bounds.maxLat - bounds.minLat)) * H,
  });

  const visibleUnits = useMemo(() => visibleUnitsFor(units, fogSide), [units, fogSide]);
  const hexes = useMemo(
    () =>
      showHexGrid
        ? buildHexGrid(theater, center).filter(
            (cell) =>
              cell.center.lat > bounds.minLat - 0.1 &&
              cell.center.lat < bounds.maxLat + 0.1 &&
              cell.center.lng > bounds.minLng - 0.1 &&
              cell.center.lng < bounds.maxLng + 0.1
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showHexGrid, theater, center.lat, center.lng, bounds]
  );

  return (
    <svg className="theater-map svg-fallback" viewBox={`0 0 ${W} ${H}`} style={{ height, width: "100%" }}>
      <rect x={0} y={0} width={W} height={H} fill="#0d1a24" />
      {!showHexGrid
        ? Array.from({ length: 12 }).map((_, i) => (
            <line key={`v${i}`} x1={(i * W) / 12} y1={0} x2={(i * W) / 12} y2={H} stroke="#16293a" strokeWidth={1} />
          ))
        : null}
      {!showHexGrid
        ? Array.from({ length: 8 }).map((_, i) => (
            <line key={`h${i}`} x1={0} y1={(i * H) / 8} x2={W} y2={(i * H) / 8} stroke="#16293a" strokeWidth={1} />
          ))
        : null}
      {theater.map((feature) => {
        const points = feature.polygon.map((p) => {
          const { x, y } = px(p);
          return `${x},${y}`;
        });
        return (
          <g key={feature.id}>
            <polygon
              points={points.join(" ")}
              fill={feature.kind === "island" ? "#3d4a44" : "#27424a"}
              stroke="#5c6f66"
              strokeWidth={1}
              opacity={feature.kind === "zone" ? 0.25 : 0.95}
            />
            <text
              x={px(feature.polygon[0]).x}
              y={px(feature.polygon[0]).y - 6}
              fill="#9fb3a9"
              fontSize={11}
            >
              {feature.name}
            </text>
          </g>
        );
      })}
      {hexes.map((cell) => {
        const style = hexStyles[cell.terrain];
        const points = cell.vertices.map((v) => {
          const { x, y } = px(v);
          return `${x},${y}`;
        });
        return (
          <polygon
            key={`hex-${cell.col}-${cell.row}`}
            points={points.join(" ")}
            fill={style.fillColor}
            fillOpacity={style.fillOpacity}
            stroke={style.color}
            strokeOpacity={style.opacity}
            strokeWidth={1}
          />
        );
      })}
      {(objectives ?? []).map((objective) =>
        objective.area ? (
          <circle
            key={objective.id}
            cx={px(objective.area.center).x}
            cy={px(objective.area.center).y}
            r={(objective.area.radiusKm / 111 / (bounds.maxLat - bounds.minLat)) * H}
            fill="none"
            stroke={sideColors[objective.side]}
            strokeDasharray="6 5"
            opacity={0.7}
          />
        ) : null
      )}
      {visibleUnits.map((unit) => {
        const { x, y } = px(unit.position);
        const dead = unit.status === "destroyed";
        const color = dead ? "#5b6663" : sideColors[unit.side];
        const strength = Math.max(0, Math.min(100, Math.round(unit.strength)));
        const strengthColor = strength > 60 ? "#35c26e" : strength > 30 ? "#f5a524" : "#f04438";
        return (
          <g
            key={unit.id}
            transform={`translate(${x},${y})`}
            onClick={onSelectUnit ? () => onSelectUnit(unit.id) : undefined}
            style={{ cursor: onSelectUnit ? "pointer" : "default" }}
            opacity={dead ? 0.6 : 1}
          >
            {unit.id === selectedUnitId ? (
              <rect x={-12} y={-10.5} width={24} height={21} rx={4} fill="none" stroke="#fff" strokeWidth={2} />
            ) : null}
            <rect x={-9} y={-8} width={18} height={16} rx={2.5} fill={color} stroke="#ffffffcc" strokeWidth={1.3} />
            <text y={2.5} textAnchor="middle" fill="#fff" fontSize={8} fontWeight={800}>
              {dead ? "✕" : unit.domain[0].toUpperCase()}
            </text>
            <rect x={-7} y={4.5} width={14} height={2} rx={1} fill="#00000066" />
            <rect x={-7} y={4.5} width={(strength / 100) * 14} height={2} rx={1} fill={strengthColor} />
          </g>
        );
      })}
      <text x={12} y={H - 12} fill="#5f7185" fontSize={11}>
        Offline chart, fictional Meridian Archipelago theater
      </text>
    </svg>
  );
}

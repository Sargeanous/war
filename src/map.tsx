// TheaterMap — the shared operational map for SANDTABLE.
// Uses Leaflet from the CDN (window.L) with dark tiles; degrades to a pure SVG
// plot when Leaflet is unavailable (offline). The theater is fictional: island
// polygons are drawn over open ocean, so no real-world geography is implied.
//
// Wargame board grammar: an optional hex-grid layer (terrain classified from the
// island/shoal polygons) and NATO-style unit counters. Fog of war renders only
// what one side can see (own units + detected enemies).

import { useEffect, useMemo, useRef } from "react";
import type { LatLng, Objective, SimEvent, TheaterFeature, Unit } from "./types";
import { sideColors } from "./data";

declare global {
  interface Window {
    L?: any;
  }
}

export interface MapUnit
  extends Pick<Unit, "id" | "side" | "name" | "domain" | "position" | "headingDeg" | "status" | "strength"> {
  detectedByEnemy?: boolean;
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

function hexLabel(cell: HexCell): string {
  return `${String(cell.col).padStart(2, "0")}${String(cell.row).padStart(2, "0")}`;
}

// --- Fog of war ------------------------------------------------------------------

function visibleUnitsFor(units: MapUnit[], fogSide?: "blue" | "red" | null): MapUnit[] {
  if (!fogSide) return units;
  return units.filter((u) => u.side === fogSide || u.detectedByEnemy || u.status === "destroyed");
}

// --- NATO-style counters -----------------------------------------------------------

const glyphSvg = (body: string) =>
  `<svg viewBox="0 0 20 12" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const DOMAIN_GLYPHS: Record<string, string> = {
  land: glyphSvg(`<line x1="2" y1="1.5" x2="18" y2="10.5"/><line x1="18" y1="1.5" x2="2" y2="10.5"/>`),
  sea: glyphSvg(`<ellipse cx="10" cy="6" rx="7.5" ry="4.3"/>`),
  air: glyphSvg(`<path d="M2.5 11 Q10 -3.5 17.5 11"/>`),
  cyber: glyphSvg(`<path d="M10 1.2 L18 6 L10 10.8 L2 6 Z"/><line x1="2" y1="6" x2="18" y2="6"/>`),
  space: glyphSvg(`<path d="M4 10.5 Q10 1 16 10.5"/><circle cx="10" cy="4.4" r="1.6"/>`),
};

function counterHtml(unit: MapUnit, selected: boolean): string {
  const dead = unit.status === "destroyed";
  const color = dead ? "#5b6663" : sideColors[unit.side];
  const strength = Math.max(0, Math.min(100, Math.round(unit.strength)));
  const strengthColor = strength > 60 ? "#35c26e" : strength > 30 ? "#f5a524" : "#f04438";
  const ring = selected ? `box-shadow:0 0 0 2px #ffffff,0 0 0 5px ${color}55;` : "";
  const dim = dead ? "opacity:.62;filter:saturate(.35);" : "";
  const glyph = DOMAIN_GLYPHS[unit.domain] ?? DOMAIN_GLYPHS.land;
  const deadMark = dead ? `<span class="mc-dead">✕</span>` : "";
  return `<div class="map-counter" style="background:${color};${ring}${dim}"><span class="mc-glyph">${glyph}</span><span class="mc-str"><i style="width:${strength}%;background:${strengthColor}"></i></span>${deadMark}</div>`;
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
    height,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const hexLayerRef = useRef<any>(null);
  const hexLabelsRef = useRef<any>(null);
  const clickRef = useRef(onMapClick);
  const selectRef = useRef(onSelectUnit);
  clickRef.current = onMapClick;
  selectRef.current = onSelectUnit;

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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 12, minZoom: 4 }).addTo(map);
    // Dedicated panes keep the hex board between the tiles and the tactical overlay.
    map.createPane("hexPane").style.zIndex = "350";
    map.createPane("hexLabelPane").style.zIndex = "360";
    map.on("click", (e: any) => {
      if (clickRef.current) clickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    mapRef.current = map;
    overlayRef.current = L.layerGroup().addTo(map);
    if ((import.meta as any).env?.DEV) (window as any).__sandtableMap = map; // browser-QA hook, dev builds only
    return () => {
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

  // Hex board layer — static per theater, lives outside the per-tick overlay.
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

    const layer = L.layerGroup();
    for (const cell of hexes) {
      L.polygon(
        cell.vertices.map((v) => [v.lat, v.lng]),
        { ...hexStyles[cell.terrain], weight: 1, pane: "hexPane", interactive: false }
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
  }, [hexes, showHexGrid]);

  useEffect(() => {
    const L = window.L;
    const overlay = overlayRef.current;
    if (!L || !overlay) return;
    overlay.clearLayers();

    for (const feature of theater) {
      const latlngs = feature.polygon.map((p) => [p.lat, p.lng]);
      const style =
        feature.kind === "island"
          ? { color: "#5c6f66", weight: 1, fillColor: "#3d4a44", fillOpacity: 0.9 }
          : feature.kind === "shoal"
            ? { color: "#3f5a63", weight: 1, dashArray: "4 4", fillColor: "#27424a", fillOpacity: 0.5 }
            : { color: "#8a7b3f", weight: 1, dashArray: "6 4", fillOpacity: 0.06, fillColor: "#8a7b3f" };
      L.polygon(latlngs, style).bindTooltip(feature.name, { direction: "center", className: "map-feature-label" }).addTo(overlay);
    }

    if (objectives) {
      for (const objective of objectives) {
        if (!objective.area) continue;
        L.circle([objective.area.center.lat, objective.area.center.lng], {
          radius: objective.area.radiusKm * 1000,
          color: sideColors[objective.side],
          weight: 1.5,
          dashArray: "8 6",
          fillOpacity: 0.05,
        })
          .bindTooltip(`OBJ · ${objective.title}`, { direction: "top" })
          .addTo(overlay);
      }
    }

    if (trails) {
      for (const [unitId, path] of Object.entries(trails)) {
        if (path.length < 2) continue;
        const unit = visibleUnits.find((u) => u.id === unitId);
        if (!unit && fogSide) continue; // no trails for units this side cannot see
        L.polyline(
          path.map((p) => [p.lat, p.lng]),
          { color: unit ? sideColors[unit.side] : "#888", weight: 1.5, opacity: 0.55, dashArray: "2 5" }
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
          color: sideColors[unit.side],
          weight: 1,
          opacity: 0.5,
          fillOpacity: 0.03,
        }).addTo(overlay);
      }
    }

    for (const unit of visibleUnits) {
      const icon = L.divIcon({
        className: "map-unit-icon",
        html: counterHtml(unit, unit.id === selectedUnitId),
        iconSize: [28, 24],
        iconAnchor: [14, 12],
      });
      const marker = L.marker([unit.position.lat, unit.position.lng], { icon });
      marker.bindTooltip(
        `<strong>${unit.name}</strong><br/>${unit.status.toUpperCase()} · str ${Math.round(unit.strength)}%`,
        { direction: "top", offset: [0, -12] }
      );
      marker.on("click", () => {
        if (selectRef.current) selectRef.current(unit.id);
      });
      marker.addTo(overlay);
    }

    if (events) {
      for (const event of events) {
        if (!event.position) continue;
        const color = event.type === "destroyed" ? "#e5484d" : event.type === "engagement" ? "#f5a524" : "#7cc4ff";
        L.circleMarker([event.position.lat, event.position.lng], {
          radius: 9,
          color,
          weight: 2,
          fillOpacity: 0.15,
          className: "map-event-pulse",
        })
          .bindTooltip(event.title, { direction: "top" })
          .addTo(overlay);
      }
    }
  }, [visibleUnits, fogSide, theater, objectives, selectedUnitId, trails, events, sensorRingsFor, sensorRanges]);

  return <div ref={containerRef} className="theater-map" style={{ height }} />;
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
        Offline chart — fictional Meridian Archipelago theater
      </text>
    </svg>
  );
}

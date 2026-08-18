// TheaterMap — the shared operational map for SANDTABLE.
// Uses Leaflet from the CDN (window.L) with dark tiles; degrades to a pure SVG
// plot when Leaflet is unavailable (offline). The theater is fictional: island
// polygons are drawn over open ocean, so no real-world geography is implied.

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
  height?: number;
}

const domainShape: Record<string, string> = {
  sea: "50% 50% 50% 50%",
  air: "50% 50% 8% 50%",
  land: "16%",
  cyber: "40% 10% 40% 10%",
  space: "50% 10% 50% 10%",
};

function unitHtml(unit: MapUnit, selected: boolean): string {
  const color = unit.status === "destroyed" ? "#8b9490" : sideColors[unit.side];
  const glyph = { sea: "▮", air: "▲", land: "■", cyber: "◆", space: "✦" }[unit.domain] ?? "■";
  const opacity = unit.status === "destroyed" ? 0.55 : 1;
  const ring = selected ? `box-shadow:0 0 0 4px ${color}44, 0 0 0 2px #fff;` : "";
  const cross =
    unit.status === "destroyed"
      ? `<span style="position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-weight:900;">✕</span>`
      : "";
  return `<div class="map-unit" style="position:relative;width:26px;height:26px;border-radius:${domainShape[unit.domain] ?? "16%"};background:${color};opacity:${opacity};border:2px solid #ffffffcc;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:800;transform:rotate(0deg);${ring}">${glyph}${cross}</div>`;
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
    height,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const clickRef = useRef(onMapClick);
  const selectRef = useRef(onSelectUnit);
  clickRef.current = onMapClick;
  selectRef.current = onSelectUnit;

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
    map.on("click", (e: any) => {
      if (clickRef.current) clickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    mapRef.current = map;
    overlayRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setView([center.lat, center.lng], zoom, { animate: false });
  }, [center.lat, center.lng, zoom]);

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
        const unit = units.find((u) => u.id === unitId);
        L.polyline(
          path.map((p) => [p.lat, p.lng]),
          { color: unit ? sideColors[unit.side] : "#888", weight: 1.5, opacity: 0.55, dashArray: "2 5" }
        ).addTo(overlay);
      }
    }

    if (sensorRingsFor && sensorRanges) {
      for (const unitId of sensorRingsFor) {
        const unit = units.find((u) => u.id === unitId);
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

    for (const unit of units) {
      const icon = L.divIcon({
        className: "map-unit-icon",
        html: unitHtml(unit, unit.id === selectedUnitId),
        iconSize: [26, 26],
        iconAnchor: [13, 13],
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
  }, [units, theater, objectives, selectedUnitId, trails, events, sensorRingsFor, sensorRanges]);

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
  height = 420,
}: Pick<
  TheaterMapProps,
  "center" | "units" | "theater" | "objectives" | "selectedUnitId" | "onSelectUnit" | "height"
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

  return (
    <svg className="theater-map svg-fallback" viewBox={`0 0 ${W} ${H}`} style={{ height, width: "100%" }}>
      <rect x={0} y={0} width={W} height={H} fill="#0d1a24" />
      {Array.from({ length: 12 }).map((_, i) => (
        <line key={`v${i}`} x1={(i * W) / 12} y1={0} x2={(i * W) / 12} y2={H} stroke="#16293a" strokeWidth={1} />
      ))}
      {Array.from({ length: 8 }).map((_, i) => (
        <line key={`h${i}`} x1={0} y1={(i * H) / 8} x2={W} y2={(i * H) / 8} stroke="#16293a" strokeWidth={1} />
      ))}
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
      {units.map((unit) => {
        const { x, y } = px(unit.position);
        const color = unit.status === "destroyed" ? "#8b9490" : sideColors[unit.side];
        return (
          <g
            key={unit.id}
            transform={`translate(${x},${y})`}
            onClick={onSelectUnit ? () => onSelectUnit(unit.id) : undefined}
            style={{ cursor: onSelectUnit ? "pointer" : "default" }}
          >
            {unit.id === selectedUnitId ? <circle r={13} fill="none" stroke="#fff" strokeWidth={2} /> : null}
            <circle r={9} fill={color} stroke="#ffffffbb" strokeWidth={1.5} opacity={unit.status === "destroyed" ? 0.5 : 1} />
            <text y={4} textAnchor="middle" fill="#fff" fontSize={9} fontWeight={800}>
              {unit.domain[0].toUpperCase()}
            </text>
            {unit.status === "destroyed" ? (
              <text y={4} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={900}>
                ✕
              </text>
            ) : null}
          </g>
        );
      })}
      <text x={12} y={H - 12} fill="#5f7185" fontSize={11}>
        Offline chart — fictional Meridian Archipelago theater
      </text>
    </svg>
  );
}

// The sand table.
//
// SANDTABLE is named after the oldest wargaming instrument there is: a terrain
// model on a table, lit from above, that commanders stand around. The platform
// was drawing its fictional archipelago as flat coloured polygons on top of real
// satellite imagery of somewhere else, which is neither the fiction nor the
// instrument.
//
// This renders the theater as a lit relief model instead. The heightfield is
// derived from the scenario's own island and shoal polygons, so the coastline is
// exactly the coastline the simulation adjudicates against, then hillshaded from
// a fixed key light and colour ramped sand over water. It is a Leaflet base
// layer, so it pans, zooms and registers like any other basemap.

import type { LatLng, TheaterFeature } from "./types";

const TILE = 256;
// The height is sampled on a coarse lattice and bilinearly upsampled. Sampling
// every pixel means a point-in-polygon test per pixel per island, which is far
// too much work to do while somebody is dragging the map.
const STEP = 4;

// --- deterministic value noise ------------------------------------------------

function hash2(ix: number, iy: number, seed: number): number {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    total += amp * valueNoise(x * freq, y * freq, seed + i * 17);
    freq *= 2;
    amp *= 0.5;
  }
  return total;
}

// --- polygon geometry ---------------------------------------------------------

// Longitude degrees are shorter than latitude degrees away from the equator, so
// every distance is measured in latitude-equivalent degrees to stay isotropic.
const LNG_SCALE = Math.cos((23.9 * Math.PI) / 180);

function pointInRing(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const yi = ring[i].lat;
    const xi = ring[i].lng;
    const yj = ring[j].lat;
    const xj = ring[j].lng;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(lat: number, lng: number, ring: LatLng[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const ay = ring[j].lat;
    const ax = (ring[j].lng - lng) * LNG_SCALE;
    const by = ring[i].lat;
    const bx = (ring[i].lng - lng) * LNG_SCALE;
    const py = lat;
    const vx = bx - ax;
    const vy = by - ay;
    const wx = 0 - ax;
    const wy = py - ay;
    const len = vx * vx + vy * vy;
    let t = len > 0 ? (wx * vx + wy * vy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - vx * t;
    const dy = wy - vy * t;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * A height sampler closed over the theater. Positive is land, negative is water,
 * and the coastline sits exactly where the scenario's polygon says it does.
 */
export function buildHeightSampler(theater: TheaterFeature[]): (lat: number, lng: number) => number {
  const islands = theater.filter((f) => f.kind === "island").map((f) => f.polygon);
  const shoals = theater.filter((f) => f.kind === "shoal").map((f) => f.polygon);

  return (lat: number, lng: number): number => {
    // Signed distance to the nearest island, ramped over a few km so the coast
    // is a beach rather than a cliff.
    let land = 0;
    for (const ring of islands) {
      const d = distanceToRing(lat, lng, ring);
      const signed = pointInRing(lat, lng, ring) ? d : -d;
      const v = smoothstep(-0.014, 0.05, signed);
      if (v > land) land = v;
    }
    // Shoals never break the surface, they only lift the seabed.
    let shoal = 0;
    for (const ring of shoals) {
      const d = distanceToRing(lat, lng, ring);
      const signed = pointInRing(lat, lng, ring) ? d : -d;
      const v = smoothstep(-0.012, 0.04, signed);
      if (v > shoal) shoal = v;
    }

    const detail = fbm(lat * 46, lng * 46 * LNG_SCALE, 7);
    const base = land - (1 - land) * (0.52 - 0.4 * shoal);
    // Land carries most of the relief; open water stays broadly flat so the
    // shading does not turn the sea into gravel.
    return base + (detail - 0.5) * (land > 0.02 ? 0.34 : 0.09);
  };
}

// --- colour -------------------------------------------------------------------

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A Leaflet GridLayer that paints the relief. Uses window.L, which the app
 * already loads from CDN, so this stays free of a Leaflet type dependency.
 */
export function createSandTableLayer(L: any, theater: TheaterFeature[], options: Record<string, unknown> = {}): any {
  const sample = buildHeightSampler(theater);

  const Layer = L.GridLayer.extend({
    createTile(coords: { x: number; y: number; z: number }) {
      const tile = document.createElement("canvas");
      tile.width = TILE;
      tile.height = TILE;
      const ctx = tile.getContext("2d");
      if (!ctx) return tile;

      // Tile corners in world coordinates, then in lat/lng.
      const nw = L.CRS.EPSG3857.pointToLatLng(L.point(coords.x * TILE, coords.y * TILE), coords.z);
      const se = L.CRS.EPSG3857.pointToLatLng(L.point((coords.x + 1) * TILE, (coords.y + 1) * TILE), coords.z);
      const lat0 = nw.lat;
      const lng0 = nw.lng;
      const dLat = (se.lat - nw.lat) / TILE;
      const dLng = (se.lng - nw.lng) / TILE;

      const n = TILE / STEP + 1;
      const grid = new Float32Array(n * n);
      for (let gy = 0; gy < n; gy += 1) {
        const lat = lat0 + dLat * (gy * STEP);
        for (let gx = 0; gx < n; gx += 1) {
          grid[gy * n + gx] = sample(lat, lng0 + dLng * (gx * STEP));
        }
      }

      // The hillshade has to look the same at every zoom, so the slope is scaled
      // by the ground distance a pixel covers rather than by the pixel itself.
      const degPerSample = Math.abs(dLat) * STEP;
      const relief = 0.011 / Math.max(degPerSample, 1e-6);

      const img = ctx.createImageData(TILE, TILE);
      const data = img.data;
      const lx = -0.62;
      const ly = -0.66;
      const lz = 0.43;

      for (let py = 0; py < TILE; py += 1) {
        const fy = py / STEP;
        const gy = Math.min(n - 2, Math.floor(fy));
        const ty = fy - gy;
        for (let px = 0; px < TILE; px += 1) {
          const fx = px / STEP;
          const gx = Math.min(n - 2, Math.floor(fx));
          const tx = fx - gx;

          const h00 = grid[gy * n + gx];
          const h10 = grid[gy * n + gx + 1];
          const h01 = grid[(gy + 1) * n + gx];
          const h11 = grid[(gy + 1) * n + gx + 1];
          const top = h00 + (h10 - h00) * tx;
          const bot = h01 + (h11 - h01) * tx;
          const h = top + (bot - top) * ty;

          // Slope from the coarse lattice, which is smooth enough to shade well.
          const nx = (h00 - h10) * relief;
          const ny = (h00 - h01) * relief;
          const len = Math.sqrt(nx * nx + ny * ny + 1);
          let shade = (nx * lx + ny * ly + lz) / len;
          shade = 0.64 + shade * 0.8;
          if (shade < 0.34) shade = 0.34;
          if (shade > 1.45) shade = 1.45;

          let r: number;
          let g: number;
          let b: number;
          if (h < 0) {
            const t = Math.min(1, -h / 0.5);
            r = mix(30, 8, t);
            g = mix(64, 21, t);
            b = mix(74, 28, t);
            shade = 0.92 + (shade - 0.92) * 0.3;
          } else {
            const t = Math.min(1, h / 0.42);
            r = mix(148, 214, t);
            g = mix(127, 195, t);
            b = mix(96, 162, t);
            // Contour banding, the way a relief plate is printed.
            const band = (h * 14) % 1;
            if (band < 0.06) {
              r *= 0.87;
              g *= 0.87;
              b *= 0.88;
            }
          }

          const o = (py * TILE + px) * 4;
          data[o] = Math.min(255, r * shade);
          data[o + 1] = Math.min(255, g * shade);
          data[o + 2] = Math.min(255, b * shade);
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return tile;
    },
  });

  return new Layer({ minZoom: 4, maxZoom: 13, tileSize: TILE, ...options });
}

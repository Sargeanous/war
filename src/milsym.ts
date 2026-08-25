// milsym.ts
// Zero-dependency generator of APP-6 / MIL-STD-2525-style unit symbols as SVG
// strings, suitable for Leaflet divIcons and inline SVG. Pure, deterministic,
// no imports, no DOM access.

export type Affiliation = "friend" | "hostile" | "neutral";

export interface MilSymbolOptions {
  side: "blue" | "red" | "neutral";
  domain: "land" | "sea" | "air" | "cyber" | "space";
  classId?: string; // ontology id like "maritime.destroyer"; keyword-match the icon
  status: "active" | "damaged" | "destroyed" | "withdrawn";
  strength: number; // 0..100
  selected?: boolean;
  size?: number; // frame width in px, default 30
}

export interface MilSymbolResult {
  html: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const INK = "#10100E"; // frame + icon stroke
const FRAME_STROKE_W = 1.6;
const FILL_DESATURATED = "#9aa3a0";
const AMBER = "#f5a524";
const RED = "#e5484d";
const BAR_GREEN = "#35c26e";
const BAR_AMBER = "#f5a524";
const BAR_RED = "#f04438";

const AFF_FILL: Record<Affiliation, string> = {
  friend: "#80E0FF",
  hostile: "#FF8080",
  neutral: "#AAFFAA",
};

export function affiliationOf(side: string): Affiliation {
  if (side === "blue") return "friend";
  if (side === "red") return "hostile";
  return "neutral";
}

export function frameColor(aff: Affiliation): string {
  return AFF_FILL[aff];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Round to 2 decimals so path data stays tight and deterministic.
function n(v: number): number {
  return Math.round(v * 100) / 100;
}

// Round to nearest half pixel for layout coordinates (crisper strokes).
function half(v: number): number {
  return Math.round(v * 2) / 2;
}

type Shape =
  | "roundRect" // friend land/sea/cyber
  | "archBottom" // friend air/space (open at the bottom)
  | "archTop" // friend subsurface (open at the top, U shape)
  | "diamond" // hostile land/sea/cyber
  | "tent" // hostile air/space (^, open at the bottom)
  | "vee" // hostile subsurface (V, open at the top)
  | "square"; // neutral

interface FramePaths {
  fill: string; // closed silhouette path data (for the fill layer)
  edge: string; // stroked outline path data (open edge omitted for open frames)
  open: boolean;
}

function pickShape(aff: Affiliation, domain: MilSymbolOptions["domain"], classId: string): Shape {
  const sub = classId.indexOf("submarine") >= 0;
  if (aff === "neutral") return "square";
  const airlike = domain === "air" || domain === "space";
  if (aff === "friend") {
    if (sub) return "archTop";
    if (airlike) return "archBottom";
    return "roundRect";
  }
  // hostile
  if (sub) return "vee";
  if (airlike) return "tent";
  return "diamond";
}

// Frame bounding-box height for a given shape, keeping visual mass similar.
function frameHeight(shape: Shape, size: number): number {
  switch (shape) {
    case "roundRect":
      return half(size * 0.66);
    case "square":
      // True square; side chosen so the area is close to the friend rect.
      return half(size * 0.8);
    case "archBottom":
    case "archTop":
    case "tent":
    case "vee":
      return half(size * 0.72);
    case "diamond":
      return half(size * 0.9);
  }
}

// Frame bounding-box width; the neutral frame is a true square with an area
// comparable to the friend rectangle, so it is narrower than `size`.
function frameWidth(shape: Shape, size: number): number {
  if (shape === "square") return half(size * 0.8);
  return size;
}

function framePaths(shape: Shape, x: number, y: number, w: number, h: number, rx: number): FramePaths {
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (shape) {
    case "roundRect": {
      const r = Math.min(rx, w / 2, h / 2);
      const d =
        `M ${n(x + r)} ${n(y)} H ${n(x + w - r)} ` +
        `A ${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)} V ${n(y + h - r)} ` +
        `A ${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)} H ${n(x + r)} ` +
        `A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)} V ${n(y + r)} ` +
        `A ${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)} Z`;
      return { fill: d, edge: d, open: false };
    }
    case "square": {
      const d = `M ${n(x)} ${n(y)} H ${n(x + w)} V ${n(y + h)} H ${n(x)} Z`;
      return { fill: d, edge: d, open: false };
    }
    case "diamond": {
      const d = `M ${n(cx)} ${n(y)} L ${n(x + w)} ${n(cy)} L ${n(cx)} ${n(y + h)} L ${n(x)} ${n(cy)} Z`;
      return { fill: d, edge: d, open: false };
    }
    case "archBottom": {
      // Flat bottom edge omitted; dome across the top (exact half-ellipse).
      const ry = h * 0.5;
      const edge =
        `M ${n(x)} ${n(y + h)} L ${n(x)} ${n(y + ry)} ` +
        `A ${n(w / 2)} ${n(ry)} 0 0 1 ${n(x + w)} ${n(y + ry)} ` +
        `L ${n(x + w)} ${n(y + h)}`;
      return { fill: edge + " Z", edge, open: true };
    }
    case "archTop": {
      // Flat top edge omitted; bowl across the bottom (U shape).
      const ry = h * 0.5;
      const edge =
        `M ${n(x)} ${n(y)} L ${n(x)} ${n(y + h - ry)} ` +
        `A ${n(w / 2)} ${n(ry)} 0 0 0 ${n(x + w)} ${n(y + h - ry)} ` +
        `L ${n(x + w)} ${n(y)}`;
      return { fill: edge + " Z", edge, open: true };
    }
    case "tent": {
      const edge = `M ${n(x)} ${n(y + h)} L ${n(cx)} ${n(y)} L ${n(x + w)} ${n(y + h)}`;
      return { fill: edge + " Z", edge, open: true };
    }
    case "vee": {
      const edge = `M ${n(x)} ${n(y)} L ${n(cx)} ${n(y + h)} L ${n(x + w)} ${n(y)}`;
      return { fill: edge + " Z", edge, open: true };
    }
  }
}

// Interior box used to place the icon inside a frame.
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function interiorBox(shape: Shape, fx: number, fy: number, fw: number, fh: number): Box {
  switch (shape) {
    case "roundRect":
    case "square":
      return { x: fx + 3, y: fy + 3, w: fw - 6, h: fh - 6 };
    case "archBottom":
      return { x: fx + 4, y: fy + 4, w: fw - 8, h: fh - 6 };
    case "archTop":
      return { x: fx + 4, y: fy + 2.5, w: fw - 8, h: fh - 7 };
    case "diamond":
      return { x: fx + fw * 0.27, y: fy + fh * 0.27, w: fw * 0.46, h: fh * 0.46 };
    case "tent":
      // Widest at the bottom: bias the interior downward.
      return { x: fx + fw * 0.28, y: fy + fh * 0.42, w: fw * 0.44, h: fh * 0.5 };
    case "vee":
      // Widest at the top: bias the interior upward.
      return { x: fx + fw * 0.28, y: fy + fh * 0.08, w: fw * 0.44, h: fh * 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Icon selection
// ---------------------------------------------------------------------------

type IconSpec =
  | { kind: "text"; label: string }
  | { kind: "saltire" }
  | { kind: "dot" }
  | { kind: "dome" }
  | { kind: "delta" };

const KEYWORD_ICONS: Array<[string, IconSpec]> = [
  ["maritime-patrol", { kind: "text", label: "MPA" }],
  ["missile-boat", { kind: "text", label: "PT" }],
  ["carrier", { kind: "text", label: "CV" }],
  ["destroyer", { kind: "text", label: "DD" }],
  ["frigate", { kind: "text", label: "FF" }],
  ["corvette", { kind: "text", label: "FS" }],
  ["auxiliary", { kind: "text", label: "AO" }],
  ["amphibious", { kind: "text", label: "LHA" }],
  ["submarine", { kind: "text", label: "SS" }],
  ["fighter", { kind: "text", label: "FTR" }],
  ["strike", { kind: "text", label: "ATK" }],
  ["aew", { kind: "text", label: "AEW" }],
  ["uav", { kind: "delta" }],
  ["marine", { kind: "saltire" }],
  ["infantry", { kind: "saltire" }],
  ["artillery", { kind: "dot" }],
  ["battery", { kind: "dot" }],
  ["sam", { kind: "dome" }],
  ["cyber", { kind: "text", label: "CYB" }],
  ["constellation", { kind: "text", label: "SAT" }],
  ["space", { kind: "text", label: "SAT" }],
];

function pickIcon(classId: string, domain: MilSymbolOptions["domain"]): IconSpec {
  const id = classId.toLowerCase();
  if (id.length > 0) {
    for (let i = 0; i < KEYWORD_ICONS.length; i++) {
      if (id.indexOf(KEYWORD_ICONS[i][0]) >= 0) return KEYWORD_ICONS[i][1];
    }
  }
  switch (domain) {
    case "sea":
      return { kind: "text", label: "SHP" };
    case "air":
      return { kind: "text", label: "AIR" };
    case "land":
      return { kind: "saltire" };
    case "cyber":
      return { kind: "text", label: "CYB" };
    case "space":
      return { kind: "text", label: "SAT" };
  }
}

function iconMarkup(icon: IconSpec, shape: Shape, box: Box, size: number): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  switch (icon.kind) {
    case "text": {
      const tight = shape === "diamond" || shape === "tent" || shape === "vee";
      let fs = size * (icon.label.length >= 3 ? 0.26 : 0.3);
      if (tight) fs *= 0.85;
      return (
        `<text x="${n(cx)}" y="${n(cy)}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="'IBM Plex Mono', Consolas, monospace" font-weight="700" ` +
        `font-size="${n(fs)}" letter-spacing="0.5" fill="${INK}">${icon.label}</text>`
      );
    }
    case "saltire": {
      // Two diagonals corner-to-corner of the frame interior.
      return (
        `<line x1="${n(box.x)}" y1="${n(box.y)}" x2="${n(box.x + box.w)}" y2="${n(box.y + box.h)}" ` +
        `stroke="${INK}" stroke-width="${FRAME_STROKE_W}" stroke-linecap="round"/>` +
        `<line x1="${n(box.x + box.w)}" y1="${n(box.y)}" x2="${n(box.x)}" y2="${n(box.y + box.h)}" ` +
        `stroke="${INK}" stroke-width="${FRAME_STROKE_W}" stroke-linecap="round"/>`
      );
    }
    case "dot": {
      const r = Math.max(2, size * 0.083);
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${INK}"/>`;
    }
    case "dome": {
      // Air-defense dome: upward arc spanning the frame interior.
      const by = box.y + box.h;
      return (
        `<path d="M ${n(box.x)} ${n(by)} A ${n(box.w / 2)} ${n(box.h * 0.95)} 0 0 1 ${n(box.x + box.w)} ${n(by)}" ` +
        `fill="none" stroke="${INK}" stroke-width="${FRAME_STROKE_W}" stroke-linecap="round"/>`
      );
    }
    case "delta": {
      // Small filled delta triangle glyph.
      const tw = box.w * 0.62;
      const th = box.h * 0.58;
      return (
        `<path d="M ${n(cx - tw / 2)} ${n(cy + th / 2)} L ${n(cx)} ${n(cy - th / 2)} ` +
        `L ${n(cx + tw / 2)} ${n(cy + th / 2)} Z" fill="${INK}"/>`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------------

const PAD = 4; // padding on every side (total svg width = size + 8)
const BAR_H = 3;
const BAR_GAP = 2;

interface Geom {
  size: number;
  shape: Shape;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  svgW: number;
  svgH: number;
  barY: number;
  anchorX: number;
  anchorY: number;
}

function computeGeom(opts: MilSymbolOptions): Geom {
  const size = opts.size && opts.size > 0 ? opts.size : 30;
  const aff = affiliationOf(opts.side);
  const shape = pickShape(aff, opts.domain, (opts.classId || "").toLowerCase());
  const fw = frameWidth(shape, size);
  const fh = frameHeight(shape, size);
  const fx = half(PAD + (size - fw) / 2);
  const fy = PAD;
  const svgW = size + PAD * 2;
  const barY = fy + fh + BAR_GAP;
  const svgH = barY + BAR_H + PAD;
  return {
    size,
    shape,
    fx,
    fy,
    fw,
    fh,
    svgW,
    svgH,
    barY,
    anchorX: fx + fw / 2,
    anchorY: fy + fh / 2,
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function milSymbolSvg(opts: MilSymbolOptions): string {
  const g = computeGeom(opts);
  const aff = affiliationOf(opts.side);
  const classId = (opts.classId || "").toLowerCase();
  const icon = pickIcon(classId, opts.domain);
  const paths = framePaths(g.shape, g.fx, g.fy, g.fw, g.fh, 2);
  // Below ~20px the icon glyph and strength bar read as noise, not information;
  // compact symbols keep only frame, fill, status overlays and selection ring.
  const compact = g.size < 20;
  const strokeW = compact ? 1.25 : FRAME_STROKE_W;

  const destroyed = opts.status === "destroyed";
  const withdrawn = opts.status === "withdrawn";
  const damaged = opts.status === "damaged";

  const fillColor = destroyed ? FILL_DESATURATED : frameColor(aff);
  const fillOpacity = withdrawn ? ' fill-opacity="0.35"' : "";
  const dash = withdrawn ? ' stroke-dasharray="4 3"' : "";

  const parts: string[] = [];

  // Frame + icon group (dimmed as a whole when destroyed).
  const body: string[] = [];

  // Subtle dark outer stroke (halo) so the symbol reads on satellite imagery.
  body.push(
    `<path d="${paths.edge}" fill="none" stroke="#000000" stroke-width="${n(strokeW + (compact ? 1.5 : 2))}" ` +
      `stroke-opacity="0.55" stroke-linejoin="round" stroke-linecap="round"${dash}/>`
  );

  // Fill of the (closed) silhouette. For open frames this fills the area
  // bounded by the open edge without stroking it.
  body.push(`<path d="${paths.fill}" fill="${fillColor}"${fillOpacity} stroke="none"/>`);

  // Frame stroke; open frames stroke only the open outline.
  body.push(
    `<path d="${paths.edge}" fill="none" stroke="${INK}" stroke-width="${strokeW}" ` +
      `stroke-linejoin="miter" stroke-linecap="square"${dash}/>`
  );

  // Icon.
  if (!compact) {
    body.push(iconMarkup(icon, g.shape, interiorBox(g.shape, g.fx, g.fy, g.fw, g.fh), g.size));
  }

  if (destroyed) {
    parts.push(`<g opacity="0.55">${body.join("")}</g>`);
  } else {
    parts.push(body.join(""));
  }

  // Status overlays drawn at full opacity across the frame box.
  const slashW = compact ? 1.5 : 2;
  const crossW = compact ? 1.8 : 2.5;
  if (damaged) {
    parts.push(
      `<line x1="${n(g.fx)}" y1="${n(g.fy + g.fh)}" x2="${n(g.fx + g.fw)}" y2="${n(g.fy)}" ` +
        `stroke="${AMBER}" stroke-width="${slashW}" stroke-linecap="round"/>`
    );
  }
  if (destroyed) {
    parts.push(
      `<line x1="${n(g.fx)}" y1="${n(g.fy + g.fh)}" x2="${n(g.fx + g.fw)}" y2="${n(g.fy)}" ` +
        `stroke="${RED}" stroke-width="${crossW}" stroke-linecap="round"/>` +
        `<line x1="${n(g.fx)}" y1="${n(g.fy)}" x2="${n(g.fx + g.fw)}" y2="${n(g.fy + g.fh)}" ` +
        `stroke="${RED}" stroke-width="${crossW}" stroke-linecap="round"/>`
    );
  }

  // Strength bar directly under the frame, on a dark track. Compact symbols
  // omit it (the geometry still reserves its slot so anchors stay stable).
  if (!compact) {
    const st = Number.isFinite(opts.strength) ? Math.max(0, Math.min(100, opts.strength)) : 0;
    const barColor = st > 60 ? BAR_GREEN : st > 30 ? BAR_AMBER : BAR_RED;
    const barW = (g.fw * st) / 100;
    parts.push(
      `<rect x="${n(g.fx)}" y="${n(g.barY)}" width="${n(g.fw)}" height="${BAR_H}" fill="${INK}" opacity="0.85"/>`
    );
    if (barW > 0) {
      parts.push(
        `<rect x="${n(g.fx)}" y="${n(g.barY)}" width="${n(barW)}" height="${BAR_H}" fill="${barColor}"/>`
      );
    }
  }

  // Selected: 2px white ring offset ~2px outside the frame silhouette.
  // Painted last so the strength bar cannot clip its bottom edge.
  if (opts.selected) {
    const d = 3; // inflate so the ring gap reads as ~2px
    const ring = framePaths(g.shape, g.fx - d, g.fy - d, g.fw + d * 2, g.fh + d * 2, 2 + d);
    parts.push(
      `<path d="${ring.edge}" fill="none" stroke="#FFFFFF" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.svgW}" height="${g.svgH}" ` +
    `viewBox="0 0 ${g.svgW} ${g.svgH}" style="display:block;overflow:visible">` +
    parts.join("") +
    `</svg>`
  );
}

export function milSymbolHtml(opts: MilSymbolOptions): MilSymbolResult {
  const g = computeGeom(opts);
  const svg = milSymbolSvg(opts);
  const html =
    `<div style="position:relative;width:${g.svgW}px;height:${g.svgH}px;line-height:0">` +
    svg +
    `</div>`;
  return {
    html,
    width: g.svgW,
    height: g.svgH,
    anchorX: g.anchorX,
    anchorY: g.anchorY,
  };
}

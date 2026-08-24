// OPORD parsing, the "Intelligent Documents" pipeline.
// Turns an operational-order text into structured sides/entities/objectives, then
// materializes a ready-to-run Scenario. Uses the Anthropic Messages API when a key
// is present; a deterministic offline parser covers the bundled sample and any
// document following the same bullet conventions. Zero npm dependencies.

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Class matching
// ---------------------------------------------------------------------------

// Aliases seen in operational text → ontology class ids.
const CLASS_ALIASES = [
  [/aircraft carrier|carrier|cvn/i, "maritime.carrier"],
  [/guided[- ]missile destroyer|destroyer|ddg/i, "maritime.destroyer"],
  [/frigate|ffg/i, "maritime.frigate"],
  [/submarine|ssn|ssk|boat, attack/i, "maritime.submarine"],
  [/amphibious|lhd|lha|assault ship/i, "maritime.amphibious"],
  [/auxiliary|oiler|replenishment|supply ship/i, "maritime.auxiliary"],
  [/missile boat|fast attack craft|fac/i, "maritime.missile-boat"],
  [/corvette/i, "maritime.corvette"],
  [/fighter squadron|fighter|f\/a|interceptor/i, "air.fighter-squadron"],
  [/strike squadron|bomber/i, "air.strike-squadron"],
  [/early warning|aew|awacs/i, "air.aew"],
  [/maritime patrol|mpa|patrol aircraft/i, "air.maritime-patrol"],
  [/uav|drone|unmanned/i, "air.uav-recon"],
  [/marine battalion|marines|infantry battalion/i, "land.marine-battalion"],
  [/coastal (defense|missile) battery|anti-ship battery|shore battery/i, "land.coastal-battery"],
  [/sam battalion|air defense battalion|surface-to-air/i, "land.sam-battalion"],
  [/artillery/i, "land.artillery"],
  [/cyber/i, "cyber.ops-cell"],
  [/satellite|constellation|space/i, "space.recon-constellation"],
];

export function matchClass(freetext, classes) {
  const text = String(freetext || "").toLowerCase();
  // Exact label containment first.
  for (const cls of classes) {
    if (cls.label && text.includes(cls.label.toLowerCase())) return cls;
  }
  for (const [re, id] of CLASS_ALIASES) {
    if (re.test(text)) {
      const cls = classes.find((c) => c.id === id);
      if (cls) return cls;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offline deterministic parser
// ---------------------------------------------------------------------------

const SIDE_HEADINGS = [
  { side: "blue", re: /^\s*(?:\d+\.\s*)?(blue|friendly|own|coalition)\s+forces/i },
  { side: "red", re: /^\s*(?:\d+\.\s*)?(red|enemy|opfor|opposing)\s+forces/i },
];
const OBJECTIVES_RE = /^\s*(?:\d+\.\s*)?(mission|objectives|mission \/ objectives)/i;
const CONSTRAINTS_RE = /^\s*(?:\d+\.\s*)?(constraints|coordinating instructions|restrictions)/i;

const ENTITY_RE =
  /^\s*[-•]\s*(?:(\d+)\s*[x×]\s*)?(.+?)\s+(?:at|vic|near)\s+(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)(?:\s*\((?:TF|task force)\s+([^)]+)\))?\s*$/i;
const OBJECTIVE_RE = /^\s*[-•]\s*\((blue|red)\)\s*(.+)$/i;

function objectiveKind(text) {
  const t = text.toLowerCase();
  if (/(seize|control|secure|capture)/.test(t)) return "control-area";
  if (/(destroy|neutrali|strike)/.test(t)) return "destroy";
  if (/(protect|escort|defend|screen)/.test(t)) return "protect";
  if (/(deny|block|interdict)/.test(t)) return "deny";
  if (/(deliver|land|transport|sealift)/.test(t)) return "deliver";
  return "control-area";
}

export function parseOpordOffline(text, classes) {
  const lines = String(text || "").split(/\r?\n/);
  const title = (lines.find((l) => l.trim().length > 4) || "Untitled operational order").trim();
  let section = null; // "blue" | "red" | "objectives" | "constraints"
  const sides = { blue: [], red: [] };
  const objectives = [];
  const constraints = [];
  const unparsed = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sideHead = SIDE_HEADINGS.find((h) => h.re.test(line));
    if (sideHead) {
      section = sideHead.side;
      continue;
    }
    if (OBJECTIVES_RE.test(line)) {
      section = "objectives";
      continue;
    }
    if (CONSTRAINTS_RE.test(line)) {
      section = "constraints";
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      section = null; // any other numbered section ends entity capture
      continue;
    }

    if (section === "blue" || section === "red") {
      const m = line.match(ENTITY_RE);
      if (!m) {
        if (/^[-•]/.test(line)) unparsed.push(line);
        continue;
      }
      const [, countStr, desc, latStr, lngStr, taskForce] = m;
      const quoted = desc.match(/["“]([^"”]+)["”]/);
      const cls = matchClass(desc.replace(/["“][^"”]*["”]/g, ""), classes) ?? matchClass(desc, classes);
      if (!cls) {
        unparsed.push(line);
        continue;
      }
      sides[section].push({
        name: quoted ? quoted[1] : null,
        classId: cls.id,
        classLabel: cls.label,
        domain: cls.domain || "sea",
        count: Math.max(1, Math.min(6, Number(countStr) || 1)),
        position: { lat: round2(Number(latStr)), lng: round2(Number(lngStr)) },
        taskForce: taskForce ? taskForce.trim() : null,
      });
      continue;
    }
    if (section === "objectives") {
      const m = line.match(OBJECTIVE_RE);
      if (m) objectives.push({ side: m[1].toLowerCase(), title: m[2].trim(), kind: objectiveKind(m[2]) });
      continue;
    }
    if (section === "constraints" && /^[-•]/.test(line)) {
      constraints.push(line.replace(/^[-•]\s*/, ""));
    }
  }

  return {
    source: "offline",
    title,
    summary: `${sides.blue.length} BLUE and ${sides.red.length} RED entity group(s) extracted, ${objectives.length} objective(s), ${constraints.length} constraint(s).`,
    sides: [
      { side: "blue", entities: sides.blue },
      { side: "red", entities: sides.red },
    ],
    objectives,
    constraints,
    unparsed,
  };
}

// ---------------------------------------------------------------------------
// Anthropic extraction (falls back to the offline parser on any failure)
// ---------------------------------------------------------------------------

export async function parseOpordAnthropic(text, classes, apiKey, model) {
  const catalog = classes.map((c) => `${c.id}, ${c.label} (${c.domain || "any"})`).join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 6000,
        system:
          "You extract structured wargame scenario data from fictional exercise operational orders. " +
          "Reply with STRICT JSON only, no markdown fences, no prose. Schema: " +
          '{"title":string,"summary":string(<=200 chars),"sides":[{"side":"blue"|"red","entities":[{"name":string|null,' +
          '"classId":string,"count":number,"position":{"lat":number,"lng":number},"taskForce":string|null}]}],' +
          '"objectives":[{"side":"blue"|"red","title":string,"kind":"control-area"|"destroy"|"protect"|"deliver"|"deny"}],' +
          '"constraints":[string]}. ' +
          "classId MUST be one of the catalog ids below (pick the closest). Coordinates are decimal degrees. " +
          "Every entity needs a position; infer from context if a group shares one.\n\nCLASS CATALOG:\n" +
          catalog,
        messages: [{ role: "user", content: `Extract the scenario data from this exercise OPORD:\n\n${text}` }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.stop_reason === "refusal") return null;
    const rawText = (data.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(rawText);
    // Validate + coerce against the catalog; salvage bad classIds via the alias matcher.
    const byId = new Map(classes.map((c) => [c.id, c]));
    const sides = [];
    for (const sideName of ["blue", "red"]) {
      const found = (parsed.sides || []).find((s) => s && s.side === sideName);
      const entities = [];
      for (const e of (found && found.entities) || []) {
        if (!e || !e.position) continue;
        let cls = byId.get(e.classId) || matchClass(e.classId, classes) || matchClass(e.name || "", classes);
        if (!cls) continue;
        entities.push({
          name: e.name ? String(e.name).slice(0, 60) : null,
          classId: cls.id,
          classLabel: cls.label,
          domain: cls.domain || "sea",
          count: Math.max(1, Math.min(6, Number(e.count) || 1)),
          position: { lat: round2(Number(e.position.lat) || 0), lng: round2(Number(e.position.lng) || 0) },
          taskForce: e.taskForce ? String(e.taskForce).slice(0, 40) : null,
        });
      }
      sides.push({ side: sideName, entities });
    }
    if (!sides[0].entities.length && !sides[1].entities.length) return null;
    return {
      source: "anthropic",
      title: String(parsed.title || "Operational order").slice(0, 120),
      summary: String(parsed.summary || "").slice(0, 240),
      sides,
      objectives: (parsed.objectives || [])
        .filter((o) => o && (o.side === "blue" || o.side === "red") && o.title)
        .map((o) => ({
          side: o.side,
          title: String(o.title).slice(0, 140),
          kind: ["control-area", "destroy", "protect", "deliver", "deny"].includes(o.kind) ? o.kind : objectiveKind(String(o.title)),
        })),
      constraints: (parsed.constraints || []).map((c) => String(c).slice(0, 160)).slice(0, 8),
      unparsed: [],
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenario materialization
// ---------------------------------------------------------------------------

const DOMAIN_BASELINE = {
  sea: { speedKts: 16, sensors: [{ type: "surface-search-radar", rangeKm: 45 }], weapons: [{ type: "gun", rangeKm: 12, pk: 0.3, ammo: 20 }] },
  air: { speedKts: 420, sensors: [{ type: "air-search-radar", rangeKm: 120 }], weapons: [{ type: "aam", rangeKm: 80, pk: 0.55, ammo: 6 }] },
  land: { speedKts: 0, sensors: [{ type: "surface-search-radar", rangeKm: 60 }], weapons: [{ type: "ssm", rangeKm: 110, pk: 0.5, ammo: 8 }] },
  cyber: { speedKts: 0, sensors: [{ type: "elint", rangeKm: 400 }], weapons: [{ type: "cyber-effect", rangeKm: 500, pk: 0.3, ammo: 12 }] },
  space: { speedKts: 0, sensors: [{ type: "elint", rangeKm: 800 }], weapons: [] },
};

function statsTemplateFor(classId, domain, state) {
  for (const scn of state.scenarios) {
    const unit = (scn.units || []).find((u) => u.classId === classId);
    if (unit) return { speedKts: unit.speedKts, sensors: deepClone(unit.sensors), weapons: deepClone(unit.weapons) };
  }
  const cls = state.ontology.classes.find((c) => c.id === classId);
  if (cls && cls.defaults) {
    return { speedKts: cls.defaults.speedKts ?? 12, sensors: deepClone(cls.defaults.sensors ?? []), weapons: deepClone(cls.defaults.weapons ?? []) };
  }
  return deepClone(DOMAIN_BASELINE[domain] || DOMAIN_BASELINE.sea);
}

function centroid(entities) {
  if (!entities.length) return { lat: 34, lng: -40.9 };
  return {
    lat: round2(entities.reduce((s, e) => s + e.position.lat, 0) / entities.length),
    lng: round2(entities.reduce((s, e) => s + e.position.lng, 0) / entities.length),
  };
}

export function materializeScenario(parse, opts, state, nowIso) {
  const name = String(opts.name || parse.title || "OPORD scenario").slice(0, 80);
  const codename = String(opts.codename || name.replace(/^opord\s*[\d-]*\s*[—-]?\s*/i, "") || "IMPORTED ORDER")
    .toUpperCase()
    .slice(0, 40);
  let idBase = `scn-opord-${codename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
  let id = idBase;
  let n = 2;
  while (state.scenarios.some((s) => s.id === id)) id = `${idBase}-${n++}`;

  const blue = parse.sides.find((s) => s.side === "blue")?.entities ?? [];
  const red = parse.sides.find((s) => s.side === "red")?.entities ?? [];
  const all = [...blue, ...red];
  const center = centroid(all);

  const units = [];
  let seq = 0;
  for (const entity of all) {
    const side = blue.includes(entity) ? "blue" : "red";
    const stats = statsTemplateFor(entity.classId, entity.domain, state);
    for (let i = 0; i < entity.count; i++) {
      seq += 1;
      const jitter = entity.count > 1 ? { lat: (i - (entity.count - 1) / 2) * 0.07, lng: ((i % 2) - 0.5) * 0.06 } : { lat: 0, lng: 0 };
      units.push({
        id: `${side}-op-${String(seq).padStart(2, "0")}`,
        side,
        name: entity.name
          ? entity.count > 1
            ? `${entity.name} ${i + 1}`
            : entity.name
          : `${entity.classLabel}${entity.count > 1 ? ` ${i + 1}` : ""} (${side.toUpperCase()})`,
        classId: entity.classId,
        domain: entity.domain,
        position: { lat: round2(entity.position.lat + jitter.lat), lng: round2(entity.position.lng + jitter.lng) },
        headingDeg: side === "blue" ? 90 : 270,
        speedKts: stats.speedKts,
        strength: 100,
        supply: 88,
        sensors: deepClone(stats.sensors),
        weapons: deepClone(stats.weapons),
        status: "active",
        taskForce: entity.taskForce || undefined,
        notes: `Imported from operational document "${parse.title}".`,
      });
    }
  }

  const objectives = parse.objectives.map((o, i) => {
    const own = o.side === "blue" ? blue : red;
    const enemy = o.side === "blue" ? red : blue;
    const anchor = o.kind === "protect" || o.kind === "deliver" ? centroid(own) : centroid(enemy);
    return {
      id: `obj-${id}-${i + 1}`,
      side: o.side,
      title: o.title,
      description: `${o.title} (from operational document).`,
      kind: o.kind,
      area: { center: anchor, radiusKm: o.kind === "protect" ? 30 : 40 },
      weight: 1,
    };
  });
  for (const side of ["blue", "red"]) {
    const own = objectives.filter((o) => o.side === side);
    own.forEach((o) => (o.weight = round2(1 / Math.max(1, own.length))));
  }

  return {
    id,
    name,
    codename,
    description:
      (parse.summary ? `${parse.summary} ` : "") +
      `Generated from an operational document by the Intelligent Documents pipeline (${parse.source}).` +
      (parse.constraints.length ? ` Constraints: ${parse.constraints.join("; ")}.` : ""),
    theater: "Meridian Archipelago",
    mapCenter: center,
    mapZoom: 7,
    durationHours: Number(opts.durationHours) || 72,
    status: "ready",
    createdBy: String(opts.createdBy || "Plans Cell (J5)"),
    updatedAt: nowIso(),
    sides: [
      { id: "blue", name: "BLUE · Coalition Task Force", commander: "CDRE Ada Reyes", color: "#1f5f99" },
      { id: "red", name: "RED · Opposing Force (OPFOR)", commander: "COL Stefan Marek", color: "#b42318" },
    ],
    units,
    objectives,
    environment: { weather: "clear", seaState: 3, visibilityKm: 18, emcon: "restricted", cyberThreat: "elevated" },
  };
}

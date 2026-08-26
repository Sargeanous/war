// SANDTABLE intel-to-COA bridge: the cue inbox and the Scenario Architect core.
// SANDTABLE never detects anything itself. It CONSUMES normalised cues, either
// live from BASEER (the Global Situational Awareness platform) or from the
// bundled replay, then turns a confirmed cue into a runnable scenario through
// materializeScenario in opord.mjs. Every AI step here has an offline
// deterministic twin so the demo works with no API key. Zero npm dependencies.

import { matchClass } from "./opord.mjs";

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clampPct = (n) => clamp(Math.round(Number(n) || 0), 0, 100);

// ---------------------------------------------------------------------------
// Theater bounds. Every coordinate this module emits into a scenario is held
// inside the Meridian Archipelago box, with an inner margin so the formation
// jitter materializeScenario applies cannot walk a unit outside it.
// ---------------------------------------------------------------------------

const THEATER_BOX = { minLat: 22.9, maxLat: 25.1, minLng: 58.7, maxLng: 63.7 };
const THEATER_CENTER = { lat: 23.85, lng: 61.1 };
const EDGE_MARGIN = 0.12;

const inTheater = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= THEATER_BOX.minLat &&
  lat <= THEATER_BOX.maxLat &&
  lng >= THEATER_BOX.minLng &&
  lng <= THEATER_BOX.maxLng;

// A non-finite coordinate falls back to the theater centre. A real zero is kept
// and clamped like any other out-of-theater value, so an equatorial coordinate
// is not silently rewritten as the centre of the exercise map.
function clampPos(lat, lng) {
  const latN = Number(lat);
  const lngN = Number(lng);
  return {
    lat: round2(clamp(Number.isFinite(latN) ? latN : THEATER_CENTER.lat, THEATER_BOX.minLat + EDGE_MARGIN, THEATER_BOX.maxLat - EDGE_MARGIN)),
    lng: round2(clamp(Number.isFinite(lngN) ? lngN : THEATER_CENTER.lng, THEATER_BOX.minLng + EDGE_MARGIN, THEATER_BOX.maxLng - EDGE_MARGIN)),
  };
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const SEVERITIES = ["critical", "high", "medium", "low"];
const ORIGINS = ["focalpoint", "chokepoint", "surge", "conflict", "event"];

const slug = (text, words = 8) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, words)
    .join("-") || "cue";

// ---------------------------------------------------------------------------
// Seeded inbox, present at boot so the page is never empty
// ---------------------------------------------------------------------------

const entity = (id, kind, name, lat, lng, opts = {}) => ({
  id,
  kind,
  name,
  lat: round4(lat),
  lng: round4(lng),
  courseDeg: opts.courseDeg ?? null,
  speedKts: opts.speedKts ?? null,
  classHint: opts.classHint ?? null,
  affiliation: opts.affiliation || "unknown",
});

export function buildIntelCues() {
  return [
    {
      id: "cue-serpent-shoal-loiter",
      origin: "event",
      title: "Unregistered hulls loitering off Serpent Shoal",
      severity: "medium",
      confidence: 46,
      state: "new",
      geo: { lat: 23.62, lng: 61.65, radiusKm: 28 },
      observedAt: "2026-08-26T03:48:00Z",
      narrative:
        "Three hulls have held station inside a 28 km circle north of Serpent Shoal for eleven hours with transponders intermittent. Two came in from the eastern approaches and never resumed a track. No commercial reason to loiter here, the shoal has no anchorage and the nearest lane is 40 km south.",
      entities: [
        entity("ent-ssl-01", "vessel", "Contact SIERRA-1", 23.62, 61.58, { courseDeg: 95, speedKts: 3, classHint: "class-patrol-boat", affiliation: "unknown" }),
        entity("ent-ssl-02", "vessel", "Contact SIERRA-2", 23.58, 61.71, { courseDeg: 270, speedKts: 2, classHint: "class-patrol-boat", affiliation: "unknown" }),
        entity("ent-ssl-03", "vessel", "MV Kestrel Dawn", 23.66, 61.66, { courseDeg: 180, speedKts: 1, classHint: "class-tanker", affiliation: "neutral" }),
      ],
      provenance: {
        sources: ["AIS gap correlation", "Coastal HF direction finding", "Commercial optical revisit"],
        sensor: "BASEER maritime track fusion",
        detector: "loiter-anomaly v3",
        collectedAt: "2026-08-26T03:48:00Z",
      },
      assessment: null,
      collection: [],
      handoffs: [
        {
          id: "hnd-ssl-01",
          at: "2026-08-26T03:49:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Ingested cue",
          detail: "Normalised the BASEER event stream alert, 3 hulls holding station for eleven hours with transponders intermittent, confidence 46%.",
          source: "offline",
          latencyMs: 70,
        },
      ],
      ingestHandoffId: "hnd-ssl-01",
      scenarioId: null,
    },
    {
      id: "cue-north-channel-emitters",
      origin: "focalpoint",
      title: "Emitter cluster forming in the North Meridian Channel",
      severity: "high",
      confidence: 63,
      state: "reviewing",
      geo: { lat: 24.45, lng: 62.02, radiusKm: 45 },
      observedAt: "2026-08-26T05:20:00Z",
      narrative:
        "Fourteen radio-frequency signals from six distinct emitter types have collapsed into one 45 km cluster across the North Meridian Channel in under four hours. The mix pairs surface search radars with a military datalink waveform, which is a control relationship rather than a coincidence of traffic.",
      entities: [
        entity("ent-nce-01", "vessel", "Contact NOVEMBER-1", 24.48, 61.98, { courseDeg: 250, speedKts: 18, classHint: "class-corvette", affiliation: "hostile" }),
        entity("ent-nce-02", "vessel", "Contact NOVEMBER-2", 24.36, 62.12, { courseDeg: 240, speedKts: 22, classHint: "class-missile-boat", affiliation: "hostile" }),
        entity("ent-nce-03", "facility", "Ilha Norte emitter site", 24.79, 61.86, { classHint: "class-radar-site", affiliation: "hostile" }),
      ],
      provenance: {
        sources: ["RF geolocation network", "Datalink waveform library", "Synthetic aperture radar revisit"],
        sensor: "BASEER RF geolocation",
        detector: "focalpoint-clustering v4",
        collectedAt: "2026-08-26T05:20:00Z",
      },
      assessment: {
        unitType: "Naval surface picket with a shore control node",
        intent:
          "Establish a cued surveillance and engagement picture over the northern channel, most likely as the sensing half of an anti-access posture rather than an exercise.",
        confidence: 68,
        sources: ["RF geolocation network", "Datalink waveform library", "Synthetic aperture radar revisit"],
        reasoning:
          "Six emitter types inside 45 km, two of them fire-control class, is a battery-plus-sensor pairing and not commercial density. The two surface contacts hold a mutual support interval consistent with a picket line, and the shore site on Ilha Norte carries the only datalink emission in the cluster, which makes it the control node.",
        source: "offline",
        latencyMs: 640,
        atIso: "2026-08-26T05:34:00Z",
        handoffId: "hnd-nce-02",
      },
      collection: [],
      handoffs: [
        {
          id: "hnd-nce-01",
          at: "2026-08-26T05:22:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Ingested cue",
          detail: "Normalised the BASEER focal point into an intel cue, 14 signals across 6 emitter types, confidence 63%.",
          source: "offline",
          latencyMs: 90,
        },
        {
          id: "hnd-nce-02",
          at: "2026-08-26T05:34:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Identified unit",
          detail: "Assessed a naval surface picket with a shore control node at 68% confidence. Held at Possible pending collection.",
          source: "offline",
          latencyMs: 640,
        },
      ],
      ingestHandoffId: "hnd-nce-01",
      scenarioId: null,
    },
    {
      id: "cue-halfmoon-transit-spike",
      origin: "chokepoint",
      title: "Military transit spike through the Half-Moon Bank narrows",
      severity: "critical",
      confidence: 88,
      state: "confirmed",
      geo: { lat: 24.28, lng: 62.6, radiusKm: 55 },
      observedAt: "2026-08-26T06:05:00Z",
      narrative:
        "Transits through the Half-Moon Bank narrows have run at 31 hulls in twelve hours against a seven-hull baseline, and nine of the thirty-one are military. Commercial traffic has stopped using the northern lane entirely, which is the signature of a closure being enforced rather than a scheduling artefact.",
      entities: [
        entity("ent-hts-01", "vessel", "Contact HOTEL-1", 24.3, 62.6, { courseDeg: 265, speedKts: 24, classHint: "class-corvette", affiliation: "hostile" }),
        entity("ent-hts-02", "vessel", "Contact HOTEL-2", 24.24, 62.68, { courseDeg: 260, speedKts: 26, classHint: "class-missile-boat", affiliation: "hostile" }),
        entity("ent-hts-03", "vessel", "Contact HOTEL-3", 24.36, 62.52, { courseDeg: 255, speedKts: 22, classHint: "class-frigate", affiliation: "hostile" }),
        entity("ent-hts-04", "aircraft", "Track HOTEL-9", 24.18, 62.44, { courseDeg: 270, speedKts: 340, classHint: "class-maritime-patrol", affiliation: "hostile" }),
      ],
      provenance: {
        sources: ["Chokepoint transit baseline", "Naval vessel recognition", "Air track fusion", "Port departure records"],
        sensor: "BASEER chokepoint monitor",
        detector: "chokepoint-transit-baseline v2",
        collectedAt: "2026-08-26T06:05:00Z",
      },
      assessment: {
        unitType: "Surface action group, missile-armed, with organic maritime patrol",
        intent:
          "Screen and then close the northern narrows to coalition shipping, holding the lane under missile cover while the follow-on force moves west.",
        confidence: 88,
        sources: ["Chokepoint transit baseline", "Naval vessel recognition", "Air track fusion", "Port departure records"],
        reasoning:
          "Nine military hulls out of thirty-one transits against a seven-hull baseline is a four-fold departure that no commercial cycle produces. Full motion video resolved a launcher fit on two of the three surface contacts and the patrol aircraft is flying a barrier pattern west of them, so the group is sensing ahead of its own movement.",
        source: "offline",
        latencyMs: 720,
        atIso: "2026-08-26T06:41:00Z",
        handoffId: "hnd-hts-06",
      },
      collection: [
        {
          id: "tsk-hts-01",
          taskingId: "902853-RRN",
          asset: "IRIS-52 MQ-9",
          mode: "FMV",
          resolutionM: 0.3,
          etaMinutes: 12,
          priority: "urgent",
          status: "collected",
          requestedAt: "2026-08-26T06:12:00Z",
          approvedBy: "LTC Amina Faraj, Collection Manager (J2)",
          approvedAt: "2026-08-26T06:18:00Z",
          collectedAt: "2026-08-26T06:38:00Z",
          result:
            "Full motion video over the narrows confirmed four canister launchers on the lead hull and two on the second, both with covers off and crews closed up. Third hull held a helicopter on deck. No merchant traffic inside the narrows for the duration of the pass.",
          requestHandoffId: "hnd-hts-03",
          approveHandoffId: "hnd-hts-04",
          collectHandoffId: "hnd-hts-05",
        },
      ],
      handoffs: [
        {
          id: "hnd-hts-01",
          at: "2026-08-26T06:06:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Ingested cue",
          detail: "Normalised the BASEER chokepoint alert, 31 transits against a 7-hull baseline, 9 military, confidence 88%.",
          source: "offline",
          latencyMs: 80,
        },
        {
          id: "hnd-hts-02",
          at: "2026-08-26T06:11:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Identified unit",
          detail: "Assessed a missile-armed surface action group. Proposed two tasking options for confirmation.",
          source: "offline",
          latencyMs: 700,
        },
        {
          id: "hnd-hts-03",
          at: "2026-08-26T06:12:00Z",
          actor: "CDR Iris Okonkwo, Senior Watch Officer",
          kind: "human",
          autonomy: "human-required",
          action: "Requested collection tasking",
          detail: "Drafted tasking 902853-RRN against the narrows, IRIS-52 MQ-9 full motion video at 0.3 m, urgent. Held for a named collection manager to release it.",
          source: null,
          latencyMs: null,
        },
        {
          id: "hnd-hts-04",
          at: "2026-08-26T06:18:00Z",
          actor: "LTC Amina Faraj, Collection Manager (J2)",
          kind: "human",
          autonomy: "human-required",
          action: "Approved collection tasking",
          detail: "Approved tasking 902853-RRN, IRIS-52 MQ-9 full motion video at 0.3 m, urgent priority, 12 minute time on target.",
          source: null,
          latencyMs: null,
        },
        {
          id: "hnd-hts-05",
          at: "2026-08-26T06:38:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Reported collection",
          detail: "902853-RRN collected 20 minutes after release. Full motion video held the three hulls in frame for the whole pass and the product was filed against the cue.",
          source: "offline",
          latencyMs: 110,
        },
        {
          id: "hnd-hts-06",
          at: "2026-08-26T06:41:00Z",
          actor: "SAGE",
          kind: "ai",
          autonomy: "auto",
          action: "Fused collection result",
          detail: "Launcher fit resolved on two hulls. Recommended raising the track from Possible to Confirmed at 88%.",
          source: "offline",
          latencyMs: 720,
        },
        {
          id: "hnd-hts-07",
          at: "2026-08-26T06:47:00Z",
          actor: "CDR Iris Okonkwo, Senior Watch Officer",
          kind: "human",
          autonomy: "human-required",
          action: "Confirmed the track",
          detail: "Accepted the identification and raised the cue to Confirmed. Released the cue for scenario generation.",
          source: null,
          latencyMs: null,
        },
      ],
      ingestHandoffId: "hnd-hts-01",
      scenarioId: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// The replay script. Five further cues released one at a time, telling one
// escalating story and covering all five origin values.
// ---------------------------------------------------------------------------

export const CUE_SCRIPT = [
  {
    origin: "focalpoint",
    title: "OPFOR surface action group sorties west of Monte Meridian",
    severity: "medium",
    confidence: 52,
    state: "new",
    geo: { lat: 23.89, lng: 62.05, radiusKm: 40 },
    observedAt: null,
    narrative:
      "Four hulls have cleared the Monte Meridian roadstead on a westerly heading inside ninety minutes, which is the whole ready element of the flotilla moving at once. Two are running darkened. The grouping is tight enough to be a formation under a single command rather than four independent sailings.",
    entities: [
      entity("ent-sag-01", "vessel", "Contact WHISKEY-1", 23.92, 62.05, { courseDeg: 268, speedKts: 20, classHint: "class-corvette", affiliation: "hostile" }),
      entity("ent-sag-02", "vessel", "Contact WHISKEY-2", 23.86, 61.95, { courseDeg: 272, speedKts: 24, classHint: "class-missile-boat", affiliation: "hostile" }),
      entity("ent-sag-03", "vessel", "Contact WHISKEY-3", 23.79, 62.02, { courseDeg: 265, speedKts: 24, classHint: "class-missile-boat", affiliation: "hostile" }),
      entity("ent-sag-04", "vessel", "Contact WHISKEY-4", 24.0, 61.98, { courseDeg: 270, speedKts: 14, classHint: "class-auxiliary", affiliation: "hostile" }),
    ],
    provenance: {
      sources: ["RF geolocation network", "Synthetic aperture radar revisit", "Port departure records"],
      sensor: "BASEER maritime track fusion",
      detector: "focalpoint-clustering v4",
      collectedAt: null,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    ingestHandoffId: null,
    scenarioId: null,
  },
  {
    origin: "chokepoint",
    title: "Transit spike closing the Meridian Strait corridor",
    severity: "high",
    confidence: 61,
    state: "new",
    geo: { lat: 23.85, lng: 61.76, radiusKm: 35 },
    observedAt: null,
    narrative:
      "Transits through the strait corridor have gone from a nine-hull daily baseline to twenty-six in eight hours, and five of them are military. Every one of the five is holding inside the corridor rather than passing through it, so the corridor is being occupied, not used.",
    entities: [
      entity("ent-cor-01", "vessel", "Contact XRAY-1", 23.88, 61.72, { courseDeg: 20, speedKts: 12, classHint: "class-missile-boat", affiliation: "hostile" }),
      entity("ent-cor-02", "vessel", "Contact XRAY-2", 23.82, 61.8, { courseDeg: 200, speedKts: 11, classHint: "class-missile-boat", affiliation: "hostile" }),
      entity("ent-cor-03", "vessel", "Contact XRAY-3", 23.92, 61.62, { courseDeg: 355, speedKts: 16, classHint: "class-corvette", affiliation: "hostile" }),
      entity("ent-cor-04", "vessel", "Contact XRAY-4", 23.76, 61.86, { courseDeg: 180, speedKts: 6, classHint: "class-submarine", affiliation: "hostile" }),
      entity("ent-cor-05", "vessel", "MV Anselm Trader", 23.86, 61.9, { courseDeg: 250, speedKts: 9, classHint: "class-merchant", affiliation: "neutral" }),
    ],
    provenance: {
      sources: ["Chokepoint transit baseline", "AIS gap correlation", "Naval vessel recognition"],
      sensor: "BASEER chokepoint monitor",
      detector: "chokepoint-transit-baseline v2",
      collectedAt: null,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    ingestHandoffId: null,
    scenarioId: null,
  },
  {
    origin: "surge",
    title: "Military air surge over the Monte Meridian airfield",
    severity: "high",
    confidence: 68,
    state: "new",
    geo: { lat: 23.99, lng: 62.36, radiusKm: 60 },
    observedAt: null,
    narrative:
      "Military air movements over Monte Meridian are running at a z-score of 4.1 against the thirty day baseline, a 310% increase, with nineteen sorties in the current six hour window against a mean of four. Two of the tracks are flying air-defense intercept geometry rather than transit routes.",
    entities: [
      entity("ent-air-01", "aircraft", "Track YANKEE-1", 23.98, 62.3, { courseDeg: 285, speedKts: 420, classHint: "class-fighter", affiliation: "hostile" }),
      entity("ent-air-02", "aircraft", "Track YANKEE-2", 24.06, 62.18, { courseDeg: 300, speedKts: 400, classHint: "class-fighter", affiliation: "hostile" }),
      entity("ent-air-03", "aircraft", "Track YANKEE-5", 23.88, 62.36, { courseDeg: 190, speedKts: 330, classHint: "class-maritime-patrol", affiliation: "hostile" }),
      entity("ent-air-04", "facility", "Monte Meridian airfield", 24.01, 62.53, { classHint: "class-airfield", affiliation: "hostile" }),
    ],
    provenance: {
      sources: ["Air track fusion", "Airfield activity imagery", "Datalink waveform library"],
      sensor: "BASEER air track fusion",
      detector: "surge-zscore v3",
      collectedAt: null,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    ingestHandoffId: null,
    scenarioId: null,
  },
  {
    origin: "event",
    title: "Coastal missile battery radiating on Ponta Oeste",
    severity: "critical",
    confidence: 79,
    state: "new",
    geo: { lat: 23.8, lng: 61.3, radiusKm: 30 },
    observedAt: null,
    narrative:
      "A fire-control emission consistent with an anti-ship missile battery has come up on Ponta Oeste, at the western end of the archipelago and directly across the coalition approach lane. The emitter went active, radiated for four minutes, then went silent, which is a readiness check rather than a routine calibration.",
    entities: [
      entity("ent-cmb-01", "ground", "Ponta Oeste battery position", 23.8, 61.3, { classHint: "class-coastal-battery", affiliation: "hostile" }),
      entity("ent-cmb-02", "facility", "Ponta Oeste fire-control radar", 23.84, 61.34, { classHint: "class-radar-site", affiliation: "hostile" }),
      entity("ent-cmb-03", "vessel", "Contact ZULU-1", 23.72, 61.24, { courseDeg: 340, speedKts: 18, classHint: "class-missile-boat", affiliation: "hostile" }),
    ],
    provenance: {
      sources: ["RF geolocation network", "Emitter parametric library", "Synthetic aperture radar revisit"],
      sensor: "BASEER RF geolocation",
      detector: "emitter-activation v5",
      collectedAt: null,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    ingestHandoffId: null,
    scenarioId: null,
  },
  {
    origin: "conflict",
    title: "Layered anti-access posture set across the Meridian Archipelago",
    severity: "critical",
    confidence: 86,
    state: "new",
    geo: { lat: 23.92, lng: 61.9, radiusKm: 90 },
    observedAt: null,
    narrative:
      "The four preceding cues now resolve into one posture. Surface pickets hold the strait, the air regiment is at surge tempo, the western battery is live and a sub-surface contact sits on the approach lane. Two declared exclusion notices have been broadcast covering the corridor. This is a closure of the archipelago, executed in sequence.",
    entities: [
      entity("ent-cvg-01", "vessel", "Contact WHISKEY-1", 23.9, 61.86, { courseDeg: 270, speedKts: 18, classHint: "class-corvette", affiliation: "hostile" }),
      entity("ent-cvg-02", "vessel", "Contact XRAY-1", 23.78, 61.72, { courseDeg: 200, speedKts: 12, classHint: "class-missile-boat", affiliation: "hostile" }),
      entity("ent-cvg-03", "aircraft", "Track YANKEE-1", 24.05, 62.1, { courseDeg: 280, speedKts: 410, classHint: "class-fighter", affiliation: "hostile" }),
      entity("ent-cvg-04", "ground", "Ponta Oeste battery position", 23.8, 61.3, { classHint: "class-coastal-battery", affiliation: "hostile" }),
      entity("ent-cvg-05", "vessel", "Contact XRAY-4", 23.68, 61.55, { courseDeg: 190, speedKts: 5, classHint: "class-submarine", affiliation: "hostile" }),
    ],
    provenance: {
      sources: ["Chokepoint transit baseline", "RF geolocation network", "Air track fusion", "Navigational warning broadcasts", "Naval vessel recognition"],
      sensor: "BASEER multi-source correlation",
      detector: "posture-convergence v2",
      collectedAt: null,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    ingestHandoffId: null,
    scenarioId: null,
  },
];

export function nextScriptedCue(cursor, nowIso) {
  const template = CUE_SCRIPT[Number(cursor)];
  if (!template) return null;
  const at = typeof nowIso === "function" ? nowIso() : String(nowIso || new Date().toISOString());
  const cue = deepClone(template);
  const stamp = at.replace(/\D/g, "").slice(-6);
  cue.id = `cue-${slug(template.title, 4)}-${stamp}`;
  cue.observedAt = at;
  cue.provenance.collectedAt = at;
  cue.state = "new";
  cue.assessment = null;
  cue.collection = [];
  cue.handoffs = [];
  // The ingest record is written where the push actually lands, when the cue is
  // admitted to the inbox, so the template leaves it null rather than inventing a
  // record for a hand-off that has not happened yet.
  cue.ingestHandoffId = null;
  cue.scenarioId = null;
  return cue;
}

// ---------------------------------------------------------------------------
// BASEER projection. Pure, tolerant of every shape quirk, never throws.
// Projected cues keep their reported real-world geography; the theater clamp is
// applied later, in cueToParse, when a cue becomes a scenario.
// ---------------------------------------------------------------------------

const ORIGIN_SENSOR = {
  focalpoint: "BASEER multi-source correlation",
  chokepoint: "BASEER chokepoint monitor",
  surge: "BASEER activity baseline",
  conflict: "BASEER conflict event feed",
  event: "BASEER event stream",
};

const ORIGIN_DETECTOR = {
  focalpoint: "focalpoint-clustering v4",
  chokepoint: "chokepoint-transit-baseline v2",
  surge: "surge-zscore v3",
  conflict: "conflict-event-correlation v1",
  event: "event-stream-triage v2",
};

const ORIGIN_RADIUS = { focalpoint: 45, chokepoint: 35, surge: 60, conflict: 25, event: 20 };

// Null, undefined and blank strings are rejected BEFORE the finite test.
// Number(null) is 0 and Number("") is 0, both finite, so a BASEER field that
// arrives explicitly null would otherwise be read as a real zero and would
// swallow the candidate that actually carries the value. Booleans, arrays and
// objects are rejected for the same reason, Number(true) is 1 and Number([]) is 0.
function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Same discipline for text. A finite number is accepted and stringified because
// BASEER sends several identifiers, MMSI above all, as numbers rather than
// strings, and dropping them loses the only name a contact has.
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readCoords(source) {
  if (!source || typeof source !== "object") return null;
  if (Array.isArray(source)) {
    // GeoJSON ordering, longitude first.
    const lng = firstFinite(source[0]);
    const lat = firstFinite(source[1]);
    return lat === null || lng === null ? null : { lat, lng };
  }
  const lat = firstFinite(source.lat, source.latitude, source.centerLat, source.center_lat, source.y);
  const lng = firstFinite(source.lng, source.lon, source.long, source.longitude, source.centerLng, source.center_lon, source.x);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function coordsOf(record) {
  if (!record || typeof record !== "object") return null;
  const candidates = [record, record.geo, record.location, record.center, record.centroid, record.position, record.coordinates, record.geometry && record.geometry.coordinates];
  for (const candidate of candidates) {
    const found = readCoords(candidate);
    if (!found) continue;
    if (Math.abs(found.lat) > 90 || Math.abs(found.lng) > 180) continue;
    if (found.lat === 0 && found.lng === 0) continue;
    return { lat: round4(found.lat), lng: round4(found.lng) };
  }
  return null;
}

// BASEER carries confidence on three incompatible scales. credibility and
// FocalPoint.confidence are already 0..100; confidenceScore is 0..10.
function normalizeConfidence(record) {
  const tenPoint = firstFinite(record.confidenceScore, record.confidence_score);
  if (tenPoint !== null) return clampPct(tenPoint > 10 ? tenPoint : tenPoint * 10);
  const hundredPoint = firstFinite(record.confidence, record.credibility, record.credibilityScore, record.reliability);
  if (hundredPoint !== null) return clampPct(hundredPoint <= 1 ? hundredPoint * 100 : hundredPoint);
  return 50;
}

function normalizeSeverity(record, confidence) {
  const raw = String(record.severity || record.severityLevel || record.priority || "").toLowerCase();
  if (SEVERITIES.includes(raw)) return raw;
  if (confidence >= 85) return "critical";
  if (confidence >= 65) return "high";
  if (confidence >= 40) return "medium";
  return "low";
}

function normalizeIso(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
    // A zero epoch is a missing field rather than 1970, so it falls through.
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
  }
  return new Date().toISOString();
}

function uniqueStrings(values, cap = 6) {
  const out = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

function affiliationOf(raw) {
  const text = String(raw || "").toLowerCase();
  if (/hostile|military|combatant|warship|opfor/.test(text)) return "hostile";
  if (/neutral|civil|commercial|merchant|fishing/.test(text)) return "neutral";
  return "unknown";
}

function plural(n, one, many) {
  return `${n} ${Math.abs(Number(n)) === 1 ? one : many}`;
}

const asArray = (value) => (Array.isArray(value) ? value : []);

function projectEntities(record, cueId, origin, anchor) {
  const out = [];
  const push = (kind, name, lat, lng, opts) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    out.push(entity(`${cueId}-e${out.length + 1}`, kind, name, lat, lng, opts));
  };

  for (const signal of asArray(record.signals).slice(0, 6)) {
    if (!signal || typeof signal !== "object") continue;
    const at = coordsOf(signal) || anchor;
    push("vessel", firstString(signal.title, signal.name, signal.type, signal.category) || "Reported signal", at.lat, at.lng, {
      classHint: firstString(signal.classHint, signal.vesselType, signal.type),
      affiliation: affiliationOf(firstString(signal.affiliation, signal.category, signal.type)),
      courseDeg: firstFinite(signal.courseDeg, signal.course, signal.heading),
      speedKts: firstFinite(signal.speedKts, signal.speed, signal.sog),
    });
  }

  for (const vessel of asArray(record.militaryVessels).slice(0, 6)) {
    if (!vessel || typeof vessel !== "object") continue;
    const at = coordsOf(vessel) || anchor;
    push("vessel", firstString(vessel.name, vessel.shipName, vessel.mmsi, vessel.callsign) || "Military vessel", at.lat, at.lng, {
      classHint: firstString(vessel.classHint, vessel.vesselType, vessel.shipType, vessel.type),
      affiliation: "hostile",
      courseDeg: firstFinite(vessel.courseDeg, vessel.course, vessel.heading),
      speedKts: firstFinite(vessel.speedKts, vessel.speed, vessel.sog),
    });
  }

  if (origin === "conflict") {
    const actors = uniqueStrings([record.actor1, record.actor2], 2);
    actors.forEach((actor, i) => {
      push("ground", actor, anchor.lat + (i === 0 ? 0.03 : -0.03), anchor.lng + (i === 0 ? -0.03 : 0.03), {
        classHint: "class-ground-formation",
        affiliation: "unknown",
      });
    });
  }

  if (!out.length) {
    const count = firstFinite(record.vesselCount, record.currentCount, record.signalCount, record.count) || 1;
    const kind = origin === "surge" ? "aircraft" : origin === "conflict" ? "ground" : "vessel";
    push(kind, `Aggregate reporting, ${plural(Math.max(1, Math.round(count)), "contact", "contacts")}`, anchor.lat, anchor.lng, {
      classHint: null,
      affiliation: "unknown",
    });
  }
  return out;
}

function projectNarrative(record, origin, confidence) {
  const given = firstString(record.narrative, record.summary, record.description, record.analysis, record.assessment);
  if (given) return given.slice(0, 700);
  const bits = [];
  if (origin === "focalpoint") {
    const signals = firstFinite(record.signalCount, asArray(record.signals).length);
    const types = firstFinite(record.typeCount);
    if (signals !== null) bits.push(plural(signals, "correlated signal", "correlated signals"));
    if (types !== null) bits.push(plural(types, "distinct signal type", "distinct signal types"));
  }
  if (origin === "chokepoint") {
    const vessels = firstFinite(record.vesselCount);
    const military = firstFinite(record.militaryCount, asArray(record.militaryVessels).length);
    if (vessels !== null) bits.push(`${plural(vessels, "transit", "transits")} observed`);
    if (military !== null) bits.push(`${military} assessed military`);
  }
  if (origin === "surge") {
    const z = firstFinite(record.zScore);
    const pct = firstFinite(record.percentIncrease);
    const current = firstFinite(record.currentCount);
    if (z !== null) bits.push(`z-score ${round2(z)} against baseline`);
    if (pct !== null) bits.push(`${Math.round(pct)}% increase`);
    if (current !== null) bits.push(`${plural(current, "event", "events")} in the current window`);
  }
  if (origin === "conflict") {
    const fatalities = firstFinite(record.fatalities);
    const actors = uniqueStrings([record.actor1, record.actor2], 2);
    if (actors.length) bits.push(`reported parties ${actors.join(" and ")}`);
    if (fatalities !== null) bits.push(plural(fatalities, "fatality report", "fatality reports"));
  }
  bits.push(`normalised confidence ${confidence}%`);
  return `Cue projected from BASEER: ${bits.join(", ")}.`;
}

function projectRecord(record, origin, usedIds) {
  if (!record || typeof record !== "object") return null;
  const anchor = coordsOf(record);
  if (!anchor) return null;

  const confidence = normalizeConfidence(record);
  const severity = normalizeSeverity(record, confidence);
  const title =
    firstString(record.title, record.name, record.label, record.headline, record.chokepointName, record.eventType) ||
    `${origin} cue at ${anchor.lat.toFixed(2)}, ${anchor.lng.toFixed(2)}`;
  const observedAt = normalizeIso(record.observedAt, record.timestamp, record.detectedAt, record.eventDate, record.date, record.createdAt, record.lastSeen);

  let id = `cue-${origin}-${slug(firstString(record.id, record._id, record.uuid) || title)}`;
  if (usedIds.has(id)) {
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  usedIds.add(id);

  const entities = projectEntities(record, id, origin, anchor);

  return {
    id,
    origin,
    title: title.slice(0, 140),
    severity,
    confidence,
    state: "new",
    geo: {
      lat: anchor.lat,
      lng: anchor.lng,
      radiusKm: Math.round(clamp(firstFinite(record.radiusKm, record.radius_km, record.radius) ?? ORIGIN_RADIUS[origin], 5, 400)),
    },
    observedAt,
    narrative: projectNarrative(record, origin, confidence),
    entities,
    provenance: {
      sources: uniqueStrings(
        [
          ...asArray(record.sources),
          ...asArray(record.signals).map((s) => s && (s.source || s.sourceName)),
          firstString(record.source, record.dataSource, record.feed),
          "BASEER",
        ],
        6
      ),
      sensor: firstString(record.sensor) || ORIGIN_SENSOR[origin],
      detector: firstString(record.detector, record.algorithm, record.rule) || ORIGIN_DETECTOR[origin],
      collectedAt: observedAt,
    },
    assessment: null,
    collection: [],
    handoffs: [],
    // Written when the projected cue is admitted to the inbox, not here: at this
    // point the push has been normalised but not yet recorded against a cue.
    ingestHandoffId: null,
    scenarioId: null,
  };
}

export function projectBaseerPayloads(payloads) {
  const bundle = payloads && typeof payloads === "object" ? payloads : {};
  const groups = [
    ["focalpoint", bundle.focalpoints],
    ["chokepoint", bundle.chokepointAlerts],
    ["surge", bundle.surge],
    ["conflict", bundle.conflicts],
    ["event", bundle.events],
  ];
  const usedIds = new Set();
  const out = [];
  for (const [origin, list] of groups) {
    for (const record of asArray(list)) {
      let cue = null;
      try {
        cue = projectRecord(record, origin, usedIds);
      } catch {
        cue = null;
      }
      if (cue) out.push(cue);
    }
  }
  out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence);
  return out;
}

// ---------------------------------------------------------------------------
// Live BASEER fetch. Falls back to null so the caller can run the replay.
// ---------------------------------------------------------------------------

const BASEER_ENDPOINTS = [
  ["focalpoints", "/api/focalpoints", "focalpoints"],
  ["chokepointAlerts", "/api/chokepoints/alerts", "alerts"],
  ["surge", "/api/surge", "surge"],
  ["conflicts", "/api/conflicts", "conflicts"],
  ["events", "/api/events?limit=50", "events"],
];

function unwrapEnvelope(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  for (const candidate of [payload.data, payload[key], payload.results, payload.items, payload.records]) {
    if (Array.isArray(candidate)) return candidate;
  }
  if (payload.data && typeof payload.data === "object") {
    for (const candidate of [payload.data[key], payload.data.results, payload.data.items]) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return null;
}

async function fetchEndpoint(baseUrl, path, key, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    return unwrapEnvelope(await response.json(), key);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function fetchBaseerCues(baseUrl, token) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return null;
  const settled = await Promise.allSettled(BASEER_ENDPOINTS.map(([, path, key]) => fetchEndpoint(base, path, key, token)));
  const payloads = {};
  let reached = 0;
  settled.forEach((result, i) => {
    const list = result.status === "fulfilled" ? result.value : null;
    payloads[BASEER_ENDPOINTS[i][0]] = list;
    if (list) reached += 1;
  });
  if (!reached) return null;
  return projectBaseerPayloads(payloads);
}

// ---------------------------------------------------------------------------
// Scenario Architect, deterministic core. A cue becomes a "parse" object that
// materializeScenario in opord.mjs turns into a runnable scenario.
// ---------------------------------------------------------------------------

const KIND_DOMAIN = { vessel: "sea", aircraft: "air", ground: "land", facility: "land" };

// Ontology class ids reached from a cue's classHint or entity name.
const CLASS_HINTS = [
  [/carrier|cvn/, "maritime.carrier"],
  [/destroyer|ddg/, "maritime.destroyer"],
  [/frigate|ffg/, "maritime.frigate"],
  [/submarine|ssk|ssn|sub surface/, "maritime.submarine"],
  [/amphib|landing ship|lhd|lha/, "maritime.amphibious"],
  [/auxiliary|tanker|oiler|replenish|merchant|cargo|freighter/, "maritime.auxiliary"],
  [/missile boat|fast attack|patrol boat|patrol craft/, "maritime.missile-boat"],
  [/corvette/, "maritime.corvette"],
  [/fighter|interceptor/, "air.fighter-squadron"],
  [/strike|bomber/, "air.strike-squadron"],
  [/aew|early warning|awacs/, "air.aew"],
  [/maritime patrol|patrol aircraft|mpa/, "air.maritime-patrol"],
  [/uav|drone|unmanned/, "air.uav-recon"],
  [/marine|infantry|ground formation/, "land.marine-battalion"],
  [/coastal|anti ship battery|shore battery/, "land.coastal-battery"],
  [/sam|air defence|air defense/, "land.sam-battalion"],
  [/artillery|rocket/, "land.artillery"],
  [/radar|surveillance site|emitter/, "facility.radar-site"],
  [/command post|headquarters|joint command/, "facility.command-post"],
  [/depot|logistic/, "facility.logistics-depot"],
  [/airfield|airstrip|runway/, "facility.airfield"],
];

const KIND_DEFAULT_CLASSES = {
  vessel: ["maritime.corvette", "maritime.missile-boat", "maritime.frigate"],
  aircraft: ["air.fighter-squadron", "air.strike-squadron", "air.maritime-patrol"],
  ground: ["land.coastal-battery", "land.artillery", "land.marine-battalion"],
  facility: ["facility.radar-site", "facility.command-post", "facility.airfield"],
};

function classCatalog(state) {
  const classes = (state && state.ontology && Array.isArray(state.ontology.classes) ? state.ontology.classes : []).filter(
    (c) => c && c.id && (c.category === "force" || c.category === "facility") && c.id.includes(".")
  );
  return classes;
}

function resolveClass(hint, name, kind, classes) {
  const byId = classes.find((c) => c.id === hint);
  if (byId) return byId;
  const text = `${hint || ""} ${name || ""}`
    .toLowerCase()
    .replace(/^class-/, "")
    .replace(/[-_.]+/g, " ");
  for (const [re, id] of CLASS_HINTS) {
    if (!re.test(text)) continue;
    const cls = classes.find((c) => c.id === id);
    if (cls) return cls;
  }
  const salvaged = matchClass(text, classes);
  if (salvaged) return salvaged;
  for (const id of KIND_DEFAULT_CLASSES[kind] || KIND_DEFAULT_CLASSES.vessel) {
    const cls = classes.find((c) => c.id === id);
    if (cls) return cls;
  }
  const domain = KIND_DOMAIN[kind] || "sea";
  return classes.find((c) => c.domain === domain) || classes[0] || null;
}

function cueAnchor(cue) {
  const geo = cue && cue.geo ? cue.geo : null;
  if (geo && inTheater(Number(geo.lat), Number(geo.lng))) return { lat: Number(geo.lat), lng: Number(geo.lng) };
  return { ...THEATER_CENTER };
}

// A cue projected from BASEER carries real-world coordinates. Its internal
// geometry is preserved as offsets and replayed around the theater anchor so the
// exercise map stays inside the Meridian Archipelago.
//
// The choice between keeping the reported coordinates and replaying the cue
// around the anchor is made ONCE per cue, in cuePlacement, and the resulting
// transform is applied to every entity of that cue. Deciding it per entity tore
// a grouping reported near the edge of the theater box apart: contacts inside
// the box kept real coordinates while their neighbours a few kilometres away
// were replayed around the centre, and the formation stopped being a formation.
const SPREAD_LAT = 0.6;
const SPREAD_LNG = 0.8;

const INNER_BOX = {
  minLat: THEATER_BOX.minLat + EDGE_MARGIN,
  maxLat: THEATER_BOX.maxLat - EDGE_MARGIN,
  minLng: THEATER_BOX.minLng + EDGE_MARGIN,
  maxLng: THEATER_BOX.maxLng - EDGE_MARGIN,
};

// Inside the box AND clear of the margin the formation jitter needs, so a point
// that passes this needs no clamping and cannot be pulled off its neighbours.
const placeable = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= INNER_BOX.minLat &&
  lat <= INNER_BOX.maxLat &&
  lng >= INNER_BOX.minLng &&
  lng <= INNER_BOX.maxLng;

function cuePlacement(anchor, reported, points) {
  const valid = asArray(points)
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ lat: firstFinite(p.lat), lng: firstFinite(p.lng) }))
    .filter((p) => p.lat !== null && p.lng !== null);
  const identity = { mode: "absolute", anchor, reference: anchor, scale: 1, shift: { lat: 0, lng: 0 } };
  if (!valid.length || valid.every((p) => placeable(p.lat, p.lng))) return identity;

  const reportedLat = reported ? firstFinite(reported.lat) : null;
  const reportedLng = reported ? firstFinite(reported.lng) : null;
  const reference = reportedLat !== null && reportedLng !== null ? { lat: reportedLat, lng: reportedLng } : anchor;

  // One scale for the whole cue, so a wide real-world spread is shrunk to fit
  // without changing the shape of the grouping.
  let spreadLat = 0;
  let spreadLng = 0;
  for (const p of valid) {
    spreadLat = Math.max(spreadLat, Math.abs(p.lat - reference.lat));
    spreadLng = Math.max(spreadLng, Math.abs(p.lng - reference.lng));
  }
  const scale = Math.min(1, spreadLat > SPREAD_LAT ? SPREAD_LAT / spreadLat : 1, spreadLng > SPREAD_LNG ? SPREAD_LNG / spreadLng : 1);

  // One translation for the whole cue, so a grouping that straddles the box edge
  // slides inside as one body instead of having its outliers clamped onto it.
  let loLat = 0;
  let hiLat = 0;
  let loLng = 0;
  let hiLng = 0;
  for (const p of valid) {
    const dLat = (p.lat - reference.lat) * scale;
    const dLng = (p.lng - reference.lng) * scale;
    loLat = Math.min(loLat, dLat);
    hiLat = Math.max(hiLat, dLat);
    loLng = Math.min(loLng, dLng);
    hiLng = Math.max(hiLng, dLng);
  }
  const shift = {
    lat: Math.max(0, INNER_BOX.minLat - (anchor.lat + loLat)) - Math.max(0, anchor.lat + hiLat - INNER_BOX.maxLat),
    lng: Math.max(0, INNER_BOX.minLng - (anchor.lng + loLng)) - Math.max(0, anchor.lng + hiLng - INNER_BOX.maxLng),
  };
  return { mode: "relative", anchor, reference, scale, shift };
}

// Where a synthetic addition hangs off the cue, the anchor after the cue-wide shift.
function placementAnchor(placement) {
  return clampPos(placement.anchor.lat + placement.shift.lat, placement.anchor.lng + placement.shift.lng);
}

function placePoint(placement, lat, lng) {
  const latN = firstFinite(lat);
  const lngN = firstFinite(lng);
  if (latN === null || lngN === null) return placementAnchor(placement);
  if (placement.mode === "absolute") return clampPos(latN, lngN);
  return clampPos(
    placement.anchor.lat + placement.shift.lat + (latN - placement.reference.lat) * placement.scale,
    placement.anchor.lng + placement.shift.lng + (lngN - placement.reference.lng) * placement.scale
  );
}

// Associated elements a duty officer would expect to find with the reported
// grouping. Added only when the cue itself reports too little to game against.
const RED_SUPPORT = [
  { name: "Cueing surveillance radar", classId: "facility.radar-site", kind: "facility", count: 1, dLat: 0.18, dLng: 0.34 },
  { name: "Strait picket element", classId: "maritime.missile-boat", kind: "vessel", count: 2, dLat: -0.16, dLng: 0.22 },
  { name: "Ready alert flight", classId: "air.fighter-squadron", kind: "aircraft", count: 1, dLat: 0.3, dLng: 0.48 },
  { name: "Coastal defense battery", classId: "land.coastal-battery", kind: "ground", count: 1, dLat: -0.06, dLng: 0.44 },
];

// Only tracks the cue carries as hostile, or as still unknown, become RED units.
// A track the cue explicitly calls neutral is civil traffic, and materializing a
// merchant as an OPFOR combatant would put a factual error into the generated
// scenario and quietly break the provenance story the cue is there to tell. The
// generated scenario carries BLUE and RED only, so neutral tracks are withheld
// rather than recoloured, and cueToParse states that in the scenario summary so
// the description stays truthful about what was and was not carried over.
// Unknown tracks are carried as RED, because an unidentified grouping is the
// thing the exercise exists to play against, and they are labelled as unresolved
// in the order of battle instead of being asserted as hostile.
function redEntities(cue, placement, classes) {
  const out = [];
  const withheldNeutral = [];
  let unknownCarried = 0;

  for (const source of asArray(cue.entities)) {
    if (!source || typeof source !== "object") continue;
    const affiliation = affiliationOf(source.affiliation);
    if (affiliation === "neutral") {
      withheldNeutral.push(firstString(source.name) || "unnamed track");
      continue;
    }
    const kind = KIND_DOMAIN[source.kind] ? source.kind : "vessel";
    const cls = resolveClass(source.classHint, source.name, kind, classes);
    if (!cls) continue;
    if (affiliation !== "hostile") unknownCarried += 1;
    out.push({
      name: firstString(source.name) || null,
      classId: cls.id,
      classLabel: cls.label,
      domain: cls.domain || KIND_DOMAIN[kind] || "sea",
      count: 1,
      position: placePoint(placement, source.lat, source.lng),
      taskForce: affiliation === "hostile" ? "Reported grouping" : "Unidentified grouping",
    });
  }

  const anchor = placementAnchor(placement);
  let units = out.reduce((sum, e) => sum + e.count, 0);
  for (const support of RED_SUPPORT) {
    if (units >= 4) break;
    const cls = resolveClass(support.classId, support.name, support.kind, classes);
    if (!cls) continue;
    out.push({
      name: support.name,
      classId: cls.id,
      classLabel: cls.label,
      domain: cls.domain || KIND_DOMAIN[support.kind] || "sea",
      count: support.count,
      position: clampPos(anchor.lat + support.dLat, anchor.lng + support.dLng),
      taskForce: "Associated defense",
    });
    units += support.count;
  }
  return { entities: out, withheldNeutral, unknownCarried };
}

// Standing response package, hand-placed relative to the response anchor so the
// group reads as a task force in column with its screen ahead and the
// high-value units behind. Offsets are degrees from that anchor.
const BLUE_SLOTS = {
  carrier: { classId: "maritime.carrier", name: "CVN 79 Vigilant", dLat: 0.0, dLng: -0.3, taskForce: "CTF-71 Watchkeeper" },
  destroyer1: { classId: "maritime.destroyer", name: "DDG 122 Bulwark", dLat: 0.24, dLng: -0.06, taskForce: "CTF-71 Watchkeeper" },
  destroyer2: { classId: "maritime.destroyer", name: "DDG 126 Ironside", dLat: -0.24, dLng: -0.06, taskForce: "CTF-71 Watchkeeper" },
  frigate1: { classId: "maritime.frigate", name: "FFG 64 Kestrel", dLat: 0.14, dLng: 0.16, taskForce: "CTF-71 Watchkeeper" },
  frigate2: { classId: "maritime.frigate", name: "FFG 68 Lanyard", dLat: -0.14, dLng: 0.16, taskForce: "CTF-71 Watchkeeper" },
  submarine: { classId: "maritime.submarine", name: "SSN 796 Nightfin", dLat: 0.0, dLng: 0.34, taskForce: "CTF-71 Watchkeeper" },
  fighter: { classId: "air.fighter-squadron", name: "VFA-142 Nightjars", dLat: 0.42, dLng: 0.1, taskForce: "CAW-7 Air Package" },
  strike: { classId: "air.strike-squadron", name: "VFA-158 Ironbolt", dLat: -0.12, dLng: -0.24, taskForce: "CAW-7 Air Package" },
  aew: { classId: "air.aew", name: "CAW-7 Farwatch", dLat: 0.06, dLng: -0.36, taskForce: "CAW-7 Air Package" },
  uav: { classId: "air.uav-recon", name: "UAV-11 Kingfisher", dLat: -0.4, dLng: 0.28, taskForce: "CAW-7 Air Package" },
  mpa: { classId: "air.maritime-patrol", name: "VP-44 Storm Petrel", dLat: -0.46, dLng: -0.04, taskForce: "CAW-7 Air Package" },
  amphib: { classId: "maritime.amphibious", name: "LHA 11 Redoubt", dLat: -0.02, dLng: -0.44, taskForce: "CTF-76 Gate" },
  marines: { classId: "land.marine-battalion", name: "2nd Bn / 5th Coalition Marines", dLat: -0.02, dLng: -0.44, taskForce: "CTF-76 Gate" },
  cyber: { classId: "cyber.ops-cell", name: "Joint Cyber Effects Detachment", dLat: 0.0, dLng: -0.3, taskForce: "CTF-71 Watchkeeper" },
};

const SEVERITY_PACKAGE = {
  low: ["destroyer1", "frigate1", "frigate2", "mpa", "uav"],
  medium: ["destroyer1", "frigate1", "frigate2", "mpa", "uav"],
  high: ["destroyer1", "destroyer2", "frigate1", "frigate2", "submarine", "fighter", "aew"],
  critical: ["carrier", "destroyer1", "destroyer2", "frigate1", "frigate2", "submarine", "fighter", "strike", "aew", "uav"],
};

// One specialist increment per cue origin, so the package answers the cue.
const ORIGIN_INCREMENT = {
  focalpoint: ["cyber", "uav"],
  chokepoint: ["mpa", "uav"],
  surge: ["aew", "fighter"],
  event: ["strike", "uav"],
  conflict: ["amphib", "marines", "cyber"],
};

// How far west of the cue the response stages, in degrees of longitude.
const SEVERITY_STANDOFF = { critical: 1.7, high: 1.5, medium: 1.25, low: 1.0 };

function blueEntities(cue, anchor, classes) {
  const severity = SEVERITIES.includes(cue.severity) ? cue.severity : "medium";
  const origin = ORIGINS.includes(cue.origin) ? cue.origin : "event";
  const standoff = SEVERITY_STANDOFF[severity];
  const responseLng = Math.min(anchor.lng - 0.6, anchor.lng - standoff);
  const responseAnchor = clampPos(anchor.lat, responseLng);

  const slots = [];
  for (const key of [...SEVERITY_PACKAGE[severity], ...ORIGIN_INCREMENT[origin]]) {
    if (!slots.includes(key) && BLUE_SLOTS[key]) slots.push(key);
  }

  const out = [];
  for (const key of slots) {
    const slot = BLUE_SLOTS[key];
    const cls = classes.find((c) => c.id === slot.classId);
    if (!cls) continue;
    out.push({
      name: slot.name,
      classId: cls.id,
      classLabel: cls.label,
      domain: cls.domain || "sea",
      count: 1,
      position: clampPos(responseAnchor.lat + slot.dLat, responseAnchor.lng + slot.dLng),
      taskForce: slot.taskForce,
    });
  }
  return out;
}

// BLUE task keyed to the cue origin, escalating with severity.
const BLUE_OBJECTIVE = {
  focalpoint: {
    base: { title: "Fix and shadow the reported grouping", kind: "control-area" },
    critical: { title: "Break up the reported grouping before it completes its posture", kind: "destroy" },
  },
  chokepoint: {
    base: { title: "Keep the transit corridor open to coalition shipping", kind: "control-area" },
    critical: { title: "Deny any attempt to close the transit corridor", kind: "deny" },
  },
  surge: {
    base: { title: "Hold air superiority over the surge area", kind: "control-area" },
    critical: { title: "Destroy the air threat generating the surge", kind: "destroy" },
  },
  event: {
    base: { title: "Deny the anti-ship threat arc across the approach lane", kind: "deny" },
    critical: { title: "Destroy the anti-ship threat covering the approach lane", kind: "destroy" },
  },
  conflict: {
    base: { title: "Protect coalition shipping inside the disputed water", kind: "protect" },
    critical: { title: "Seize control of the disputed water and the islands astride it", kind: "control-area" },
  },
};

const RED_OBJECTIVE = {
  focalpoint: { title: "Keep the coalition surveillance picture ambiguous", kind: "deny" },
  chokepoint: { title: "Close the transit corridor to coalition shipping", kind: "deny" },
  surge: { title: "Contest the air picture over the archipelago", kind: "deny" },
  event: { title: "Hold coalition hulls inside the missile engagement zone", kind: "destroy" },
  conflict: { title: "Hold the disputed water and the islands astride it", kind: "control-area" },
};

export function cueToParse(cue, state) {
  const source = cue && typeof cue === "object" ? cue : {};
  const origin = ORIGINS.includes(source.origin) ? source.origin : "event";
  const severity = SEVERITIES.includes(source.severity) ? source.severity : "medium";
  const confidence = clampPct(source.confidence);
  const title = firstString(source.title) || "Unnamed intel cue";
  const classes = classCatalog(state);
  const anchor = cueAnchor(source);
  const reportedLat = source.geo ? firstFinite(source.geo.lat) : null;
  const reportedLng = source.geo ? firstFinite(source.geo.lng) : null;
  const reported = reportedLat !== null && reportedLng !== null ? { lat: reportedLat, lng: reportedLng } : anchor;
  const radiusKm = Math.round(clamp(firstFinite(source.geo && source.geo.radiusKm) ?? 30, 5, 400));

  // One placement decision for the whole cue, taken before any entity is placed.
  const placement = cuePlacement(anchor, reported, asArray(source.entities));
  const { entities: red, withheldNeutral, unknownCarried } = redEntities(source, placement, classes);
  const blue = blueEntities({ ...source, origin, severity }, placementAnchor(placement), classes);

  const blueTask = severity === "critical" ? BLUE_OBJECTIVE[origin].critical : BLUE_OBJECTIVE[origin].base;
  const redTask = RED_OBJECTIVE[origin];

  const assessed = source.assessment && source.assessment.unitType ? source.assessment.unitType : null;
  const collected = asArray(source.collection).filter((t) => t && t.status === "collected").length;

  // The order of battle is BLUE and RED only, so the summary has to say out loud
  // which reported tracks were left out of it and why.
  const named = withheldNeutral.slice(0, 3).join(", ");
  const neutralNote = withheldNeutral.length
    ? ` ${plural(withheldNeutral.length, "track", "tracks")} the cue carries as neutral (${named}${withheldNeutral.length > 3 ? ", and others" : ""}) ` +
      `stayed out of the RED order of battle, civil traffic is not materialized as an OPFOR combatant.`
    : "";
  const unknownNote = unknownCarried
    ? ` ${plural(unknownCarried, "track", "tracks")} still carried as unknown sit in the RED order of battle as an unidentified grouping, pending identification.`
    : "";

  return {
    source: "intel-cue",
    title: `Intel response, ${title}`.slice(0, 120),
    summary:
      `Generated from intel cue ${firstString(source.id) || "unidentified"} (${origin}, ${severity}, ${confidence}% confidence): ${title}. ` +
      `${plural(red.length, "RED group", "RED groups")} projected from the cue inside a ${radiusKm} km reported circle, ` +
      `${plural(blue.length, "BLUE group", "BLUE groups")} staged to the west as the response package` +
      (assessed ? `, against an assessed ${assessed.toLowerCase()}` : "") +
      (collected ? `, ${plural(collected, "collection product", "collection products")} fused` : "") +
      "." +
      neutralNote +
      unknownNote,
    sides: [
      { side: "blue", entities: blue },
      { side: "red", entities: red },
    ],
    objectives: [
      { side: "blue", title: blueTask.title, kind: blueTask.kind },
      { side: "red", title: redTask.title, kind: redTask.kind },
    ],
    constraints: [
      `Cue ${firstString(source.id) || "unidentified"} carried ${confidence}% confidence from ${firstString(source.provenance && source.provenance.sensor) || "BASEER"} at hand-off.`,
      `Hold outside the ${radiusKm} km reported circle until the identification is confirmed by a named human.`,
      "Weapons release and any change of posture require a named human approval, SAGE may not close the loop.",
      ...(withheldNeutral.length
        ? [
            `${plural(withheldNeutral.length, "neutral track", "neutral tracks")} reported inside the circle are civil traffic and are not represented in this order of battle. Positive identification is required before engaging any contact that is not listed.`,
          ]
        : []),
      "Exercise data only. RED / OPFOR is a fictional adversary in the Meridian Archipelago.",
    ],
    unparsed: [],
  };
}

// ---------------------------------------------------------------------------
// Offline AI twins. Deterministic, grounded in the cue's own fields.
// ---------------------------------------------------------------------------

function entityMix(cue) {
  const mix = { vessel: 0, aircraft: 0, ground: 0, facility: 0, hostile: 0, neutral: 0 };
  for (const e of asArray(cue.entities)) {
    if (!e || typeof e !== "object") continue;
    if (mix[e.kind] !== undefined) mix[e.kind] += 1;
    if (e.affiliation === "hostile") mix.hostile += 1;
    if (e.affiliation === "neutral") mix.neutral += 1;
  }
  mix.total = mix.vessel + mix.aircraft + mix.ground + mix.facility;
  mix.dominant =
    ["vessel", "aircraft", "ground", "facility"].sort((a, b) => mix[b] - mix[a] || a.localeCompare(b))[0] || "vessel";
  return mix;
}

const UNIT_TYPE_BY_MIX = {
  vessel: {
    focalpoint: "Surface action group, missile-armed patrol element",
    chokepoint: "Surface picket line enforcing a corridor closure",
    surge: "Surface group surging from a single home port",
    conflict: "Combined surface grouping inside a contested area",
    event: "Missile-armed patrol element operating under shore cover",
  },
  aircraft: {
    focalpoint: "Air regiment detachment, mixed fighter and patrol",
    chokepoint: "Maritime patrol detachment screening a chokepoint",
    surge: "Air regiment at surge tempo, fighter-led",
    conflict: "Air component of a joint anti-access grouping",
    event: "Alert intercept flight generated on cue",
  },
  ground: {
    focalpoint: "Coastal defense grouping with organic sensing",
    chokepoint: "Coastal missile battery covering a chokepoint",
    surge: "Coastal defense grouping raising readiness",
    conflict: "Coastal defense grouping, reinforced",
    event: "Coastal missile battery, reinforced",
  },
  facility: {
    focalpoint: "Shore control node with a cued sensor network",
    chokepoint: "Surveillance site cueing a corridor closure",
    surge: "Airfield generating a surge sortie cycle",
    conflict: "Fixed command and sensing node of an anti-access system",
    event: "Fire-control radar site supporting a missile battery",
  },
};

export function offlineIdentify(cue) {
  const source = cue && typeof cue === "object" ? cue : {};
  const origin = ORIGINS.includes(source.origin) ? source.origin : "event";
  const severity = SEVERITIES.includes(source.severity) ? source.severity : "medium";
  const base = clampPct(source.confidence);
  const mix = entityMix(source);
  const provenance = source.provenance && typeof source.provenance === "object" ? source.provenance : {};
  const sources = uniqueStrings([...asArray(provenance.sources), firstString(provenance.sensor), firstString(provenance.detector)], 6);
  const collected = asArray(source.collection).filter((t) => t && t.status === "collected");

  const evidence = Math.min(12, mix.total * 3);
  const corroboration = Math.min(8, sources.length * 2);
  const severityLift = { critical: 6, high: 4, medium: 2, low: 0 }[severity];
  const collectionLift = collected.length ? 9 : 0;
  const confidence = clampPct(Math.round(base * 0.82 + evidence + corroboration + severityLift + collectionLift));

  const unitType = (UNIT_TYPE_BY_MIX[mix.dominant] || UNIT_TYPE_BY_MIX.vessel)[origin];
  const radiusKm = Math.round(Number(source.geo && source.geo.radiusKm) || 30);

  const intentByOrigin = {
    focalpoint: `Consolidate a cued surveillance and engagement picture over the reported ${radiusKm} km circle, most likely as the sensing half of an anti-access posture.`,
    chokepoint: "Occupy and then close the corridor to coalition shipping, holding the lane under missile cover.",
    surge: "Generate and sustain an air-defense alert cycle to contest the air picture ahead of a surface movement.",
    conflict: "Hold the disputed water and the islands astride it, and make coalition transit a decision rather than a routine.",
    event: "Bring the anti-ship threat arc to readiness across the coalition approach lane without firing first.",
  };
  const intent =
    severity === "critical"
      ? `${intentByOrigin[origin]} At critical severity the posture is assessed as executable now, not as preparation.`
      : intentByOrigin[origin];

  const composition = [
    mix.vessel ? `${plural(mix.vessel, "surface or sub-surface contact", "surface or sub-surface contacts")}` : null,
    mix.aircraft ? `${plural(mix.aircraft, "air track", "air tracks")}` : null,
    mix.ground ? `${plural(mix.ground, "ground element", "ground elements")}` : null,
    mix.facility ? `${plural(mix.facility, "fixed site", "fixed sites")}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const reasoning =
    `The cue reports ${composition || "no resolved entities"} inside a ${radiusKm} km circle, of which ${mix.hostile} are already carried as hostile and ${mix.neutral} as neutral, which is a grouping rather than ambient traffic. ` +
    `${plural(sources.length, "independent source", "independent sources")} agree through ${firstString(provenance.detector) || "the BASEER detector"}, and ${firstString(provenance.sensor) || "the reporting sensor"} carried it at ${base}% before analysis. ` +
    (collected.length
      ? `Collection product ${collected[0].taskingId || collected[0].id || "on file"} resolved the identification directly, which is why confidence lands at ${confidence}% rather than the reported ${base}%. `
      : `Nothing has been collected against it yet, so ${confidence}% is the ceiling until a tasking is approved. `) +
    `Assessment is held as ${severity === "critical" || collected.length ? "sufficient for a named human to confirm" : "Possible pending collection"}.`;

  return { unitType, intent, confidence, sources, reasoning };
}

const INTERROGATION_ROUTES = [
  { key: "confidence", re: /\bconfiden|\bcertain|\bsure\b|how (likely|reliable|good)|reliabil/i },
  { key: "change", re: /\bchang|\bnew\b|\bdelta\b|since|\bescalat|\bworse|\btrend/i },
  { key: "recommend", re: /\bshould\b|\brecommend|\bdo about|what next|\bnext step|\badvise|\boptions?\b|\bcourse of action/i },
  { key: "sources", re: /\bsource|\bsensor|\bdetector|\bprovenance|\bwhere did|\bhow do (you|we) know/i },
  { key: "timing", re: /\bwhen\b|\bhow long|\btime\b|\bobserved|\bhistory/i },
  { key: "location", re: /\bwhere\b|\bposition|\blocation|\bgeo|\bcoordinat|\bhow far/i },
  { key: "identity", re: /\bwhat\b|\bwho\b|\bwhich\b|\bidentif|\bunit\b|\bcontact|\bhull\b|\btarget/i },
];

export function offlineInterrogate(cue, question) {
  const source = cue && typeof cue === "object" ? cue : {};
  const text = String(question || "");
  const mix = entityMix(source);
  const provenance = source.provenance && typeof source.provenance === "object" ? source.provenance : {};
  const geo = source.geo && typeof source.geo === "object" ? source.geo : { lat: THEATER_CENTER.lat, lng: THEATER_CENTER.lng, radiusKm: 30 };
  const confidence = clampPct(source.confidence);
  const radiusKm = Math.round(Number(geo.radiusKm) || 30);
  const sources = uniqueStrings(asArray(provenance.sources), 6);
  const collected = asArray(source.collection).filter((t) => t && t.status === "collected");
  const pending = asArray(source.collection).filter((t) => t && t.status !== "collected");
  const assessment = source.assessment && typeof source.assessment === "object" ? source.assessment : null;
  const title = firstString(source.title) || "the cue";
  const route = (INTERROGATION_ROUTES.find((r) => r.re.test(text)) || { key: "summary" }).key;

  const composition = [
    mix.vessel ? `${plural(mix.vessel, "surface or sub-surface contact", "surface or sub-surface contacts")}` : null,
    mix.aircraft ? `${plural(mix.aircraft, "air track", "air tracks")}` : null,
    mix.ground ? `${plural(mix.ground, "ground element", "ground elements")}` : null,
    mix.facility ? `${plural(mix.facility, "fixed site", "fixed sites")}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  switch (route) {
    case "confidence":
      return (
        `The cue arrived at ${confidence}% normalised confidence from ${firstString(provenance.sensor) || "the reporting sensor"} via ${firstString(provenance.detector) || "its detector"}, corroborated by ${plural(sources.length, "source", "sources")}. ` +
        (assessment ? `The identification sits at ${clampPct(assessment.confidence)}% and names it a ${String(assessment.unitType || "grouping").toLowerCase()}. ` : "No identification has been recorded against it yet. ") +
        (collected.length
          ? `Collection ${collected[0].taskingId || collected[0].id} has already been fused, so this is as firm as it gets without a new pass.`
          : `Nothing has been collected yet, so treat the figure as Possible rather than Confirmed.`)
      );
    case "change":
      return (
        `${title} is currently carried as ${String(source.state || "new")} at ${String(source.severity || "medium")} severity and ${confidence}% confidence, observed ${firstString(source.observedAt) || "at an unrecorded time"}. ` +
        `${plural(asArray(source.handoffs).length, "hand-off record", "hand-off records")} sit behind it, ${asArray(source.handoffs).filter((h) => h && h.kind === "human").length} of them human decisions. ` +
        (collected.length ? `The last change was the collection result on ${collected[0].collectedAt || "file"}.` : `Nothing has changed since ingest, ${plural(pending.length, "tasking is", "taskings are")} outstanding.`)
      );
    case "recommend":
      return (
        `With ${confidence}% confidence and ${mix.total} reported entit(ies), the next step is collection rather than action: task a sensor against the ${radiusKm} km circle and hold the response package outside it. ` +
        (collected.length
          ? `Collection is already in, so the decision in front of you is whether to raise the track to Confirmed and release it for course-of-action generation. That signature is yours, not SAGE's.`
          : `Two tasking options are available against this cue, and approval needs a named collection manager before any asset moves.`) +
        ` Nothing here justifies weapons release at ${String(source.severity || "medium")} severity without a confirmed identification.`
      );
    case "sources":
      return (
        `Provenance is ${firstString(provenance.sensor) || "an unnamed sensor"} through detector ${firstString(provenance.detector) || "unrecorded"}, collected ${firstString(provenance.collectedAt) || "at an unrecorded time"}. ` +
        `${plural(sources.length, "source", "sources")} contributed: ${sources.length ? sources.join(", ") : "none recorded"}. ` +
        `SANDTABLE performed no detection of its own here, the cue is consumed from BASEER exactly as normalised at ${confidence}%.`
      );
    case "timing":
      return (
        `${title} was observed ${firstString(source.observedAt) || "at an unrecorded time"} and collected ${firstString(provenance.collectedAt) || "at the same time"}. ` +
        (collected.length
          ? `Collection landed ${collected[0].collectedAt || "on file"} against tasking ${collected[0].taskingId || collected[0].id}, roughly ${Math.round(Number(collected[0].etaMinutes) || 0)} minutes after approval.`
          : pending.length
            ? `The outstanding tasking is quoted at ${Math.round(Number(pending[0].etaMinutes) || 0)} minutes to first product.`
            : `No collection has been timed against it yet.`)
      );
    case "location":
      return (
        `The reported centre is ${Number(geo.lat).toFixed(2)}N ${Number(geo.lng).toFixed(2)}E with a ${radiusKm} km circle of uncertainty, in the Meridian Archipelago. ` +
        `${mix.total} entit(ies) sit inside it: ${composition || "none resolved"}. ` +
        `The response package stages west of the circle, so the geometry reads as a force approaching rather than one already committed.`
      );
    case "identity":
      return (
        (assessment
          ? `The identification on file is a ${String(assessment.unitType || "grouping").toLowerCase()} at ${clampPct(assessment.confidence)}% confidence. `
          : `No identification has been recorded yet, the cue is still raw at ${confidence}% confidence. `) +
        `The cue reports ${composition || "no resolved entities"}, of which ${mix.hostile} are carried hostile and ${mix.neutral} neutral. ` +
        `${firstString(source.narrative) ? String(source.narrative).split(/(?<=\.)\s/)[0] : `Origin is ${String(source.origin || "event")}.`}`
      );
    default:
      return (
        `${title}: ${String(source.origin || "event")} origin, ${String(source.severity || "medium")} severity, ${confidence}% confidence, currently ${String(source.state || "new")}. ` +
        `It reports ${composition || "no resolved entities"} inside a ${radiusKm} km circle centred ${Number(geo.lat).toFixed(2)}N ${Number(geo.lng).toFixed(2)}E. ` +
        `${plural(sources.length, "source", "sources")} contributed through ${firstString(provenance.sensor) || "the reporting sensor"}. ` +
        `Ask about identity, location, confidence, sources, timing, what changed or what to do next.`
      );
  }
}

// ---------------------------------------------------------------------------
// Collection tasking options. Availability against resolution, the moment where
// the operator picks a sensor and a named human has to approve it.
// ---------------------------------------------------------------------------

const COLLECTION_OPTIONS = {
  critical: [
    {
      asset: "IRIS-52 MQ-9",
      mode: "FMV",
      resolutionM: 0.3,
      etaMinutes: 12,
      priority: "urgent",
      note: "Armed ISR already airborne on the western station. Full motion video over the circle in twelve minutes, and it can stay there.",
    },
    {
      asset: "HAWKEYE-11 HALE",
      mode: "EO/IR",
      resolutionM: 0.15,
      etaMinutes: 24,
      priority: "urgent",
      note: "Finer imagery from above the threat arc, twice the wait and a single pass rather than a persistent stare.",
    },
    {
      asset: "SENTINEL-4 satellite pass",
      mode: "SAR",
      resolutionM: 0.5,
      etaMinutes: 34,
      priority: "priority",
      note: "All-weather radar imagery, coarser but immune to cloud and unaffected by the emitter going silent.",
    },
  ],
  high: [
    {
      asset: "IRIS-52 MQ-9",
      mode: "FMV",
      resolutionM: 0.3,
      etaMinutes: 18,
      priority: "priority",
      note: "Nearest armed ISR orbit. Persistent video, but it leaves the northern station uncovered while it is tasked.",
    },
    {
      asset: "SENTINEL-4 satellite pass",
      mode: "SAR",
      resolutionM: 0.5,
      etaMinutes: 41,
      priority: "priority",
      note: "Next radar pass over the archipelago, no asset displaced and no exposure to the reported threat arc.",
    },
    {
      asset: "VP-44 Storm Petrel",
      mode: "EO/IR",
      resolutionM: 0.4,
      etaMinutes: 55,
      priority: "routine",
      note: "Maritime patrol aircraft, wide-area search across the whole circle rather than one point in it.",
    },
  ],
  medium: [
    {
      asset: "UAV-11 Kingfisher",
      mode: "EO/IR",
      resolutionM: 0.45,
      etaMinutes: 26,
      priority: "routine",
      note: "Unarmed reconnaissance orbit, close enough to identify hull types without escalating the picture.",
    },
    {
      asset: "SENTINEL-4 satellite pass",
      mode: "SAR",
      resolutionM: 0.6,
      etaMinutes: 48,
      priority: "routine",
      note: "Scheduled radar pass, no asset displaced. Slower, and it will not resolve a launcher fit.",
    },
  ],
  low: [
    {
      asset: "SENTINEL-4 satellite pass",
      mode: "SAR",
      resolutionM: 0.8,
      etaMinutes: 62,
      priority: "routine",
      note: "Next scheduled pass. Cheapest confirmation available and it costs no on-station time.",
    },
    {
      asset: "MERIDIAN-3 commercial revisit",
      mode: "EO/IR",
      resolutionM: 1.2,
      etaMinutes: 95,
      priority: "routine",
      note: "Commercial optical revisit, low resolution and daylight only, but it leaves no military signature.",
    },
  ],
};

export function collectionOptionsFor(cue) {
  const severity = SEVERITIES.includes(cue && cue.severity) ? cue.severity : "medium";
  return deepClone(COLLECTION_OPTIONS[severity]);
}

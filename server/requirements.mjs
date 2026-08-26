// Commander's intelligence requirements.
//
// A cue arriving on its own is an alert. A cue that says "this answers priority
// requirement 2, indicator B, inside named area NORTH CHANNEL" is intelligence.
// Without this layer SANDTABLE showed BASEER pushes floating free of anything the
// commander had actually asked for, which is the thing a J2 notices first.
//
// Requirements are authored here and matched to cues deterministically: a cue
// answers an indicator when its centre falls inside the indicator's named area
// AND it carries substance of the right kind. Geography alone is a coincidence;
// substance alone is unanchored. Both, and it is an answer.

const KM_PER_DEG_LAT = 111;

function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * KM_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Named areas of interest. Each is a place the commander wants watched, with the
// reason it is worth watching written next to it.
export function buildNamedAreas() {
  return [
    {
      id: "nai-strait",
      name: "STRAIT",
      title: "Meridian Strait transit corridor",
      centre: { lat: 23.85, lng: 61.7 },
      radiusKm: 70,
      why: "The corridor the coalition has to pass through. Anything massing here decides whether the transit is contested or opposed.",
    },
    {
      id: "nai-shoreline",
      name: "SHORELINE",
      title: "Southern shore battery arc",
      centre: { lat: 23.8, lng: 61.4 },
      radiusKm: 60,
      why: "The coastal missile arc covering the corridor. Fire-control emissions from here are the difference between a threat and an engagement.",
    },
    {
      id: "nai-serpent",
      name: "SERPENT",
      title: "Serpent Shoal approaches",
      centre: { lat: 23.62, lng: 61.65 },
      radiusKm: 45,
      why: "Shallow water on the southern approach where a picket can sit unseen against the shoal.",
    },
    {
      id: "nai-north-channel",
      name: "NORTH CHANNEL",
      title: "North Meridian Channel",
      centre: { lat: 24.45, lng: 62.02 },
      radiusKm: 60,
      why: "Where the opposing air defence network is believed to be anchored. New emitters here change the air plan.",
    },
    {
      id: "nai-monte-airfield",
      name: "MONTE AIRFIELD",
      title: "Monte Meridian airfield",
      centre: { lat: 23.99, lng: 62.36 },
      radiusKm: 45,
      why: "The only hard runway in the archipelago. Sortie tempo here is the difference between an air defence sitting still and an air force being generated.",
    },
    {
      id: "nai-half-moon",
      name: "HALF-MOON",
      title: "Half-Moon Bank narrows",
      centre: { lat: 24.28, lng: 62.6 },
      radiusKm: 70,
      why: "The only sea route by which the opposing force can reinforce the archipelago from the north.",
    },
  ];
}

/**
 * Priority intelligence requirements. Each is a question the commander needs
 * answered to make a decision, broken into indicators that a sensor could
 * actually observe, each tied to the ground it would be observed on.
 */
export function buildRequirements() {
  return [
    {
      id: "pir-1",
      number: 1,
      question: "Will the opposing force contest the strait transit corridor, and with what?",
      decision: "Whether the task force runs the strait behind minimum suppression or rolls the coastal threat back first.",
      priority: "critical",
      indicators: [
        {
          id: "pir-1-a",
          letter: "A",
          text: "Surface combatants or missile craft massing inside the transit corridor.",
          naiId: "nai-strait",
          kinds: ["vessel"],
          keywords: ["combatant", "missile craft", "corridor", "massing", "surface action"],
        },
        {
          id: "pir-1-b",
          letter: "B",
          text: "Coastal fire-control emitters radiating along the southern shore.",
          naiId: "nai-shoreline",
          kinds: ["facility", "ground"],
          keywords: ["fire control", "fire-control", "battery", "launcher", "revetment"],
        },
        {
          id: "pir-1-c",
          letter: "C",
          text: "Unregistered hulls holding station on the southern approaches.",
          naiId: "nai-serpent",
          kinds: ["vessel"],
          keywords: ["loiter", "transponder", "unregistered", "holding station", "shoal"],
        },
      ],
    },
    {
      id: "pir-2",
      number: 2,
      question: "Where is the opposing integrated air defence anchored, and is it being reinforced?",
      decision: "Whether the air component opens with suppression or can be held for the landing.",
      priority: "critical",
      indicators: [
        {
          id: "pir-2-a",
          letter: "A",
          text: "Distinct emitter types collapsing into a single cluster.",
          naiId: "nai-north-channel",
          kinds: ["facility"],
          keywords: ["emitter", "cluster", "radio-frequency"],
        },
        {
          id: "pir-2-b",
          letter: "B",
          text: "Sortie tempo above baseline over the archipelago airfield.",
          naiId: "nai-monte-airfield",
          kinds: ["aircraft"],
          keywords: ["sortie", "squadron", "airfield", "orbit", "combat air"],
        },
      ],
    },
    {
      id: "pir-3",
      number: 3,
      question: "Is the opposing force reinforcing the archipelago through the northern narrows?",
      decision: "Whether the operation still has the force ratio it was planned on, or has to move earlier.",
      priority: "high",
      indicators: [
        {
          id: "pir-3-a",
          letter: "A",
          text: "Military transit rate through the narrows running above the civil baseline.",
          naiId: "nai-half-moon",
          kinds: ["vessel"],
          keywords: ["transit", "narrows", "baseline"],
        },
        {
          id: "pir-3-b",
          letter: "B",
          text: "Amphibious or heavy-lift shipping inside the transit stream.",
          naiId: "nai-half-moon",
          kinds: ["vessel"],
          keywords: ["amphibious", "landing ship", "roll-on", "heavy lift", "transport"],
        },
      ],
    },
  ];
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Which indicators a single cue answers, and why. Returns the reasoning as well
 * as the result, because an anchor a J2 cannot check is not worth having.
 */
export function matchCue(cue, requirements, namedAreas) {
  const matches = [];
  if (!cue || !cue.geo) return matches;
  const centre = { lat: cue.geo.lat, lng: cue.geo.lng };
  const haystack = `${cue.title || ""} ${cue.narrative || ""} ${asArray(cue.entities)
    .map((e) => `${e.name || ""} ${e.classHint || ""}`)
    .join(" ")}`.toLowerCase();
  const kinds = new Set(asArray(cue.entities).map((e) => e.kind));

  for (const pir of requirements) {
    for (const indicator of pir.indicators) {
      const area = namedAreas.find((a) => a.id === indicator.naiId);
      if (!area) continue;
      const rangeKm = distanceKm(area.centre, centre);
      // The cue has to actually be in the area. Two circles grazing each other is
      // a coincidence of geometry, and an indicator answered by a coincidence is
      // worse than an indicator left open.
      if (rangeKm > area.radiusKm) continue;
      // And it has to carry the substance the indicator watches for. Geography
      // alone anchors nothing: plenty of hulls sit in a named area without being
      // the thing the commander asked about.
      const kindHit = indicator.kinds.filter((k) => kinds.has(k));
      const wordHit = indicator.keywords.filter((w) => haystack.includes(w));
      if (!kindHit.length || !wordHit.length) continue;
      matches.push({
        pirId: pir.id,
        pirNumber: pir.number,
        indicatorId: indicator.id,
        letter: indicator.letter,
        indicator: indicator.text,
        naiId: area.id,
        naiName: area.name,
        rangeKm: Math.round(rangeKm),
        // The evidence, spelled out. A J2 can disagree with it on the page.
        because: [
          `The cue sits inside ${area.name}, ${Math.round(rangeKm)} km from its centre.`,
          `It carries ${kindHit.join(" and ")} tracks, which is what this indicator watches for.`,
          `Its reporting mentions ${wordHit.slice(0, 3).join(", ")}.`,
        ],
      });
    }
  }
  return matches;
}

/**
 * The requirements board: every PIR with its indicators, what is answering them,
 * and how far the question has actually moved. A confirmed cue answers an
 * indicator; an unconfirmed one only indicates it.
 */
export function requirementsBoard(cues, requirements, namedAreas) {
  const list = asArray(cues);
  const byIndicator = new Map();
  for (const cue of list) {
    if (cue.state === "dismissed") continue;
    for (const match of matchCue(cue, requirements, namedAreas)) {
      if (!byIndicator.has(match.indicatorId)) byIndicator.set(match.indicatorId, []);
      byIndicator.get(match.indicatorId).push({
        cueId: cue.id,
        title: cue.title,
        state: cue.state,
        confidence: cue.confidence,
        severity: cue.severity,
        naiName: match.naiName,
        rangeKm: match.rangeKm,
        because: match.because,
      });
    }
  }

  const pirs = requirements.map((pir) => {
    const indicators = pir.indicators.map((indicator) => {
      const area = namedAreas.find((a) => a.id === indicator.naiId) || null;
      const cueHits = byIndicator.get(indicator.id) || [];
      const answered = cueHits.some((c) => c.state === "confirmed" || c.state === "spawned");
      return {
        id: indicator.id,
        letter: indicator.letter,
        text: indicator.text,
        naiId: indicator.naiId,
        naiName: area ? area.name : indicator.naiId,
        naiTitle: area ? area.title : null,
        status: answered ? "answered" : cueHits.length ? "indicated" : "open",
        cues: cueHits,
      };
    });
    const answered = indicators.filter((i) => i.status === "answered").length;
    const indicated = indicators.filter((i) => i.status === "indicated").length;
    return {
      id: pir.id,
      number: pir.number,
      question: pir.question,
      decision: pir.decision,
      priority: pir.priority,
      indicators,
      answered,
      indicated,
      total: indicators.length,
      status: answered === indicators.length ? "answered" : answered || indicated ? "developing" : "open",
    };
  });

  return {
    pirs,
    namedAreas,
    // What is left to collect against, which is the only actionable line on the board.
    outstanding: pirs.flatMap((p) =>
      p.indicators.filter((i) => i.status === "open").map((i) => ({ pirNumber: p.number, letter: i.letter, text: i.text, naiName: i.naiName }))
    ),
  };
}

// SANDTABLE adversary planner.
//
// A wargame is a friendly plan tested against an enemy plan. Before this module
// RED only chased the nearest contact inside a fixed reach, which is a threat
// model, not an opponent. Here RED gets an authored scheme of manoeuvre: phased
// tasks per role, a station geometry derived from the scenario itself, and a
// fires policy that can hold the whole force silent until BLUE walks inside the
// coastal envelope.
//
// Everything produced here is JSON-serializable and lives on branch._red.
// The engine reads it; index.mjs projects a masked view onto branch.adversary.

const KM_PER_DEG_LAT = 111;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * KM_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function centroid(points) {
  if (!points.length) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat: round4(lat), lng: round4(lng) };
}

/**
 * Point km along the bearing from `from` towards `to`, never past it. Every call
 * site wants a point BETWEEN the two ends; an uncapped fraction turns a 60 km
 * reach across a 0.2 km separation into a 300x extrapolation, which is how RED
 * ended up ordered to a station on the far side of the BLUE force.
 */
function towards(from, to, km) {
  const total = distanceKm(from, to);
  if (!total) return { ...from };
  const frac = Math.min(km / total, 1);
  return {
    lat: round4(from.lat + (to.lat - from.lat) * frac),
    lng: round4(from.lng + (to.lng - from.lng) * frac),
  };
}

/** Point km to the left (+) or right (-) of the from-to axis, measured at `from`. */
function offAxis(from, to, km) {
  const total = distanceKm(from, to);
  if (!total) return { ...from };
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  // Perpendicular in the local flat projection, normalised back to degrees.
  const cos = Math.cos((from.lat * Math.PI) / 180) || 1;
  const px = -dLng * cos;
  const py = dLat / cos;
  const norm = Math.sqrt(px * px + py * py) || 1;
  return {
    lat: round4(from.lat + (px / norm) * (km / KM_PER_DEG_LAT)),
    lng: round4(from.lng + (py / norm) * (km / (KM_PER_DEG_LAT * cos))),
  };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

// RED is tasked by role, not by unit id, so a plan written once applies to any
// scenario the intel bridge or the designer produces.
export const ADVERSARY_ROLES = [
  { id: "coastal-fires", label: "Coastal fires", detail: "Shore-based anti-ship batteries and tube artillery." },
  { id: "air-defense", label: "Air defence", detail: "Surface-to-air battalions holding the umbrella." },
  { id: "surveillance", label: "Surveillance", detail: "Early-warning and surface-search sites feeding the picture." },
  { id: "strike-boat", label: "Strike boats", detail: "Missile craft held for a massed anti-ship salvo." },
  { id: "patrol", label: "Patrol", detail: "Corvettes screening the approaches." },
  { id: "subsurface", label: "Subsurface", detail: "Submarines on barrier or ambush stations." },
  { id: "air", label: "Air", detail: "Interceptor and strike squadrons." },
  { id: "sustainment", label: "Command and sustainment", detail: "Command posts and depots that must survive." },
];

const ROLE_LABEL = new Map(ADVERSARY_ROLES.map((r) => [r.id, r.label]));

// Roles that actually shoot. Only these unmask the force when they are damaged.
const FIRING_ROLES = new Set(["coastal-fires", "air-defense", "strike-boat", "patrol", "subsurface", "air"]);

export function roleForUnit(unit) {
  const cls = String(unit.classId || "");
  if (cls.includes("coastal-battery") || cls.includes("artillery")) return "coastal-fires";
  if (cls.includes("sam")) return "air-defense";
  if (cls.includes("radar") || cls.includes("surveillance")) return "surveillance";
  if (cls.includes("submarine")) return "subsurface";
  if (cls.includes("missile-boat") || cls.includes("fast-attack")) return "strike-boat";
  if (cls.includes("command-post") || cls.includes("depot") || cls.includes("logistics")) return "sustainment";
  if (unit.domain === "air") return "air";
  if (unit.domain === "sea") return "patrol";
  return "coastal-fires";
}

// A capital unit is what a coastal missile force is actually waiting for. The
// hold-fire gate opens on these, not on a picket boat wandering into range.
const CAPITAL_HINTS = ["carrier", "destroyer", "cruiser", "amphibious", "landing", "flagship"];
export function isCapitalUnit(unit) {
  const cls = String(unit.classId || "");
  return CAPITAL_HINTS.some((hint) => cls.includes(hint));
}

// ---------------------------------------------------------------------------
// Plan templates
// ---------------------------------------------------------------------------

// Task verbs the engine understands. Each resolves to a destination through
// stationFor(); "sortie-intercept" is the old reactive behaviour, now one task
// inside a plan rather than the whole of RED's brain.
export const ADVERSARY_TASKS = {
  "hold-station": "Hold the assigned station and do not close.",
  disperse: "Scatter off the berth so a first salvo cannot catch the force massed.",
  screen: "Screen the seaward approach at standoff from the battery.",
  "barrier-picket": "Sit across the BLUE axis of advance and wait.",
  "advance-axis": "Push forward along the axis to the contact line.",
  "sortie-intercept": "Close and intercept the nearest detected BLUE unit within reach.",
  "withdraw-home": "Break contact and fall back on the home station.",
  "fall-back-umbrella": "Withdraw inside the coastal battery envelope and fight from under it.",
};

export const ADVERSARY_PLANS = [
  {
    id: "adv-tidewall",
    codename: "TIDEWALL",
    name: "Coastal denial",
    posture: "defensive-ambush",
    summary: "Present nothing worth striking until BLUE capital ships are inside the coastal envelope, then mass one salvo.",
    intent:
      "RED accepts the loss of the outer sea area to buy an ambush. The battery umbrella, the strike boats and the " +
      "squadrons stay silent and dispersed while BLUE spends its first hours hunting emitters that never radiate. When " +
      "a BLUE capital ship crosses inside the coastal missile envelope RED releases every launcher at once and trades " +
      "the surprise for a single decisive exchange.",
    risk: "If BLUE never closes, RED spends the exercise silent and cedes the strait without a fight.",
    // What BLUE would have to do to break it, written for the after-action reveal.
    counter: "Stand off outside the battery envelope, strike the launchers with air and long-range fires first, and refuse the close-in trade.",
    fires: {
      mode: "hold-until-trigger",
      triggerRangeKm: 95,
      triggerNote: "A BLUE capital ship inside 95 km of the battery centre.",
      releaseAtFraction: 0.45,
      releaseOnLoss: true,
      emconWhileHeld: "silent",
    },
    phases: [
      {
        id: "adv-p1",
        name: "Silent watch",
        toFraction: 0.35,
        intent: "Radiate nothing, disperse the boats, put the submarine across the approach and let BLUE come.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "disperse",
          patrol: "screen",
          subsurface: "barrier-picket",
          air: "hold-station",
          sustainment: "hold-station",
        },
      },
      {
        id: "adv-p2",
        name: "Massed salvo",
        toFraction: 0.72,
        // The release IS this phase's start line. A coastal force whose ambush has
        // been sprung is not still on silent watch, so releasing fires early pulls
        // the plan forward rather than leaving the phase card contradicting the log.
        startsOnRelease: true,
        intent: "On release, every launcher and squadron engages the closest capital target in one exchange.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "sortie-intercept",
          patrol: "sortie-intercept",
          subsurface: "sortie-intercept",
          air: "sortie-intercept",
          sustainment: "hold-station",
        },
      },
      {
        id: "adv-p3",
        name: "Preserve the force",
        toFraction: 1,
        intent: "Break contact with what survives, keep the command post and the depot intact for the next phase.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "withdraw-home",
          patrol: "fall-back-umbrella",
          subsurface: "withdraw-home",
          air: "withdraw-home",
          sustainment: "hold-station",
        },
      },
    ],
  },
  {
    id: "adv-sealance",
    codename: "SEA LANCE",
    name: "Forward contest",
    posture: "offensive-screen",
    summary: "Meet BLUE well forward, force early attrition and early emission, and fight the strait battle on RED's picture.",
    intent:
      "RED refuses to let BLUE choose the moment. The boats and the squadrons push out to a contact line short of the " +
      "strait, take the first exchange far from the coast and make BLUE burn magazines and emissions early. What " +
      "survives falls back inside the battery umbrella and fights the second half from under it.",
    risk: "Fighting forward puts the strike boats outside the battery umbrella, where BLUE air can pick them off.",
    counter: "Absorb the forward contact with the screen, hold the capital ships back, and let RED spend itself before closing.",
    fires: {
      mode: "weapons-free",
      triggerRangeKm: 0,
      triggerNote: "Weapons free from the opening tick.",
      releaseAtFraction: 0,
      releaseOnLoss: true,
      emconWhileHeld: "free",
    },
    phases: [
      {
        id: "adv-p1",
        name: "Push the picket",
        toFraction: 0.3,
        intent: "Advance the boats and the submarine to the contact line and find BLUE first.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "advance-axis",
          patrol: "advance-axis",
          subsurface: "advance-axis",
          air: "hold-station",
          sustainment: "hold-station",
        },
      },
      {
        id: "adv-p2",
        name: "Contest the approach",
        toFraction: 0.75,
        intent: "Take the exchange forward, commit the squadrons, keep BLUE emitting.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "sortie-intercept",
          patrol: "sortie-intercept",
          subsurface: "sortie-intercept",
          air: "sortie-intercept",
          sustainment: "hold-station",
        },
      },
      {
        id: "adv-p3",
        name: "Fall back on the battery",
        toFraction: 1,
        intent: "Withdraw the survivors under the coastal umbrella and hold the inner denial area.",
        tasks: {
          "coastal-fires": "hold-station",
          "air-defense": "hold-station",
          surveillance: "hold-station",
          "strike-boat": "fall-back-umbrella",
          patrol: "fall-back-umbrella",
          subsurface: "barrier-picket",
          air: "withdraw-home",
          sustainment: "hold-station",
        },
      },
    ],
  },
];

export const DEFAULT_ADVERSARY_PLAN_ID = "adv-tidewall";

export function findAdversaryPlan(planId) {
  return ADVERSARY_PLANS.find((p) => p.id === planId) || null;
}

/** Catalogue projection for the API: templates without the resolved geometry. */
export function adversaryPlanCatalogue() {
  return ADVERSARY_PLANS.map((plan) => ({
    id: plan.id,
    codename: plan.codename,
    name: plan.name,
    posture: plan.posture,
    summary: plan.summary,
    intent: plan.intent,
    risk: plan.risk,
    counter: plan.counter,
    firesMode: plan.fires.mode,
    firesNote: plan.fires.triggerNote,
    phases: plan.phases.map((phase) => ({ id: phase.id, name: phase.name, intent: phase.intent })),
  }));
}

// ---------------------------------------------------------------------------
// Resolution against a concrete scenario
// ---------------------------------------------------------------------------

/**
 * Turn a plan template into a concrete scheme for this scenario: role per unit,
 * station geometry, phase boundaries in sim hours and a fires gate.
 */
export function resolveAdversaryPlan({ scenario, planId, durationHours }) {
  const plan = findAdversaryPlan(planId) || findAdversaryPlan(DEFAULT_ADVERSARY_PLAN_ID);
  if (!plan) return null;
  const units = (scenario.units || []).filter((u) => u.side === "red");
  if (!units.length) return null;

  const roles = {};
  for (const unit of units) roles[unit.id] = roleForUnit(unit);

  const redPoints = units.map((u) => u.position);
  const bluePoints = (scenario.units || []).filter((u) => u.side === "blue").map((u) => u.position);
  const redCentre = centroid(redPoints) || { lat: 0, lng: 0 };
  const blueCentre = centroid(bluePoints) || redCentre;

  const batteryPoints = units.filter((u) => roles[u.id] === "coastal-fires").map((u) => u.position);
  const batteryCentre = centroid(batteryPoints) || redCentre;

  // The area RED is actually holding: its own deny or control objective if the
  // scenario author wrote one, otherwise the battery centre.
  const redObjective = (scenario.objectives || []).find(
    (o) => o.side === "red" && o.area && (o.kind === "deny" || o.kind === "control-area")
  );
  const objectiveCentre = redObjective && redObjective.area ? { ...redObjective.area.center } : null;
  const denyRadiusKm = redObjective && redObjective.area ? redObjective.area.radiusKm : 50;
  // A scenario materialised from an intel cue anchors a RED deny objective on the
  // centroid of the force it is denying, which can sit on top of BLUE itself. That
  // gives no usable axis: the bearing becomes rounding noise and RED is sent
  // through the BLUE formation and out the other side. Fall back to the ground RED
  // is actually standing on.
  const denyCentre = objectiveCentre && distanceKm(objectiveCentre, blueCentre) > 25 ? objectiveCentre : batteryCentre;

  // Contact line: where a forward-fighting RED wants the first exchange, short
  // of BLUE and outside its own denial area. Never past BLUE.
  const separationKm = distanceKm(denyCentre, blueCentre);
  const reachKm = Math.min(clamp(separationKm * 0.55, 60, 260), separationKm * 0.9);
  const contactLine = towards(denyCentre, blueCentre, reachKm);

  const geometry = {
    redCentre,
    blueCentre,
    batteryCentre,
    denyCentre,
    denyRadiusKm,
    contactLine,
    screenLeft: offAxis(towards(denyCentre, blueCentre, denyRadiusKm * 0.9), blueCentre, 55),
    screenRight: offAxis(towards(denyCentre, blueCentre, denyRadiusKm * 0.9), blueCentre, -55),
    umbrellaRadiusKm: Math.round(clamp(denyRadiusKm * 0.8, 30, 90)),
  };

  const duration = Number(durationHours) > 0 ? Number(durationHours) : 24;
  let startH = 0;
  const phases = plan.phases.map((phase) => {
    const endH = Math.round(duration * phase.toFraction * 10) / 10;
    const resolved = {
      id: phase.id,
      name: phase.name,
      intent: phase.intent,
      startH,
      endH: Math.max(endH, startH),
      startsOnRelease: Boolean(phase.startsOnRelease),
      tasks: { ...phase.tasks },
    };
    startH = resolved.endH;
    return resolved;
  });

  return {
    planId: plan.id,
    codename: plan.codename,
    name: plan.name,
    posture: plan.posture,
    summary: plan.summary,
    intent: plan.intent,
    risk: plan.risk,
    counter: plan.counter,
    fires: {
      mode: plan.fires.mode,
      triggerRangeKm: plan.fires.triggerRangeKm,
      triggerNote: plan.fires.triggerNote,
      releaseAtH: Math.round(duration * plan.fires.releaseAtFraction * 10) / 10,
      releaseOnLoss: plan.fires.releaseOnLoss,
      emconWhileHeld: plan.fires.emconWhileHeld,
      released: plan.fires.mode === "weapons-free",
      releasedAtH: plan.fires.mode === "weapons-free" ? 0 : null,
      releaseReason: plan.fires.mode === "weapons-free" ? "Weapons free from the opening tick." : null,
    },
    roles,
    geometry,
    phases,
    currentPhaseId: phases.length ? phases[0].id : null,
    revealed: false,
    // Set the first time a RED unit actually fires, which is the only part of the
    // fires policy the players can legitimately see.
    firesObserved: false,
    firesObservedAtH: null,
    // What BLUE could legitimately observe, appended as the run goes. This is the
    // masked view the players get before the reveal.
    indicators: [],
  };
}

export function adversaryPhaseAt(redPlan, simTimeH) {
  if (!redPlan || !redPlan.phases.length) return null;
  const byClock = redPlan.phases.find((p) => simTimeH >= p.startH && simTimeH < p.endH) || redPlan.phases[redPlan.phases.length - 1];
  if (!redPlan.fires.released) return byClock;
  // Once fires are out, the plan cannot still be in a phase that only begins on
  // release. Jump to it, and never backwards: a later phase stays where it is.
  const salvo = redPlan.phases.find((p) => p.startsOnRelease);
  if (!salvo) return byClock;
  const order = redPlan.phases.indexOf(byClock);
  return order < redPlan.phases.indexOf(salvo) ? salvo : byClock;
}

export function taskForUnit(redPlan, unit, simTimeH) {
  const phase = adversaryPhaseAt(redPlan, simTimeH);
  if (!phase) return null;
  const role = redPlan.roles[unit.id] || roleForUnit(unit);
  return phase.tasks[role] || "hold-station";
}

/**
 * Where a unit under this task should be heading. Returns null when the task
 * has no fixed destination (the engine then falls back to intercept logic or
 * leaves the unit where it stands).
 */
export function stationFor(redPlan, unit, task, index) {
  const geo = redPlan.geometry;
  const home = unit._home || unit.position;
  switch (task) {
    case "hold-station":
      return distanceKm(unit.position, home) > 4 ? { ...home } : null;
    case "disperse": {
      // Deterministic scatter: alternate sides of the axis, widening by index.
      const side = index % 2 === 0 ? 1 : -1;
      const spread = 18 + (index % 3) * 14;
      return offAxis(home, geo.blueCentre, side * spread);
    }
    case "screen": {
      return index % 2 === 0 ? { ...geo.screenLeft } : { ...geo.screenRight };
    }
    case "barrier-picket": {
      const lateral = index % 2 === 0 ? 30 : -30;
      return offAxis(geo.contactLine, geo.blueCentre, lateral);
    }
    case "advance-axis": {
      const lateral = index % 2 === 0 ? 40 : -40;
      return offAxis(geo.contactLine, geo.blueCentre, lateral);
    }
    case "withdraw-home":
      return { ...home };
    case "fall-back-umbrella":
      return towards(geo.batteryCentre, home, Math.min(geo.umbrellaRadiusKm, distanceKm(geo.batteryCentre, home)));
    default:
      return null;
  }
}

/**
 * Should RED's fires stay held this tick? Returns a release reason when the gate
 * opens, or null while it holds.
 */
export function firesReleaseCheck(redPlan, branchUnits, simTimeH) {
  const fires = redPlan.fires;
  if (fires.released) return null;
  if (fires.releaseOnLoss) {
    // Losing a unit unmasks the force. Damage alone only unmasks it when the unit
    // hit was one of the shooters: a jammed radar or a struck depot is a reason to
    // stay silent, not a reason to give the ambush away.
    const killed = branchUnits.find((u) => u.side === "red" && u.status === "destroyed");
    if (killed) return `RED lost ${killed.name}, so the ambush no longer buys anything and fires are released.`;
    const shooterHit = branchUnits.find(
      (u) => u.side === "red" && u.strength < 100 && FIRING_ROLES.has(redPlan.roles[u.id] || roleForUnit(u))
    );
    if (shooterHit) {
      return `${shooterHit.name} was struck while holding fire, so RED is shooting back rather than losing the launcher for nothing.`;
    }
  }
  const centre = redPlan.geometry.batteryCentre;
  const capital = branchUnits
    .filter((u) => u.side === "blue" && u.status !== "destroyed" && isCapitalUnit(u))
    .map((u) => ({ unit: u, rangeKm: distanceKm(u.position, centre) }))
    .filter((x) => x.rangeKm <= fires.triggerRangeKm)
    .sort((a, b) => a.rangeKm - b.rangeKm)[0];
  if (capital) {
    return `${capital.unit.name} crossed inside the battery envelope at ${Math.round(capital.rangeKm)} km, which is the trigger the plan was written around.`;
  }
  if (simTimeH >= fires.releaseAtH) {
    return `The plan's own patience ran out at T+${fires.releaseAtH}h and RED released fires rather than lose the window.`;
  }
  return null;
}

/** Human-readable task label for the reveal panel and the after-action report. */
export function describeTask(task) {
  return ADVERSARY_TASKS[task] || task;
}

export function roleLabel(role) {
  return ROLE_LABEL.get(role) || role;
}

/**
 * The masked projection BLUE is allowed to see while the run is live: nothing of
 * the plan itself, only what RED's behaviour has already given away.
 */
export function projectAdversary(redPlan) {
  if (!redPlan) return null;
  const phase = redPlan.phases.find((p) => p.id === redPlan.currentPhaseId) || null;
  const base = {
    revealed: Boolean(redPlan.revealed),
    firesReleased: Boolean(redPlan.fires.released),
    firesReleasedAtH: redPlan.fires.releasedAtH,
    indicators: redPlan.indicators.slice(-12),
  };
  if (!redPlan.revealed) {
    // Before the reveal the players get what they OBSERVED, not the state of the
    // gate. Under a weapons-free plan the gate is open at tick zero, and reporting
    // that would name the plan to anyone who has read the catalogue. RED firing is
    // observable; RED having permission to fire is not.
    return {
      ...base,
      firesReleased: Boolean(redPlan.firesObserved),
      firesReleasedAtH: redPlan.firesObservedAtH,
      planId: null,
      codename: "Withheld",
      name: "OPFOR plan withheld",
      posture: null,
      summary: "The adversary scheme of manoeuvre is held by the white cell until the run completes or the umpire reveals it.",
      intent: null,
      risk: null,
      counter: null,
      firesMode: null,
      firesNote: null,
      currentPhase: null,
      phases: [],
      laydown: [],
    };
  }
  return {
    ...base,
    planId: redPlan.planId,
    codename: redPlan.codename,
    name: redPlan.name,
    posture: redPlan.posture,
    summary: redPlan.summary,
    intent: redPlan.intent,
    risk: redPlan.risk,
    counter: redPlan.counter,
    firesMode: redPlan.fires.mode,
    firesNote: redPlan.fires.triggerNote,
    currentPhase: phase ? { id: phase.id, name: phase.name, intent: phase.intent, startH: phase.startH, endH: phase.endH } : null,
    phases: redPlan.phases.map((p) => ({
      id: p.id,
      name: p.name,
      intent: p.intent,
      startH: p.startH,
      endH: p.endH,
      startsOnRelease: Boolean(p.startsOnRelease),
      tasks: Object.entries(p.tasks).map(([role, task]) => ({
        role,
        roleLabel: roleLabel(role),
        task,
        taskLabel: describeTask(task),
      })),
    })),
    laydown: Object.entries(
      Object.entries(redPlan.roles).reduce((acc, [unitId, role]) => {
        if (!acc[role]) acc[role] = [];
        acc[role].push(unitId);
        return acc;
      }, {})
    ).map(([role, unitIds]) => ({ role, roleLabel: roleLabel(role), unitIds })),
  };
}

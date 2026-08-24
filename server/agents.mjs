// SANDTABLE AI layer (L2): strategic decomposition, COA synthesis, decision
// recommendation and agent-activity synthesis. Pure functions over state owned
// by index.mjs / engine.mjs. Deterministic: seeded mulberry32 only.

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// Capability discovery, key off domain and classId substrings, never exact lists.
// ---------------------------------------------------------------------------

const has = (unit, ...needles) => needles.some((n) => unit.classId.includes(n));

function capabilityGroups(units) {
  const alive = units.filter((u) => u.status !== "destroyed" && u.status !== "withdrawn");
  return {
    isr: alive.filter((u) => has(u, "uav", "aew", "maritime-patrol", "recon", "radar-site")),
    cyber: alive.filter((u) => u.domain === "cyber"),
    asw: alive.filter((u) => has(u, "submarine", "maritime-patrol") || (u.sensors || []).some((s) => s.type === "sonar")),
    strike: alive.filter((u) => (u.weapons || []).some((w) => w.type === "strike")),
    fighters: alive.filter((u) => has(u, "fighter")),
    surface: alive.filter((u) => u.domain === "sea" && has(u, "destroyer", "frigate", "corvette", "missile-boat")),
    capital: alive.filter((u) => has(u, "carrier", "amphibious")),
    amphib: alive.filter((u) => has(u, "amphibious", "marine")),
    sustain: alive.filter((u) => has(u, "auxiliary", "depot")),
    ground: alive.filter((u) => u.domain === "land"),
  };
}

const ids = (units, n = 4) => units.slice(0, n).map((u) => u.id);

// ---------------------------------------------------------------------------
// Strategic decomposition
// ---------------------------------------------------------------------------

/**
 * Decompose a mission into a doctrinal task graph:
 * ISR/cyber shaping -> SEAD/strike -> maneuver -> amphibious -> sustainment.
 * Mutates and returns the mission (status "decomposed").
 */
export function decomposeMission(mission, scenario) {
  const duration = scenario.durationHours || 72;
  const side = mission.side || "blue";
  const own = (scenario.units || []).filter((u) => u.side === side);
  const cap = capabilityGroups(own);
  const suffix = mission.id.replace(/^msn-/, "");
  let seq = 0;
  const nextId = () => `st-${suffix}-${String((seq += 1)).padStart(2, "0")}`;
  const win = (a, b) => ({ startH: Math.round(duration * a), endH: Math.round(duration * b) });

  const tasks = [];
  const push = (title, domain, description, frac, agentId, unitIds, dependsOn) => {
    const { startH, endH } = win(frac[0], frac[1]);
    tasks.push({
      id: nextId(),
      title,
      domain,
      description,
      startH,
      endH,
      assignedAgentId: agentId,
      assignedUnitIds: unitIds,
      dependsOn,
      status: "assigned",
    });
    return tasks[tasks.length - 1].id;
  };

  if (!own.length) {
    // Planning-template scenario with no forces yet: emit staff planning tasks.
    const t1 = push("Frame the operational problem", "land", "Define the problem, constraints and end state with the staff.", [0, 0.2], "agt-situ-01", [], []);
    const t2 = push("Build the intelligence estimate", "air", "Collect and fuse the intelligence baseline for the theater.", [0.1, 0.45], "agt-situ-01", [], [t1]);
    push("Draft force packages", "sea", "Assemble candidate force packages against the estimate.", [0.35, 0.8], "agt-coa-01", [], [t2]);
    mission.status = "decomposed";
    mission.subTasks = tasks;
    mission.updatedAt = new Date().toISOString();
    return mission;
  }

  const isrId = cap.isr.length
    ? push(
        "Develop the battlespace picture",
        "air",
        "Persistent ISR sweep of the approaches and emitter mapping of the defense.",
        [0, 0.3],
        "agt-situ-01",
        ids(cap.isr),
        []
      )
    : null;

  const cyberId = cap.cyber.length
    ? push(
        "Degrade opposing C2 networks",
        "cyber",
        "Open cyber effects against command, control and sensor fusion nodes.",
        [0.02, 0.5],
        "agt-cyber-01",
        ids(cap.cyber),
        isrId ? [isrId] : []
      )
    : null;

  const aswId = cap.asw.length
    ? push(
        "Establish the ASW screen",
        "sea",
        "Sanitize the transit axis and hold a sub-surface barrier ahead of the main body.",
        [0.04, 0.55],
        "agt-asw-01",
        ids(cap.asw),
        []
      )
    : null;

  const seadId = cap.strike.length
    ? push(
        "Suppress the air-defense system",
        "air",
        "Roll back SAM and radar coverage over the operating corridor.",
        [0.2, 0.55],
        "agt-sead-01",
        ids([...cap.strike, ...cap.fighters]),
        [isrId, cyberId].filter(Boolean)
      )
    : null;

  const strikeId = cap.strike.length || cap.surface.length
    ? push(
        "Strike coastal-defense and fires nodes",
        cap.strike.length ? "air" : "sea",
        "Neutralize anti-ship batteries and long-range fires threatening the transit.",
        [0.25, 0.65],
        "agt-fires-01",
        ids([...cap.strike, ...cap.surface]),
        [seadId, isrId].filter(Boolean)
      )
    : null;

  const sweepId = cap.surface.length
    ? push(
        "Clear the surface picket",
        "sea",
        "Sweep opposing surface combatants from the corridor and hold it open.",
        [0.35, 0.75],
        "agt-fires-01",
        ids(cap.surface),
        [strikeId || seadId || isrId].filter(Boolean)
      )
    : null;

  const transitId = cap.capital.length || cap.surface.length
    ? push(
        "Move the main body through the corridor",
        "sea",
        "Threat-weighted transit of the main body behind the screen.",
        [0.4, 0.8],
        "agt-route-01",
        ids([...cap.capital, ...cap.surface], 6),
        [sweepId, aswId].filter(Boolean)
      )
    : null;

  const landId = cap.amphib.length
    ? push(
        "Conduct the amphibious landing",
        "land",
        "Ship-to-shore movement and lodgement against the suppressed defense.",
        [0.75, 0.95],
        "agt-amphib-01",
        ids(cap.amphib),
        [transitId || sweepId].filter(Boolean)
      )
    : null;

  if (cap.sustain.length) {
    push(
      "Sustain the force",
      "sea",
      "Underway replenishment cycle and consumption forecasting for the force.",
      [0.1, 1],
      "agt-log-01",
      ids(cap.sustain),
      []
    );
  }

  push(
    "Consolidate and assess effects",
    landId ? "land" : "sea",
    "Consolidate gains, re-posture the force and feed effectiveness back to planning.",
    [0.9, 1],
    "agt-situ-01",
    ids(landId ? cap.amphib : cap.capital.length ? cap.capital : own),
    [landId || transitId || sweepId || strikeId].filter(Boolean)
  );

  mission.status = "decomposed";
  mission.subTasks = tasks;
  mission.updatedAt = new Date().toISOString();
  return mission;
}

// ---------------------------------------------------------------------------
// COA synthesis
// ---------------------------------------------------------------------------

/**
 * Archetype utility model (documented so the scores are explainable):
 *   tempo t  , how hard the COA races the clock (raises effect and risk)
 *   standoff s- how much it trades time for survivability (lowers risk, raises cost)
 *   complexity c, moving parts / synchronization burden (lowers feasibility)
 * feasibility  = 86 - 22c + readiness bonus (force size vs 18 units)
 * risk         = 32 + 42t - 26s
 * resourceCost = 44 + 26s + 16c
 * expectedEffect = 54 + 26t + 12(1-c) + isr bonus
 * acceptability = 92 - 0.5 * risk
 * composite    = .25 feas + .2 accept + .2 effect + .2 (100-risk) + .15 (100-cost)
 */
const ARCHETYPES = [
  {
    key: "direct-pressure",
    name: "Direct Pressure",
    approach: "Tempo over attrition, force the objective early behind minimum-necessary suppression",
    t: 0.85,
    s: 0.2,
    c: 0.4,
    axis: "center",
  },
  {
    key: "standoff-rollback",
    name: "Standoff Rollback",
    approach: "Systematic reduction from standoff, nothing enters the threat arc until it is suppressed",
    t: 0.3,
    s: 0.9,
    c: 0.35,
    axis: "hold-west",
  },
  {
    key: "northern-envelopment",
    name: "Northern Envelopment",
    approach: "Indirect approach, swing wide north, unhinge the defense from its flank",
    t: 0.55,
    s: 0.45,
    c: 0.75,
    axis: "north",
  },
  {
    key: "southern-hook",
    name: "Southern Hook",
    approach: "Indirect approach, southern axis against the rear sustainment area",
    t: 0.6,
    s: 0.4,
    c: 0.7,
    axis: "south",
  },
  {
    key: "attrition-blockade",
    name: "Blockade & Strangle",
    approach: "Deny and outlast, isolate the objective and let sustainment pressure decide",
    t: 0.2,
    s: 0.7,
    c: 0.5,
    axis: "ring",
  },
];

const COA_COLORS = ["#1f5f99", "#7c3aed", "#0d8a8a", "#b45309", "#9d174d", "#4d7c0f"];

function centroid(units) {
  if (!units.length) return { lat: 34, lng: -41.5 };
  const lat = units.reduce((s, u) => s + u.position.lat, 0) / units.length;
  const lng = units.reduce((s, u) => s + u.position.lng, 0) / units.length;
  return { lat, lng };
}

function objectiveAnchor(scenario, side) {
  const area = (scenario.objectives || []).find((o) => o.side === side && o.area);
  if (area) return { ...area.area.center };
  const enemy = (scenario.units || []).filter((u) => u.side !== side && u.side !== "neutral");
  return centroid(enemy.length ? enemy : scenario.units || []);
}

/** Waypoint geometry per archetype axis, from own centroid toward the anchor. */
function axisWaypoints(from, to, axis, rng) {
  const j = () => (rng() - 0.5) * 0.12;
  const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  switch (axis) {
    case "north":
      return [
        { lat: from.lat + 0.35 + j(), lng: from.lng + 0.3 },
        { lat: mid.lat + 1.05 + j(), lng: mid.lng + j() },
        { lat: to.lat + 0.55, lng: to.lng + 0.35 + j() },
        { lat: to.lat + 0.15, lng: to.lng + j() },
      ];
    case "south":
      return [
        { lat: from.lat - 0.35 + j(), lng: from.lng + 0.3 },
        { lat: mid.lat - 1.0 + j(), lng: mid.lng + j() },
        { lat: to.lat - 0.5, lng: to.lng + 0.3 + j() },
        { lat: to.lat - 0.12, lng: to.lng + j() },
      ];
    case "hold-west":
      return [
        { lat: from.lat + j(), lng: from.lng + 0.25 },
        { lat: mid.lat + j(), lng: mid.lng - 0.35 },
        { lat: to.lat + j(), lng: to.lng - 0.3 },
      ];
    case "ring":
      return [
        { lat: mid.lat + 0.7 + j(), lng: mid.lng + j() },
        { lat: to.lat + 0.45, lng: to.lng + 0.55 + j() },
        { lat: to.lat - 0.3, lng: to.lng + 0.5 + j() },
      ];
    default:
      return [
        { lat: from.lat + j(), lng: from.lng + 0.4 },
        { lat: mid.lat + j(), lng: mid.lng + j() },
        { lat: to.lat + j(), lng: to.lng - 0.1 },
      ];
  }
}

const roundPos = (p) => ({ lat: round1(p.lat * 10) / 10, lng: round1(p.lng * 10) / 10 });


// Commander weighting strategies for COA scoring (per the planning-assistant
// pattern: results-first / loss-control / speed-first / balanced).
export const COA_STRATEGIES = {
  "results-first": { label: "Results first", feasibility: 0.15, acceptability: 0.1, effect: 0.45, safety: 0.15, economy: 0.15, tempo: 0 },
  "loss-control": { label: "Loss control", feasibility: 0.2, acceptability: 0.25, effect: 0.1, safety: 0.35, economy: 0.1, tempo: 0 },
  "speed-first": { label: "Speed first", feasibility: 0.2, acceptability: 0.1, effect: 0.2, safety: 0.1, economy: 0.05, tempo: 0.35 },
  balanced: { label: "Balanced", feasibility: 0.25, acceptability: 0.2, effect: 0.2, safety: 0.2, economy: 0.15, tempo: 0 },
};

// Visible reasoning trace for the planning assistant panel.
export function buildCoaAnalysis(scenario, mission, strategyKey, generated) {
  const own = (scenario.units || []).filter((u) => u.side === (mission.side || "blue") && u.status === "active");
  const cap = capabilityGroups(own);
  const w = COA_STRATEGIES[strategyKey] || COA_STRATEGIES.balanced;
  const ranked = [...generated].sort((a, b) => b.scores.composite - a.scores.composite);
  return [
    { step: "Scenario parsing", detail: `${scenario.codename}: ${scenario.units.length} pieces, ${scenario.objectives.length} objectives, sea state ${scenario.environment.seaState}, EMCON ${scenario.environment.emcon}.`, ms: 1.2 },
    { step: "Force & capability analysis", detail: `${own.length} own pieces, strike ${cap.strike.length}, air ${cap.fighters.length}, ISR ${cap.isr.length}, amphibious ${cap.amphib.length}, sustainment ${cap.sustain.length}.`, ms: 1.4 },
    { step: "Terrain & axis analysis", detail: "North, south and enveloping approach axes evaluated against the objective anchor and strait chokepoints.", ms: 1.1 },
    { step: "Constraints & weighting", detail: `Strategy "${w.label}", effect ${Math.round(w.effect * 100)}%, risk aversion ${Math.round(w.safety * 100)}%, tempo ${Math.round(w.tempo * 100)}%, feasibility ${Math.round(w.feasibility * 100)}%.`, ms: 0.8 },
    { step: "Candidate construction", detail: `${generated.length} doctrinal archetype(s) instantiated with four-phase skeletons and axis waypoints.`, ms: 1.6 },
    { step: "Plan grading", detail: `Composites ${ranked.map((c) => c.scores.composite).join(" / ")} · "${ranked[0].name}" graded RECOMMENDED under ${w.label}.`, ms: 0.9 },
  ];
}

export function generateCoas(scenario, mission, count, existingCount, strategyKey = "balanced") {
  const rng = mulberry32(hashString(scenario.id) + existingCount * 101 + 7);
  const side = mission.side || "blue";
  const own = (scenario.units || []).filter((u) => u.side === side && u.status === "active");
  const cap = capabilityGroups(own);
  const from = centroid(own);
  const anchor = objectiveAnchor(scenario, side);
  const subTasks = mission.subTasks || [];
  const duration = scenario.durationHours || 72;
  const readiness = clamp((own.length / 18) * 10, 0, 10);
  const isrBonus = cap.isr.length ? 6 : 0;
  const out = [];

  for (let i = 0; i < count; i += 1) {
    const arch = ARCHETYPES[(existingCount + i) % ARCHETYPES.length];
    const serial = existingCount + i + 1;
    const way = axisWaypoints(from, anchor, arch.axis, rng).map(roundPos);

    // Phase skeleton: shape (0-25%), reduce (25-55%), maneuver (55-80%), decide (80-100%).
    const cut = (a, b) => [Math.round(duration * a), Math.round(duration * b)];
    const phaseDefs = [
      { name: "Shape and screen", frac: cut(0, 0.25), intent: "Build the picture, open cyber effects and set the screens.", pick: ["Develop", "Degrade", "ASW", "screen", "Sustain"] },
      { name: arch.s > 0.6 ? "Reduce from standoff" : "Suppress the defense", frac: cut(0.25, 0.55), intent: arch.s > 0.6 ? "Roll the defense back from outside its reach before any hull is committed." : "Suppress only what blocks the corridor and keep the force moving.", pick: ["Suppress", "Strike"] },
      { name: arch.axis === "ring" ? "Isolate the objective" : "Maneuver the main body", frac: cut(0.55, 0.8), intent: arch.axis === "ring" ? "Cut the objective off from reinforcement and resupply." : "Move the main body along the chosen axis behind the screen.", pick: ["Clear", "Move", "main body"] },
      { name: "Decide and consolidate", frac: cut(0.8, 1), intent: "Deliver the decisive act and consolidate gains.", pick: ["amphibious", "Consolidate"] },
    ];

    const phases = phaseDefs.map((def, pi) => {
      const matched = subTasks.filter((t) => def.pick.some((k) => t.title.toLowerCase().includes(k.toLowerCase())));
      const assignments = (matched.length ? matched : subTasks.slice(pi, pi + 2)).map((task, ti) => {
        const share = way.slice(Math.min(pi, way.length - 2));
        return {
          subTaskId: task.id,
          unitIds: task.assignedUnitIds || [],
          action: `${arch.key}:${task.title.toLowerCase().split(" ").slice(0, 3).join("-")}`,
          waypoints: share.map((p) => ({ lat: round1(p.lat + (ti - 0.5) * 0.08), lng: round1(p.lng + (ti - 0.5) * 0.06) })),
        };
      });
      return {
        id: `coa-gen-${serial}-p${pi + 1}`,
        name: def.name,
        startH: def.frac[0],
        endH: def.frac[1],
        intent: def.intent,
        assignments,
      };
    });

    const jitter = () => Math.round((rng() - 0.5) * 8);
    const feasibility = clamp(Math.round(86 - 22 * arch.c + readiness + jitter()), 30, 96);
    const risk = clamp(Math.round(32 + 42 * arch.t - 26 * arch.s + jitter()), 15, 95);
    const resourceCost = clamp(Math.round(44 + 26 * arch.s + 16 * arch.c + jitter()), 20, 95);
    const expectedEffect = clamp(Math.round(54 + 26 * arch.t + 12 * (1 - arch.c) + isrBonus + jitter()), 25, 95);
    const acceptability = clamp(Math.round(92 - 0.5 * risk), 20, 95);
    const tempo = clamp(Math.round(38 + 55 * arch.t + jitter() / 2), 20, 96);
    const w = COA_STRATEGIES[strategyKey] || COA_STRATEGIES.balanced;
    const composite = Math.round(
      w.feasibility * feasibility +
        w.acceptability * acceptability +
        w.effect * expectedEffect +
        w.safety * (100 - risk) +
        w.economy * (100 - resourceCost) +
        w.tempo * tempo
    );

    out.push({
      id: `coa-${scenario.id.replace(/^scn-/, "")}-g${serial}`,
      scenarioId: scenario.id,
      missionId: mission.id,
      name: `${arch.name} ${serial > ARCHETYPES.length ? `II` : ""}`.trim(),
      approach: arch.approach,
      summary: buildCoaSummary(arch, scenario, cap, duration),
      generatedBy: "agent",
      generatorAgentId: "agt-coa-01",
      phases,
      scores: { feasibility, acceptability, risk, resourceCost, expectedEffect, composite },
      status: "candidate",
      strategy: strategyKey,
      color: COA_COLORS[(existingCount + i) % COA_COLORS.length],
      createdAt: new Date().toISOString(),
    });
  }
  const byComposite = [...out].sort((a, b) => b.scores.composite - a.scores.composite);
  for (const coa of out) coa.grade = "alternate";
  if (byComposite[0]) byComposite[0].grade = "recommended";
  const rest = byComposite.slice(1);
  if (rest.length) rest.sort((a, b) => a.scores.risk - b.scores.risk)[0].grade = "steady";
  return out;
}

function buildCoaSummary(arch, scenario, cap, duration) {
  const strait = (scenario.objectives || []).find((o) => o.kind === "control-area");
  const objName = strait ? strait.title.toLowerCase() : "the objective area";
  switch (arch.key) {
    case "direct-pressure":
      return `The force closes on ${objName} at best speed behind the ASW and ISR screens, suppressing only the defensive nodes that cover the corridor. Fastest path to the end state within the ${duration}h window; accepts exposure to the coastal missile arc during the transit.`;
    case "standoff-rollback":
      return `The main body holds outside the threat arc while ${cap.strike.length || "the"} strike elements and cyber effects methodically reduce the defense. Only then does the force advance on ${objName}. Lowest risk to capital units; trades roughly a day of tempo and a heavier munitions bill.`;
    case "northern-envelopment":
      return `A feint fixes the defense on the direct axis while the force swings wide north to unhinge the northern flank, then descends on ${objName} from an unexpected bearing. High payoff if the turn stays undetected; complex synchronization and a long, fuel-hungry route.`;
    case "southern-hook":
      return `The force runs a southern axis against the defense's sustainment rear, forcing it to fight facing the wrong direction, then swings up onto ${objName}. Avoids the prepared kill zone; stresses navigation through the southern shoals and stretches the screen thin.`;
    default:
      return `The force isolates ${objName} with a standoff ring, interdicting every resupply run while strikes reduce depots and command nodes. Wins by exhaustion rather than assault, cheapest in blood, longest in hours, and dependent on the blockade staying tight for most of the ${duration}h.`;
  }
}

// ---------------------------------------------------------------------------
// Decision recommendation (human + AI collaborative decision support)
// ---------------------------------------------------------------------------

const RISK_EV = { low: 68, medium: 55, high: 44 };

export function recommendDecision(branch, decisionPoint, scenario) {
  let best = null;
  let bestEv = -1;
  for (const option of decisionPoint.options) {
    const ev = typeof option._ev === "number" ? option._ev : RISK_EV[option.risk] ?? 50;
    if (ev > bestEv) {
      bestEv = ev;
      best = option;
    }
  }
  if (!best) best = decisionPoint.options[0];
  const m = branch.metrics || {};
  const posture =
    (m.blueStrength ?? 100) < 70
      ? "with the force already attrited, preserving combat power weighs heaviest"
      : (m.objectiveScore ?? 0) > 60
        ? "the objective picture is favorable, so protecting the gained position dominates"
        : "the correlation of forces still favors us, so expected mission effect dominates";
  const rationale = `Expected-value comparison across the ${decisionPoint.options.length} options favors "${best.label}" (${best.risk} risk): ${posture}. ${best.projectedEffect}`;
  return { optionId: best.id, rationale };
}

// ---------------------------------------------------------------------------
// Agent activity synthesis (Observation / Piece-drive API log)
// ---------------------------------------------------------------------------

const EVENT_AGENTS = {
  detection: { agentId: "agt-situ-01", api: "observation", verb: "Fused contact report into the recognized picture" },
  engagement: { agentId: "agt-fires-01", api: "piece-drive", verb: "Sequenced fires task" },
  damage: { agentId: "agt-fires-01", api: "observation", verb: "Logged battle-damage assessment" },
  destroyed: { agentId: "agt-fires-01", api: "observation", verb: "Confirmed kill and retargeted the salvo plan" },
  move: { agentId: "agt-route-01", api: "piece-drive", verb: "Re-optimized transit legs" },
  phase: { agentId: "agt-coa-01", api: "piece-drive", verb: "Issued phase-change tasking" },
  decision: { agentId: "agt-coa-01", api: "observation", verb: "Framed commander decision options" },
  logistics: { agentId: "agt-log-01", api: "piece-drive", verb: "Adjusted the replenishment schedule" },
  cyber: { agentId: "agt-cyber-01", api: "piece-drive", verb: "Executed cyber effect window" },
  intervention: { agentId: "agt-situ-01", api: "observation", verb: "Registered umpire intervention in the world state" },
  victory: { agentId: "agt-situ-01", api: "observation", verb: "Reported end-state condition met" },
  info: { agentId: "agt-situ-01", api: "observation", verb: "Updated situation estimate" },
};

export function agentActivityFor(run) {
  const out = [];
  let seq = 0;
  for (const branch of run.branches || []) {
    const events = (branch._full && branch._full.events) || branch.recentEvents || [];
    for (const event of events) {
      const map = EVENT_AGENTS[event.type] || EVENT_AGENTS.info;
      out.push({
        id: `act-${run.id}-${(seq += 1)}`,
        runId: run.id,
        branchId: branch.id,
        agentId: map.agentId,
        tick: event.tick,
        simTimeH: event.simTimeH,
        action: `${map.verb}: ${event.title}`,
        rationale: event.detail,
        api: map.api,
      });
    }
  }
  out.sort((a, b) => b.tick - a.tick);
  return out.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Assessment narrative
// ---------------------------------------------------------------------------

export function commentaryFor(assessment, branch) {
  const dims = [...assessment.dimensions].sort((a, b) => b.score - a.score);
  const strongest = dims[0];
  const weakest = dims[dims.length - 1];
  const d = assessment.decisionStats;
  const decisionsLine = d.total
    ? `Of ${d.total} commander decision${d.total === 1 ? "" : "s"}, ${d.followedAi} followed the AI recommendation and ${d.overridden} overrode it${
        d.overridden > 0 && assessment.overallScore >= 65
          ? ", the overrides did not degrade the outcome, which argues for keeping the human veto exactly where it is"
          : ""
      }.`
    : "No commander decision points were triggered on this branch.";
  const verdictLine = {
    "decisive-success": `${branch.name} achieved the end state with margin to spare`,
    success: `${branch.name} achieved the mission's essential conditions`,
    marginal: `${branch.name} reached only part of the end state and the result would be contested in review`,
    failure: `${branch.name} failed to achieve the end state`,
  }[assessment.verdict];
  return (
    `${verdictLine}, scoring ${assessment.overallScore}/100. The branch was strongest on ${strongest.name.toLowerCase()} ` +
    `(${Math.round(strongest.score)}) and weakest on ${weakest.name.toLowerCase()} (${Math.round(weakest.score)}). ` +
    `The loss-exchange ratio closed at ${assessment.lossExchangeRatio.toFixed(1)} : 1. ${decisionsLine}`
  );
}

export function recommendationsFor(assessment, branch) {
  const recs = [];
  const dim = (name) => assessment.dimensions.find((x) => x.name === name);
  const accomplishment = dim("Mission accomplishment");
  const preservation = dim("Force preservation");
  const tempo = dim("Tempo");
  const efficiency = dim("Resource efficiency");

  if (accomplishment && accomplishment.score < 60) {
    recs.push("Re-sequence suppression before maneuver: the objective set was not reduced enough before the main body committed.");
  }
  if (preservation && preservation.score < 60) {
    recs.push("Hold capital units outside the coastal missile arc until the battery threat is confirmed down; the attrition profile was driven by early exposure.");
  }
  if (tempo && tempo.score < 55) {
    recs.push("Compress the shaping phase · ISR confidence plateaued well before the force actually moved.");
  }
  if (efficiency && efficiency.score < 55) {
    recs.push("Ration standoff munitions against mobile targets and push the replenishment cycle 6-8 hours earlier.");
  }
  if (assessment.decisionStats.overridden > assessment.decisionStats.followedAi) {
    recs.push("Review the decision points where the commander consistently overrode SAGE: either retrain the recommendation policy on this scenario family or codify the commander's heuristic as doctrine.");
  }
  if (assessment.lossExchangeRatio < 2) {
    recs.push("An exchange ratio under 2:1 will not sustain a longer campaign, revisit the engagement rules of thumb for surface combatants inside 45 km.");
  }
  if (!recs.length) {
    recs.push("Bank this branch as the pattern solution for the scenario family and vary opposing-force posture in the next rehearsal to test its robustness.");
  }
  recs.push("Feed the effectiveness assessment back into the agent library so the tactical policies train against this outcome.");
  return recs.slice(0, 5);
}

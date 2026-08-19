// SANDTABLE deduction engine (L1): tick-based joint simulation with rule-set
// adjudication, COA-driven movement, decision points and assessment scoring.
// Everything stored on runs/branches is JSON-serializable; keys starting with
// "_" are internal (stripped from API responses by index.mjs, kept in state.json).

import { recommendDecision, commentaryFor, recommendationsFor } from "./agents.mjs";

const HOURS_PER_TICK = 0.25;
const KM_PER_DEG_LAT = 111;
const EVENT_LOG_CAP = 600;
const RECENT_EVENTS = 30;
const SNAPSHOT_EVERY = 4;
const MAX_DECISIONS_PER_BRANCH = 4;
const SALVO_COOLDOWN_TICKS = 6;
const MAX_SALVOS_PER_TICK = 6;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const nowIso = () => new Date().toISOString();
const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

// Mulberry32 step over a persisted numeric state — deterministic across save/load.
function roll(branch) {
  branch._rngState = (branch._rngState + 0x6d2b79f5) | 0;
  let t = branch._rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Die respecting the rule set's model: deterministic = fixed midpoint. */
function die(branch, ruleSet) {
  return ruleSet.adjudication.dieModel === "deterministic" ? 0.5 : roll(branch);
}

function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * KM_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function bearingDeg(from, to) {
  const dLng = (to.lng - from.lng) * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180));
  const dLat = to.lat - from.lat;
  return (Math.atan2(dLng, dLat) * 180) / Math.PI + (Math.atan2(dLng, dLat) < 0 ? 360 : 0);
}

function moveToward(unit, target, km) {
  const total = distanceKm(unit.position, target);
  if (total <= 0.01) return true;
  const frac = Math.min(1, km / total);
  unit.position = {
    lat: round4(unit.position.lat + (target.lat - unit.position.lat) * frac),
    lng: round4(unit.position.lng + (target.lng - unit.position.lng) * frac),
  };
  unit.headingDeg = Math.round(bearingDeg(unit.position, target));
  return frac >= 1 || distanceKm(unit.position, target) < 2;
}

const alive = (u) => u.status === "active" || u.status === "damaged";
const enemySide = (side) => (side === "blue" ? "red" : "blue");
const isSupplier = (u) => u.classId.includes("auxiliary") || u.classId.includes("depot");
const isSub = (u) => u.classId.includes("submarine");

// ---------------------------------------------------------------------------
// Rule evaluation over the documented fact vocabulary
// ---------------------------------------------------------------------------

function factValue(fact, ctx) {
  const { actor, target, env, rangeKm, simTimeH, phaseName } = ctx;
  switch (fact) {
    case "range":
      return rangeKm;
    case "weather":
      return env.weather;
    case "seaState":
      return env.seaState;
    case "emcon":
      return env.emcon;
    case "simTimeH":
      return simTimeH;
    case "phase.name":
      return phaseName;
    default: {
      const [who, prop] = fact.split(".");
      const unit = who === "actor" ? actor : who === "target" ? target : null;
      if (!unit || !prop) return undefined;
      return unit[prop];
    }
  }
}

function conditionMet(condition, ctx) {
  const value = factValue(condition.fact, ctx);
  if (value === undefined || value === null) return false;
  const expected = condition.value;
  switch (condition.op) {
    case "eq":
      return String(value) === String(expected);
    case "neq":
      return String(value) !== String(expected);
    case "gt":
      return Number(value) > Number(expected);
    case "gte":
      return Number(value) >= Number(expected);
    case "lt":
      return Number(value) < Number(expected);
    case "lte":
      return Number(value) <= Number(expected);
    case "within-km":
      return Number(value) <= Number(expected);
    case "has":
      return String(value).includes(String(expected));
    default:
      return false;
  }
}

/** Collect effects of enabled rules in a category whose conditions all hold. */
function firedEffects(ruleSet, category, ctx) {
  const out = [];
  for (const rule of ruleSet.rules) {
    if (!rule.enabled || rule.category !== category) continue;
    if (rule.conditions.every((c) => conditionMet(c, ctx))) {
      for (const effect of rule.effects) out.push({ rule, effect });
    }
  }
  out.sort((a, b) => a.rule.priority - b.rule.priority);
  return out;
}

function factorProduct(effects, type) {
  let factor = 1;
  for (const { effect } of effects) {
    if (effect.type === type) factor *= Number(effect.params.factor) || 1;
  }
  return factor;
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

export function createRun({ scenario, coas, ruleSet, engine, speed, label, id }) {
  const branches = coas.map((coa, index) => {
    const units = deepClone(scenario.units).map((unit) => ({
      ...unit,
      detectedByEnemy: false,
      _detBy: { blue: false, red: false },
      _home: { ...unit.position },
      _wpPhase: null,
      _wpIdx: 0,
      _cdUntil: 0,
    }));
    const branch = {
      id: `${id}-br${index + 1}`,
      coaId: coa.id,
      name: coa.name,
      color: coa.color,
      status: "running",
      currentPhaseId: coa.phases.length ? coa.phases[0].id : null,
      currentPhaseName: coa.phases.length ? coa.phases[0].name : null,
      units,
      recentEvents: [],
      eventCount: 0,
      decisions: [],
      metrics: null,
      metricsHistory: [],
      _full: { events: [], snapshots: [] },
      _coa: deepClone(coa),
      _rngState: (ruleSet.adjudication.seed + index * 7919) >>> 0,
      _tick: 0,
      _simTimeH: 0,
      _evSeq: 0,
      _mod: { speedFactor: 1, pkFactor: 1, detectFactor: 1, expiresAtTick: 0 },
      _holdUntilTick: 0,
      _victoryPoints: 0,
      _flags: { firstContact: false, attritionCheck: false, phasePending: null, ruleDecisionTitle: null },
      _objHalfTick: null,
      _initialBlue: 0,
      _initialAmmo: 0,
    };
    branch._initialBlue = sideStrength(branch.units, "blue");
    branch._initialAmmo = totalAmmo(branch.units, "blue");
    branch.metrics = computeMetrics(branch, scenario);
    branch.score = computeScore(branch, scenario);
    snapshot(branch);
    pushEvent(branch, {
      type: "info",
      severity: "info",
      title: "Branch initialized",
      detail: `${coa.name}: ${units.length} pieces loaded, adjudicating under "${ruleSet.name}".`,
    });
    return branch;
  });

  return {
    id,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    ruleSetId: ruleSet.id,
    engine,
    status: "running",
    clock: { tick: 0, simTimeH: 0, hoursPerTick: HOURS_PER_TICK, speed: speed || 1 },
    branches,
    startedAt: nowIso(),
    label,
  };
}

// ---------------------------------------------------------------------------
// Events, metrics, snapshots
// ---------------------------------------------------------------------------

function pushEvent(branch, partial) {
  const event = {
    id: `ev-${branch.id}-${(branch._evSeq += 1)}`,
    tick: branch._tick,
    simTimeH: round1(branch._simTimeH),
    ...partial,
  };
  branch._full.events.push(event);
  if (branch._full.events.length > EVENT_LOG_CAP) branch._full.events.splice(0, branch._full.events.length - EVENT_LOG_CAP);
  branch.eventCount += 1;
  branch.recentEvents = branch._full.events.slice(-RECENT_EVENTS).reverse();
  return event;
}

function sideStrength(units, side) {
  const own = units.filter((u) => u.side === side);
  if (!own.length) return 0;
  return own.reduce((sum, u) => sum + (u.status === "destroyed" ? 0 : u.strength), 0) / own.length;
}

function totalAmmo(units, side) {
  return units
    .filter((u) => u.side === side)
    .reduce((sum, u) => sum + (u.weapons || []).reduce((s, w) => s + w.ammo, 0), 0);
}

function objectiveCompletion(objective, units) {
  const blueAlive = units.filter((u) => u.side === objective.side && alive(u));
  switch (objective.kind) {
    case "control-area": {
      if (!objective.area) return 0;
      const inside = blueAlive.filter((u) => distanceKm(u.position, objective.area.center) <= objective.area.radiusKm);
      const hostiles = units.filter(
        (u) => u.side === enemySide(objective.side) && alive(u) && u.domain === "sea" && distanceKm(u.position, objective.area.center) <= objective.area.radiusKm
      );
      const presence = clamp(inside.length / 2, 0, 1);
      return clamp(presence - hostiles.length * 0.35, 0, 1);
    }
    case "destroy": {
      const targets = (objective.targetUnitIds || []).map((tid) => units.find((u) => u.id === tid)).filter(Boolean);
      if (!targets.length) return 0;
      return targets.filter((t) => t.status === "destroyed").length / targets.length;
    }
    case "protect": {
      const targets = (objective.targetUnitIds || []).map((tid) => units.find((u) => u.id === tid)).filter(Boolean);
      if (!targets.length) return 1;
      return targets.reduce((s, t) => s + (t.status === "destroyed" ? 0 : t.strength / 100), 0) / targets.length;
    }
    case "deliver": {
      if (!objective.area) return 0;
      const carriers = blueAlive.filter((u) => u.domain === "land" || u.classId.includes("amphibious"));
      if (!carriers.length) return 0;
      const nearest = Math.min(...carriers.map((u) => distanceKm(u.position, objective.area.center)));
      if (nearest <= objective.area.radiusKm) return 1;
      return clamp(1 - (nearest - objective.area.radiusKm) / 220, 0, 0.85);
    }
    case "deny": {
      if (!objective.area) return 1;
      const hostiles = units.filter(
        (u) => u.side === enemySide(objective.side) && alive(u) && distanceKm(u.position, objective.area.center) <= objective.area.radiusKm
      );
      return hostiles.length ? clamp(1 - hostiles.length * 0.3, 0, 1) : 1;
    }
    default:
      return 0;
  }
}

function objectiveScoreFor(branch, scenario, side) {
  const objectives = (scenario.objectives || []).filter((o) => o.side === side);
  if (!objectives.length) return 0;
  const totalWeight = objectives.reduce((s, o) => s + o.weight, 0) || 1;
  const score = objectives.reduce((s, o) => s + objectiveCompletion(o, branch.units) * o.weight, 0) / totalWeight;
  return clamp(Math.round(score * 100), 0, 100);
}

function computeMetrics(branch, scenario) {
  const units = branch.units;
  const blue = units.filter((u) => u.side === "blue");
  return {
    blueStrength: round1(sideStrength(units, "blue")),
    redStrength: round1(sideStrength(units, "red")),
    blueLosses: blue.filter((u) => u.status === "destroyed").length,
    redLosses: units.filter((u) => u.side === "red" && u.status === "destroyed").length,
    objectiveScore: objectiveScoreFor(branch, scenario, "blue"),
    supplyLevel: round1(blue.length ? blue.reduce((s, u) => s + u.supply, 0) / blue.length : 0),
  };
}

// Mirrored wargame scoreboard: objective points (weighted objective completion +
// accumulated victory-rule points for BLUE), force points (remaining strength),
// combat points (enemy units destroyed). Net is BLUE total minus RED total.
function computeScore(branch, scenario) {
  const forcePoints = (side) =>
    Math.round(
      branch.units.filter((u) => u.side === side && u.status !== "destroyed").reduce((sum, u) => sum + u.strength, 0)
    );
  const blueObjective = objectiveScoreFor(branch, scenario, "blue") * 2 + Math.round(branch._victoryPoints);
  const redObjective = objectiveScoreFor(branch, scenario, "red") * 2;
  const blue = {
    objective: blueObjective,
    force: forcePoints("blue"),
    combat: branch.metrics.redLosses * 150,
  };
  const red = {
    objective: redObjective,
    force: forcePoints("red"),
    combat: branch.metrics.blueLosses * 150,
  };
  const blueTotal = blue.objective + blue.force + blue.combat;
  const redTotal = red.objective + red.force + red.combat;
  return {
    blue: { ...blue, total: blueTotal },
    red: { ...red, total: redTotal },
    net: blueTotal - redTotal,
  };
}

function snapshot(branch) {
  branch._full.snapshots.push({
    tick: branch._tick,
    simTimeH: round1(branch._simTimeH),
    units: branch.units.map((u) => ({
      id: u.id,
      position: { ...u.position },
      headingDeg: u.headingDeg,
      strength: round1(u.strength),
      status: u.status,
      detectedByEnemy: Boolean(u.detectedByEnemy),
    })),
    metrics: { ...branch.metrics },
  });
  if (branch._full.snapshots.length > 500) branch._full.snapshots.splice(0, branch._full.snapshots.length - 500);
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export function tickRun(run, ctx) {
  if (run.status === "completed" || run.status === "aborted") return { completed: true };
  for (const branch of run.branches) {
    if (branch.status === "running") tickBranch(run, branch, ctx);
  }
  run.clock.tick = Math.max(...run.branches.map((b) => b._tick), run.clock.tick);
  run.clock.simTimeH = round1(Math.max(...run.branches.map((b) => b._simTimeH), 0));

  const terminal = run.branches.every((b) => b.status === "completed" || b.status === "aborted");
  if (terminal) {
    run.status = "completed";
  } else if (run.branches.some((b) => b.status === "awaiting-decision")) {
    run.status = "awaiting-decision";
  } else {
    run.status = "running";
  }
  return { completed: run.status === "completed" };
}

function activePhase(coa, simTimeH) {
  if (!coa || !coa.phases.length) return null;
  return coa.phases.find((p) => simTimeH >= p.startH && simTimeH < p.endH) || coa.phases[coa.phases.length - 1];
}

function assignmentFor(phase, unitId) {
  if (!phase) return null;
  return phase.assignments.find((a) => a.unitIds.includes(unitId)) || null;
}

function tickBranch(run, branch, ctx) {
  const { scenario, ruleSet } = ctx;
  const env = scenario.environment;
  branch._tick += 1;
  branch._simTimeH = branch._tick * HOURS_PER_TICK;
  const coa = branch._coa;
  const phase = activePhase(coa, branch._simTimeH);
  const phaseName = phase ? phase.name : "free-play";

  // Phase transition bookkeeping + queued phase decision.
  if (phase && branch.currentPhaseId !== phase.id) {
    const isFirst = coa.phases.length && coa.phases[0].id === phase.id;
    branch.currentPhaseId = phase.id;
    branch.currentPhaseName = phase.name;
    if (!isFirst) {
      pushEvent(branch, {
        type: "phase",
        severity: "info",
        title: `Phase: ${phase.name}`,
        detail: phase.intent,
      });
      branch._flags.phasePending = phase;
    }
  }

  const baseCtx = { env, simTimeH: branch._simTimeH, phaseName, rangeKm: undefined, actor: null, target: null };
  const modActive = branch._tick <= branch._mod.expiresAtTick;
  const holding = branch._tick <= branch._holdUntilTick;

  // --- Movement ---------------------------------------------------------------
  if (!holding) {
    for (const unit of branch.units) {
      if (!alive(unit)) continue;
      const moveCtx = { ...baseCtx, actor: unit };
      const ruleFactor = factorProduct(firedEffects(ruleSet, "movement", moveCtx), "modify-speed");
      const supplyFactor = unit.supply < 20 ? 0.5 : 1;
      const branchFactor = unit.side === "blue" && modActive ? branch._mod.speedFactor : 1;
      const kmPerTick = unit.speedKts * 1.852 * HOURS_PER_TICK * ruleFactor * supplyFactor * branchFactor;
      if (kmPerTick <= 0) continue;

      let destination = null;
      if (unit._forcedWp) {
        destination = unit._forcedWp;
      } else if (unit.side === "blue") {
        const assignment = assignmentFor(phase, unit.id);
        if (assignment && assignment.waypoints.length) {
          if (unit._wpPhase !== (phase && phase.id)) {
            unit._wpPhase = phase ? phase.id : null;
            unit._wpIdx = 0;
          }
          destination = assignment.waypoints[Math.min(unit._wpIdx, assignment.waypoints.length - 1)];
        }
      } else if (unit.side === "red" && (unit.domain === "sea" || unit.domain === "air")) {
        // RED reactive AI: intercept the nearest detected BLUE unit within reach,
        // staying within a leash of the home station.
        const reach = unit.domain === "air" ? 220 : 150;
        const targets = branch.units.filter((t) => t.side === "blue" && alive(t) && t._detBy.red && distanceKm(unit.position, t.position) <= reach);
        if (targets.length) {
          targets.sort((a, b) => distanceKm(unit.position, a.position) - distanceKm(unit.position, b.position));
          const leashKm = 110;
          if (distanceKm(unit._home, targets[0].position) <= leashKm + reach) {
            destination = targets[0].position;
          }
        }
      }

      if (!destination) continue;
      const arrived = moveToward(unit, destination, kmPerTick);
      if (arrived) {
        if (unit._forcedWp) {
          delete unit._forcedWp;
        } else if (unit.side === "blue") {
          unit._wpIdx += 1;
        }
      }
    }
  }

  // --- Detection ----------------------------------------------------------------
  for (const observer of branch.units) {
    if (!alive(observer)) continue;
    for (const target of branch.units) {
      if (target.side === observer.side || target.side === "neutral" || !alive(target)) continue;
      if (target._detBy[observer.side]) continue;
      const rangeKm = distanceKm(observer.position, target.position);
      const sensors = observer.sensors || [];
      let sensorRange = 0;
      if (isSub(target)) {
        const sonar = sensors.filter((s) => s.type.includes("sonar"));
        sensorRange = sonar.length ? Math.max(...sonar.map((s) => s.rangeKm)) : 0;
        if (rangeKm <= 12) sensorRange = Math.max(sensorRange, 12);
      } else {
        sensorRange = sensors.length ? Math.max(...sensors.map((s) => s.rangeKm)) : 0;
      }
      if (!sensorRange || rangeKm > sensorRange) continue;

      const detCtx = { ...baseCtx, actor: observer, target, rangeKm: round1(rangeKm) };
      const effects = firedEffects(ruleSet, "detection", detCtx);
      const reveal = effects.some(({ effect }) => effect.type === "reveal-unit");
      let p = (0.38 * (1 - rangeKm / sensorRange) + 0.08) * factorProduct(effects, "modify-detection");
      if (observer.side === "blue" && modActive) p *= branch._mod.detectFactor;
      if (reveal || die(branch, ruleSet) < clamp(p, 0.02, 0.95)) {
        target._detBy[observer.side] = true;
        target.detectedByEnemy = true;
        pushEvent(branch, {
          type: "detection",
          severity: "info",
          actorId: observer.id,
          targetId: target.id,
          title: `${observer.name} gained contact on ${target.name}`,
          detail: `${reveal ? "Visual-horizon reveal" : "Sensor track"} at ${Math.round(rangeKm)} km in ${phaseName}.`,
          position: { ...target.position },
        });
        if (observer.side === "blue" && !branch._flags.firstContact) {
          branch._flags.firstContact = "pending";
        }
      }
    }
  }

  // --- Engagements -----------------------------------------------------------------
  let salvos = 0;
  const destroyedThisTick = [];
  for (const actor of branch.units) {
    if (salvos >= MAX_SALVOS_PER_TICK) break;
    if (!alive(actor) || actor.supply <= 5 || branch._tick < actor._cdUntil) continue;
    const weapons = (actor.weapons || []).filter((w) => w.ammo > 0);
    if (!weapons.length) continue;

    let choice = null;
    for (const target of branch.units) {
      if (target.side === actor.side || target.side === "neutral" || !alive(target)) continue;
      if (!target._detBy[actor.side]) continue;
      const rangeKm = distanceKm(actor.position, target.position);
      for (const weapon of weapons) {
        if (rangeKm > weapon.rangeKm) continue;
        if (!weaponCanEngage(weapon, target)) continue;
        if (!choice || rangeKm < choice.rangeKm) choice = { target, weapon, rangeKm };
      }
    }
    if (!choice) continue;

    const { target, weapon, rangeKm } = choice;
    const engCtx = { ...baseCtx, actor, target, rangeKm: round1(rangeKm) };
    const effects = firedEffects(ruleSet, "engagement", engCtx);
    let pk = weapon.pk * factorProduct(effects, "modify-pk");
    if (actor.side === "blue" && modActive) pk *= branch._mod.pkFactor;
    pk = clamp(pk, 0.02, 0.97);

    weapon.ammo -= 1;
    actor.supply = clamp(actor.supply - 1.2, 0, 100);
    actor._cdUntil = branch._tick + SALVO_COOLDOWN_TICKS;
    salvos += 1;

    // Firing exposes the shooter.
    if (!actor._detBy[target.side]) {
      actor._detBy[target.side] = true;
      actor.detectedByEnemy = true;
    }

    const rollValue = die(branch, ruleSet);
    const hit = rollValue < pk;
    const damage = hit ? damageFor(weapon, branch, ruleSet) : 0;
    const pkModifiers = effects
      .filter(({ effect }) => effect.type === "modify-pk")
      .map(({ rule, effect }) => ({ rule: rule.name, factor: round2(Number(effect.params.factor) || 1) }));
    if (actor.side === "blue" && modActive && branch._mod.pkFactor !== 1) {
      pkModifiers.push({ rule: "Commander decision effect", factor: round2(branch._mod.pkFactor) });
    }
    pushEvent(branch, {
      type: "engagement",
      severity: "warn",
      actorId: actor.id,
      targetId: target.id,
      title: `${actor.name} engaged ${target.name}`,
      detail: `${weapon.type.toUpperCase()} salvo at ${Math.round(rangeKm)} km (pk ${pk.toFixed(2)}) — ${hit ? "HIT" : "miss"}.`,
      position: { ...target.position },
      adjudication: {
        attacker: actor.name,
        target: target.name,
        weapon: weapon.type.toUpperCase(),
        weaponType: weapon.type,
        rangeKm: round1(rangeKm),
        basePk: round2(weapon.pk),
        modifiers: pkModifiers,
        finalPk: round2(pk),
        roll: round2(rollValue),
        result: hit ? "hit" : "miss",
        damage: round1(damage),
      },
    });

    if (hit) {
      target.strength = round1(clamp(target.strength - damage, 0, 100));
      if (weapon.type === "cyber-effect") target.supply = clamp(target.supply - 12, 0, 100);
      if (target.strength <= 0) {
        target.status = "destroyed";
        destroyedThisTick.push(target);
        pushEvent(branch, {
          type: "destroyed",
          severity: "danger",
          actorId: actor.id,
          targetId: target.id,
          title: `${target.name} destroyed`,
          detail: `Killed by ${actor.name} at ${Math.round(rangeKm)} km.`,
          position: { ...target.position },
        });
      } else {
        if (target.strength < 60 && target.status === "active") target.status = "damaged";
        pushEvent(branch, {
          type: "damage",
          severity: "warn",
          actorId: actor.id,
          targetId: target.id,
          title: `${target.name} took ${Math.round(damage)}% damage`,
          detail: `Strength now ${Math.round(target.strength)}%. ${target.status === "damaged" ? "Combat effectiveness degraded." : ""}`,
          position: { ...target.position },
        });
      }
    }
  }

  // --- Logistics --------------------------------------------------------------------
  for (const unit of branch.units) {
    if (!alive(unit)) continue;
    const logCtx = { ...baseCtx, actor: unit };
    const effects = firedEffects(ruleSet, "logistics", logCtx);
    let drain = 0.06 + (unit.speedKts > 0 ? 0.18 : 0);
    for (const { effect } of effects) {
      if (effect.type === "consume-supply") drain += Number(effect.params.amount) || 0;
      if (effect.type === "spawn-event" && branch._tick % 16 === 0) {
        pushEvent(branch, {
          type: "logistics",
          severity: String(effect.params.severity || "warn"),
          actorId: unit.id,
          title: `${effect.params.title || "Sustainment report"}: ${unit.name}`,
          detail: `Supply state ${Math.round(unit.supply)}% under "${phaseName}".`,
        });
      }
      if (effect.type === "request-decision" && !branch._flags.ruleDecisionTitle) {
        branch._flags.ruleDecisionTitle = String(effect.params.title || "Rule-directed commander check");
      }
    }
    if (!isSupplier(unit)) unit.supply = clamp(unit.supply - drain, 0, 100);

    if (!isSupplier(unit) && unit.supply < 96) {
      const supplier = branch.units.find(
        (s) => s.side === unit.side && alive(s) && isSupplier(s) && distanceKm(s.position, unit.position) <= 18
      );
      if (supplier) unit.supply = clamp(unit.supply + 2.5, 0, 100);
    }
  }

  // --- Attrition rules ------------------------------------------------------------------
  for (const unit of branch.units) {
    if (!alive(unit)) continue;
    const attrCtx = { ...baseCtx, actor: unit };
    for (const { effect } of firedEffects(ruleSet, "attrition", attrCtx)) {
      if (effect.type !== "apply-damage") continue;
      unit.strength = round1(clamp(unit.strength - (Number(effect.params.amount) || 0), 0, 100));
      if (unit.strength <= 0) {
        unit.status = "destroyed";
        destroyedThisTick.push(unit);
        pushEvent(branch, {
          type: "destroyed",
          severity: "danger",
          targetId: unit.id,
          title: `${unit.name} lost`,
          detail: "Progressive damage accumulation proved unrecoverable.",
          position: { ...unit.position },
        });
      } else if (unit.strength < 60 && unit.status === "active") {
        unit.status = "damaged";
      }
    }
  }

  // --- Victory scoring rules ---------------------------------------------------------------
  for (const casualty of destroyedThisTick) {
    const vicCtx = { ...baseCtx, actor: null, target: casualty };
    for (const { effect } of firedEffects(ruleSet, "victory", vicCtx)) {
      if (effect.type === "score-points") branch._victoryPoints += Number(effect.params.points) || 0;
    }
  }

  // --- Metrics, snapshots ---------------------------------------------------------------------
  branch.metrics = computeMetrics(branch, scenario);
  branch.score = computeScore(branch, scenario);
  if (branch.metrics.objectiveScore >= 50 && branch._objHalfTick === null) branch._objHalfTick = branch._tick;
  if (branch._tick % SNAPSHOT_EVERY === 0) {
    branch.metricsHistory.push({ tick: branch._tick, simTimeH: round1(branch._simTimeH), ...branch.metrics });
    if (branch.metricsHistory.length > 320) branch.metricsHistory.splice(0, branch.metricsHistory.length - 320);
    snapshot(branch);
  }

  // --- Completion ---------------------------------------------------------------------------------
  const duration = scenario.durationHours || 72;
  if (branch._simTimeH >= duration || branch.metrics.blueStrength < 25 || branch.metrics.redStrength < 25 || branch.metrics.objectiveScore >= 95) {
    completeBranch(branch, scenario, duration);
    return;
  }

  // --- Decision points ----------------------------------------------------------------------------
  maybeCreateDecision(run, branch, ctx, phaseName);
}

function weaponCanEngage(weapon, target) {
  switch (weapon.type) {
    case "aam":
    case "sam":
      return target.domain === "air";
    case "torpedo":
      return target.domain === "sea";
    case "ssm":
      return target.domain === "sea";
    case "strike":
      return target.domain === "sea" || target.domain === "land";
    case "gun":
      return target.domain !== "cyber" && target.domain !== "space";
    case "cyber-effect":
      return true;
    default:
      return target.domain === "sea" || target.domain === "land";
  }
}

function damageFor(weapon, branch, ruleSet) {
  const spread = die(branch, ruleSet);
  switch (weapon.type) {
    case "torpedo":
      return 26 + spread * 24;
    case "ssm":
      return 18 + spread * 26;
    case "strike":
      return 16 + spread * 26;
    case "aam":
    case "sam":
      return 15 + spread * 20;
    case "cyber-effect":
      return 4 + spread * 10;
    case "gun":
      return 4 + spread * 8;
    default:
      return 10 + spread * 15;
  }
}

function completeBranch(branch, scenario, duration) {
  branch.status = "completed";
  const m = branch.metrics;
  const outcome =
    m.objectiveScore >= 70 && m.blueStrength > m.redStrength
      ? "BLUE end state achieved"
      : m.redStrength < 25
        ? "Opposing force combat-ineffective"
        : m.blueStrength < 25
          ? "BLUE force culminated"
          : "Exercise window closed";
  pushEvent(branch, {
    type: "victory",
    severity: m.blueStrength < 25 ? "danger" : "good",
    title: `Branch complete — ${outcome}`,
    detail: `T+${round1(branch._simTimeH)}h of ${duration}h. Objectives ${m.objectiveScore}%, BLUE ${m.blueStrength}%, RED ${m.redStrength}%.`,
  });
  branch.metricsHistory.push({ tick: branch._tick, simTimeH: round1(branch._simTimeH), ...branch.metrics });
  snapshot(branch);
}

// ---------------------------------------------------------------------------
// Decision points
// ---------------------------------------------------------------------------

function maybeCreateDecision(run, branch, ctx, phaseName) {
  if (branch.decisions.length >= MAX_DECISIONS_PER_BRANCH) return;
  if (branch.decisions.some((d) => d.status === "open")) return;

  let spec = null;
  if (branch._flags.phasePending) {
    const phase = branch._flags.phasePending;
    branch._flags.phasePending = null;
    spec = phaseDecisionSpec(branch, phase);
  } else if (branch._flags.firstContact === "pending") {
    branch._flags.firstContact = true;
    spec = contactDecisionSpec(branch);
  } else if (!branch._flags.attritionCheck && branch.metrics.blueStrength < 70) {
    branch._flags.attritionCheck = true;
    spec = attritionDecisionSpec(branch);
  } else if (branch._flags.ruleDecisionTitle) {
    const title = branch._flags.ruleDecisionTitle;
    branch._flags.ruleDecisionTitle = null;
    spec = ruleDecisionSpec(branch, title);
  }
  if (!spec) return;

  const decision = {
    id: `dp-${branch.id}-${branch.decisions.length + 1}`,
    tick: branch._tick,
    simTimeH: round1(branch._simTimeH),
    title: spec.title,
    situation: spec.situation,
    options: spec.options,
    aiRecommendationId: "",
    aiRationale: "",
    status: "open",
  };
  const recommendation = recommendDecision(branch, decision, ctx.scenario);
  decision.aiRecommendationId = recommendation.optionId;
  decision.aiRationale = recommendation.rationale;
  branch.decisions.push(decision);
  branch.status = "awaiting-decision";
  pushEvent(branch, {
    type: "decision",
    severity: "warn",
    title: `Commander decision required: ${decision.title}`,
    detail: `${spec.situation} SAGE recommends "${spec.options.find((o) => o.id === recommendation.optionId)?.label}". Branch holds in ${phaseName} until decided.`,
  });
}

const opt = (id, label, description, projectedEffect, risk, ev, apply) => ({
  id,
  label,
  description,
  projectedEffect,
  risk,
  _ev: ev,
  _apply: apply,
});

function phaseDecisionSpec(branch, phase) {
  const m = branch.metrics;
  return {
    title: `Commit to "${phase.name}"?`,
    situation: `The plan calls for transitioning to ${phase.name} (${phase.intent}) BLUE strength ${m.blueStrength}%, objectives ${m.objectiveScore}%.`,
    options: [
      opt(
        "o1",
        "Proceed as planned",
        "Execute the phase on the planned timeline and geometry.",
        "Keeps the synchronized plan intact; no new exposure beyond what was wargamed.",
        "medium",
        62,
        { kind: "none" }
      ),
      opt(
        "o2",
        "Accelerate the tempo",
        "Compress the timeline: +25% movement speed and weapons-free posture for 8 hours.",
        "Gains 4-6 hours on the clock at the cost of a noisier signature and tighter engagement margins.",
        "high",
        m.objectiveScore < 40 ? 58 : 48,
        { kind: "mod", speedFactor: 1.25, pkFactor: 1.08, detectFactor: 1.15, hours: 8 }
      ),
      opt(
        "o3",
        "Hold 4 hours and re-set the screen",
        "Pause the advance, tighten the ASW/air screens and top off supply before committing.",
        "Trades tempo for posture: better supply state and screen geometry entering the phase.",
        "low",
        m.supplyLevel < 55 ? 66 : 52,
        { kind: "hold", hours: 4, resupply: 6 }
      ),
    ],
  };
}

function contactDecisionSpec(branch) {
  return {
    title: "First contact — fires posture?",
    situation: "BLUE sensors hold the first confirmed track on the opposing force. The force must set its emissions and fires posture for the meeting engagement.",
    options: [
      opt(
        "o1",
        "Maintain EMCON, develop the track",
        "Hold fire, keep emissions tight and let ISR refine the picture before shooting.",
        "Preserves surprise and magazine depth; risks the opponent shooting first.",
        "medium",
        60,
        { kind: "mod", detectFactor: 0.85, pkFactor: 1, speedFactor: 1, hours: 6 }
      ),
      opt(
        "o2",
        "Immediate coordinated salvo",
        "Commit ready fires at every in-range track before the opponent's kill chain closes.",
        "Maximum first-salvo advantage; burns munitions on a still-fuzzy picture.",
        "high",
        55,
        { kind: "strike-now" }
      ),
      opt(
        "o3",
        "Open the range and probe",
        "Turn the main body away 20 km and probe with unmanned and air assets only.",
        "Safest for capital units; concedes water and 3-4 hours of tempo.",
        "low",
        47,
        { kind: "mod", speedFactor: 0.8, detectFactor: 0.8, pkFactor: 1, hours: 6 }
      ),
    ],
  };
}

function attritionDecisionSpec(branch) {
  const damaged = branch.units.filter((u) => u.side === "blue" && u.status === "damaged").length;
  return {
    title: "Force falling below 70% — continue?",
    situation: `Aggregate BLUE strength has dropped to ${branch.metrics.blueStrength}% with ${damaged} unit(s) damaged. The commander must decide whether the mission still justifies the attrition curve.`,
    options: [
      opt(
        "o1",
        "Continue the mission",
        "Accept the losses and press the current plan to its objective.",
        "Keeps the objective timeline alive; the attrition trend continues unless the geometry improves.",
        "high",
        branch.metrics.objectiveScore >= 55 ? 60 : 46,
        { kind: "none" }
      ),
      opt(
        "o2",
        "Withdraw damaged units",
        "Detach every unit under 45% strength westward and continue with the remainder.",
        "Preserves hulls and crews; thins the screen and slows the advance.",
        "medium",
        56,
        { kind: "withdraw-damaged", threshold: 45 }
      ),
      opt(
        "o3",
        "Defensive re-set and resupply surge",
        "Hold in place 6 hours behind the screen while the replenishment cycle runs.",
        "Restores supply and posture at the price of six hours and the initiative.",
        "low",
        branch.metrics.supplyLevel < 50 ? 62 : 50,
        { kind: "hold", hours: 6, resupply: 25 }
      ),
    ],
  };
}

function ruleDecisionSpec(branch, title) {
  return {
    title,
    situation: "An adjudication rule in the active rule set has flagged the current situation for a mandatory commander check.",
    options: [
      opt("o1", "Commit the reserve", "Release held units and weapons authority into the current fight.", "Raises combat power now; nothing left for the next crisis.", "high", 52, {
        kind: "mod",
        pkFactor: 1.15,
        speedFactor: 1.1,
        detectFactor: 1.1,
        hours: 8,
      }),
      opt("o2", "Hold the reserve", "Keep the reserve out of contact and continue with committed forces.", "Preserves flexibility; the current engagement stays a fair fight.", "medium", 58, {
        kind: "none",
      }),
      opt("o3", "Break contact locally", "Disengage the most-pressed units and reform one bound back.", "Cheapest in losses; cedes the local area for at least a phase.", "low", 45, {
        kind: "mod",
        speedFactor: 0.75,
        pkFactor: 0.9,
        detectFactor: 0.8,
        hours: 6,
      }),
    ],
  };
}

export function applyDecision(run, branchId, decisionId, optionId, decidedBy, rationale, ctx) {
  const branch = run.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  const decision = branch.decisions.find((d) => d.id === decisionId);
  if (!decision) throw new Error(`Unknown decision "${decisionId}".`);
  if (decision.status !== "open") return;
  const option = decision.options.find((o) => o.id === optionId) || decision.options[0];

  decision.status = "decided";
  decision.decidedBy = decidedBy;
  decision.decidedOptionId = option.id;
  decision.decisionRationale = rationale || "";
  decision.followedAi = option.id === decision.aiRecommendationId;

  applyOptionEffect(branch, option, ctx);
  if (branch.status === "awaiting-decision") branch.status = "running";
  pushEvent(branch, {
    type: "decision",
    severity: "info",
    title: `Decision: ${option.label}`,
    detail: `${decidedBy} resolved "${decision.title}" (${decision.followedAi ? "followed" : "overrode"} the AI recommendation). ${rationale || ""}`.trim(),
  });
}

function applyOptionEffect(branch, option, ctx) {
  const apply = option._apply || { kind: "none" };
  const ticksPerHour = 1 / HOURS_PER_TICK;
  switch (apply.kind) {
    case "mod":
      branch._mod = {
        speedFactor: apply.speedFactor ?? 1,
        pkFactor: apply.pkFactor ?? 1,
        detectFactor: apply.detectFactor ?? 1,
        expiresAtTick: branch._tick + Math.round((apply.hours ?? 6) * ticksPerHour),
      };
      break;
    case "hold": {
      branch._holdUntilTick = branch._tick + Math.round((apply.hours ?? 4) * ticksPerHour);
      const boost = apply.resupply ?? 0;
      for (const unit of branch.units) {
        if (unit.side === "blue" && alive(unit)) unit.supply = clamp(unit.supply + boost, 0, 100);
      }
      break;
    }
    case "withdraw-damaged": {
      for (const unit of branch.units) {
        if (unit.side === "blue" && alive(unit) && unit.strength < (apply.threshold ?? 45)) {
          unit.status = "withdrawn";
          pushEvent(branch, {
            type: "move",
            severity: "neutral",
            actorId: unit.id,
            title: `${unit.name} withdrawn`,
            detail: "Detached westward per commander decision to preserve the force.",
            position: { ...unit.position },
          });
        }
      }
      break;
    }
    case "strike-now": {
      // One immediate bonus salvo from every ready BLUE shooter at detected targets.
      for (const unit of branch.units) {
        if (unit.side === "blue" && alive(unit)) unit._cdUntil = 0;
      }
      branch._mod = { speedFactor: 1, pkFactor: 1.1, detectFactor: 1.1, expiresAtTick: branch._tick + Math.round(4 * ticksPerHour) };
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

export function applyIntervention(run, branchId, request, ctx) {
  const branch = run.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  const params = request.params || {};
  const findUnit = () => branch.units.find((u) => u.id === String(params.unitId || ""));

  switch (request.type) {
    case "inject-event": {
      pushEvent(branch, {
        type: "intervention",
        severity: ["neutral", "good", "warn", "danger", "info"].includes(String(params.severity)) ? String(params.severity) : "info",
        title: String(params.title || "Umpire inject"),
        detail: `White-cell inject by ${request.requestedBy}.`,
        position:
          params.lat !== undefined && params.lng !== undefined
            ? { lat: Number(params.lat), lng: Number(params.lng) }
            : undefined,
      });
      break;
    }
    case "move-unit": {
      const unit = findUnit();
      if (!unit) throw new Error(`Unknown unit "${params.unitId}".`);
      unit._forcedWp = { lat: Number(params.lat) || unit.position.lat, lng: Number(params.lng) || unit.position.lng };
      pushEvent(branch, {
        type: "intervention",
        severity: "info",
        actorId: unit.id,
        title: `${unit.name} retasked by umpire`,
        detail: `Ordered to ${round4(unit._forcedWp.lat)}, ${round4(unit._forcedWp.lng)} by ${request.requestedBy}.`,
      });
      break;
    }
    case "set-weather": {
      const weather = ["clear", "overcast", "storm"].includes(String(params.weather)) ? String(params.weather) : "overcast";
      ctx.scenario.environment.weather = weather;
      pushEvent(branch, {
        type: "intervention",
        severity: weather === "storm" ? "warn" : "info",
        title: `Weather set to ${weather}`,
        detail: `Environmental control by ${request.requestedBy}; movement and detection rules now adjudicate against "${weather}".`,
      });
      break;
    }
    case "resupply": {
      const amount = clamp(Number(params.amount) || 40, 5, 100);
      const unit = findUnit();
      const targets = unit ? [unit] : branch.units.filter((u) => u.side === "blue" && alive(u));
      for (const t of targets) t.supply = clamp(t.supply + amount, 0, 100);
      pushEvent(branch, {
        type: "logistics",
        severity: "good",
        actorId: unit ? unit.id : undefined,
        title: unit ? `${unit.name} resupplied (+${amount})` : `Force-wide resupply (+${amount})`,
        detail: `Emergency sustainment authorized by ${request.requestedBy}.`,
      });
      break;
    }
    case "withdraw-unit": {
      const unit = findUnit();
      if (!unit) throw new Error(`Unknown unit "${params.unitId}".`);
      unit.status = "withdrawn";
      pushEvent(branch, {
        type: "intervention",
        severity: "neutral",
        actorId: unit.id,
        title: `${unit.name} withdrawn by umpire`,
        detail: `Removed from play by ${request.requestedBy}.`,
        position: { ...unit.position },
      });
      break;
    }
    default:
      throw new Error(`Unknown intervention type "${request.type}".`);
  }
  branch.metrics = computeMetrics(branch, ctx.scenario);
  branch.score = computeScore(branch, ctx.scenario);
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export function buildAssessments(run, ctx) {
  const { scenario } = ctx;
  const duration = scenario.durationHours || 72;
  return run.branches.map((branch) => {
    const m = branch.metrics;
    const coaName = branch.name;

    const accomplishment = clamp(m.objectiveScore + Math.min(10, branch._victoryPoints / 10), 0, 100);
    const preservation = clamp((m.blueStrength / Math.max(branch._initialBlue, 1)) * 100, 0, 100);
    const halfH = branch._objHalfTick !== null ? branch._objHalfTick * HOURS_PER_TICK : duration;
    const tempo = clamp(Math.round(100 - (halfH / duration) * 85 - (m.objectiveScore < 50 ? 20 : 0)), 5, 100);
    const ammoLeft = branch._initialAmmo > 0 ? totalAmmo(branch.units, "blue") / branch._initialAmmo : 1;
    const efficiency = clamp(Math.round(0.55 * m.supplyLevel + 45 * ammoLeft), 0, 100);

    const decided = branch.decisions.filter((d) => d.status === "decided");
    const followed = decided.filter((d) => d.followedAi).length;
    const overridden = decided.length - followed;
    let decisionQuality = decided.length ? clamp(58 + followed * 6 - overridden * 2, 30, 95) : 65;

    const dimensions = [
      { name: "Mission accomplishment", score: Math.round(accomplishment), weight: 0.35, detail: `Objectives closed at ${m.objectiveScore}% with ${Math.round(branch._victoryPoints)} victory points accumulated.` },
      { name: "Force preservation", score: Math.round(preservation), weight: 0.25, detail: `BLUE ended at ${m.blueStrength}% aggregate strength against ${branch._initialBlue.toFixed(0)}% at start; ${m.blueLosses} unit(s) lost.` },
      { name: "Tempo", score: tempo, weight: 0.15, detail: branch._objHalfTick !== null ? `Objective picture crossed 50% at T+${round1(halfH)}h of ${duration}h.` : `The objective picture never crossed 50% inside the window.` },
      { name: "Resource efficiency", score: efficiency, weight: 0.15, detail: `Force supply closed at ${m.supplyLevel}% with ${Math.round(ammoLeft * 100)}% of magazines remaining.` },
      { name: "Decision quality", score: 0, weight: 0.1, detail: "" },
    ];

    let overall = Math.round(dimensions.slice(0, 4).reduce((s, d) => s + d.score * d.weight, 0) / 0.9);
    if (overall >= 65 && overridden > 0) decisionQuality = clamp(decisionQuality + 6, 30, 97);
    dimensions[4].score = Math.round(decisionQuality);
    dimensions[4].detail = decided.length
      ? `${decided.length} decision(s): ${followed} followed SAGE, ${overridden} commander override(s).`
      : "No commander decision points were triggered.";
    overall = Math.round(dimensions.reduce((s, d) => s + d.score * d.weight, 0));

    const verdict = overall >= 80 ? "decisive-success" : overall >= 65 ? "success" : overall >= 45 ? "marginal" : "failure";
    const objectives = (scenario.objectives || []).filter((o) => o.side === "blue");
    const objectiveResults = objectives.map((o) => {
      const completion = Math.round(objectiveCompletion(o, branch.units) * 100);
      return { objectiveId: o.id, title: o.title, achieved: completion >= 80, completion };
    });
    const lossExchangeRatio = round1(m.redLosses / Math.max(m.blueLosses, 1));

    const draft = {
      id: `asm-${run.id}-${branch.id}`,
      runId: run.id,
      branchId: branch.id,
      branchName: branch.name,
      coaName,
      overallScore: overall,
      verdict,
      dimensions,
      objectiveResults,
      lossExchangeRatio,
      decisionStats: { total: decided.length, followedAi: followed, overridden },
      aiCommentary: "",
      recommendations: [],
      generatedAt: nowIso(),
    };
    draft.aiCommentary = commentaryFor(draft, branch);
    draft.recommendations = recommendationsFor(draft, branch);
    return draft;
  });
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export function buildReplay(run, branchId) {
  const branch = run.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error(`Unknown branch "${branchId}".`);
  return {
    runId: run.id,
    branchId: branch.id,
    snapshots: branch._full.snapshots,
    events: branch._full.events,
    decisions: branch.decisions,
  };
}

// SANDTABLE backend entry point: env loading, HTTP router, in-memory state with
// debounced persistence, realtime run loops, boot seeding (including the
// synchronous historical rehearsal run) and the SAGE copilot endpoint.
// Plain Node ESM, zero npm dependencies. Every JSON response mirrors ../src/types.ts.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOntology } from "./ontology.mjs";
import {
  buildTheater,
  buildScenarios,
  buildRuleSets,
  buildAgents,
  buildMissions,
  buildCoas,
  buildPlatform,
  buildUsers,
  buildAuditSeed,
} from "./data.mjs";
import {
  createRun,
  tickRun,
  applyDecision,
  applyIntervention,
  buildAssessments,
  buildReplay,
} from "./engine.mjs";
import { decomposeMission, generateCoas, agentActivityFor, buildCoaAnalysis, COA_STRATEGIES } from "./agents.mjs";
import { parseOpordOffline, parseOpordAnthropic, materializeScenario } from "./opord.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SERVER_DIR, "..");
const STATE_PATH = path.join(SERVER_DIR, "state.json");
const MAX_BODY_BYTES = 1024 * 1024;
const HISTORICAL_TICK_CAP = 20000;
const ACTIVE_RUN_STATUSES = ["initializing", "running", "awaiting-decision", "paused"];
const TERMINAL_RUN_STATUSES = ["completed", "aborted"];

// ---------------------------------------------------------------------------
// Env loader — parse KEY=VALUE lines from .env at the project root; existing
// process.env values win.
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  let text = "";
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();
const PORT = Number(process.env.WAR_API_PORT) || 5189;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

let idSeq = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}${(idSeq++).toString(36).padStart(3, "0")}`;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Deep-clone a value while dropping every key that starts with "_". */
function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) continue;
      out[k] = stripInternal(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

const STATE_KEYS = [
  "scenarios",
  "theater",
  "ontology",
  "missions",
  "coas",
  "ruleSets",
  "agents",
  "runs",
  "assessments",
  "users",
  "auditLogs",
  "platform",
];

/** @type {{scenarios: any[], theater: any[], ontology: any, missions: any[], coas: any[], ruleSets: any[], agents: any[], runs: any[], assessments: any[], users: any[], auditLogs: any[], platform: any}} */
let state = null;

let persistTimer = null;
let stateDirty = false;

function persistNow() {
  if (!state) return;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    stateDirty = false;
  } catch (err) {
    console.error(`[sandtable] failed to persist state: ${err.message}`);
  }
}

function schedulePersist() {
  stateDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 2000);
  if (typeof persistTimer.unref === "function") persistTimer.unref();
}

const findScenario = (id) => state.scenarios.find((s) => s.id === id);
const findRuleSet = (id) => state.ruleSets.find((r) => r.id === id);
const findRun = (id) => state.runs.find((r) => r.id === id);
const findMission = (id) => state.missions.find((m) => m.id === id);
const findCoa = (id) => state.coas.find((c) => c.id === id);

function audit(user, action, target, detail, at) {
  const entry = { id: nextId("aud"), at: at || nowIso(), user, action, target, detail };
  state.auditLogs.push(entry);
  if (state.auditLogs.length > 500) state.auditLogs.splice(0, state.auditLogs.length - 500);
  schedulePersist();
  return entry;
}

// ---------------------------------------------------------------------------
// Realtime loop management — the HTTP layer owns one setInterval per running
// realtime run (1000 / clock.speed ms per tick). Turn-based runs advance only
// via the "step" control action.
// ---------------------------------------------------------------------------

/** @type {Map<string, NodeJS.Timeout>} */
const loops = new Map();

const ctxFor = (run) => ({ scenario: findScenario(run.scenarioId), ruleSet: findRuleSet(run.ruleSetId) });

function stopLoop(runId) {
  const handle = loops.get(runId);
  if (handle) {
    clearInterval(handle);
    loops.delete(runId);
  }
}

function startLoop(run) {
  if (run.engine !== "realtime") return;
  stopLoop(run.id);
  if (TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "paused") return;
  const intervalMs = Math.max(40, Math.round(1000 / (run.clock.speed || 1)));
  const handle = setInterval(() => advanceRun(run), intervalMs);
  loops.set(run.id, handle);
}

function advanceRun(run) {
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    finishRun(run);
    return;
  }
  let result;
  try {
    result = tickRun(run, ctxFor(run));
  } catch (err) {
    console.error(`[sandtable] tick failed for ${run.id}: ${err.message}`);
    stopLoop(run.id);
    return;
  }
  if ((result && result.completed) || TERMINAL_RUN_STATUSES.includes(run.status)) finishRun(run);
  schedulePersist();
}

/** Recompute run.status from branch statuses (never overrides paused/terminal). */
function reconcileRunStatus(run) {
  if (TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "paused") return;
  if (run.branches.every((b) => b.status === "completed" || b.status === "aborted")) {
    if (run.status !== "completed") run.status = "completed";
    finishRun(run);
  } else if (run.branches.some((b) => b.status === "awaiting-decision")) {
    run.status = "awaiting-decision";
  } else {
    run.status = "running";
  }
}

/** One-time cleanup when a run reaches a terminal status. */
function finishRun(run) {
  stopLoop(run.id);
  if (run._finalized) return;
  run._finalized = true;
  if (!run.completedAt) run.completedAt = nowIso();
  const scenario = findScenario(run.scenarioId);
  if (scenario && scenario.status === "running") {
    scenario.status = "ready";
    scenario.updatedAt = nowIso();
  }
  if (run.status === "completed") {
    for (const branch of run.branches) {
      const coa = findCoa(branch.coaId);
      if (coa && coa.status !== "rejected") coa.status = "simulated";
    }
  }
  audit(
    "engine",
    run.status === "aborted" ? "run-aborted" : "run-completed",
    run.id,
    `${run.label} finished at T+${round1(run.clock.simTimeH)}h with ${run.branches.length} branch(es).`
  );
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Boot — load persisted state or build seeds plus the historical rehearsal run.
// ---------------------------------------------------------------------------

function loadPersistedState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    for (const key of STATE_KEYS) {
      if (!(key in parsed)) return null;
    }
    return parsed;
  } catch (err) {
    console.error(`[sandtable] could not load state.json (${err.message}); rebuilding seeds.`);
    return null;
  }
}

function buildSeedState() {
  const ontology = buildOntology();
  return {
    scenarios: buildScenarios(),
    theater: buildTheater(),
    ontology,
    missions: buildMissions(),
    coas: buildCoas(),
    ruleSets: buildRuleSets(),
    agents: buildAgents(),
    runs: [],
    assessments: [],
    users: buildUsers(),
    auditLogs: buildAuditSeed(),
    platform: buildPlatform(),
  };
}

/**
 * Synchronously run one full historical deduction to completion so Assessment
 * and Replay have real computed data on first launch. Every decision point is
 * auto-resolved with the AI recommendation (followedAi).
 */
function runHistoricalDeduction() {
  const scenario = findScenario("scn-azure-horizon") || state.scenarios[0];
  const ruleSet = findRuleSet("rs-standard") || state.ruleSets[0];
  if (!scenario || !ruleSet) return;
  const scenarioCoas = state.coas.filter((c) => c.scenarioId === scenario.id);
  const wantedNames = ["direct thrust", "air-first suppression"];
  let coas = wantedNames
    .map((n) => scenarioCoas.find((c) => c.name.toLowerCase().includes(n)))
    .filter(Boolean);
  if (coas.length < 2) coas = scenarioCoas.slice(0, 2);
  if (!coas.length) return;

  const run = createRun({
    scenario,
    coas,
    ruleSet,
    engine: "realtime",
    speed: 4,
    label: "Historical: AZURE HORIZON rehearsal",
    id: "run-historical-001",
  });
  const ctx = { scenario, ruleSet };

  let iterations = 0;
  while (iterations < HISTORICAL_TICK_CAP) {
    iterations += 1;
    if (TERMINAL_RUN_STATUSES.includes(run.status)) break;
    for (const branch of run.branches) {
      for (const decision of branch.decisions) {
        if (decision.status !== "open") continue;
        applyDecision(
          run,
          branch.id,
          decision.id,
          decision.aiRecommendationId,
          "SAGE auto-umpire",
          "Rehearsal policy: commander accepted the AI recommendation.",
          ctx
        );
      }
    }
    const result = tickRun(run, ctx);
    if ((result && result.completed) || TERMINAL_RUN_STATUSES.includes(run.status)) break;
  }
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
    run.status = "completed";
    for (const branch of run.branches) {
      if (branch.status !== "completed" && branch.status !== "aborted") branch.status = "completed";
    }
  }

  // Backdate so the rehearsal reads as yesterday's exercise.
  const startedAt = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 22 * 3600 * 1000).toISOString();
  run.startedAt = startedAt;
  run.completedAt = completedAt;
  run._finalized = true;
  state.runs.push(run);

  for (const coa of coas) {
    if (coa.status !== "rejected") coa.status = "simulated";
  }

  const assessments = buildAssessments(run, ctx);
  for (const assessment of assessments) {
    assessment.generatedAt = completedAt;
    state.assessments.push(assessment);
  }

  audit(
    "engine",
    "run-completed",
    run.id,
    `${run.label} completed after ${run.clock.tick} ticks (${run.branches.length} branches, decisions auto-resolved by SAGE).`,
    completedAt
  );
  audit(
    "SAGE auto-umpire",
    "assessment-generated",
    run.id,
    `${assessments.length} branch assessment(s) computed for ${run.label}.`,
    completedAt
  );
}

function boot() {
  const persisted = loadPersistedState();
  if (persisted) {
    state = persisted;
    console.log(`[sandtable] state restored from ${path.relative(ROOT_DIR, STATE_PATH)}`);
  } else {
    state = buildSeedState();
    console.log("[sandtable] seed data built; running historical rehearsal deduction...");
    runHistoricalDeduction();
    persistNow();
    console.log("[sandtable] historical rehearsal complete; state persisted.");
  }
  for (const run of state.runs) {
    if (run.engine === "realtime" && ACTIVE_RUN_STATUSES.includes(run.status) && run.status !== "paused") {
      startLoop(run);
    }
  }
}

// ---------------------------------------------------------------------------
// Derived views — run summaries and live platform numbers.
// ---------------------------------------------------------------------------

function toRunSummary(run) {
  const scenario = findScenario(run.scenarioId);
  return {
    id: run.id,
    label: run.label,
    scenarioId: run.scenarioId,
    scenarioName: run.scenarioName,
    status: run.status,
    engine: run.engine,
    branchCount: run.branches.length,
    simTimeH: round1(run.clock.simTimeH),
    durationHours: scenario ? scenario.durationHours : 72,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function livePlatform() {
  const base = state.platform;
  const active = state.runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status));
  let totalTicks = 0;
  let totalEvents = 0;
  let totalBranches = 0;
  for (const run of state.runs) {
    totalTicks += run.clock.tick;
    for (const branch of run.branches) {
      totalEvents += branch.eventCount;
      totalBranches += 1;
    }
  }
  const wobble = Math.floor(Date.now() / 1000) % 5;

  const engines = base.engines.map((engine) => {
    const isSim = engine.kind === "realtime" || engine.kind === "turn-based";
    const mine = isSim ? active.filter((r) => r.engine === engine.kind) : active;
    const perRunLoad = isSim ? 22 : 12;
    return {
      ...engine,
      activeRuns: mine.length,
      loadPct: clamp(engine.loadPct + mine.length * perRunLoad + wobble, 2, 96),
    };
  });

  const dataDomains = base.dataDomains.map((domain) => {
    const name = domain.name.toLowerCase();
    let extraRecords = 0;
    if (name.includes("runtime")) extraRecords = totalTicks * 8 + totalBranches * 120;
    else if (name.includes("deduction")) extraRecords = totalEvents * 3 + totalTicks * 2;
    else if (name.includes("assessment")) extraRecords = state.assessments.length * 60;
    else if (name.includes("scenario")) extraRecords = state.scenarios.length * 40 + state.coas.length * 25;
    return {
      ...domain,
      records: domain.records + extraRecords,
      sizeGB: round2(domain.sizeGB + extraRecords / 250000),
    };
  });

  return {
    engines,
    dataDomains,
    lowCode: {
      maps: base.lowCode.maps,
      pieces: base.lowCode.pieces,
      rules: state.ruleSets.reduce((sum, rs) => sum + rs.rules.length, 0),
      scenarios: state.scenarios.length,
    },
    apiStats: {
      observationCalls: base.apiStats.observationCalls + totalTicks * 3 + totalEvents * 2,
      pieceDriveCalls: base.apiStats.pieceDriveCalls + totalTicks * 2 + totalEvents,
      avgLatencyMs: base.apiStats.avgLatencyMs + active.length * 4 + wobble,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario validation
// ---------------------------------------------------------------------------

function validateScenario(scenario) {
  const issues = [];
  const activeUnits = scenario.units.filter((u) => u.status !== "destroyed" && u.status !== "withdrawn");

  if (scenario.units.length === 0) {
    issues.push({ level: "error", code: "no-units", message: "Scenario has no units — place an order of battle before running." });
  } else {
    for (const side of ["blue", "red"]) {
      if (!activeUnits.some((u) => u.side === side)) {
        issues.push({
          level: "error",
          code: `side-empty-${side}`,
          message: `No active ${side.toUpperCase()} units — a deduction needs both sides on the board.`,
        });
      }
    }
  }

  for (const side of ["blue", "red"]) {
    const sideObjectives = scenario.objectives.filter((o) => o.side === side);
    if (!sideObjectives.length) {
      issues.push({
        level: "warning",
        code: `objectives-missing-${side}`,
        message: `${side.toUpperCase()} has no objectives — scoring and victory checks will be inert for that side.`,
      });
      continue;
    }
    const weightSum = sideObjectives.reduce((sum, o) => sum + o.weight, 0);
    if (weightSum < 0.85 || weightSum > 1.15) {
      issues.push({
        level: "warning",
        code: `objective-weights-${side}`,
        message: `${side.toUpperCase()} objective weights sum to ${round2(weightSum)} — expected ~1.0 for normalized scoring.`,
      });
    }
  }

  const strays = scenario.units.filter(
    (u) => u.position.lat < 31 || u.position.lat > 37 || u.position.lng < -45 || u.position.lng > -35
  );
  if (strays.length) {
    issues.push({
      level: "error",
      code: "unit-out-of-theater",
      message: `${strays.length} unit(s) positioned outside the Meridian Archipelago theater box (lat 31..37, lng -45..-35).`,
    });
  }

  const inert = activeUnits.filter((u) => u.sensors.length === 0 && u.weapons.length === 0);
  if (inert.length) {
    issues.push({
      level: "warning",
      code: "unit-inert",
      message: `${inert.length} unit(s) carry no sensors or weapons and will neither detect nor engage.`,
    });
  }

  if (scenario.durationHours < 12 || scenario.durationHours > 240) {
    issues.push({
      level: "warning",
      code: "duration-unusual",
      message: `Duration ${scenario.durationHours}h is outside the usual 12–240h exercise window.`,
    });
  }

  if (scenario.environment.emcon === "silent") {
    issues.push({
      level: "info",
      code: "emcon-silent",
      message: "EMCON silent is set — detection ranges will be sharply reduced for both sides.",
    });
  }
  if (scenario.environment.weather === "storm") {
    issues.push({
      level: "info",
      code: "weather-storm",
      message: `Storm with sea state ${scenario.environment.seaState} — expect degraded sensors and slower surface movement.`,
    });
  }

  const ok = !issues.some((i) => i.level === "error");
  if (ok) {
    issues.push({
      level: "info",
      code: "structure-ok",
      message: `Structural checks passed: ${activeUnits.length} active units, ${scenario.objectives.length} objectives, ${scenario.durationHours}h horizon.`,
    });
  }
  return { scenarioId: scenario.id, ok, issues, checkedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Rule set testing — canned situations evaluated against the documented fact
// vocabulary (range, actor.*, target.*, weather, seaState, emcon, simTimeH,
// phase.name).
// ---------------------------------------------------------------------------

const TEST_SITUATIONS = [
  {
    id: "surface-engagement",
    label: "Surface action — BLUE destroyer vs RED missile boat at 32 km, clear weather",
    keywords: ["surface", "ship", "missile boat", "destroyer", "naval", "ssm"],
    facts: {
      range: 32,
      "actor.domain": "sea",
      "actor.side": "blue",
      "actor.strength": 92,
      "actor.supply": 74,
      "actor.status": "active",
      "target.domain": "sea",
      "target.side": "red",
      "target.strength": 80,
      "target.status": "active",
      weather: "clear",
      seaState: 2,
      emcon: "restricted",
      simTimeH: 14,
      "phase.name": "engagement",
    },
  },
  {
    id: "air-strike",
    label: "Air raid — BLUE strike package vs RED SAM battalion at 110 km, overcast",
    keywords: ["air", "strike", "raid", "sam", "sead", "aircraft", "sortie"],
    facts: {
      range: 110,
      "actor.domain": "air",
      "actor.side": "blue",
      "actor.strength": 96,
      "actor.supply": 62,
      "actor.status": "active",
      "target.domain": "land",
      "target.side": "red",
      "target.strength": 88,
      "target.status": "active",
      weather: "overcast",
      seaState: 3,
      emcon: "free",
      simTimeH: 26,
      "phase.name": "engagement",
    },
  },
  {
    id: "submarine-ambush",
    label: "Subsurface ambush — RED submarine vs BLUE supply ship at 12 km, EMCON silent",
    keywords: ["sub", "torpedo", "ambush", "underwater", "asw", "silent"],
    facts: {
      range: 12,
      "actor.domain": "sea",
      "actor.side": "red",
      "actor.strength": 100,
      "actor.supply": 90,
      "actor.status": "active",
      "target.domain": "sea",
      "target.side": "blue",
      "target.strength": 100,
      "target.status": "active",
      weather: "clear",
      seaState: 4,
      emcon: "silent",
      simTimeH: 41,
      "phase.name": "detection",
    },
  },
  {
    id: "storm-transit",
    label: "Storm transit — BLUE task group at 18% supply moving through sea state 6",
    keywords: ["storm", "supply", "logistic", "transit", "movement", "weather", "resupply"],
    facts: {
      range: 180,
      "actor.domain": "sea",
      "actor.side": "blue",
      "actor.strength": 84,
      "actor.supply": 18,
      "actor.status": "active",
      "target.domain": "sea",
      "target.side": "red",
      "target.strength": 90,
      "target.status": "active",
      weather: "storm",
      seaState: 6,
      emcon: "restricted",
      simTimeH: 55,
      "phase.name": "movement",
    },
  },
];

const OP_LABELS = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  "within-km": "within km",
  has: "has",
};

function evaluateCondition(condition, facts) {
  const raw = facts[condition.fact];
  if (raw === undefined) {
    return { pass: false, why: `fact "${condition.fact}" is not present in this situation` };
  }
  const actual = Number(raw);
  const expected = Number(condition.value);
  switch (condition.op) {
    case "eq":
      return { pass: String(raw) === String(condition.value), why: `${condition.fact}=${raw}` };
    case "neq":
      return { pass: String(raw) !== String(condition.value), why: `${condition.fact}=${raw}` };
    case "gt":
      return { pass: actual > expected, why: `${condition.fact}=${raw}` };
    case "gte":
      return { pass: actual >= expected, why: `${condition.fact}=${raw}` };
    case "lt":
      return { pass: actual < expected, why: `${condition.fact}=${raw}` };
    case "lte":
      return { pass: actual <= expected, why: `${condition.fact}=${raw}` };
    case "within-km":
      return { pass: actual <= expected, why: `${condition.fact}=${raw} km vs ${condition.value} km` };
    case "has":
      return {
        pass: Array.isArray(raw) ? raw.includes(condition.value) : String(raw).includes(String(condition.value)),
        why: `${condition.fact}=${raw}`,
      };
    default:
      return { pass: false, why: `unsupported operator "${condition.op}"` };
  }
}

const conditionText = (c) => `${c.fact} ${OP_LABELS[c.op] || c.op} ${c.value}`;

function effectText(effect) {
  const p = effect.params || {};
  switch (effect.type) {
    case "modify-pk":
      return `modify-pk x${p.factor !== undefined ? p.factor : 1}`;
    case "modify-detection":
      return `modify-detection x${p.factor !== undefined ? p.factor : 1}`;
    case "modify-speed":
      return `modify-speed x${p.factor !== undefined ? p.factor : 1}`;
    case "apply-damage":
      return `apply-damage ${p.amount !== undefined ? p.amount : 0}`;
    case "consume-supply":
      return `consume-supply ${p.amount !== undefined ? p.amount : 0}`;
    case "reveal-unit":
      return "reveal-unit";
    case "score-points":
      return `score-points +${p.points !== undefined ? p.points : 0}`;
    case "spawn-event":
      return `spawn-event "${p.title !== undefined ? p.title : "event"}"`;
    case "request-decision":
      return `request-decision "${p.title !== undefined ? p.title : "decision"}"`;
    default:
      return effect.type;
  }
}

function pickSituation(text) {
  const q = String(text || "").toLowerCase();
  const byId = TEST_SITUATIONS.find((s) => s.id === q);
  if (byId) return byId;
  let best = TEST_SITUATIONS[0];
  let bestHits = 0;
  for (const situation of TEST_SITUATIONS) {
    let hits = 0;
    for (const keyword of situation.keywords) {
      if (q.includes(keyword)) hits += 1;
    }
    if (q.includes(situation.id)) hits += 3;
    if (hits > bestHits) {
      bestHits = hits;
      best = situation;
    }
  }
  return best;
}

function testRuleSet(ruleSet, situationText) {
  const situation = pickSituation(situationText);
  const ordered = [...ruleSet.rules].sort((a, b) => a.priority - b.priority);
  const trace = [];
  const totals = { pk: 1, detection: 1, speed: 1, damage: 0, supply: 0, points: 0, reveals: 0 };
  const spawned = [];
  const decisionsRequested = [];
  let firedCount = 0;

  for (const rule of ordered) {
    if (!rule.enabled) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, fired: false, detail: "Rule disabled — skipped." });
      continue;
    }
    let failed = null;
    for (const condition of rule.conditions) {
      const result = evaluateCondition(condition, situation.facts);
      if (!result.pass) {
        failed = { condition, why: result.why };
        break;
      }
    }
    if (failed) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        fired: false,
        detail: `Not fired — condition "${conditionText(failed.condition)}" failed (${failed.why}).`,
      });
      continue;
    }
    firedCount += 1;
    for (const effect of rule.effects) {
      const p = effect.params || {};
      if (effect.type === "modify-pk") totals.pk *= Number(p.factor) || 1;
      else if (effect.type === "modify-detection") totals.detection *= Number(p.factor) || 1;
      else if (effect.type === "modify-speed") totals.speed *= Number(p.factor) || 1;
      else if (effect.type === "apply-damage") totals.damage += Number(p.amount) || 0;
      else if (effect.type === "consume-supply") totals.supply += Number(p.amount) || 0;
      else if (effect.type === "score-points") totals.points += Number(p.points) || 0;
      else if (effect.type === "reveal-unit") totals.reveals += 1;
      else if (effect.type === "spawn-event") spawned.push(String(p.title || "event"));
      else if (effect.type === "request-decision") decisionsRequested.push(String(p.title || "decision"));
    }
    const when = rule.conditions.length ? rule.conditions.map(conditionText).join(" AND ") : "always";
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      fired: true,
      detail: `WHEN ${when} THEN ${rule.effects.map(effectText).join(", ")}.`,
    });
  }

  const parts = [];
  if (totals.pk !== 1) parts.push(`Pk x${round2(totals.pk)}`);
  if (totals.detection !== 1) parts.push(`detection x${round2(totals.detection)}`);
  if (totals.speed !== 1) parts.push(`speed x${round2(totals.speed)}`);
  if (totals.damage > 0) parts.push(`${round1(totals.damage)} damage applied`);
  if (totals.supply > 0) parts.push(`${round1(totals.supply)} supply consumed`);
  if (totals.points > 0) parts.push(`+${totals.points} victory points`);
  if (totals.reveals > 0) parts.push(`${totals.reveals} unit reveal(s)`);
  if (spawned.length) parts.push(`event(s): ${spawned.join(", ")}`);
  if (decisionsRequested.length) parts.push(`decision requested: ${decisionsRequested.join(", ")}`);

  const outcome =
    `${firedCount}/${ordered.length} rules fired for "${situation.label}". ` +
    (parts.length ? `Net adjudication: ${parts.join("; ")}.` : "No effects applied — baseline adjudication stands.");

  return { ruleSetId: ruleSet.id, situation: situation.label, outcome, trace, testedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Copilot — SAGE. OpenAI chat completions when a key is configured, otherwise
// rule-based answers composed from live state.
// ---------------------------------------------------------------------------

const SAGE_SYSTEM_PROMPT =
  "You are SAGE, the strategy advisor inside the fictional SANDTABLE wargame demo. " +
  "Everything here is invented: the Meridian Archipelago theater, Exercise AZURE HORIZON, " +
  "BLUE Coalition Task Force versus RED Opposing Force (OPFOR). Answer as a concise " +
  "military staff advisor in two to five sentences, grounded strictly in the live " +
  "situation data provided below. Never present the exercise as real-world events and " +
  "never reference real countries, forces or persons.";

const activeRuns = () => state.runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status));

function situationSummary() {
  const lines = [];
  lines.push("Exercise AZURE HORIZON — fictional Meridian Archipelago theater; BLUE Coalition Task Force vs RED OPFOR.");
  lines.push(
    `Scenarios: ${state.scenarios.map((s) => `${s.name} [${s.status}, ${s.units.length} units, ${s.objectives.length} objectives]`).join("; ")}.`
  );
  const rs = state.ruleSets.find((r) => r.status === "active") || state.ruleSets[0];
  if (rs) {
    lines.push(
      `Active rule set: ${rs.name} (${rs.rules.filter((r) => r.enabled).length} enabled rules, ${rs.adjudication.mode} adjudication, ${rs.adjudication.dieModel} die model).`
    );
  }
  for (const run of state.runs.slice(-4)) {
    const scenario = findScenario(run.scenarioId);
    lines.push(
      `Run "${run.label}" (${run.engine}, ${run.status}) at T+${round1(run.clock.simTimeH)}h of ${scenario ? scenario.durationHours : 72}h:`
    );
    for (const branch of run.branches) {
      const m = branch.metrics;
      lines.push(
        `  - ${branch.name}: ${branch.status}; BLUE ${Math.round(m.blueStrength)}% vs RED ${Math.round(m.redStrength)}%; objectives ${Math.round(m.objectiveScore)}%; losses B${m.blueLosses}/R${m.redLosses}; supply ${Math.round(m.supplyLevel)}%.`
      );
      for (const decision of branch.decisions) {
        if (decision.status !== "open") continue;
        const rec = decision.options.find((o) => o.id === decision.aiRecommendationId);
        lines.push(`    Open decision: "${decision.title}" — AI recommends "${rec ? rec.label : decision.aiRecommendationId}".`);
      }
    }
  }
  const inPlay = state.coas.filter((c) => c.status === "selected" || c.status === "simulated");
  if (inPlay.length) {
    lines.push(
      `COAs in play: ${inPlay.map((c) => `${c.name} (${c.approach}; composite ${c.scores.composite}, risk ${c.scores.risk})`).join("; ")}.`
    );
  }
  lines.push(`Agent library: ${state.agents.filter((a) => a.status === "ready").length}/${state.agents.length} agents ready.`);
  if (state.assessments.length) {
    lines.push(
      `Latest assessments: ${state.assessments.slice(-4).map((a) => `${a.branchName} — ${a.verdict} (${a.overallScore}/100, LER ${a.lossExchangeRatio})`).join("; ")}.`
    );
  }
  return lines.join("\n").slice(0, 6000);
}

function describeBranch(branch) {
  const m = branch.metrics;
  return `${branch.name} is ${branch.status} at BLUE ${Math.round(m.blueStrength)}% vs RED ${Math.round(m.redStrength)}%, objective completion ${Math.round(m.objectiveScore)}%, losses B${m.blueLosses}/R${m.redLosses}`;
}

function answerRunStatus() {
  const act = activeRuns();
  if (act.length) {
    const pieces = act.slice(0, 2).map((run) => {
      const scenario = findScenario(run.scenarioId);
      const branchText = run.branches.map(describeBranch).join(". ");
      const open = run.branches.reduce((n, b) => n + b.decisions.filter((d) => d.status === "open").length, 0);
      return (
        `"${run.label}" (${run.engine}) is ${run.status} at T+${round1(run.clock.simTimeH)}h of ${scenario ? scenario.durationHours : 72}h. ` +
        `${branchText}.` +
        (open ? ` ${open} decision point(s) are awaiting the commander.` : "")
      );
    });
    return pieces.join(" ");
  }
  const done = state.runs
    .filter((r) => TERMINAL_RUN_STATUSES.includes(r.status))
    .sort((a, b) => String(a.completedAt || "").localeCompare(String(b.completedAt || "")));
  const latest = done[done.length - 1];
  if (!latest) {
    return "No deduction runs have been launched yet. Open the Deduction page, pick a ready scenario, one or more selected COAs and a rule set, then start a realtime or turn-based run.";
  }
  return (
    `No run is active right now. The most recent, "${latest.label}", finished ${latest.status} at T+${round1(latest.clock.simTimeH)}h. ` +
    latest.branches.map(describeBranch).join(". ") +
    ". Head to Assessment & Replay to review it."
  );
}

function answerDecisions() {
  const open = [];
  for (const run of activeRuns()) {
    for (const branch of run.branches) {
      for (const decision of branch.decisions) {
        if (decision.status !== "open") continue;
        const rec = decision.options.find((o) => o.id === decision.aiRecommendationId);
        open.push(
          `"${decision.title}" on branch ${branch.name} of ${run.label} — ${decision.options.length} options, AI recommends "${rec ? rec.label : decision.aiRecommendationId}"`
        );
      }
    }
  }
  if (!open.length) {
    return "No decision points are open right now. They surface at COA phase boundaries and on emergent triggers such as first contact or a branch dropping below 70% strength; the branch pauses until the commander decides.";
  }
  return `${open.length} decision point(s) are open: ${open.join("; ")}. The commander can follow the AI recommendation or override it with a rationale — both are retained for the assessment.`;
}

function answerCoaComparison() {
  const coas = [...state.coas].sort((a, b) => b.scores.composite - a.scores.composite);
  if (!coas.length) return "No COAs exist yet. Decompose a mission on the COA Generation page, then generate two to four candidates to compare.";
  const top = coas.slice(0, 3).map(
    (c) =>
      `${c.name} (${c.approach}) — composite ${c.scores.composite}, feasibility ${c.scores.feasibility}, expected effect ${c.scores.expectedEffect}, risk ${c.scores.risk} [${c.status}]`
  );
  const best = coas[0];
  const safest = [...coas].sort((a, b) => a.scores.risk - b.scores.risk)[0];
  let advice = `On composite utility, ${best.name} leads.`;
  if (safest && safest.id !== best.id) {
    advice += ` If risk tolerance is low, ${safest.name} carries the lowest risk score (${safest.scores.risk}).`;
  }
  return `Comparing ${coas.length} COA(s): ${top.join("; ")}. ${advice}`;
}

function answerRules() {
  const rs = state.ruleSets.find((r) => r.status === "active") || state.ruleSets[0];
  if (!rs) return "No rule sets are configured yet. Create one on the Simulation Rules page to control detection, engagement, movement, logistics, attrition and victory adjudication.";
  const enabled = rs.rules.filter((r) => r.enabled);
  const byCategory = {};
  for (const rule of enabled) byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
  const cats = Object.entries(byCategory).map(([k, v]) => `${v} ${k}`).join(", ");
  return (
    `The governing rule set is "${rs.name}" with ${enabled.length} of ${rs.rules.length} rules enabled (${cats}). ` +
    `Adjudication runs in ${rs.adjudication.mode} mode with a ${rs.adjudication.dieModel} die model (seed ${rs.adjudication.seed}), phases ordered ${rs.adjudication.phaseOrder.join(" > ")}. ` +
    "Each tick the engine evaluates rule conditions over facts like range, domain, strength, supply, weather and EMCON, then applies effects such as Pk or detection modifiers, damage, supply consumption and victory points."
  );
}

function answerAgents() {
  const byMode = {};
  for (const agent of state.agents) byMode[agent.driveMode] = (byMode[agent.driveMode] || 0) + 1;
  const modeText = Object.entries(byMode).map(([k, v]) => `${v} ${k}`).join(", ");
  const ready = state.agents.filter((a) => a.status === "ready").length;
  const best = [...state.agents].sort((a, b) => b.metrics.winRate - a.metrics.winRate)[0];
  return (
    `The tactical library holds ${state.agents.length} mission agents (${modeText}); ${ready} are ready. ` +
    (best
      ? `Top evaluator is ${best.name} (${best.specialty}, ${best.driveMode}) at ${Math.round(best.metrics.winRate * 100)}% eval win rate and ${best.metrics.avgLatencyMs} ms average latency. `
      : "") +
    "Agents sense through the Observation API and act through the Piece-drive API; strategic decomposition assigns them to sub-tasks by specialty."
  );
}

function answerAssessments() {
  if (!state.assessments.length) {
    return "No assessments have been generated yet. Complete a deduction run, then use Generate assessment on the Assessment & Replay page to score each branch across mission accomplishment, force preservation, tempo, resource efficiency and decision quality.";
  }
  const latestRunId = state.assessments[state.assessments.length - 1].runId;
  const batch = state.assessments.filter((a) => a.runId === latestRunId);
  const run = findRun(latestRunId);
  const lines = batch.map(
    (a) =>
      `${a.branchName} (${a.coaName}): ${a.verdict}, ${a.overallScore}/100, loss exchange ${a.lossExchangeRatio}, decisions ${a.decisionStats.followedAi}/${a.decisionStats.total} followed the AI`
  );
  const best = [...batch].sort((a, b) => b.overallScore - a.overallScore)[0];
  return (
    `Latest assessed run is "${run ? run.label : latestRunId}". ${lines.join("; ")}. ` +
    (best ? `${best.branchName} scored highest — its replay is available branch-by-branch with full snapshots and the event log.` : "")
  );
}

function answerPlatform() {
  const platform = livePlatform();
  const online = platform.engines.filter((e) => e.status === "online").length;
  return (
    "SANDTABLE is layered in three tiers. L3 applications carry the workflow from scenario design through COA generation, rule configuration and full-process deduction to assessment and replay. " +
    `L2 is the AI layer: strategic task decomposition, a tactical agent library of ${state.agents.length} agents across five drive modes, and human+AI collaborative decision on the OODA loop, wired to the wargame system through ${platform.apiStats.observationCalls.toLocaleString("en-US")} observation and ${platform.apiStats.pieceDriveCalls.toLocaleString("en-US")} piece-drive calls so far. ` +
    `L1 is the platform foundation: ${online}/${platform.engines.length} simulation engines online, a unified data foundation across ${platform.dataDomains.length} domains, and an ontology of ${state.ontology.classes.length} classes and ${state.ontology.relations.length} relations backing the low-code designers.`
  );
}

function answerOverview() {
  const act = activeRuns();
  const open = act.reduce(
    (n, r) => n + r.branches.reduce((m, b) => m + b.decisions.filter((d) => d.status === "open").length, 0),
    0
  );
  return (
    `Exercise AZURE HORIZON overview: ${state.scenarios.filter((s) => s.status === "ready").length} scenario(s) ready of ${state.scenarios.length}, ` +
    `${state.coas.length} COA(s) on file, ${state.agents.filter((a) => a.status === "ready").length}/${state.agents.length} agents ready, ` +
    `${act.length} active run(s) and ${open} open decision(s), ${state.assessments.length} assessment(s) archived. ` +
    "Ask me about run status, COA comparison, decision points, adjudication rules, the agent library, assessments or the platform architecture."
  );
}

function offlineAnswer(question, reason, startedMs) {
  const q = question.toLowerCase();
  let answer;
  if (/\b(coa|course of action|courses of action|compare|comparison|which plan|best plan)\b/.test(q)) {
    answer = answerCoaComparison();
  } else if (/\b(decision|decide|awaiting|pending|option)\b/.test(q)) {
    answer = answerDecisions();
  } else if (/\b(rule|rules|adjudicat\w*|die model|dice|pk|engagement rules)\b/.test(q)) {
    answer = answerRules();
  } else if (/\b(assess\w*|verdict|after action|aar|replay|debrief)\b/.test(q)) {
    answer = answerAssessments();
  } else if (/\b(agent|agents|drive mode|tactical library|ai layer|ooda)\b/.test(q)) {
    answer = answerAgents();
  } else if (/\b(platform|layer|layers|architecture|foundation|ontolog\w*|data domain|storage|engine|engines)\b/.test(q)) {
    answer = answerPlatform();
  } else if (/\b(run|runs|running|deduction|simulat\w*|progress|status|branch|branches|clock|tick)\b/.test(q)) {
    answer = answerRunStatus();
  } else {
    answer = answerOverview();
  }
  return { answer, source: "offline", reason, latencyMs: Date.now() - startedMs };
}

// SAGE via the Anthropic Messages API. Raw HTTP by design: this server is
// dependency-free (see CONTRACTS.md), mirroring the existing OpenAI path.
// Claude Opus 5 thinks adaptively by default, so no `thinking` parameter is
// sent; max_tokens covers thinking + answer. A safety-classifier decline
// (stop_reason "refusal") degrades to the offline knowledge base.
async function askAnthropic(question, pageContext, startedMs, apiKey) {
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        output_config: { effort: "medium" },
        system:
          `${SAGE_SYSTEM_PROMPT}\n\nKeep answers under 180 words unless the question demands more.` +
          `\n\nLive situation:\n${situationSummary()}`,
        messages: [
          {
            role: "user",
            content: pageContext ? `${question}\n\n(Page context: ${pageContext})` : question,
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return offlineAnswer(question, `anthropic_http_${response.status}`, startedMs);
    const data = await response.json();
    if (data && data.stop_reason === "refusal") return offlineAnswer(question, "anthropic_refusal", startedMs);
    const answer = Array.isArray(data && data.content)
      ? data.content
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
          .trim()
      : "";
    if (!answer) return offlineAnswer(question, "anthropic_empty", startedMs);
    return { answer, source: "anthropic", model, latencyMs: Date.now() - startedMs };
  } catch (err) {
    clearTimeout(timer);
    return offlineAnswer(question, err && err.name === "AbortError" ? "anthropic_timeout" : "anthropic_error", startedMs);
  }
}

async function handleAsk(body) {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw httpError(400, "Field 'question' is required.");
  const pageContext = typeof body.context === "string" ? body.context.trim() : "";
  const startedMs = Date.now();
  // Provider precedence: Anthropic, then OpenAI, then the offline knowledge base.
  if (process.env.ANTHROPIC_API_KEY) return askAnthropic(question, pageContext, startedMs, process.env.ANTHROPIC_API_KEY);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return offlineAnswer(question, "no_api_key", startedMs);

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 450,
        messages: [
          { role: "system", content: `${SAGE_SYSTEM_PROMPT}\n\nLive situation:\n${situationSummary()}` },
          {
            role: "user",
            content: pageContext ? `${question}\n\n(Page context: ${pageContext})` : question,
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return offlineAnswer(question, `openai_http_${response.status}`, startedMs);
    const data = await response.json();
    const answer =
      data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : "";
    if (!answer) return offlineAnswer(question, "openai_empty", startedMs);
    return { answer, source: "openai", model, latencyMs: Date.now() - startedMs };
  } catch (err) {
    clearTimeout(timer);
    return offlineAnswer(question, err && err.name === "AbortError" ? "openai_timeout" : "openai_error", startedMs);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** Wipe all state, reseed, and re-run the historical rehearsal (synchronous). */
function handleResetDemo() {
  for (const handle of loops.values()) clearInterval(handle);
  loops.clear();
  console.log("[sandtable] demo reset requested; reseeding and re-running the rehearsal...");
  state = buildSeedState();
  runHistoricalDeduction();
  audit("admin", "demo-reset", "platform", "State wiped and reseeded; historical rehearsal deduction re-run.");
  persistNow();
  console.log("[sandtable] demo reset complete.");
  return { ok: true, scenarios: state.scenarios.length, runs: state.runs.length };
}

const PIECE_DOMAINS = { sea: "maritime", air: "air", land: "land", cyber: "cyber", space: "space" };

/** Low-code piece designer: add a force class (with unit defaults) to the ontology. */
function handleCreatePieceType(body) {
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) throw httpError(400, "Field 'label' is required.");
  const domain = Object.keys(PIECE_DOMAINS).includes(body.domain) ? body.domain : "sea";
  const prefix = PIECE_DOMAINS[domain];
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw httpError(400, "Field 'label' must contain letters or digits.");
  let id = `${prefix}.${slug}`;
  if (state.ontology.classes.some((c) => c.id === id)) {
    id = `${prefix}.${slug}-${state.ontology.classes.filter((c) => c.id.startsWith(`${prefix}.${slug}`)).length + 1}`;
  }
  const parentCandidate = `${prefix}.unit`;
  const parent = state.ontology.classes.some((c) => c.id === parentCandidate) ? parentCandidate : "force-unit";

  const sanitizeSensors = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((s) => s && typeof s.type === "string" && s.type.trim())
      .slice(0, 6)
      .map((s) => ({ type: s.type.trim(), rangeKm: clamp(Number(s.rangeKm) || 10, 1, 600) }));
  const sanitizeWeapons = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((w) => w && typeof w.type === "string" && w.type.trim())
      .slice(0, 6)
      .map((w) => ({
        type: w.type.trim(),
        rangeKm: clamp(Number(w.rangeKm) || 10, 1, 600),
        pk: clamp(Number(w.pk) || 0.4, 0.02, 0.95),
        ammo: Math.round(clamp(Number(w.ammo) || 8, 1, 200)),
      }));

  const pieceClass = {
    id,
    label,
    parent,
    category: "force",
    domain,
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : `Custom ${label.toLowerCase()} piece type authored in the low-code designer.`,
    attributes: [
      { name: "strength", type: "number", unit: "%", description: "Combat effectiveness remaining, 0-100." },
      { name: "supply", type: "number", unit: "%", description: "Fuel and munitions state, 0-100." },
      { name: "speedKts", type: "number", unit: "kts", description: "Ordered speed." },
      {
        name: "status",
        type: "enum",
        enumValues: ["active", "damaged", "destroyed", "withdrawn"],
        description: "Adjudicated unit state.",
      },
    ],
    icon: "Puzzle",
    defaults: {
      speedKts: clamp(Number(body.speedKts) || 12, 0, 600),
      strength: 100,
      supply: clamp(Number(body.supply) || 100, 10, 100),
      sensors: sanitizeSensors(body.sensors),
      weapons: sanitizeWeapons(body.weapons),
    },
  };

  state.ontology.classes.push(pieceClass);
  state.ontology.updatedAt = nowIso();
  state.platform.lowCode.pieces = state.ontology.classes.filter((c) => c.category === "force").length;
  audit("designer", "piece-created", pieceClass.id, `Piece type "${label}" (${domain}) added to the ontology.`);
  schedulePersist();
  return pieceClass;
}

function requireScenario(id) {
  const scenario = findScenario(id);
  if (!scenario) throw httpError(404, `Unknown scenario "${id}".`);
  return scenario;
}

function requireRun(id) {
  const run = findRun(id);
  if (!run) throw httpError(404, `Unknown run "${id}".`);
  return run;
}

// Run payloads carry the scenario's live environment so the console header
// reflects umpire weather changes without a bootstrap refetch.
function serializeRun(run) {
  const scenario = findScenario(run.scenarioId);
  return { ...stripInternal(run), environment: scenario ? scenario.environment : null };
}

function requireBranch(run, branchId) {
  const branch = run.branches.find((b) => b.id === branchId);
  if (!branch) throw httpError(404, `Unknown branch "${branchId}" on run "${run.id}".`);
  return branch;
}

const DEFAULT_ENVIRONMENT = { weather: "clear", seaState: 2, visibilityKm: 18, emcon: "restricted", cyberThreat: "low" };
const DEFAULT_SIDES = [
  { id: "blue", name: "Coalition Task Force", commander: "RADM K. Ellison", color: "#1f5f99" },
  { id: "red", name: "Opposing Force (OPFOR)", commander: "GEN V. Maro", color: "#b23b3b" },
];

const deepClone = (v) => JSON.parse(JSON.stringify(v));

function handleCreateScenario(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw httpError(400, "Field 'name' is required.");
  const template = body.template ? findScenario(body.template) : findScenario("scn-blank-template");
  const scenario = {
    id: nextId("scn"),
    name,
    codename: typeof body.codename === "string" && body.codename.trim() ? body.codename.trim() : name.toUpperCase(),
    description:
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : `Planning draft for ${name} in the Meridian Archipelago.`,
    theater: "Meridian Archipelago",
    mapCenter: template ? deepClone(template.mapCenter) : { lat: 34.0, lng: -40.0 },
    mapZoom: template ? template.mapZoom : 7,
    durationHours: template ? template.durationHours : 48,
    status: "draft",
    createdBy: "Planning Cell",
    updatedAt: nowIso(),
    sides: template && template.sides.length ? deepClone(template.sides) : deepClone(DEFAULT_SIDES),
    units: template ? deepClone(template.units) : [],
    objectives: template ? deepClone(template.objectives) : [],
    environment: template ? deepClone(template.environment) : { ...DEFAULT_ENVIRONMENT },
  };
  state.scenarios.push(scenario);
  audit("operator", "scenario-created", scenario.id, `Scenario "${scenario.name}" created${template ? ` from template ${template.id}` : ""}.`);
  schedulePersist();
  return scenario;
}

const SCENARIO_UPDATABLE = [
  "name",
  "codename",
  "description",
  "mapCenter",
  "mapZoom",
  "durationHours",
  "status",
  "sides",
  "units",
  "objectives",
  "environment",
];

function handleUpdateScenario(id, body) {
  const scenario = requireScenario(id);
  for (const key of SCENARIO_UPDATABLE) {
    if (key in body && body[key] !== undefined) scenario[key] = body[key];
  }
  scenario.updatedAt = nowIso();
  audit("operator", "scenario-updated", scenario.id, `Scenario "${scenario.name}" saved (${scenario.units.length} units, ${scenario.objectives.length} objectives).`);
  schedulePersist();
  return scenario;
}

// --- Intelligent Documents (OPORD pipeline) --------------------------------------

function forceClassCatalog() {
  return state.ontology.classes.filter((c) => c.category === "force" && c.id.includes("."));
}

async function handleParseOpord(body) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 40) throw httpError(400, "Provide the operational document text (at least a few lines).");
  if (text.length > 20000) throw httpError(400, "Document too large (20k character cap for the demo).");
  const classes = forceClassCatalog();
  let parse = null;
  if (process.env.ANTHROPIC_API_KEY) {
    parse = await parseOpordAnthropic(text, classes, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || "claude-opus-5");
  }
  if (!parse) parse = parseOpordOffline(text, classes);
  const total = parse.sides.reduce((s, side) => s + side.entities.length, 0);
  if (!total) throw httpError(422, "No force entities could be extracted — check the document follows an OPORD structure with BLUE/RED force sections.");
  audit("planner", "opord-parsed", parse.title, `Intelligent Documents extracted ${total} entity group(s) via ${parse.source}.`);
  return parse;
}

function handleScenarioFromOpord(body) {
  const parse = body && typeof body.parse === "object" ? body.parse : null;
  if (!parse || !Array.isArray(parse.sides)) throw httpError(400, "Field 'parse' (an OpordParse) is required.");
  const scenario = materializeScenario(
    parse,
    { name: body.name, codename: body.codename, durationHours: body.durationHours, createdBy: body.createdBy },
    state,
    nowIso
  );
  state.scenarios.push(scenario);
  state.platform.lowCode.scenarios = state.scenarios.length;
  audit(
    "planner",
    "scenario-imported",
    scenario.id,
    `Scenario "${scenario.name}" materialized from an operational document (${scenario.units.length} units, ${scenario.objectives.length} objectives).`
  );
  schedulePersist();
  return scenario;
}

function handleCreateMission(body) {
  const scenario = requireScenario(String(body.scenarioId || ""));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw httpError(400, "Field 'title' is required.");
  const side = ["blue", "red", "neutral"].includes(body.side) ? body.side : "blue";
  const mission = {
    id: nextId("msn"),
    scenarioId: scenario.id,
    side,
    title,
    intent: typeof body.intent === "string" ? body.intent : "",
    endState: typeof body.endState === "string" ? body.endState : "",
    status: "draft",
    subTasks: [],
    updatedAt: nowIso(),
  };
  state.missions.push(mission);
  audit("operator", "mission-created", mission.id, `Mission "${mission.title}" drafted for ${scenario.name}.`);
  schedulePersist();
  return mission;
}

function handleDecomposeMission(id) {
  const index = state.missions.findIndex((m) => m.id === id);
  if (index === -1) throw httpError(404, `Unknown mission "${id}".`);
  const mission = state.missions[index];
  const scenario = requireScenario(mission.scenarioId);
  const decomposed = decomposeMission(mission, scenario);
  decomposed.updatedAt = nowIso();
  state.missions[index] = decomposed;
  audit("SAGE", "mission-decomposed", decomposed.id, `Mission "${decomposed.title}" decomposed into ${decomposed.subTasks.length} sub-tasks.`);
  schedulePersist();
  return decomposed;
}

const MISSION_UPDATABLE = ["title", "intent", "endState", "status", "subTasks", "side"];

function handleUpdateMission(id, body) {
  const mission = findMission(id);
  if (!mission) throw httpError(404, `Unknown mission "${id}".`);
  for (const key of MISSION_UPDATABLE) {
    if (key in body && body[key] !== undefined) mission[key] = body[key];
  }
  mission.updatedAt = nowIso();
  audit("operator", "mission-updated", mission.id, `Mission "${mission.title}" updated.`);
  schedulePersist();
  return mission;
}

function handleGenerateCoas(body) {
  const scenario = requireScenario(String(body.scenarioId || ""));
  const mission = findMission(String(body.missionId || ""));
  if (!mission) throw httpError(404, `Unknown mission "${body.missionId}".`);
  const count = clamp(Math.round(Number(body.count) || 3), 2, 4);
  const existingCount = state.coas.filter((c) => c.missionId === mission.id).length;
  const strategy = Object.prototype.hasOwnProperty.call(COA_STRATEGIES, body.strategy) ? body.strategy : "balanced";
  const generated = generateCoas(scenario, mission, count, existingCount, strategy);
  for (const coa of generated) state.coas.push(coa);
  const analysis = buildCoaAnalysis(scenario, mission, strategy, generated);
  audit("SAGE", "coas-generated", mission.id, `${generated.length} COA candidate(s) generated for "${mission.title}" under the ${COA_STRATEGIES[strategy].label} strategy.`);
  schedulePersist();
  return { coas: generated, analysis, strategy };
}

// Silent deduction: a throwaway headless run of one COA under the active rule set,
// auto-accepting every AI recommendation. Nothing is persisted except the summary
// stamped onto the COA itself.
function handleSilentEval(coaId) {
  const coa = findCoa(coaId);
  if (!coa) throw httpError(404, `Unknown COA "${coaId}".`);
  const scenario = requireScenario(coa.scenarioId);
  const ruleSet = state.ruleSets.find((r) => r.status === "active") || state.ruleSets[0];
  if (!ruleSet) throw httpError(400, "No rule set available for silent evaluation.");
  const run = createRun({
    scenario,
    coas: [coa],
    ruleSet,
    engine: "realtime",
    speed: 4,
    label: `Silent eval — ${coa.name}`,
    id: `run-silent-${Date.now().toString(36)}`,
  });
  const ctx = { scenario, ruleSet };
  let iterations = 0;
  while (iterations < HISTORICAL_TICK_CAP) {
    iterations += 1;
    if (TERMINAL_RUN_STATUSES.includes(run.status)) break;
    for (const branch of run.branches) {
      for (const decision of branch.decisions) {
        if (decision.status !== "open") continue;
        applyDecision(run, branch.id, decision.id, decision.aiRecommendationId, "SAGE silent umpire", "Silent evaluation: AI recommendation auto-accepted.", ctx);
      }
    }
    const result = tickRun(run, ctx);
    if ((result && result.completed) || TERMINAL_RUN_STATUSES.includes(run.status)) break;
  }
  const branch = run.branches[0];
  const m = branch.metrics;
  coa.silentEval = {
    evaluatedAt: nowIso(),
    ruleSetId: ruleSet.id,
    projected: {
      objectiveScore: m.objectiveScore,
      blueStrength: m.blueStrength,
      redStrength: m.redStrength,
      blueLosses: m.blueLosses,
      redLosses: m.redLosses,
      supplyLevel: m.supplyLevel,
      decisions: branch.decisions.length,
      durationH: Math.round(branch._simTimeH || scenario.durationHours),
      net: branch.score ? branch.score.net : 0,
    },
  };
  if (coa.status === "candidate") coa.status = "simulated";
  audit("SAGE", "coa-silent-eval", coa.id, `Silent deduction of "${coa.name}": objectives ${m.objectiveScore}%, BLUE ${m.blueStrength}%, RED ${m.redStrength}% at T+${coa.silentEval.projected.durationH}h.`);
  schedulePersist();
  return coa;
}

const COA_UPDATABLE = ["name", "approach", "summary", "status", "phases", "scores", "color"];

function handleUpdateCoa(id, body) {
  const coa = findCoa(id);
  if (!coa) throw httpError(404, `Unknown COA "${id}".`);
  for (const key of COA_UPDATABLE) {
    if (key in body && body[key] !== undefined) coa[key] = body[key];
  }
  audit("operator", "coa-updated", coa.id, `COA "${coa.name}" set to ${coa.status}.`);
  schedulePersist();
  return coa;
}

function handleCreateRuleSet(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw httpError(400, "Field 'name' is required.");
  const domainFocus = ["joint", "land", "sea", "air", "cyber", "space"].includes(body.domainFocus)
    ? body.domainFocus
    : "joint";
  const ruleSet = {
    id: nextId("rs"),
    name,
    description: typeof body.description === "string" ? body.description : "",
    domainFocus,
    status: "draft",
    rules: [],
    adjudication: {
      mode: "hybrid",
      dieModel: "stochastic",
      seed: 20260818,
      phaseOrder: ["movement", "detection", "engagement", "logistics", "attrition", "victory"],
    },
    updatedAt: nowIso(),
    author: typeof body.author === "string" && body.author.trim() ? body.author.trim() : "operator",
  };
  state.ruleSets.push(ruleSet);
  audit(ruleSet.author, "ruleset-created", ruleSet.id, `Rule set "${ruleSet.name}" created (${domainFocus}).`);
  schedulePersist();
  return ruleSet;
}

const RULESET_UPDATABLE = ["name", "description", "domainFocus", "status", "rules", "adjudication"];

function handleUpdateRuleSet(id, body) {
  const ruleSet = findRuleSet(id);
  if (!ruleSet) throw httpError(404, `Unknown rule set "${id}".`);
  for (const key of RULESET_UPDATABLE) {
    if (key in body && body[key] !== undefined) ruleSet[key] = body[key];
  }
  ruleSet.updatedAt = nowIso();
  audit("operator", "ruleset-updated", ruleSet.id, `Rule set "${ruleSet.name}" saved with ${ruleSet.rules.length} rules.`);
  schedulePersist();
  return ruleSet;
}

function handleStartRun(body) {
  const scenario = requireScenario(String(body.scenarioId || ""));
  const ruleSet = findRuleSet(String(body.ruleSetId || ""));
  if (!ruleSet) throw httpError(404, `Unknown rule set "${body.ruleSetId}".`);
  if (!Array.isArray(body.coaIds) || body.coaIds.length === 0) {
    throw httpError(400, "Field 'coaIds' must be a non-empty array.");
  }
  const coas = body.coaIds.map((cid) => {
    const coa = findCoa(String(cid));
    if (!coa) throw httpError(404, `Unknown COA "${cid}".`);
    if (coa.scenarioId !== scenario.id) throw httpError(400, `COA "${coa.name}" does not belong to scenario "${scenario.name}".`);
    return coa;
  });
  const engine = body.engine === "turn-based" ? "turn-based" : body.engine === "realtime" ? "realtime" : null;
  if (!engine) throw httpError(400, "Field 'engine' must be 'realtime' or 'turn-based'.");
  const speed = clamp(Number(body.speed) || 1, 0.25, 16);
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : `${scenario.codename} deduction ${state.runs.length + 1}`;

  const run = createRun({ scenario, coas, ruleSet, engine, speed, label, id: nextId("run") });
  state.runs.push(run);
  scenario.status = "running";
  scenario.updatedAt = nowIso();
  startLoop(run);
  audit("operator", "run-started", run.id, `${label}: ${coas.length} branch(es) on ${scenario.name} via ${ruleSet.name} (${engine}, x${speed}).`);
  schedulePersist();
  return serializeRun(run);
}

function handleControlRun(id, body) {
  const run = requireRun(id);
  const action = String(body.action || "");
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw httpError(400, `Run is already ${run.status}.`);
  }
  switch (action) {
    case "pause": {
      stopLoop(run.id);
      run.status = "paused";
      break;
    }
    case "resume": {
      run.status = run.branches.some((b) => b.status === "awaiting-decision") ? "awaiting-decision" : "running";
      startLoop(run);
      break;
    }
    case "speed": {
      const speed = clamp(Number(body.value) || run.clock.speed || 1, 0.25, 16);
      run.clock.speed = speed;
      if (run.status !== "paused") startLoop(run);
      break;
    }
    case "step": {
      if (run.engine !== "turn-based") throw httpError(400, "Control 'step' is only valid for turn-based runs.");
      const result = tickRun(run, ctxFor(run));
      if ((result && result.completed) || TERMINAL_RUN_STATUSES.includes(run.status)) {
        finishRun(run);
      } else {
        reconcileRunStatus(run);
      }
      break;
    }
    case "abort": {
      stopLoop(run.id);
      run.status = "aborted";
      for (const branch of run.branches) {
        if (branch.status !== "completed" && branch.status !== "aborted") branch.status = "aborted";
      }
      finishRun(run);
      break;
    }
    default:
      throw httpError(400, `Unknown control action "${action}".`);
  }
  audit("operator", `run-${action}`, run.id, `Control "${action}"${body.value !== undefined ? ` (${body.value})` : ""} applied to ${run.label}.`);
  schedulePersist();
  return serializeRun(run);
}

function handleDecide(runId, branchId, body) {
  const run = requireRun(runId);
  const branch = requireBranch(run, branchId);
  const decisionId = String(body.decisionId || "");
  const optionId = String(body.optionId || "");
  const decision = branch.decisions.find((d) => d.id === decisionId);
  if (!decision) throw httpError(404, `Unknown decision "${decisionId}" on branch "${branch.name}".`);
  if (decision.status !== "open") throw httpError(400, `Decision "${decision.title}" is already ${decision.status}.`);
  if (!decision.options.some((o) => o.id === optionId)) {
    throw httpError(400, `Option "${optionId}" is not valid for decision "${decision.title}".`);
  }
  const decidedBy = typeof body.decidedBy === "string" && body.decidedBy.trim() ? body.decidedBy.trim() : "commander";
  const rationale = typeof body.rationale === "string" ? body.rationale : "";
  applyDecision(run, branch.id, decisionId, optionId, decidedBy, rationale, ctxFor(run));
  reconcileRunStatus(run);
  if (run.engine === "realtime" && !loops.has(run.id) && !TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== "paused") {
    startLoop(run);
  }
  const followed = optionId === decision.aiRecommendationId;
  audit(decidedBy, "decision-made", `${run.id}/${branch.id}`, `"${decision.title}" resolved with option ${optionId} (${followed ? "followed AI" : "overrode AI"}).`);
  schedulePersist();
  return serializeRun(run);
}

const INTERVENTION_TYPES = ["inject-event", "move-unit", "set-weather", "resupply", "withdraw-unit"];

// --- Explainable war-room Q&A ------------------------------------------------------
// Four fixed topics answered from live branch state. Deterministic offline answers
// compose from the same grounded context that is handed to the reasoning service.

const EXPLAIN_TOPICS = {
  adjudication: "Why did the latest engagement adjudicate the way it did?",
  risk: "What is the current biggest risk to BLUE?",
  "next-step": "What should the commander do next?",
  enemy: "Explain RED's current actions and likely intent.",
};

function branchExplainContext(run, branch, scenario) {
  const m = branch.metrics;
  const lines = [
    `Run "${run.label}" branch "${branch.name}" at T+${round1(run.clock.simTimeH)}h, phase "${branch.currentPhaseName || "free play"}".`,
    `Metrics: objectives ${m.objectiveScore}%, BLUE strength ${m.blueStrength}%, RED strength ${m.redStrength}%, BLUE supply ${m.supplyLevel}%, losses B${m.blueLosses}/R${m.redLosses}.`,
    `Environment: ${scenario.environment.weather}, sea state ${scenario.environment.seaState}, EMCON ${scenario.environment.emcon}.`,
  ];
  if (branch.score) lines.push(`Score: BLUE ${branch.score.blue.total} vs RED ${branch.score.red.total} (net ${branch.score.net}).`);
  const lastAdj = branch.recentEvents.find((e) => e.adjudication);
  if (lastAdj) {
    const a = lastAdj.adjudication;
    lines.push(
      `Latest adjudication: ${a.attacker} fired ${a.weapon} at ${a.target} from ${a.rangeKm} km — base pk ${a.basePk}` +
        (a.modifiers.length ? `, modified by ${a.modifiers.map((x) => `"${x.rule}" ×${x.factor}`).join(", ")}` : "") +
        ` to ${a.finalPk}; roll ${a.roll} → ${a.result.toUpperCase()}${a.result === "hit" ? ` for ${a.damage}% damage` : ""}.`
    );
  }
  const recent = branch.recentEvents.slice(0, 5).map((e) => `[${e.type}] ${e.title}`);
  if (recent.length) lines.push(`Recent events: ${recent.join(" | ")}`);
  return lines.join("\n");
}

function offlineExplain(topic, run, branch, scenario) {
  const m = branch.metrics;
  const blueAlive = branch.units.filter((u) => u.side === "blue" && u.status !== "destroyed");
  const redAlive = branch.units.filter((u) => u.side === "red" && u.status !== "destroyed");
  if (topic === "adjudication") {
    const e = branch.recentEvents.find((ev) => ev.adjudication);
    if (!e) return "No engagement has been adjudicated yet in this branch — once a piece fires, the full resolution (weapon, range, rule modifiers, random roll, damage) appears here and in the Adjudication drawer.";
    const a = e.adjudication;
    const mods = a.modifiers.length ? ` The rules ${a.modifiers.map((x) => `"${x.rule}" (×${x.factor})`).join(" and ")} adjusted it to ${a.finalPk}.` : ` No rule modified the shot, so the final pk stayed ${a.finalPk}.`;
    return (
      `${a.attacker} engaged ${a.target} with ${a.weapon} at ${a.rangeKm} km. The weapon's base kill probability is ${a.basePk}.` +
      mods +
      ` The adjudication die rolled ${a.roll}; because ${a.roll} ${a.roll < a.finalPk ? "<" : "≥"} ${a.finalPk}, the salvo ${a.result === "hit" ? `HIT for ${a.damage}% raw damage` : "MISSED"}. Every resolution in this run is auditable the same way.`
    );
  }
  if (topic === "risk") {
    const risks = [];
    const weak = [...blueAlive].sort((x, y) => x.supply - y.supply)[0];
    if (weak && weak.supply < 45) risks.push([60 + (45 - weak.supply), `${weak.name} is at ${Math.round(weak.supply)}% supply — it drops out of the fight if it is not rotated to the auxiliary within the next phase`]);
    const exposed = blueAlive.filter((u) => u.detectedByEnemy).length;
    if (exposed > blueAlive.length * 0.6) risks.push([55, `${exposed} of ${blueAlive.length} BLUE pieces are held by RED sensors — the force is fighting inside the enemy's kill chain`]);
    if (scenario.environment.weather === "storm") risks.push([50, "storm conditions are suppressing detection and movement for both sides, which favors the defender"]);
    if (m.blueStrength < 70) risks.push([70, `aggregate BLUE strength is down to ${m.blueStrength}% — attrition is outpacing the objective picture (${m.objectiveScore}%)`]);
    if (m.objectiveScore < 40 && run.clock.simTimeH > scenario.durationHours * 0.5) risks.push([65, `over half the window is spent but objectives sit at ${m.objectiveScore}% — tempo is the risk, not losses`]);
    if (!risks.length) return `No acute risk: BLUE holds ${m.blueStrength}% strength, ${m.supplyLevel}% supply and ${m.objectiveScore}% of the objective picture. The main watch item is keeping the sustainment line covered as the force advances.`;
    risks.sort((a, b) => b[0] - a[0]);
    return `Biggest risk right now: ${risks[0][1]}.${risks[1] ? ` Secondary: ${risks[1][1]}.` : ""}`;
  }
  if (topic === "next-step") {
    const open = branch.decisions.find((d) => d.status === "open");
    if (open) return `A commander decision is open: "${open.title}". SAGE recommends "${open.options.find((o) => o.id === open.aiRecommendationId)?.label}" — ${open.aiRationale}`;
    if (m.supplyLevel < 45) return `Sustainment first: force supply is ${m.supplyLevel}%. Pull the escort screen tight around the auxiliary, run a resupply rotation, then resume the advance — the objective picture (${m.objectiveScore}%) will hold.`;
    if (m.objectiveScore >= 50 && m.blueStrength > m.redStrength) return `Press the advantage: objectives at ${m.objectiveScore}% with a strength edge (${m.blueStrength}% vs ${m.redStrength}%). Keep the current phase ("${branch.currentPhaseName || "free play"}") moving and deny RED time to reconstitute.`;
    return `Develop the picture before committing: only ${redAlive.filter((u) => u.detectedByEnemy).length} of ${redAlive.length} RED pieces are held on sensors. Push ISR forward, keep EMCON ${scenario.environment.emcon}, and time the strike for the next phase boundary.`;
  }
  // enemy
  const redEvents = branch.recentEvents.filter((e) => e.actorId && redAlive.some((u) => u.id === e.actorId)).slice(0, 3);
  const acting = redEvents.map((e) => e.title).join("; ");
  return (
    `RED retains ${redAlive.length} piece(s) at ${m.redStrength}% aggregate strength (${m.redLosses} lost). ` +
    (acting ? `Latest RED activity: ${acting}. ` : "RED has initiated no engagements recently. ") +
    `Doctrine template: hold the coastal battery umbrella, keep corvettes and the submarine on the strait flanks, and force BLUE to trade attrition for tempo. Expect a reaction the moment a BLUE capital unit enters missile range.`
  );
}

async function handleExplain(runId, branchId, body) {
  const run = requireRun(runId);
  const branch = requireBranch(run, branchId);
  const topic = String(body.topic || "");
  if (!EXPLAIN_TOPICS[topic]) throw httpError(400, `Unknown topic "${topic}" — expected one of ${Object.keys(EXPLAIN_TOPICS).join(", ")}.`);
  const scenario = findScenario(run.scenarioId);
  const started = Date.now();
  if (process.env.ANTHROPIC_API_KEY) {
    const question = `${EXPLAIN_TOPICS[topic]}\n\nGrounded branch context (authoritative — answer from this):\n${branchExplainContext(run, branch, scenario)}\n\nAnswer in at most 110 words, addressed to the commander.`;
    const result = await askAnthropic(question, `deduction:${topic}`, started, process.env.ANTHROPIC_API_KEY);
    if (result.source === "anthropic") return { topic, answer: result.answer, source: "anthropic", latencyMs: result.latencyMs };
  }
  return { topic, answer: offlineExplain(topic, run, branch, scenario), source: "offline", latencyMs: Date.now() - started };
}

function handleIntervene(runId, branchId, body) {
  const run = requireRun(runId);
  const branch = requireBranch(run, branchId);
  if (TERMINAL_RUN_STATUSES.includes(run.status)) throw httpError(400, `Run is already ${run.status}.`);
  if (!INTERVENTION_TYPES.includes(body.type)) {
    throw httpError(400, `Field 'type' must be one of: ${INTERVENTION_TYPES.join(", ")}.`);
  }
  const request = {
    type: body.type,
    params: body.params && typeof body.params === "object" ? body.params : {},
    requestedBy: typeof body.requestedBy === "string" && body.requestedBy.trim() ? body.requestedBy.trim() : "umpire",
  };
  applyIntervention(run, branch.id, request, ctxFor(run));
  reconcileRunStatus(run);
  audit(request.requestedBy, "intervention", `${run.id}/${branch.id}`, `${request.type} applied to branch ${branch.name} of ${run.label}.`);
  schedulePersist();
  return serializeRun(run);
}

function handleAssessRun(id) {
  const run = requireRun(id);
  if (run.status !== "completed") {
    throw httpError(400, `Run must be completed before assessment (current status: ${run.status}).`);
  }
  const assessments = buildAssessments(run, ctxFor(run));
  state.assessments = state.assessments.filter((a) => a.runId !== run.id);
  for (const assessment of assessments) state.assessments.push(assessment);
  audit("SAGE", "assessment-generated", run.id, `${assessments.length} branch assessment(s) computed for ${run.label}.`);
  schedulePersist();
  return stripInternal(assessments);
}

function handleAgentActivity(query) {
  const runId = query.get("runId");
  let run = null;
  if (runId) {
    run = requireRun(runId);
  } else if (state.runs.length) {
    run = [...state.runs].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[state.runs.length - 1];
  }
  if (!run) return [];
  return stripInternal(agentActivityFor(run));
}

const USER_UPDATABLE = ["name", "role", "org", "permissions", "status", "lastActive"];

function handleUpdateUser(id, body) {
  const user = state.users.find((u) => u.id === id);
  if (!user) throw httpError(404, `Unknown user "${id}".`);
  for (const key of USER_UPDATABLE) {
    if (key in body && body[key] !== undefined) user[key] = body[key];
  }
  audit("operator", "user-updated", user.id, `User ${user.name} set to ${user.status} (${user.permissions.length} permissions).`);
  schedulePersist();
  return user;
}

function handleAppendAudit(body) {
  for (const field of ["user", "action", "target", "detail"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw httpError(400, `Field '${field}' is required.`);
    }
  }
  return audit(body.user.trim(), body.action.trim(), body.target.trim(), body.detail.trim());
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ID = "([A-Za-z0-9._-]+)";

const routes = [
  { method: "GET", re: /^\/health$/, handler: () => ({ ok: true }) },
  {
    method: "GET",
    re: /^\/api\/bootstrap$/,
    handler: () => ({
      scenarios: state.scenarios,
      theater: state.theater,
      missions: state.missions,
      coas: state.coas,
      ruleSets: state.ruleSets,
      agents: state.agents,
      runs: state.runs.map(toRunSummary),
      platform: livePlatform(),
      users: state.users,
    }),
  },

  { method: "GET", re: /^\/api\/scenarios$/, handler: () => state.scenarios },
  { method: "POST", re: /^\/api\/scenarios$/, handler: ({ body }) => handleCreateScenario(body) },
  { method: "POST", re: /^\/api\/opord\/parse$/, handler: ({ body }) => handleParseOpord(body) },
  { method: "POST", re: /^\/api\/scenarios\/from-opord$/, handler: ({ body }) => handleScenarioFromOpord(body) },
  { method: "GET", re: new RegExp(`^/api/scenarios/${ID}$`), handler: ({ params }) => requireScenario(params[0]) },
  { method: "PUT", re: new RegExp(`^/api/scenarios/${ID}$`), handler: ({ params, body }) => handleUpdateScenario(params[0], body) },
  {
    method: "POST",
    re: new RegExp(`^/api/scenarios/${ID}/validate$`),
    handler: ({ params }) => {
      const scenario = requireScenario(params[0]);
      const report = validateScenario(scenario);
      audit("operator", "scenario-validated", scenario.id, `Validation ${report.ok ? "passed" : "failed"} with ${report.issues.length} finding(s).`);
      return report;
    },
  },

  {
    method: "GET",
    re: /^\/api\/missions$/,
    handler: ({ query }) => {
      const scenarioId = query.get("scenarioId");
      return scenarioId ? state.missions.filter((m) => m.scenarioId === scenarioId) : state.missions;
    },
  },
  { method: "POST", re: /^\/api\/missions$/, handler: ({ body }) => handleCreateMission(body) },
  { method: "POST", re: new RegExp(`^/api/missions/${ID}/decompose$`), handler: ({ params }) => handleDecomposeMission(params[0]) },
  { method: "PUT", re: new RegExp(`^/api/missions/${ID}$`), handler: ({ params, body }) => handleUpdateMission(params[0], body) },

  {
    method: "GET",
    re: /^\/api\/coas$/,
    handler: ({ query }) => {
      const scenarioId = query.get("scenarioId");
      return scenarioId ? state.coas.filter((c) => c.scenarioId === scenarioId) : state.coas;
    },
  },
  { method: "POST", re: /^\/api\/coas\/generate$/, handler: ({ body }) => handleGenerateCoas(body) },
  { method: "PUT", re: new RegExp(`^/api/coas/${ID}$`), handler: ({ params, body }) => handleUpdateCoa(params[0], body) },

  { method: "GET", re: /^\/api\/rulesets$/, handler: () => state.ruleSets },
  { method: "POST", re: /^\/api\/rulesets$/, handler: ({ body }) => handleCreateRuleSet(body) },
  { method: "PUT", re: new RegExp(`^/api/rulesets/${ID}$`), handler: ({ params, body }) => handleUpdateRuleSet(params[0], body) },
  {
    method: "POST",
    re: new RegExp(`^/api/rulesets/${ID}/test$`),
    handler: ({ params, body }) => {
      const ruleSet = findRuleSet(params[0]);
      if (!ruleSet) throw httpError(404, `Unknown rule set "${params[0]}".`);
      const result = testRuleSet(ruleSet, String(body.situation || ""));
      audit("operator", "ruleset-tested", ruleSet.id, `Test "${result.situation}" — ${result.trace.filter((t) => t.fired).length} rule(s) fired.`);
      return result;
    },
  },

  { method: "POST", re: new RegExp(`^/api/coas/${ID}/silent-eval$`), handler: ({ params }) => handleSilentEval(params[0]) },
  { method: "GET", re: /^\/api\/runs$/, handler: () => state.runs.map(toRunSummary) },
  { method: "POST", re: /^\/api\/runs$/, handler: ({ body }) => handleStartRun(body) },
  { method: "GET", re: new RegExp(`^/api/runs/${ID}$`), handler: ({ params }) => serializeRun(requireRun(params[0])) },
  { method: "POST", re: new RegExp(`^/api/runs/${ID}/control$`), handler: ({ params, body }) => handleControlRun(params[0], body) },
  {
    method: "POST",
    re: new RegExp(`^/api/runs/${ID}/branches/${ID}/decide$`),
    handler: ({ params, body }) => handleDecide(params[0], params[1], body),
  },
  {
    method: "POST",
    re: new RegExp(`^/api/runs/${ID}/branches/${ID}/intervene$`),
    handler: ({ params, body }) => handleIntervene(params[0], params[1], body),
  },
  {
    method: "POST",
    re: new RegExp(`^/api/runs/${ID}/branches/${ID}/explain$`),
    handler: ({ params, body }) => handleExplain(params[0], params[1], body),
  },
  { method: "POST", re: new RegExp(`^/api/runs/${ID}/assess$`), handler: ({ params }) => handleAssessRun(params[0]) },
  {
    method: "GET",
    re: new RegExp(`^/api/runs/${ID}/replay/${ID}$`),
    handler: ({ params }) => {
      const run = requireRun(params[0]);
      requireBranch(run, params[1]);
      return stripInternal(buildReplay(run, params[1]));
    },
  },

  {
    method: "GET",
    re: /^\/api\/assessments$/,
    handler: ({ query }) => {
      const runId = query.get("runId");
      const list = runId ? state.assessments.filter((a) => a.runId === runId) : state.assessments;
      return stripInternal(list);
    },
  },

  { method: "GET", re: /^\/api\/ontology$/, handler: () => state.ontology },
  { method: "POST", re: /^\/api\/ontology\/classes$/, handler: ({ body }) => handleCreatePieceType(body) },
  { method: "POST", re: /^\/api\/admin\/reset$/, handler: () => handleResetDemo() },
  { method: "GET", re: /^\/api\/agents$/, handler: () => state.agents },
  { method: "GET", re: /^\/api\/agent-activity$/, handler: ({ query }) => handleAgentActivity(query) },
  { method: "GET", re: /^\/api\/platform$/, handler: () => livePlatform() },

  { method: "GET", re: /^\/api\/users$/, handler: () => state.users },
  { method: "PUT", re: new RegExp(`^/api/users/${ID}$`), handler: ({ params, body }) => handleUpdateUser(params[0], body) },

  {
    method: "GET",
    re: /^\/api\/audit$/,
    handler: () => [...state.auditLogs].sort((a, b) => b.at.localeCompare(a.at)),
  },
  { method: "POST", re: /^\/api\/audit$/, handler: ({ body }) => handleAppendAudit(body) },

  { method: "POST", re: /^\/api\/ask$/, handler: ({ body }) => handleAsk(body) },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(httpError(413, "Request body exceeds the 1 MB limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(httpError(400, "Invalid JSON body."));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url || "/", "http://localhost");
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    sendJson(res, 400, { error: "Malformed request URL." });
    return;
  }
  try {
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.re.exec(pathname);
      if (!match) continue;
      const params = match.slice(1).map((p) => decodeURIComponent(p));
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
      const payload = await route.handler({ params, query, body });
      sendJson(res, 200, payload);
      return;
    }
    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}.` });
  } catch (err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    if (status === 500) console.error(`[sandtable] ${req.method} ${pathname} failed:`, err);
    sendJson(res, status, { error: err && err.message ? err.message : "Internal server error." });
  }
});

// ---------------------------------------------------------------------------
// Startup + shutdown
// ---------------------------------------------------------------------------

boot();

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const handle of loops.values()) clearInterval(handle);
  loops.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => {
  if (!shuttingDown && stateDirty) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  }
});

server.listen(PORT, () => {
  console.log(`[sandtable] backend listening on http://localhost:${PORT}`);
  console.log(
    `[sandtable] ${state.scenarios.length} scenarios, ${state.coas.length} COAs, ${state.agents.length} agents, ${state.runs.length} run(s), ${state.assessments.length} assessment(s); copilot: ${
      process.env.ANTHROPIC_API_KEY
        ? `anthropic (${process.env.ANTHROPIC_MODEL || "claude-opus-5"})`
        : process.env.OPENAI_API_KEY
          ? `openai (${process.env.OPENAI_MODEL || "gpt-4o-mini"})`
          : "offline"
    }`
  );
});

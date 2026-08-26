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
  rewindBranchToSnapshot,
  tickRun,
  applyDecision,
  applyIntervention,
  buildAssessments,
  buildReplay,
  revealAdversary,
  adversaryTruth,
} from "./engine.mjs";
import { adversaryPlanCatalogue, findAdversaryPlan, DEFAULT_ADVERSARY_PLAN_ID } from "./adversary.mjs";
import {
  defaultClassification,
  normalizeClassification,
  classificationCatalogue,
  markingLine,
  CLASSIFICATION_LEVELS,
} from "./classification.mjs";
import { buildOpord, renderOpordText, buildFrago, renderFragoText, buildSyncMatrix, buildDecisionSupport } from "./orders.mjs";
import { buildRequirements, buildNamedAreas, requirementsBoard, matchCue } from "./requirements.mjs";
import { decomposeMission, generateCoas, agentActivityFor, buildCoaAnalysis, COA_STRATEGIES } from "./agents.mjs";
import { parseOpordOffline, parseOpordAnthropic, materializeScenario } from "./opord.mjs";
import {
  buildIntelCues,
  nextScriptedCue,
  fetchBaseerCues,
  cueToParse,
  offlineIdentify,
  offlineInterrogate,
  collectionOptionsFor,
} from "./intel.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SERVER_DIR, "..");
const STATE_PATH = path.join(SERVER_DIR, "state.json");
const MAX_BODY_BYTES = 1024 * 1024;
const HISTORICAL_TICK_CAP = 20000;
const ACTIVE_RUN_STATUSES = ["initializing", "running", "awaiting-decision", "paused"];
const TERMINAL_RUN_STATUSES = ["completed", "aborted"];

// ---------------------------------------------------------------------------
// Env loader, parse KEY=VALUE lines from .env at the project root; existing
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

/** Count with a real plural, because "1 unit(s)" is not something a staff officer writes. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/**
 * House style for text that came back from a reasoning service. The platform
 * writes in plain punctuation: no em or en dashes, no decorative middot. Model
 * output is not under our control, so it is normalised on the way in rather
 * than hoped about in the prompt.
 */
function houseStyle(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*·\s*/g, " | ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".");
}

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

/** @type {{scenarios: any[], theater: any[], ontology: any, missions: any[], coas: any[], ruleSets: any[], agents: any[], runs: any[], assessments: any[], users: any[], auditLogs: any[], platform: any, intelCues: any[], intelFeed: {cursor: number}}} */
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
// Realtime loop management, the HTTP layer owns one setInterval per running
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
    `${run.label} finished at T+${round1(run.clock.simTimeH)}h with ${plural(run.branches.length, "branch", "branches")}.`
  );
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Boot, load persisted state or build seeds plus the historical rehearsal run.
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

/**
 * Backfill state slices added after a demo has already written state.json. The
 * required keys in STATE_KEYS decide whether a file is usable at all; anything
 * newer than the file is defaulted here rather than discarding the run history.
 */
function migrateState(loaded) {
  let changed = false;
  if (!Array.isArray(loaded.intelCues)) {
    loaded.intelCues = buildIntelCues();
    changed = true;
  }
  if (!loaded.intelFeed || typeof loaded.intelFeed !== "object" || !Number.isInteger(loaded.intelFeed.cursor)) {
    loaded.intelFeed = { cursor: 0 };
    changed = true;
  }
  if (!loaded.governance || typeof loaded.governance !== "object" || !loaded.governance.policy) {
    loaded.governance = defaultGovernance();
    changed = true;
  }
  if (!loaded.governance.refusals || typeof loaded.governance.refusals !== "object") {
    loaded.governance.refusals = {};
    changed = true;
  }
  // A catalogue entry added after this file was written defaults to its own policy.
  for (const action of GOVERNED_ACTIONS) {
    if (!AUTONOMY_VALUES.includes(loaded.governance.policy[action.id])) {
      loaded.governance.policy[action.id] = action.defaultAutonomy;
      changed = true;
    }
  }
  if (!loaded.classification || typeof loaded.classification !== "object") {
    loaded.classification = defaultClassification();
    changed = true;
  }
  if (!Array.isArray(loaded.fragos)) {
    loaded.fragos = [];
    changed = true;
  }
  if (normalizeCueRecords(loaded.intelCues)) changed = true;
  return changed;
}

/**
 * Every hand-off record is addressable by its id, so a cue, its assessment and each
 * of its collection tasks carry the id of the record that produced them. State files
 * written before those fields existed are filled in here, once, rather than leaving
 * the hand-off inspector to match records on their action verb.
 */
function normalizeCueRecords(cues) {
  let changed = false;
  for (const cue of Array.isArray(cues) ? cues : []) {
    if (!cue || typeof cue !== "object") continue;
    const handoffs = Array.isArray(cue.handoffs) ? cue.handoffs : [];
    if (cue.ingestHandoffId === undefined || cue.ingestHandoffId === null) {
      const ingest = handoffs.find((h) => h && typeof h.action === "string" && h.action.startsWith("Ingested"));
      cue.ingestHandoffId = ingest ? ingest.id : null;
      changed = true;
    }
    if (cue.assessment && cue.assessment.handoffId === undefined) {
      const identified = handoffs.find((h) => h && h.action === "Identified unit");
      cue.assessment.handoffId = identified ? identified.id : null;
      changed = true;
    }
    for (const task of Array.isArray(cue.collection) ? cue.collection : []) {
      if (!task || typeof task !== "object") continue;
      for (const key of ["requestHandoffId", "approveHandoffId", "collectHandoffId", "note"]) {
        if (task[key] === undefined) {
          task[key] = null;
          changed = true;
        }
      }
      if (task.outcome === undefined) {
        // A task that landed before the outcome field existed carries a corroborating
        // product in its result, so it reads as resolving rather than inconclusive.
        task.outcome = task.status === "collected" ? "resolved" : null;
        changed = true;
      }
    }
  }
  return changed;
}

function buildSeedState() {
  const ontology = buildOntology();
  const seeded = {
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
    governance: defaultGovernance(),
    classification: defaultClassification(),
    fragos: [],
    intelCues: buildIntelCues(),
    intelFeed: { cursor: 0 },
  };
  normalizeCueRecords(seeded.intelCues);
  return seeded;
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
    redPlanId: DEFAULT_ADVERSARY_PLAN_ID,
  });
  run.redPlanId = DEFAULT_ADVERSARY_PLAN_ID;
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
    `${plural(assessments.length, "branch assessment")} computed for ${run.label}.`,
    completedAt
  );
}

function boot() {
  const persisted = loadPersistedState();
  if (persisted) {
    state = persisted;
    if (migrateState(state)) persistNow();
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
// Derived views, run summaries and live platform numbers.
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
    issues.push({ level: "error", code: "no-units", message: "Scenario has no units, place an order of battle before running." });
  } else {
    for (const side of ["blue", "red"]) {
      if (!activeUnits.some((u) => u.side === side)) {
        issues.push({
          level: "error",
          code: `side-empty-${side}`,
          message: `No active ${side.toUpperCase()} units, a deduction needs both sides on the board.`,
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
        message: `${side.toUpperCase()} has no objectives, scoring and victory checks will be inert for that side.`,
      });
      continue;
    }
    const weightSum = sideObjectives.reduce((sum, o) => sum + o.weight, 0);
    if (weightSum < 0.85 || weightSum > 1.15) {
      issues.push({
        level: "warning",
        code: `objective-weights-${side}`,
        message: `${side.toUpperCase()} objective weights sum to ${round2(weightSum)}, expected ~1.0 for normalized scoring.`,
      });
    }
  }

  // The Meridian Archipelago sits in the Gulf of Oman, so the stray check has to use
  // the box every seeded scenario, intel cue and projected order of battle is built
  // inside. The old Atlantic box failed every unit on the board.
  const strays = scenario.units.filter(
    (u) => u.position.lat < 22.9 || u.position.lat > 25.1 || u.position.lng < 58.7 || u.position.lng > 63.7
  );
  if (strays.length) {
    issues.push({
      level: "error",
      code: "unit-out-of-theater",
      message: `${strays.length} ${strays.length === 1 ? "unit is" : "units are"} positioned outside the Meridian Archipelago theater box (lat 22.9..25.1, lng 58.7..63.7).`,
    });
  }

  const inert = activeUnits.filter((u) => u.sensors.length === 0 && u.weapons.length === 0);
  if (inert.length) {
    issues.push({
      level: "warning",
      code: "unit-inert",
      message: `${inert.length} ${inert.length === 1 ? "unit carries" : "units carry"} no sensors or weapons and will neither detect nor engage.`,
    });
  }

  if (scenario.durationHours < 12 || scenario.durationHours > 240) {
    issues.push({
      level: "warning",
      code: "duration-unusual",
      message: `Duration ${scenario.durationHours}h is outside the usual 12-240h exercise window.`,
    });
  }

  if (scenario.environment.emcon === "silent") {
    issues.push({
      level: "info",
      code: "emcon-silent",
      message: "EMCON silent is set, detection ranges will be sharply reduced for both sides.",
    });
  }
  if (scenario.environment.weather === "storm") {
    issues.push({
      level: "info",
      code: "weather-storm",
      message: `Storm with sea state ${scenario.environment.seaState}, expect degraded sensors and slower surface movement.`,
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
// Rule set testing, canned situations evaluated against the documented fact
// vocabulary (range, actor.*, target.*, weather, seaState, emcon, simTimeH,
// phase.name).
// ---------------------------------------------------------------------------

const TEST_SITUATIONS = [
  {
    id: "surface-engagement",
    label: "Surface action - BLUE destroyer vs RED missile boat at 32 km, clear weather",
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
    label: "Air raid - BLUE strike package vs RED SAM battalion at 110 km, overcast",
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
    label: "Subsurface ambush - RED submarine vs BLUE supply ship at 12 km, EMCON silent",
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
    label: "Storm transit - BLUE task group at 18% supply moving through sea state 6",
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
      trace.push({ ruleId: rule.id, ruleName: rule.name, fired: false, detail: "Rule disabled, skipped." });
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
        detail: `Not fired, condition "${conditionText(failed.condition)}" failed (${failed.why}).`,
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
  if (totals.reveals > 0) parts.push(plural(totals.reveals, "unit reveal"));
  if (spawned.length) parts.push(`${spawned.length === 1 ? "event" : "events"}: ${spawned.join(", ")}`);
  if (decisionsRequested.length) parts.push(`decision requested: ${decisionsRequested.join(", ")}`);

  const outcome =
    `${firedCount}/${ordered.length} rules fired for "${situation.label}". ` +
    (parts.length ? `Net adjudication: ${parts.join("; ")}.` : "No effects applied, baseline adjudication stands.");

  return { ruleSetId: ruleSet.id, situation: situation.label, outcome, trace, testedAt: nowIso() };
}

// ---------------------------------------------------------------------------
// Copilot, SAGE. OpenAI chat completions when a key is configured, otherwise
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
  lines.push("Exercise AZURE HORIZON, fictional Meridian Archipelago theater; BLUE Coalition Task Force vs RED OPFOR.");
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
        lines.push(`    Open decision: "${decision.title}" | AI recommends "${rec ? rec.label : decision.aiRecommendationId}".`);
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
      `Latest assessments: ${state.assessments.slice(-4).map((a) => `${a.branchName}, ${a.verdict} (${a.overallScore}/100, LER ${a.lossExchangeRatio})`).join("; ")}.`
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
        (open ? ` ${plural(open, "decision point")} ${open === 1 ? "is" : "are"} awaiting the commander.` : "")
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
          `"${decision.title}" on branch ${branch.name} of ${run.label}, ${decision.options.length} options, AI recommends "${rec ? rec.label : decision.aiRecommendationId}"`
        );
      }
    }
  }
  if (!open.length) {
    return "No decision points are open right now. They surface at COA phase boundaries and on emergent triggers such as first contact or a branch dropping below 70% strength; the branch pauses until the commander decides.";
  }
  return `${plural(open.length, "decision point")} ${open.length === 1 ? "is" : "are"} open: ${open.join("; ")}. The commander can follow the AI recommendation or override it with a rationale, both are retained for the assessment.`;
}

function answerCoaComparison() {
  const coas = [...state.coas].sort((a, b) => b.scores.composite - a.scores.composite);
  if (!coas.length) return "No COAs exist yet. Decompose a mission on the COA Generation page, then generate two to four candidates to compare.";
  const top = coas.slice(0, 3).map(
    (c) =>
      `${c.name} (${c.approach}), composite ${c.scores.composite}, feasibility ${c.scores.feasibility}, expected effect ${c.scores.expectedEffect}, risk ${c.scores.risk} [${c.status}]`
  );
  const best = coas[0];
  const safest = [...coas].sort((a, b) => a.scores.risk - b.scores.risk)[0];
  let advice = `On composite utility, ${best.name} leads.`;
  if (safest && safest.id !== best.id) {
    advice += ` If risk tolerance is low, ${safest.name} carries the lowest risk score (${safest.scores.risk}).`;
  }
  return `Comparing ${plural(coas.length, "COA")}: ${top.join("; ")}. ${advice}`;
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
    (best ? `${best.branchName} scored highest, its replay is available branch-by-branch with full snapshots and the event log.` : "")
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
    `Exercise AZURE HORIZON overview: ${plural(state.scenarios.filter((s) => s.status === "ready").length, "scenario")} ready of ${state.scenarios.length}, ` +
    `${plural(state.coas.length, "COA")} on file, ${state.agents.filter((a) => a.status === "ready").length}/${state.agents.length} agents ready, ` +
    `${plural(act.length, "active run")} and ${plural(open, "open decision")}, ${plural(state.assessments.length, "assessment")} archived. ` +
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
    return { answer: houseStyle(answer), source: "anthropic", model, latencyMs: Date.now() - startedMs };
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
    return { answer: houseStyle(answer), source: "openai", model, latencyMs: Date.now() - startedMs };
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
  if (!total) throw httpError(422, "No force entities could be extracted, check the document follows an OPORD structure with BLUE/RED force sections.");
  audit("planner", "opord-parsed", parse.title, `Intelligent Documents extracted ${plural(total, "entity group")} via ${parse.source}.`);
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

// --- Autonomy policy ----------------------------------------------------------------
// Every hand-off record carried an "autonomy" field written as a literal at the call
// site, which made it a label rather than a control: nothing read it back and nothing
// could change it. The policy below is the single source of truth. Each governed
// action resolves its autonomy here, a "human-required" action refuses to execute
// without a named human, and flipping an entry in the Admin console changes what the
// API will actually do rather than what a badge says it does.

const GOVERNED_ACTIONS = [
  {
    id: "intel.interrogate",
    label: "Interrogate a cue",
    group: "Intel bridge",
    actorField: "askedBy",
    machineActor: "SAGE",
    defaultAutonomy: "auto",
    detail: "Answering an analyst question from the cue's own provenance. Reads the cue, changes nothing.",
  },
  {
    id: "intel.identify",
    label: "Identify a track",
    group: "Intel bridge",
    actorField: "identifiedBy",
    machineActor: "SAGE",
    defaultAutonomy: "auto",
    detail: "Turning tracks into a named unit type with a confidence. Writes an assessment onto the cue.",
  },
  {
    id: "intel.collection.request",
    label: "Draft a collection tasking",
    group: "Intel bridge",
    actorField: "requestedBy",
    machineActor: "SAGE",
    defaultAutonomy: "human-required",
    detail: "Drafting a tasking against a chosen asset. Commits nobody yet, but it puts a named request on the record.",
  },
  {
    id: "intel.collection.approve",
    label: "Release a collection tasking",
    group: "Intel bridge",
    actorField: "approver",
    machineActor: "SAGE",
    defaultAutonomy: "human-required",
    detail: "Sending a real asset against a real place. This is the step that spends something.",
  },
  {
    id: "intel.collection.report",
    label: "Land a collection product",
    group: "Intel bridge",
    actorField: "by",
    machineActor: "SAGE",
    defaultAutonomy: "auto",
    detail: "Reporting what the pass actually resolved, including when it resolved nothing.",
  },
  {
    id: "intel.confirm",
    label: "Confirm a track",
    group: "Intel bridge",
    actorField: "by",
    machineActor: "SAGE",
    defaultAutonomy: "human-required",
    detail: "Moving a cue from possible to confirmed. Everything downstream treats it as fact.",
  },
  {
    id: "intel.dismiss",
    label: "Dismiss a cue",
    group: "Intel bridge",
    actorField: "by",
    machineActor: "SAGE",
    defaultAutonomy: "human-required",
    detail: "Closing a cue out. A dismissed cue stops being worked, so the decision is signed.",
  },
  {
    id: "intel.scenario.spawn",
    label: "Turn a cue into a scenario",
    group: "Intel bridge",
    actorField: "createdBy",
    machineActor: "SAGE",
    defaultAutonomy: "human-required",
    detail: "The step where intelligence becomes a plannable operation. The last place to invent a name.",
  },
  {
    id: "run.adversary.reveal",
    label: "Reveal the OPFOR plan",
    group: "Exercise control",
    actorField: "revealedBy",
    machineActor: "white cell",
    defaultAutonomy: "human-required",
    detail: "Showing the players what RED was playing before the run has ended. It cannot be undone.",
  },
  {
    id: "run.intervene",
    label: "Inject into a live run",
    group: "Exercise control",
    actorField: "requestedBy",
    machineActor: "umpire",
    defaultAutonomy: "human-required",
    detail: "Changing the world state under the players: weather, positions, resupply, injects.",
  },
];

const GOVERNED_BY_ID = new Map(GOVERNED_ACTIONS.map((a) => [a.id, a]));
const AUTONOMY_VALUES = ["auto", "human-required"];

function defaultGovernance() {
  const policy = {};
  for (const action of GOVERNED_ACTIONS) policy[action.id] = action.defaultAutonomy;
  return { policy, refusals: {}, updatedAt: nowIso(), updatedBy: "platform default" };
}

/** The autonomy actually in force for an action, policy first, catalogue as fallback. */
function autonomyFor(actionId) {
  const configured = state.governance && state.governance.policy ? state.governance.policy[actionId] : null;
  if (AUTONOMY_VALUES.includes(configured)) return configured;
  const action = GOVERNED_BY_ID.get(actionId);
  return action ? action.defaultAutonomy : "auto";
}

/**
 * The gate every governed action passes through. Under "human-required" it refuses
 * an unnamed actor and records the refusal, so the policy is visibly load-bearing.
 * Under "auto" the machine acts and the record says so.
 */
function gateAction(actionId, rawActor) {
  const action = GOVERNED_BY_ID.get(actionId);
  if (!action) throw httpError(500, `Unknown governed action "${actionId}".`);
  const autonomy = autonomyFor(actionId);
  const named = typeof rawActor === "string" ? rawActor.trim().slice(0, 60) : "";
  if (autonomy === "human-required" && !named) {
    state.governance.refusals[actionId] = (state.governance.refusals[actionId] || 0) + 1;
    audit(
      "governance",
      "autonomy-refused",
      actionId,
      `"${action.label}" is set to human-required and was called without a named human. The action did not run.`
    );
    schedulePersist();
    throw Object.assign(
      httpError(
        403,
        `"${action.label}" is governed as human-required, so field '${action.actorField}' must name the person accountable for it. ${action.detail}`
      ),
      { actionId, autonomy, actorField: action.actorField, code: "autonomy_requires_human" }
    );
  }
  return {
    actionId,
    autonomy,
    // Who the record names as the actor when a human owns the step outright.
    actor: named || action.machineActor,
    kind: named ? "human" : autonomy === "auto" ? "ai" : "human",
    // Who signed for a step the machine still performed. An identification is
    // SAGE's work whoever authorised it, so the record says both.
    signedBy: named || null,
  };
}

function handleGetGovernance() {
  return {
    updatedAt: state.governance.updatedAt,
    updatedBy: state.governance.updatedBy,
    actions: GOVERNED_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      group: action.group,
      detail: action.detail,
      actorField: action.actorField,
      defaultAutonomy: action.defaultAutonomy,
      autonomy: autonomyFor(action.id),
      refusals: state.governance.refusals[action.id] || 0,
    })),
  };
}

function handleSetGovernance(body) {
  const changedBy = typeof body.changedBy === "string" && body.changedBy.trim() ? body.changedBy.trim().slice(0, 60) : "";
  if (!changedBy) throw httpError(400, "Field 'changedBy' is required: changing what the machine may do on its own is itself a signed act.");
  const actionId = String(body.actionId || "");
  const action = GOVERNED_BY_ID.get(actionId);
  if (!action) throw httpError(404, `Unknown governed action "${actionId}".`);
  const autonomy = String(body.autonomy || "");
  if (!AUTONOMY_VALUES.includes(autonomy)) throw httpError(400, `Field 'autonomy' must be one of: ${AUTONOMY_VALUES.join(", ")}.`);
  const before = autonomyFor(actionId);
  if (before === autonomy) return handleGetGovernance();
  state.governance.policy[actionId] = autonomy;
  state.governance.updatedAt = nowIso();
  state.governance.updatedBy = changedBy;
  audit(
    changedBy,
    "autonomy-policy-changed",
    actionId,
    `"${action.label}" moved from ${before} to ${autonomy} by ${changedBy}. Every later call is gated on the new setting.`
  );
  schedulePersist();
  return handleGetGovernance();
}

// --- Intel bridge (BASEER cues to scenarios) -------------------------------------
// BASEER owns detection, sensor ingest and fusion. SANDTABLE only consumes the
// normalised cue and walks it from "possible" to a live scenario. Every step writes
// a hand-off record, and the consequential steps refuse to run without a named human.

function requireCue(id) {
  const cue = state.intelCues.find((c) => c.id === id);
  if (!cue) throw httpError(404, `Unknown intel cue "${id}".`);
  return cue;
}

/**
 * Write a hand-off record. Autonomy is never passed in as a literal: it is read
 * from the policy for the action this record belongs to, so the trail and the
 * gate can never disagree about what was allowed to happen on its own.
 */
function recordHandoff(cue, fields) {
  const handoff = {
    id: nextId("hof"),
    at: nowIso(),
    actor: fields.actor,
    kind: fields.kind,
    actionId: fields.actionId || null,
    autonomy: fields.actionId ? autonomyFor(fields.actionId) : fields.autonomy,
    action: fields.action,
    detail: fields.detail,
    source: fields.source || null,
    latencyMs: Number.isFinite(fields.latencyMs) ? Math.round(fields.latencyMs) : null,
    // Set when the policy made a human sign for work the machine still did.
    signedBy: fields.signedBy || null,
  };
  if (!Array.isArray(cue.handoffs)) cue.handoffs = [];
  cue.handoffs.push(handoff);
  if (cue.handoffs.length > 60) cue.handoffs.splice(0, cue.handoffs.length - 60);
  return handoff;
}

/** The authoritative brief every grounded intel prompt is answered from. */
function cueContext(cue) {
  const lines = [
    `CUE ${cue.id} (${cue.origin}) "${cue.title}"`,
    `Severity ${cue.severity}, confidence ${cue.confidence}%, workflow state ${cue.state}, observed ${cue.observedAt}.`,
    `Centre ${cue.geo.lat.toFixed(2)}N ${cue.geo.lng.toFixed(2)}E, radius ${cue.geo.radiusKm} km, Meridian Archipelago, Gulf of Oman.`,
    `Sensor ${cue.provenance.sensor}, detector ${cue.provenance.detector}, sources ${cue.provenance.sources.join(", ")}, collected ${cue.provenance.collectedAt}.`,
    `Narrative: ${cue.narrative}`,
  ];
  for (const entity of cue.entities) {
    const course = entity.courseDeg === null ? "" : `, course ${entity.courseDeg} deg`;
    const speed = entity.speedKts === null ? "" : `, ${entity.speedKts} kts`;
    const hint = entity.classHint ? `, class hint ${entity.classHint}` : "";
    lines.push(
      `Track ${entity.name} (${entity.kind}, ${entity.affiliation}) at ${entity.lat.toFixed(2)}N ${entity.lng.toFixed(2)}E${course}${speed}${hint}.`
    );
  }
  if (cue.assessment) {
    lines.push(`Prior identification: ${cue.assessment.unitType} at ${cue.assessment.confidence}%, intent "${cue.assessment.intent}".`);
  }
  for (const task of cue.collection) {
    lines.push(
      `Collection ${task.taskingId}, ${task.asset} ${task.mode} at ${task.resolutionM} m, status ${task.status}${task.result ? `: ${task.result}` : "."}`
    );
  }
  return lines.join(nlLiteral());
}

async function handleCueInterrogate(id, body) {
  const cue = requireCue(id);
  const gate = gateAction("intel.interrogate", body.askedBy);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw httpError(400, "Field 'question' is required.");
  if (question.length > 400) throw httpError(400, "Question too long (400 character cap).");
  const started = Date.now();
  let answer = "";
  let source = "offline";
  let latencyMs = 0;
  if (process.env.ANTHROPIC_API_KEY) {
    const prompt =
      "An analyst is interrogating one intelligence cue that BASEER pushed into SANDTABLE. Answer only from the cue context below, " +
      "name the sensor or track you relied on, and say plainly when the cue does not carry the answer. Never invent tracks, sensors or " +
      "collection results, and never name a real country: the adversary is RED / OPFOR. At most 90 words, no markdown." +
      nlLiteral() +
      nlLiteral() +
      `CUE CONTEXT (authoritative):${nlLiteral()}${cueContext(cue)}${nlLiteral()}${nlLiteral()}ANALYST QUESTION: ${question}`;
    const result = await askAnthropic(prompt, `intel-cue:${cue.id}`, started, process.env.ANTHROPIC_API_KEY);
    if (result.source === "anthropic" && result.answer) {
      answer = result.answer;
      source = "anthropic";
      latencyMs = result.latencyMs;
    }
  }
  if (!answer) {
    answer = offlineInterrogate(cue, question);
    latencyMs = Date.now() - started;
  }
  const handoff = recordHandoff(cue, {
    actor: "SAGE",
    kind: "ai",
    actionId: gate.actionId,
    signedBy: gate.signedBy,
    action: "Answered interrogation",
    detail: `"${question.slice(0, 140)}" answered from cue provenance via ${source}.`,
    source,
    latencyMs,
  });
  audit("analyst", "intel-interrogated", cue.id, `Cue "${cue.title}" interrogated via ${source} in ${latencyMs} ms.`);
  schedulePersist();
  return { answer, source, latencyMs, handoff };
}

async function handleCueIdentify(id, body) {
  const cue = requireCue(id);
  const gate = gateAction("intel.identify", body && body.identifiedBy);
  // Identification is the machine step, and it runs itself. Once a named human has
  // ruled on the cue, an automatic re-identification would rewrite the assessment
  // that ruling was made on, so the machine stops at the human decision.
  if (cue.state === "confirmed" || cue.state === "spawned") {
    throw httpError(
      409,
      `Cue "${cue.id}" is "${cue.state}" and a named human has already ruled on this identification. Re-identifying it would overwrite the assessment behind that decision.`
    );
  }
  if (cue.state === "dismissed") {
    throw httpError(409, `Cue "${cue.id}" was dismissed by a named human. A dismissed cue is not re-identified.`);
  }
  const started = Date.now();
  let assessment = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const prompt =
      "Identify what this fictional intelligence cue is showing. Return STRICT JSON only: " +
      '{"unitType":string,"intent":string,"confidence":number,"sources":string[],"reasoning":string}. ' +
      "unitType names the unit type and its posture in at most 12 words. intent is one sentence on what RED / OPFOR is doing. " +
      "confidence is 0 to 100 and must stay at or below 80 while no collection task has been collected. sources cites only the sensors " +
      "and tracks listed below. reasoning is 40 to 80 words tying the observed track behaviour to the identification. Never name a real " +
      "country: the adversary is RED / OPFOR. No markdown." +
      nlLiteral() +
      nlLiteral() +
      `CUE CONTEXT (authoritative):${nlLiteral()}${cueContext(cue)}`;
    const result = await askAnthropic(prompt, `intel-identify:${cue.id}`, started, process.env.ANTHROPIC_API_KEY);
    if (result.source === "anthropic" && result.answer) {
      try {
        const cleaned = result.answer.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(cleaned);
        if (parsed && parsed.unitType && parsed.intent) {
          const stated = Number(parsed.confidence);
          assessment = {
            unitType: String(parsed.unitType).slice(0, 90),
            intent: String(parsed.intent).slice(0, 240),
            confidence: Number.isFinite(stated) ? clamp(Math.round(stated), 0, 100) : cue.confidence,
            sources: Array.isArray(parsed.sources) && parsed.sources.length
              ? parsed.sources.slice(0, 6).map((s) => String(s).slice(0, 60))
              : cue.provenance.sources.slice(),
            reasoning: String(parsed.reasoning || "").slice(0, 700),
            source: "anthropic",
            latencyMs: result.latencyMs,
            atIso: nowIso(),
          };
        }
      } catch {
        // keep the deterministic identification
      }
    }
  }
  if (!assessment) {
    assessment = { ...offlineIdentify(cue), source: "offline", latencyMs: Date.now() - started, atIso: nowIso() };
  }
  assessment.handoffId = null;
  cue.assessment = assessment;
  if (cue.state === "new") cue.state = "reviewing";
  const handoff = recordHandoff(cue, {
    actor: "SAGE",
    kind: "ai",
    actionId: gate.actionId,
    signedBy: gate.signedBy,
    action: "Identified unit",
    detail: `${assessment.unitType} at ${assessment.confidence}% confidence. ${assessment.intent}`,
    source: assessment.source,
    latencyMs: assessment.latencyMs,
  });
  assessment.handoffId = handoff.id;
  audit("SAGE", "intel-identified", cue.id, `Cue "${cue.title}" identified as ${assessment.unitType} (${assessment.confidence}%) via ${assessment.source}.`);
  schedulePersist();
  return { assessment, handoff };
}

function handleCueCollectOptions(id) {
  const cue = requireCue(id);
  return { options: collectionOptionsFor(cue) };
}

const COLLECTION_PRIORITIES = ["routine", "priority", "urgent"];

function handleCueCollect(id, body) {
  const cue = requireCue(id);
  const options = collectionOptionsFor(cue);
  if (!options.length) throw httpError(409, `No collection assets are available against cue "${cue.id}".`);
  const index = Number.isInteger(body.optionIndex) ? body.optionIndex : 0;
  if (index < 0 || index >= options.length) {
    throw httpError(400, `Field 'optionIndex' must be between 0 and ${options.length - 1}.`);
  }
  const option = options[index];
  const requestedBy = gateAction("intel.collection.request", body.requestedBy).actor;
  const task = {
    id: nextId("tsk"),
    taskingId: `${(Date.now() % 900000) + 100000}-RRN`,
    asset: String(option.asset || "IRIS-52 MQ-9").slice(0, 60),
    mode: ["EO/IR", "SAR", "FMV"].includes(option.mode) ? option.mode : "EO/IR",
    resolutionM: Number.isFinite(option.resolutionM) ? option.resolutionM : 0.3,
    etaMinutes: Number.isFinite(option.etaMinutes) ? option.etaMinutes : 18,
    priority: COLLECTION_PRIORITIES.includes(option.priority) ? option.priority : "priority",
    // The trade-off the operator was shown when they picked this asset. With the mode
    // and the resolution it decides what the pass can honestly report later.
    note: typeof option.note === "string" ? option.note.slice(0, 240) : null,
    status: "requested",
    outcome: null,
    requestedAt: nowIso(),
    approvedBy: null,
    approvedAt: null,
    collectedAt: null,
    result: null,
    requestHandoffId: null,
    approveHandoffId: null,
    collectHandoffId: null,
  };
  if (!Array.isArray(cue.collection)) cue.collection = [];
  cue.collection.push(task);
  if (cue.state === "new") cue.state = "reviewing";
  const handoff = recordHandoff(cue, {
    actor: requestedBy,
    kind: "human",
    actionId: "intel.collection.request",
    action: "Requested collection",
    detail: `Tasking ${task.taskingId}, ${task.asset} ${task.mode} at ${task.resolutionM} m, ETA ${task.etaMinutes} min, ${task.priority}. Held for named approval.`,
  });
  task.requestHandoffId = handoff.id;
  audit(requestedBy, "intel-collection-requested", cue.id, `Tasking ${task.taskingId} (${task.asset} ${task.mode}) drafted against "${cue.title}".`);
  schedulePersist();
  return { task, handoff };
}

// What a resolving sensor came back with. Written from the cue's own tracks so the
// product reads like a collection report rather than a generic success message.
const COLLECTION_DETAIL = {
  vessel: "Canister launchers on the aft deck, a surface-search emitter turning and two tenders alongside are all resolved",
  aircraft: "Underwing stores, the tanker track feeding the orbit and a second pair holding on the deck are all resolved",
  ground: "Launcher canisters, an associated fire-control emitter and two support vehicles under netting are all resolved",
  facility: "Revetted launch positions, a powered radar mast and freshly cut vehicle tracks are all resolved",
};

// The question a cue of each kind actually has to settle before its identification is
// worth confirming, and how fine a pass has to be to settle it. Radar reads structure
// and shape, so it resolves a revetment or a mast but never a canister fit or a store
// under a wing; optical and video resolve the fit only when they are fine enough.
const COLLECTION_DISCRIMINATOR = {
  vessel: { question: "the launcher fit on the hulls", optical: 0.5, radar: 0.25 },
  aircraft: { question: "the underwing stores", optical: 0.4, radar: 0 },
  ground: { question: "the launcher canisters under the netting", optical: 0.45, radar: 0.2 },
  facility: { question: "the revetted launch positions and the radar mast", optical: 0.8, radar: 0.6 },
};

/**
 * What the chosen asset can honestly report. The option note the operator picked from
 * is carried on the task, so an asset offered with a stated limitation ("it will not
 * resolve a launcher fit") comes back inconclusive however fine its nominal
 * resolution reads. Corroboration is never the default.
 */
function collectionResultFor(cue, task) {
  const lead = cue.entities.length ? cue.entities[0] : null;
  const track = lead ? lead.name : "the primary contact";
  const spec = (lead && COLLECTION_DISCRIMINATOR[lead.kind]) || COLLECTION_DISCRIMINATOR.vessel;
  const assessed = cue.assessment ? cue.assessment.unitType.toLowerCase() : "the grouping the cue reported";
  const radar = task.mode === "SAR";
  const resolutionM = Number.isFinite(task.resolutionM) ? task.resolutionM : 1;
  const warned = typeof task.note === "string" && /(will not|cannot|does not) resolve/i.test(task.note);
  const resolves = !warned && resolutionM <= (radar ? spec.radar : spec.optical);
  const pass =
    `${task.asset} completed its ${task.mode} pass at ${resolutionM} m over ` +
    `${cue.geo.lat.toFixed(2)}N ${cue.geo.lng.toFixed(2)}E and held ${track} in frame.`;
  if (resolves) {
    const detail = (lead && COLLECTION_DETAIL[lead.kind]) || "The reported grouping is resolved";
    return {
      resolves: true,
      question: spec.question,
      text: `${pass} ${detail}, which corroborates ${assessed} and rules out the civil-traffic alternative the cue was carrying.`,
    };
  }
  const why = radar
    ? `radar imagery at ${resolutionM} m reads hull shape and heading, not ${spec.question}`
    : `imagery at ${resolutionM} m is too coarse to read ${spec.question}`;
  return {
    resolves: false,
    question: spec.question,
    text:
      `${pass} The count, the geometry and the heading match the cue, but ${why}. ` +
      `Inconclusive: ${assessed} is neither corroborated nor ruled out, and a finer pass is needed before this cue can be called confirmed.`,
  };
}

function requireCollectionTask(cue, taskId) {
  const tasks = Array.isArray(cue.collection) ? cue.collection : [];
  const task = tasks.find((t) => t.id === taskId || t.taskingId === taskId);
  if (!task) throw httpError(404, `Unknown collection task "${taskId}" on cue "${cue.id}".`);
  return task;
}

/**
 * Release, and nothing more. A named human puts the asset on the tasking; the asset
 * has not flown and no product exists yet, so this step ends at "approved". Landing
 * the collection is a separate call, and the operator sees the two as two events.
 */
function handleCueApproveCollection(id, taskId, body) {
  const cue = requireCue(id);
  const task = requireCollectionTask(cue, taskId);
  if (task.status === "collected") throw httpError(409, `Tasking ${task.taskingId} has already been collected.`);
  if (task.status === "approved") {
    throw httpError(
      409,
      `Tasking ${task.taskingId} was already released by ${task.approvedBy} at ${task.approvedAt}. It is out, waiting on its product.`
    );
  }
  const approver = gateAction("intel.collection.approve", body.approver).actor;
  task.status = "approved";
  task.approvedBy = approver;
  task.approvedAt = nowIso();
  if (cue.state === "new") cue.state = "reviewing";
  const handoff = recordHandoff(cue, {
    actor: approver,
    kind: "human",
    actionId: "intel.collection.approve",
    action: "Approved collection",
    detail: `${approver} released tasking ${task.taskingId} to ${task.asset} (${task.mode}, ${task.priority}). Nothing has been collected yet.`,
  });
  task.approveHandoffId = handoff.id;
  audit(
    approver,
    "intel-collection-approved",
    cue.id,
    `${approver} released tasking ${task.taskingId} (${task.asset} ${task.mode}) against "${cue.title}".`
  );
  schedulePersist();
  return { task, handoff, cue };
}

/**
 * The product lands. What it says depends on the asset the operator chose, and the
 * confidence movement is derived from that product, so a coarse pass buys almost
 * nothing and cannot carry the cue to a confirmable picture on its own.
 */
function handleCueCollectionReport(id, taskId, body) {
  const cue = requireCue(id);
  const gate = gateAction("intel.collection.report", body && body.by);
  const task = requireCollectionTask(cue, taskId);
  if (task.status === "requested") {
    throw httpError(
      409,
      `Tasking ${task.taskingId} has not been released. A named human has to approve the tasking before its product can land.`
    );
  }
  if (task.status === "collected") throw httpError(409, `Tasking ${task.taskingId} already reported at ${task.collectedAt}.`);
  const outcome = collectionResultFor(cue, task);
  task.status = "collected";
  task.collectedAt = nowIso();
  task.result = outcome.text;
  task.outcome = outcome.resolves ? "resolved" : "inconclusive";
  // The movement follows the product: a resolved discriminator is worth a real step,
  // a pass that could not read it is worth the geometry it did confirm and no more.
  // Neither is allowed to manufacture certainty the collection did not produce.
  const before = cue.confidence;
  cue.confidence = clamp(before + (outcome.resolves ? 18 : 2), 0, 94);
  const gained = cue.confidence - before;
  let assessmentNote = "";
  if (cue.assessment && outcome.resolves) {
    const wasAssessed = cue.assessment.confidence;
    cue.assessment.confidence = clamp(wasAssessed + 18, 0, 94);
    assessmentNote = ` The identification moves with it, ${wasAssessed}% to ${cue.assessment.confidence}%, on the same product.`;
  } else if (cue.assessment) {
    assessmentNote = ` The identification stands where SAGE left it, ${cue.assessment.confidence}%.`;
  }
  if (cue.state === "new") cue.state = "reviewing";
  const elapsedMin = Math.max(
    0,
    Math.round((Date.parse(task.collectedAt) - Date.parse(task.approvedAt || task.collectedAt)) / 60000)
  );
  const timing =
    elapsedMin >= 1
      ? `${task.taskingId} reported ${elapsedMin} min after release, against a ${task.etaMinutes} min planned window.`
      : `${task.taskingId} reported inside the same minute it was released, the exercise clock does not wait out the ${task.etaMinutes} min planned window.`;
  let movement;
  if (outcome.resolves) {
    movement = `Cue confidence ${before}% to ${cue.confidence}% on a resolved discriminator.`;
  } else if (gained > 0) {
    movement = `Cue confidence ${before}% to ${cue.confidence}%, the geometry only: the pass did not resolve ${outcome.question}.`;
  } else {
    movement = `Cue confidence held at ${cue.confidence}%: the pass did not resolve ${outcome.question}.`;
  }
  // The sensor reports, not SAGE. Attributing this to an autonomous copilot would put
  // the confidence movement on the model rather than on the collection that earned it.
  const handoff = recordHandoff(cue, {
    actor: task.asset,
    kind: "machine",
    actionId: gate.actionId,
    signedBy: gate.signedBy,
    action: outcome.resolves ? "Reported collection" : "Reported inconclusive collection",
    detail: `${timing} ${outcome.text} ${movement}${assessmentNote}`,
    source: "offline",
    latencyMs: null,
  });
  task.collectHandoffId = handoff.id;
  audit(
    task.asset,
    "intel-collection-reported",
    cue.id,
    `Tasking ${task.taskingId} reported ${outcome.resolves ? "a resolving product" : "an inconclusive product"} against "${cue.title}"; cue confidence ${before}% to ${cue.confidence}%.`
  );
  schedulePersist();
  return { task, handoff, cue };
}

/**
 * The gate the whole bridge exists for. A cue only reaches confirmed from "reviewing",
 * with an identification on file and a collection that actually resolved the
 * discriminator behind it, and only a named human can move it.
 */
function handleCueConfirm(id, body) {
  const cue = requireCue(id);
  if (cue.state === "spawned") {
    throw httpError(409, `Cue "${cue.id}" is "spawned" and already produced scenario "${cue.scenarioId}". It cannot be confirmed again.`);
  }
  if (cue.state === "confirmed") {
    throw httpError(409, `Cue "${cue.id}" is already "confirmed" and is waiting on scenario generation, not on a second confirmation.`);
  }
  if (cue.state === "dismissed") {
    throw httpError(409, `Cue "${cue.id}" is "dismissed". A dismissed cue cannot be confirmed, BASEER has to push the picture again for it to be worked.`);
  }
  if (cue.state !== "reviewing") {
    throw httpError(
      409,
      `Cue "${cue.id}" is "${cue.state}". It has to be identified and collected against, so it reads "reviewing", before a named human can confirm it.`
    );
  }
  if (!cue.assessment) {
    throw httpError(409, `Cue "${cue.id}" carries no identification. Confirmation needs something to confirm, so run identification first.`);
  }
  const tasks = Array.isArray(cue.collection) ? cue.collection : [];
  const landed = tasks.filter((t) => t.status === "collected");
  if (!landed.length) {
    const pending =
      tasks.length === 0
        ? "nothing has been tasked yet"
        : tasks.length === 1
          ? "the one tasking on it has not reported"
          : `none of the ${tasks.length} taskings on it have reported`;
    throw httpError(
      409,
      `Cue "${cue.id}" has no collection product on file. Confirmation needs an approved tasking that has reported back, ${pending}.`
    );
  }
  // A tasking that came back inconclusive is a collection, not a corroboration. It
  // cannot be the evidence a confirmation rests on.
  const resolving = landed.filter((t) => t.outcome !== "inconclusive");
  if (!resolving.length) {
    throw httpError(
      409,
      `Every collection on cue "${cue.id}" came back inconclusive. Task an asset that can resolve the discriminator before a named human confirms it.`
    );
  }
  const by = gateAction("intel.confirm", body.by).actor;
  cue.state = "confirmed";
  const evidence = resolving.length === 1 ? "a resolving collection" : `${resolving.length} resolving collections`;
  const handoff = recordHandoff(cue, {
    actor: by,
    kind: "human",
    actionId: "intel.confirm",
    action: "Confirmed cue",
    detail: `${by} moved the cue from possible to confirmed at ${cue.confidence}% confidence on ${evidence}, releasing it for course of action generation.`,
  });
  audit(by, "intel-confirmed", cue.id, `Cue "${cue.title}" confirmed by ${by} at ${cue.confidence}% confidence on ${evidence}.`);
  schedulePersist();
  return { cue, handoff };
}

function handleCueDismiss(id, body) {
  const cue = requireCue(id);
  if (cue.state === "spawned") {
    throw httpError(409, `Cue "${cue.id}" is "spawned" and already produced scenario "${cue.scenarioId}". Close the scenario rather than the cue behind it.`);
  }
  if (cue.state === "dismissed") {
    throw httpError(409, `Cue "${cue.id}" was already dismissed. The dismissal on file stands.`);
  }
  const by = gateAction("intel.dismiss", body.by).actor;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "No reason recorded.";
  const from = cue.state;
  cue.state = "dismissed";
  const handoff = recordHandoff(cue, {
    actor: by,
    kind: "human",
    actionId: "intel.dismiss",
    action: "Dismissed cue",
    detail: `${by} dismissed the cue at the "${from}" step. ${reason}`,
  });
  audit(by, "intel-dismissed", cue.id, `Cue "${cue.title}" dismissed by ${by} from "${from}". ${reason}`);
  schedulePersist();
  return { cue, handoff };
}

// A cue title carries the place name, and the capitalised words in it make a far
// better scenario codename than the whole sentence truncated.
function cueCodename(cue) {
  const words = cue.title.replace(/[^A-Za-z0-9 -]+/g, " ").split(/\s+/).filter(Boolean);
  const proper = words.slice(1).filter((w) => /^[A-Z]/.test(w));
  const picked = proper.length ? proper.slice(-3) : words.slice(0, 3);
  return picked.join(" ").toUpperCase().slice(0, 40) || "INTEL CUE";
}

/** The payoff: a confirmed cue becomes a real scenario, so COA generation answers a real situation. */
function handleCueScenario(id, body) {
  const cue = requireCue(id);
  if (cue.state === "spawned" && cue.scenarioId) {
    throw httpError(409, `Cue "${cue.id}" already produced scenario "${cue.scenarioId}".`);
  }
  if (cue.state !== "confirmed") {
    throw httpError(409, `Cue "${cue.id}" is "${cue.state}". A named human must confirm the cue before it can become a scenario.`);
  }
  // The loop closes on a name. Every other gate refuses an unnamed actor, and the step
  // that turns intelligence into a plannable scenario is the last place to invent one.
  const createdBy = gateAction("intel.scenario.spawn", body.createdBy).actor;
  const parse = cueToParse(cue, state);
  if (!parse || !Array.isArray(parse.sides)) throw httpError(422, `Cue "${cue.id}" could not be projected into a scenario order of battle.`);
  const scenario = materializeScenario(
    parse,
    { name: body.name, codename: body.codename || cueCodename(cue), durationHours: body.durationHours, createdBy },
    state,
    nowIso
  );
  state.scenarios.push(scenario);
  state.platform.lowCode.scenarios = state.scenarios.length;
  cue.scenarioId = scenario.id;
  cue.state = "spawned";
  const handoff = recordHandoff(cue, {
    actor: createdBy,
    kind: "human",
    actionId: "intel.scenario.spawn",
    action: "Generated scenario",
    detail: `${createdBy} turned the confirmed cue into scenario "${scenario.name}" (${scenario.units.length} units, ${scenario.objectives.length} objectives), ready for course of action generation.`,
  });
  audit(
    createdBy,
    "intel-scenario-spawned",
    scenario.id,
    `Scenario "${scenario.name}" generated from confirmed intel cue ${cue.id} (${scenario.units.length} units, ${scenario.objectives.length} objectives).`
  );
  schedulePersist();
  return { scenario, handoff, cue };
}

/** Advance the scripted BASEER replay by one cue so the demo can be driven without the live feed. */
function handleIntelFeedAdvance() {
  const cue = nextScriptedCue(state.intelFeed.cursor, nowIso());
  if (!cue) return { cue: null };
  state.intelFeed.cursor += 1;
  if (!state.intelCues.some((c) => c.id === cue.id)) {
    recordIngest(cue, "BASEER scripted replay");
    state.intelCues.unshift(cue);
  }
  audit("BASEER", "intel-cue-received", cue.id, `Cue "${cue.title}" (${cue.severity}, ${cue.confidence}%) pushed from BASEER.`);
  schedulePersist();
  return { cue };
}

/** The machine step at the head of every cue: BASEER pushed it, nobody chose it. */
function recordIngest(cue, channel) {
  if (!Array.isArray(cue.handoffs)) cue.handoffs = [];
  const handoff = recordHandoff(cue, {
    actor: "BASEER",
    kind: "machine",
    autonomy: "auto",
    actionId: null,
    action: "Ingested cue",
    detail: `Normalised the ${channel} push into an intel cue, ${cue.severity} severity at ${cue.confidence}% reported confidence. Nothing is assessed and nothing is tasked yet.`,
    source: "offline",
    latencyMs: null,
  });
  cue.ingestHandoffId = handoff.id;
  return handoff;
}

async function handleIntelFeedSync() {
  const baseUrl = process.env.BASEER_URL;
  if (baseUrl) {
    let fetched = null;
    try {
      fetched = await fetchBaseerCues(baseUrl, process.env.BASEER_TOKEN);
    } catch (err) {
      console.error(`[sandtable] BASEER sync failed (${err.message}); falling back to the scripted replay.`);
    }
    if (Array.isArray(fetched)) {
      let count = 0;
      for (const cue of fetched) {
        if (!cue || typeof cue.id !== "string") continue;
        if (state.intelCues.some((c) => c.id === cue.id)) continue;
        recordIngest(cue, `BASEER feed at ${baseUrl}`);
        state.intelCues.unshift(cue);
        count += 1;
      }
      if (count) {
        audit(
          "BASEER",
          "intel-feed-synced",
          "intel-feed",
          `${count === 1 ? "1 new cue" : `${count} new cues`} merged from the BASEER feed at ${baseUrl}.`
        );
        schedulePersist();
      }
      return { source: "baseer", count };
    }
  }
  const advanced = handleIntelFeedAdvance();
  return { source: "replay", count: advanced.cue ? 1 : 0 };
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
  audit("SAGE", "coas-generated", mission.id, `${plural(generated.length, "COA candidate")} generated for "${mission.title}" under the ${COA_STRATEGIES[strategy].label} strategy.`);
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
    label: `Silent eval, ${coa.name}`,
    id: `run-silent-${Date.now().toString(36)}`,
    redPlanId: DEFAULT_ADVERSARY_PLAN_ID,
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

// Resume from breakpoint: fork a live run out of any recorded replay frame, so a
// commander can rewind to a moment and take a different decision path.
function handleResumeFromBreakpoint(runId, branchId, body) {
  const source = requireRun(runId);
  const branch = requireBranch(source, branchId);
  const tick = Number(body.tick);
  if (!Number.isFinite(tick)) throw httpError(400, "Field 'tick' is required.");
  const snapshots = branch._full ? branch._full.snapshots : [];
  if (!snapshots.length) throw httpError(400, 'This branch has no recorded snapshots to resume from.');
  let snap = snapshots[0];
  for (const candidate of snapshots) if (candidate.tick <= tick) snap = candidate;

  const scenario = requireScenario(source.scenarioId);
  const ruleSet = findRuleSet(source.ruleSetId) || state.ruleSets.find((r) => r.status === 'active');
  if (!ruleSet) throw httpError(400, 'No rule set available.');
  const coa = findCoa(branch.coaId);
  if (!coa) throw httpError(404, 'The COA behind this branch no longer exists.');

  const engine = source.engine === 'turn-based' ? 'turn-based' : 'realtime';
  const speed = clamp(Number(body.speed) || source.clock.speed || 2, 0.25, 16);
  const run = createRun({
    scenario,
    coas: [coa],
    ruleSet,
    engine,
    speed,
    label: 'Resumed: ' + branch.name + ' from T+' + round1(snap.simTimeH) + 'h',
    id: nextId('run'),
    redPlanId: source.redPlanId || DEFAULT_ADVERSARY_PLAN_ID,
  });
  run.redPlanId = source.redPlanId || DEFAULT_ADVERSARY_PLAN_ID;
  rewindBranchToSnapshot(run.branches[0], snap, source.label);
  // A fork keeps the crew that flew the original.
  run.seats = Array.isArray(source.seats) && source.seats.length ? JSON.parse(JSON.stringify(source.seats)) : buildSeats();
  run.clock.tick = snap.tick;
  run.clock.simTimeH = snap.simTimeH;
  run.resumedFrom = {
    runId: source.id,
    runLabel: source.label,
    branchId: branch.id,
    branchName: branch.name,
    tick: snap.tick,
    simTimeH: snap.simTimeH,
  };
  state.runs.push(run);
  startLoop(run);
  audit(
    'operator',
    'run-resumed',
    run.id,
    'Forked "' + branch.name + '" from "' + source.label + '" at T+' + round1(snap.simTimeH) + 'h to explore a different decision path.'
  );
  schedulePersist();
  return serializeRun(run);
}

// After-action report: one structured document per run, composed from the
// assessments, the branch outcomes and the decision record. Narrative sections
// come from the reasoning service when a key is present, otherwise they are
// composed deterministically from the same figures.
function reportFigures(run) {
  const scenario = findScenario(run.scenarioId);
  const assessments = state.assessments.filter((a) => a.runId === run.id);
  const branches = run.branches.map((b) => {
    const asm = assessments.find((a) => a.branchId === b.id);
    const decided = b.decisions.filter((d) => d.status === 'decided');
    return {
      name: b.name,
      verdict: asm ? asm.verdict : 'not assessed',
      overall: asm ? asm.overallScore : null,
      dimensions: asm ? asm.dimensions.map((d) => ({ name: d.name, score: d.score, weight: d.weight })) : [],
      objectiveScore: b.metrics.objectiveScore,
      blueStrength: b.metrics.blueStrength,
      redStrength: b.metrics.redStrength,
      blueLosses: b.metrics.blueLosses,
      redLosses: b.metrics.redLosses,
      supplyLevel: b.metrics.supplyLevel,
      lossExchange: b.metrics.blueLosses ? round1(b.metrics.redLosses / b.metrics.blueLosses) : b.metrics.redLosses,
      events: b.eventCount,
      decisionsTotal: decided.length,
      decisionsFollowed: decided.filter((d) => d.followedAi).length,
      decisions: decided.map((d) => ({
        title: d.title,
        chose: (d.options.find((o) => o.id === d.decidedOptionId) || {}).label || 'unknown',
        followedAi: Boolean(d.followedAi),
        simTimeH: d.simTimeH,
        rationale: d.decisionRationale || '',
      })),
    };
  });
  return { scenario, branches, assessments };
}

function offlineReportSections(run, figures) {
  const { branches } = figures;
  const ranked = [...branches].sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const sections = [];
  sections.push({
    heading: 'Summary',
    body:
      'Exercise ' + (figures.scenario ? figures.scenario.codename : run.scenarioName) + ' ran ' + branches.length +
      (run.branches.length === 1 ? ' branch to T+' : ' branches to T+') + round1(run.clock.simTimeH) + 'h under ' + run.engine + ' adjudication. ' +
      (best ? '"' + best.name + '" produced the strongest outcome (' + best.verdict + ', ' + best.overall + '/100), closing ' + best.objectiveScore + '% of the objective picture with BLUE at ' + Math.round(best.blueStrength) + '% aggregate strength.' : ''),
  });
  if (branches.length > 1 && best && worst && best.name !== worst.name) {
    sections.push({
      heading: 'Branch comparison',
      body:
        '"' + best.name + '" outperformed "' + worst.name + '" by ' + Math.abs((best.overall || 0) - (worst.overall || 0)) +
        ' points. The decisive difference was force preservation: ' + Math.round(best.blueStrength) + '% against ' +
        Math.round(worst.blueStrength) + '%, at a loss-exchange ratio of ' + best.lossExchange + ':1 versus ' +
        worst.lossExchange + ':1. Objective completion tracked ' + best.objectiveScore + '% against ' + worst.objectiveScore + '%.',
    });
  }
  const totalDec = branches.reduce((n, b) => n + b.decisionsTotal, 0);
  const followed = branches.reduce((n, b) => n + b.decisionsFollowed, 0);
  sections.push({
    heading: 'Command decisions',
    body:
      totalDec === 0
        ? 'No commander decision points were resolved during this run.'
        : followed + ' of ' + totalDec + ' decision points followed the SAGE recommendation. ' +
          (followed === totalDec
            ? 'The commander accepted AI advice throughout; the outcome reflects the recommended path rather than an independent one.'
            : plural(totalDec - followed, 'override') + (totalDec - followed === 1 ? ' was' : ' were') + ' recorded, and the divergence between branches is partly attributable to them.'),
  });
  sections.push({
    heading: 'Observations and optimisation',
    body:
      (best && best.objectiveScore < 60
        ? 'Objective completion never passed 60%, which points at the shaping phase rather than the assault: intelligence confidence plateaued well before the force committed. '
        : 'Objective completion was satisfactory; the limiting factor was tempo rather than effect. ') +
      (best && best.lossExchange < 2
        ? 'A loss-exchange ratio under 2:1 will not sustain a longer campaign, so the engagement rules for surface combatants inside 45 km deserve revision. '
        : 'The exchange ratio is sustainable for a longer campaign. ') +
      (best && best.supplyLevel < 55
        ? 'Sustainment closed at ' + Math.round(best.supplyLevel) + '%, thin enough that a follow-on phase would have stalled.'
        : 'Sustainment held with margin throughout.'),
  });
  return sections;
}

async function handleGenerateReport(runId) {
  const run = requireRun(runId);
  const figures = reportFigures(run);
  if (!figures.assessments.length) {
    throw httpError(400, 'Assess the run before generating a report.');
  }
  let sections = offlineReportSections(run, figures);
  let source = 'offline';
  if (process.env.ANTHROPIC_API_KEY) {
    const brief = JSON.stringify({ label: run.label, engine: run.engine, simTimeH: run.clock.simTimeH, branches: figures.branches }, null, 1);
    const question =
      'Write an after-action report for this fictional exercise run. Return STRICT JSON only: ' +
      '{"sections":[{"heading":string,"body":string}]}. Four sections, in order: Summary, Branch comparison, ' +
      'Command decisions, Observations and optimisation. Each body 60 to 110 words, addressed to the exercise ' +
      'director, citing the actual figures. No markdown.' + nlLiteral() + nlLiteral() + 'RUN DATA:' + nlLiteral() + brief;
    const result = await askAnthropic(question, 'aar-report', Date.now(), process.env.ANTHROPIC_API_KEY);
    if (result.source === 'anthropic' && result.answer) {
      try {
        const cleaned = result.answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.sections) && parsed.sections.length) {
          sections = parsed.sections
            .filter((x) => x && x.heading && x.body)
            .map((x) => ({ heading: String(x.heading).slice(0, 60), body: String(x.body).slice(0, 900) }));
          source = 'anthropic';
        }
      } catch {
        // keep the deterministic sections
      }
    }
  }
  const report = {
    runId: run.id,
    runLabel: run.label,
    scenarioName: run.scenarioName,
    generatedAt: nowIso(),
    source,
    simTimeH: run.clock.simTimeH,
    branches: figures.branches,
    sections,
  };
  run.report = report;
  audit('analyst', 'report-generated', run.id, 'After-action report generated for "' + run.label + '" via ' + source + '.');
  schedulePersist();
  return report;
}

function nlLiteral() {
  return String.fromCharCode(10);
}

// --- Command seats -----------------------------------------------------------------
// A run is crewed. Every seat is either held by a person or locked to an agent from
// the tactical library, which is how human-machine teaming is actually configured
// rather than merely described. RED is machine-crewed by default.
const SEAT_TEMPLATE = [
  { side: 'blue', name: 'Joint Force Commander', rank: 'Level 1 commander', specialty: 'situation-understanding' },
  { side: 'blue', name: 'Air Component', rank: 'Level 2 commander', specialty: 'fire-strike' },
  { side: 'blue', name: 'Maritime Component', rank: 'Level 2 commander', specialty: 'route-planning' },
  { side: 'blue', name: 'Landing Force', rank: 'Level 3 commander', specialty: 'logistics' },
  { side: 'red', name: 'OPFOR Commander', rank: 'Level 1 commander', specialty: 'situation-understanding' },
  { side: 'red', name: 'Coastal Defense', rank: 'Level 2 commander', specialty: 'fire-strike' },
  { side: 'red', name: 'Naval Strike Group', rank: 'Level 2 commander', specialty: 'route-planning' },
];

function agentForSpecialty(specialty) {
  const ready = state.agents.filter((a) => a.status === 'ready');
  return ready.find((a) => a.specialty === specialty) || ready[0] || state.agents[0] || null;
}

function buildSeats(participantName) {
  return SEAT_TEMPLATE.map((t, i) => {
    const agent = agentForSpecialty(t.specialty);
    const humanHeld = t.side === 'blue' && i === 0;
    return {
      id: 'seat-' + (i + 1),
      side: t.side,
      name: t.name,
      rank: t.rank,
      mode: humanHeld ? 'human' : 'ai',
      participant: humanHeld ? participantName || 'Exercise participant' : null,
      agentId: humanHeld ? null : agent ? agent.id : null,
      agentName: humanHeld ? null : agent ? agent.name : null,
    };
  });
}

function handleUpdateSeat(runId, seatId, body) {
  const run = requireRun(runId);
  if (!Array.isArray(run.seats)) throw httpError(400, 'This run has no seat roster.');
  const seat = run.seats.find((x) => x.id === seatId);
  if (!seat) throw httpError(404, 'Unknown seat "' + seatId + '".');
  if (body.mode === 'human' || body.mode === 'ai') seat.mode = body.mode;
  if (seat.mode === 'ai') {
    const requested = typeof body.agentId === 'string' ? state.agents.find((a) => a.id === body.agentId) : null;
    const agent = requested || (seat.agentId ? state.agents.find((a) => a.id === seat.agentId) : null) || agentForSpecialty('situation-understanding');
    seat.agentId = agent ? agent.id : null;
    seat.agentName = agent ? agent.name : null;
    seat.participant = null;
  } else {
    seat.agentId = null;
    seat.agentName = null;
    if (typeof body.participant === 'string' && body.participant.trim()) seat.participant = body.participant.trim().slice(0, 60);
    if (!seat.participant) seat.participant = 'Exercise participant';
  }
  audit(
    'operator',
    'seat-assigned',
    run.id,
    seat.side.toUpperCase() + ' ' + seat.name + ' is now crewed by ' + (seat.mode === 'ai' ? 'agent ' + seat.agentName : seat.participant) + '.'
  );
  schedulePersist();
  return serializeRun(run);
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

  // Which adversary plan RED is playing. The white cell picks it at launch; the
  // players are told a plan exists and nothing more.
  const redPlanId = typeof body.redPlanId === "string" && findAdversaryPlan(body.redPlanId) ? body.redPlanId : DEFAULT_ADVERSARY_PLAN_ID;

  const run = createRun({ scenario, coas, ruleSet, engine, speed, label, id: nextId("run"), redPlanId });
  run.seats = Array.isArray(body.seats) && body.seats.length ? body.seats : buildSeats(body.crewedBy);
  run.redPlanId = redPlanId;
  state.runs.push(run);
  scenario.status = "running";
  scenario.updatedAt = nowIso();
  startLoop(run);
  audit(
    "operator",
    "run-started",
    run.id,
    `${label}: ${plural(coas.length, "branch", "branches")} on ${scenario.name} via ${ruleSet.name} (${engine}, x${speed}), OPFOR playing ${redPlanId}.`
  );
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
  const option = decision.options.find((o) => o.id === optionId);
  applyDecision(run, branch.id, decisionId, optionId, decidedBy, rationale, ctxFor(run));
  // Orders out. A decision that changes the plan is an order, so the platform cuts
  // one under the name of the commander who directed it instead of leaving the
  // change to live only inside the event log.
  const frago = recordFrago(run, branch, decision, option, decidedBy, rationale);
  reconcileRunStatus(run);
  if (run.engine === "realtime" && !loops.has(run.id) && !TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== "paused") {
    startLoop(run);
  }
  const followed = optionId === decision.aiRecommendationId;
  audit(
    decidedBy,
    "decision-made",
    `${run.id}/${branch.id}`,
    `"${decision.title}" resolved with option ${optionId} (${followed ? "followed AI" : "overrode AI"}). FRAGO ${frago.number} cut under ${decidedBy}.`
  );
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
      `Latest adjudication: ${a.attacker} fired ${a.weapon} at ${a.target} from ${a.rangeKm} km, base pk ${a.basePk}` +
        (a.modifiers.length ? `, modified by ${a.modifiers.map((x) => `"${x.rule}" ×${x.factor}`).join(", ")}` : "") +
        ` to ${a.finalPk}; roll ${a.roll} → ${a.result.toUpperCase()}${a.result === "hit" ? ` for ${a.damage}% damage` : ""}.`
    );
  }
  const recent = branch.recentEvents.slice(0, 5).map((e) => `[${e.type}] ${e.title}`);
  if (recent.length) lines.push(`Recent events: ${recent.join(" | ")}`);
  // What may be said about RED. Before the reveal the adversary plan belongs to
  // the white cell, so the model is handed indicators and an explicit refusal
  // rather than the plan it would otherwise happily paraphrase.
  const adversary = branch.adversary;
  if (adversary && adversary.revealed) {
    lines.push(
      `RED plan (revealed, may be described): ${adversary.codename}, ${adversary.name}. ${adversary.summary} Fires ${
        adversary.firesReleased ? `released at T+${adversary.firesReleasedAtH}h` : "still held"
      }.`
    );
    if (adversary.currentPhase) lines.push(`RED current phase: "${adversary.currentPhase.name}", ${adversary.currentPhase.intent}`);
  } else if (adversary) {
    lines.push(
      "RED plan: WITHHELD by the white cell. You do not have it and must not invent it. Speak only about observed RED behaviour, and say plainly that the plan is masked."
    );
    lines.push(`RED fires: ${adversary.firesReleased ? `released at T+${adversary.firesReleasedAtH}h` : "not one RED shot fired so far"}.`);
    for (const ind of adversary.indicators.slice(-3)) lines.push(`Observed indicator at T+${ind.atH}h: ${ind.text}`);
  }
  return lines.join("\n");
}

function offlineExplain(topic, run, branch, scenario) {
  const m = branch.metrics;
  const blueAlive = branch.units.filter((u) => u.side === "blue" && u.status !== "destroyed");
  const redAlive = branch.units.filter((u) => u.side === "red" && u.status !== "destroyed");
  if (topic === "adjudication") {
    const e = branch.recentEvents.find((ev) => ev.adjudication);
    if (!e) return "No engagement has been adjudicated yet in this branch, once a piece fires, the full resolution (weapon, range, rule modifiers, random roll, damage) appears here and in the Adjudication drawer.";
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
    if (weak && weak.supply < 45) risks.push([60 + (45 - weak.supply), `${weak.name} is at ${Math.round(weak.supply)}% supply, it drops out of the fight if it is not rotated to the auxiliary within the next phase`]);
    const exposed = blueAlive.filter((u) => u.detectedByEnemy).length;
    if (exposed > blueAlive.length * 0.6) risks.push([55, `${exposed} of ${blueAlive.length} BLUE pieces are held by RED sensors, so the force is fighting inside the enemy's kill chain`]);
    if (scenario.environment.weather === "storm") risks.push([50, "storm conditions are suppressing detection and movement for both sides, which favors the defender"]);
    if (m.blueStrength < 70) risks.push([70, `aggregate BLUE strength is down to ${m.blueStrength}%, attrition is outpacing the objective picture (${m.objectiveScore}%)`]);
    if (m.objectiveScore < 40 && run.clock.simTimeH > scenario.durationHours * 0.5) risks.push([65, `over half the window is spent but objectives sit at ${m.objectiveScore}%, tempo is the risk, not losses`]);
    if (!risks.length) return `No acute risk: BLUE holds ${m.blueStrength}% strength, ${m.supplyLevel}% supply and ${m.objectiveScore}% of the objective picture. The main watch item is keeping the sustainment line covered as the force advances.`;
    risks.sort((a, b) => b[0] - a[0]);
    return `Biggest risk right now: ${risks[0][1]}.${risks[1] ? ` Secondary: ${risks[1][1]}.` : ""}`;
  }
  if (topic === "next-step") {
    const open = branch.decisions.find((d) => d.status === "open");
    if (open) return `A commander decision is open: "${open.title}". SAGE recommends "${open.options.find((o) => o.id === open.aiRecommendationId)?.label}", ${open.aiRationale}`;
    if (m.supplyLevel < 45) return `Sustainment first: force supply is ${m.supplyLevel}%. Pull the escort screen tight around the auxiliary, run a resupply rotation, then resume the advance, the objective picture (${m.objectiveScore}%) will hold.`;
    if (m.objectiveScore >= 50 && m.blueStrength > m.redStrength) return `Press the advantage: objectives at ${m.objectiveScore}% with a strength edge (${m.blueStrength}% vs ${m.redStrength}%). Keep the current phase ("${branch.currentPhaseName || "free play"}") moving and deny RED time to reconstitute.`;
    return `Develop the picture before committing: only ${redAlive.filter((u) => u.detectedByEnemy).length} of ${redAlive.length} RED pieces are held on sensors. Push ISR forward, keep EMCON ${scenario.environment.emcon}, and time the strike for the next phase boundary.`;
  }
  // enemy
  const redEvents = branch.recentEvents.filter((e) => e.actorId && redAlive.some((u) => u.id === e.actorId)).slice(0, 3);
  const acting = redEvents.map((e) => e.title).join("; ");
  const held = redAlive.filter((u) => u.detectedByEnemy).length;
  const adversary = branch.adversary;
  const opening =
    `RED retains ${plural(redAlive.length, "piece")} at ${m.redStrength}% aggregate strength (${m.redLosses} lost), of which BLUE holds ${held} on sensors. ` +
    (acting ? `Latest RED activity: ${acting}. ` : "RED has initiated no engagements recently. ");
  if (!adversary) {
    return `${opening}This run was adjudicated before the adversary planner shipped, so RED here is reacting to contact rather than executing a scheme of manoeuvre.`;
  }
  if (adversary.revealed) {
    const phase = adversary.currentPhase;
    return (
      `${opening}RED is executing ${adversary.codename}, ${adversary.name.toLowerCase()}. ${adversary.summary}` +
      (phase ? ` Current phase "${phase.name}": ${phase.intent}` : "") +
      (adversary.firesReleased
        ? ` RED fires were released at T+${adversary.firesReleasedAtH}h.`
        : ` RED fires are still held, so the quiet is a decision and not an absence.`)
    );
  }
  // The plan itself belongs to the white cell. SAGE answers the player from the
  // BLUE picture, so it reports indicators and refuses to read RED's mind.
  const indicator = adversary.indicators.length ? adversary.indicators[adversary.indicators.length - 1].text : null;
  return (
    `${opening}The adversary plan is held by the white cell and is not mine to read out, so this is inference from the BLUE picture only. ` +
    (adversary.firesReleased
      ? `RED released fires at T+${adversary.firesReleasedAtH}h, so it is now fighting rather than hiding.`
      : `RED has not fired a shot yet. Against a coastal force that is usually a decision rather than an absence, and it points at a battery envelope BLUE has not entered.`) +
    (indicator ? ` Latest indicator: ${indicator}` : "")
  );
}

async function handleExplain(runId, branchId, body) {
  const run = requireRun(runId);
  const branch = requireBranch(run, branchId);
  const topic = String(body.topic || "");
  if (!EXPLAIN_TOPICS[topic]) throw httpError(400, `Unknown topic "${topic}", expected one of ${Object.keys(EXPLAIN_TOPICS).join(", ")}.`);
  const scenario = findScenario(run.scenarioId);
  const started = Date.now();
  if (process.env.ANTHROPIC_API_KEY) {
    const question = `${EXPLAIN_TOPICS[topic]}\n\nGrounded branch context (authoritative, answer from this):\n${branchExplainContext(run, branch, scenario)}\n\nAnswer in at most 110 words, addressed to the commander.`;
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
    requestedBy: gateAction("run.intervene", body.requestedBy).actor,
  };
  applyIntervention(run, branch.id, request, ctxFor(run));
  reconcileRunStatus(run);
  audit(request.requestedBy, "intervention", `${run.id}/${branch.id}`, `${request.type} applied to branch ${branch.name} of ${run.label}.`);
  schedulePersist();
  return serializeRun(run);
}

// --- Commander's requirements ---------------------------------------------------------
// A cue on its own is an alert. A cue anchored to the priority requirement it
// answers, the indicator it satisfies and the named area it sits in is
// intelligence. The requirements are authored, the matching is derived on read,
// so every cue that has ever landed gets anchored without a migration.

const REQUIREMENTS = buildRequirements();
const NAMED_AREAS = buildNamedAreas();

function handleRequirements() {
  return requirementsBoard(state.intelCues, REQUIREMENTS, NAMED_AREAS);
}

/** What one cue answers, with the evidence spelled out. */
function handleCueRequirements(id) {
  const cue = requireCue(id);
  return { cueId: cue.id, matches: matchCue(cue, REQUIREMENTS, NAMED_AREAS) };
}

// --- Classification -----------------------------------------------------------------
// One platform marking, carried by every document the platform emits. The data is
// fictional, so the EXERCISE and FICTIONAL DATA caveats are locked on.

function handleGetClassification() {
  const current = normalizeClassification(state.classification);
  return { current, marking: markingLine(current), catalogue: classificationCatalogue() };
}

function handleSetClassification(body) {
  const changedBy = typeof body.changedBy === "string" && body.changedBy.trim() ? body.changedBy.trim().slice(0, 60) : "";
  if (!changedBy) throw httpError(400, "Field 'changedBy' is required: a classification decision belongs to a person.");
  const level = String(body.level || "");
  if (!CLASSIFICATION_LEVELS.some((l) => l.id === level)) {
    throw httpError(400, `Field 'level' must be one of: ${CLASSIFICATION_LEVELS.map((l) => l.id).join(", ")}.`);
  }
  const before = markingLine(state.classification);
  state.classification = normalizeClassification({
    level,
    caveats: Array.isArray(body.caveats) ? body.caveats : state.classification.caveats,
    releasableTo: typeof body.releasableTo === "string" ? body.releasableTo : state.classification.releasableTo,
    updatedAt: nowIso(),
    updatedBy: changedBy,
  });
  const after = markingLine(state.classification);
  audit(changedBy, "classification-changed", "platform", `Platform marking moved from "${before}" to "${after}" by ${changedBy}.`);
  schedulePersist();
  return handleGetClassification();
}

// --- Staff products -----------------------------------------------------------------
// The platform could read an operational order and could not write one. It can now
// emit the order, its synchronisation matrix, its decision support matrix, and the
// fragmentary orders cut when a commander changes the plan mid-run.

function handleCoaOrders(coaId, query) {
  const coa = findCoa(coaId);
  if (!coa) throw httpError(404, `Unknown COA "${coaId}".`);
  const scenario = requireScenario(coa.scenarioId);
  const mission = state.missions.find((m) => m.id === coa.missionId) || null;
  const ruleSet = state.ruleSets.find((r) => r.status === "active") || state.ruleSets[0] || null;
  const opord = buildOpord({
    scenario,
    coa,
    mission,
    ruleSet,
    classification: state.classification,
    issuedBy: (query && query.get("issuedBy")) || "Joint Force Headquarters",
    orderNumber: coa.id.replace(/[^0-9]/g, "").slice(-3) || "001",
    nowIso,
  });
  return {
    opord,
    text: renderOpordText(opord),
    sync: buildSyncMatrix(scenario, coa, mission),
    dsm: buildDecisionSupport(scenario, coa, ruleSet, mission),
  };
}

function handleRunFragos(runId) {
  const run = requireRun(runId);
  const fragos = state.fragos.filter((f) => f.runId === run.id);
  return { runId: run.id, runLabel: run.label, fragos, text: fragos.map((f) => renderFragoText(f)).join(`${nlLiteral()}${nlLiteral()}`) };
}

/** Cut the order that carries a commander decision, override or not. */
function recordFrago(run, branch, decision, option, decidedBy, rationale) {
  const sequence = state.fragos.filter((f) => f.runId === run.id).length + 1;
  const frago = buildFrago({
    run,
    branch,
    decision,
    option,
    decidedBy,
    rationale,
    sequence,
    classification: state.classification,
    nowIso,
  });
  state.fragos.push(frago);
  if (state.fragos.length > 400) state.fragos.splice(0, state.fragos.length - 400);
  return frago;
}

// --- Adversary plan ----------------------------------------------------------------
// The RED scheme of manoeuvre is white-cell property. Players see a masked view on
// the branch until the run completes or an umpire reveals it by name.

function handleRevealAdversary(id, body) {
  const run = requireRun(id);
  const revealedBy = gateAction("run.adversary.reveal", body.revealedBy).actor;
  const revealed = run.branches.map((branch) => revealAdversary(branch)).filter(Boolean);
  if (!revealed.length) throw httpError(409, "No branch in this run carries an adversary plan to reveal.");
  audit(revealedBy, "adversary-revealed", run.id, `${revealedBy} revealed the OPFOR plan to the players on ${plural(revealed.length, "branch", "branches")} of "${run.label}".`);
  schedulePersist();
  return serializeRun(run);
}

function handleAdversaryTruth(id) {
  const run = requireRun(id);
  const branches = run.branches.map((branch) => ({
    branchId: branch.id,
    branchName: branch.name,
    plan: adversaryTruth(branch),
  }));
  return { runId: run.id, runLabel: run.label, branches };
}

function handleAssessRun(id) {
  const run = requireRun(id);
  if (run.status !== "completed") {
    throw httpError(400, `Run must be completed before assessment (current status: ${run.status}).`);
  }
  const assessments = buildAssessments(run, ctxFor(run));
  state.assessments = state.assessments.filter((a) => a.runId !== run.id);
  for (const assessment of assessments) state.assessments.push(assessment);
  audit("SAGE", "assessment-generated", run.id, `${plural(assessments.length, "branch assessment")} computed for ${run.label}.`);
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
      audit("operator", "scenario-validated", scenario.id, `Validation ${report.ok ? "passed" : "failed"} with ${plural(report.issues.length, "finding")}.`);
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
      audit("operator", "ruleset-tested", ruleSet.id, `Test "${result.situation}", ${plural(result.trace.filter((t) => t.fired).length, "rule")} fired.`);
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
    re: new RegExp("^/api/runs/" + ID + "/branches/" + ID + "/resume$"),
    handler: ({ params, body }) => handleResumeFromBreakpoint(params[0], params[1], body),
  },
  {
    method: "POST",
    re: new RegExp(`^/api/runs/${ID}/branches/${ID}/explain$`),
    handler: ({ params, body }) => handleExplain(params[0], params[1], body),
  },
  { method: "GET", re: /^\/api\/adversary\/plans$/, handler: () => adversaryPlanCatalogue() },
  { method: "GET", re: /^\/api\/governance\/policy$/, handler: () => handleGetGovernance() },
  { method: "PUT", re: /^\/api\/governance\/policy$/, handler: ({ body }) => handleSetGovernance(body) },
  { method: "GET", re: /^\/api\/intel\/requirements$/, handler: () => handleRequirements() },
  {
    method: "GET",
    re: new RegExp(`^/api/intel/cues/${ID}/requirements$`),
    handler: ({ params }) => handleCueRequirements(params[0]),
  },
  { method: "GET", re: /^\/api\/classification$/, handler: () => handleGetClassification() },
  { method: "PUT", re: /^\/api\/classification$/, handler: ({ body }) => handleSetClassification(body) },
  { method: "GET", re: new RegExp(`^/api/coas/${ID}/orders$`), handler: ({ params, query }) => handleCoaOrders(params[0], query) },
  { method: "GET", re: new RegExp(`^/api/runs/${ID}/fragos$`), handler: ({ params }) => handleRunFragos(params[0]) },
  {
    method: "POST",
    re: new RegExp(`^/api/runs/${ID}/adversary/reveal$`),
    handler: ({ params, body }) => handleRevealAdversary(params[0], body),
  },
  {
    method: "GET",
    re: new RegExp(`^/api/runs/${ID}/adversary/truth$`),
    handler: ({ params }) => handleAdversaryTruth(params[0]),
  },
  { method: "POST", re: new RegExp(`^/api/runs/${ID}/assess$`), handler: ({ params }) => handleAssessRun(params[0]) },
  { method: "POST", re: new RegExp("^/api/runs/" + ID + "/report$"), handler: ({ params }) => handleGenerateReport(params[0]) },
  {
    method: "PUT",
    re: new RegExp("^/api/runs/" + ID + "/seats/" + ID + "$"),
    handler: ({ params, body }) => handleUpdateSeat(params[0], params[1], body),
  },
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

  { method: "GET", re: /^\/api\/intel\/cues$/, handler: () => [...state.intelCues].sort((a, b) => b.observedAt.localeCompare(a.observedAt)) },
  { method: "GET", re: new RegExp(`^/api/intel/cues/${ID}$`), handler: ({ params }) => requireCue(params[0]) },
  {
    method: "POST",
    re: new RegExp(`^/api/intel/cues/${ID}/interrogate$`),
    handler: ({ params, body }) => handleCueInterrogate(params[0], body),
  },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/identify$`), handler: ({ params, body }) => handleCueIdentify(params[0], body) },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/collect/options$`), handler: ({ params }) => handleCueCollectOptions(params[0]) },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/collect$`), handler: ({ params, body }) => handleCueCollect(params[0], body) },
  {
    method: "POST",
    re: new RegExp(`^/api/intel/cues/${ID}/collect/${ID}/approve$`),
    handler: ({ params, body }) => handleCueApproveCollection(params[0], params[1], body),
  },
  {
    method: "POST",
    re: new RegExp(`^/api/intel/cues/${ID}/collect/${ID}/report$`),
    handler: ({ params, body }) => handleCueCollectionReport(params[0], params[1], body),
  },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/confirm$`), handler: ({ params, body }) => handleCueConfirm(params[0], body) },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/dismiss$`), handler: ({ params, body }) => handleCueDismiss(params[0], body) },
  { method: "POST", re: new RegExp(`^/api/intel/cues/${ID}/scenario$`), handler: ({ params, body }) => handleCueScenario(params[0], body) },
  { method: "POST", re: /^\/api\/intel\/feed\/advance$/, handler: () => handleIntelFeedAdvance() },
  { method: "POST", re: /^\/api\/intel\/feed\/sync$/, handler: () => handleIntelFeedSync() },

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
    `[sandtable] ${state.scenarios.length} scenarios, ${state.coas.length} COAs, ${state.agents.length} agents, ${plural(state.runs.length, "run")}, ${plural(state.assessments.length, "assessment")}; copilot: ${
      process.env.ANTHROPIC_API_KEY
        ? `anthropic (${process.env.ANTHROPIC_MODEL || "claude-opus-5"})`
        : process.env.OPENAI_API_KEY
          ? `openai (${process.env.OPENAI_MODEL || "gpt-4o-mini"})`
          : "offline"
    }`
  );
});

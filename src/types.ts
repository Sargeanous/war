// SANDTABLE domain model. This file is the single source of truth for the
// shapes exchanged between the frontend and the backend (server mirrors these
// shapes in plain JS). Keep in sync with server/CONTRACTS.md.

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "good" | "warn" | "danger" | "info";
export type SideId = "blue" | "red" | "neutral";
export type Domain = "land" | "sea" | "air" | "cyber" | "space";

export interface LatLng {
  lat: number;
  lng: number;
}

// ---------------------------------------------------------------------------
// Ontology (unified data foundation)
// ---------------------------------------------------------------------------

export interface OntologyAttribute {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "latlng";
  unit?: string;
  enumValues?: string[];
  description?: string;
}

export interface OntologyClass {
  id: string; // e.g. "maritime.destroyer"
  label: string;
  parent: string | null; // parent class id
  category: "force" | "facility" | "system" | "event" | "concept";
  domain?: Domain;
  description: string;
  attributes: OntologyAttribute[];
  icon?: string; // lucide icon name hint
  // Low-code piece designer: default loadout applied when this class is placed
  // as a unit in Scenario Design. Absent on seed classes (domain defaults apply).
  defaults?: {
    speedKts: number;
    strength: number;
    supply: number;
    sensors: SensorSpec[];
    weapons: WeaponSpec[];
  };
}

export interface OntologyRelation {
  id: string;
  label: string; // e.g. "subordinateTo"
  from: string; // class id
  to: string; // class id
  description: string;
}

export interface Ontology {
  version: string;
  updatedAt: string;
  classes: OntologyClass[];
  relations: OntologyRelation[];
}

// ---------------------------------------------------------------------------
// Scenario design
// ---------------------------------------------------------------------------

export interface SensorSpec {
  type: string; // e.g. "surface-radar"
  rangeKm: number;
}

export interface WeaponSpec {
  type: string; // e.g. "ssm" | "sam" | "gun" | "torpedo" | "strike"
  rangeKm: number;
  pk: number; // probability of kill 0..1
  ammo: number;
}

export type UnitStatus = "active" | "damaged" | "destroyed" | "withdrawn";

export interface Unit {
  id: string;
  side: SideId;
  name: string; // e.g. "CTF Sword · DDG 114"
  classId: string; // ontology class id
  domain: Domain;
  position: LatLng;
  headingDeg: number;
  speedKts: number;
  strength: number; // 0..100
  supply: number; // 0..100
  sensors: SensorSpec[];
  weapons: WeaponSpec[];
  status: UnitStatus;
  detectedByEnemy?: boolean; // set by the engine on live branch units
  taskForce?: string;
  notes?: string;
}

export interface Objective {
  id: string;
  side: SideId;
  title: string;
  description: string;
  kind: "control-area" | "destroy" | "protect" | "deliver" | "deny";
  area?: { center: LatLng; radiusKm: number };
  targetUnitIds?: string[];
  weight: number; // 0..1, weights sum ~1 per side
}

export interface ScenarioEnvironment {
  weather: "clear" | "overcast" | "storm";
  seaState: number; // 0..9
  visibilityKm: number;
  emcon: "free" | "restricted" | "silent";
  cyberThreat: "low" | "elevated" | "severe";
}


// --- Intelligent Documents (OPORD pipeline) ---------------------------------

export interface OpordEntity {
  name: string | null;
  classId: string;
  classLabel: string;
  domain: Domain;
  count: number;
  position: LatLng;
  taskForce: string | null;
}

export interface OpordParse {
  source: "anthropic" | "offline";
  title: string;
  summary: string;
  sides: Array<{ side: "blue" | "red"; entities: OpordEntity[] }>;
  objectives: Array<{ side: "blue" | "red"; title: string; kind: Objective["kind"] }>;
  constraints: string[];
  unparsed: string[];
}

export type ScenarioStatus = "draft" | "ready" | "running" | "completed";

export interface Side {
  id: SideId;
  name: string;
  commander: string;
  color: string;
}

export interface Scenario {
  id: string;
  name: string;
  codename: string;
  description: string;
  theater: string;
  mapCenter: LatLng;
  mapZoom: number;
  durationHours: number;
  status: ScenarioStatus;
  createdBy: string;
  updatedAt: string;
  sides: Side[];
  units: Unit[];
  objectives: Objective[];
  environment: ScenarioEnvironment;
}

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface ValidationReport {
  scenarioId: string;
  ok: boolean;
  issues: ValidationIssue[];
  checkedAt: string;
}

// Fictional island geography rendered on the map (GeoJSON-lite polygons).
export interface TheaterFeature {
  id: string;
  name: string;
  kind: "island" | "shoal" | "zone";
  polygon: LatLng[]; // closed ring
}

// ---------------------------------------------------------------------------
// Missions + strategic task decomposition (L2 strategic)
// ---------------------------------------------------------------------------

export type SubTaskStatus = "pending" | "assigned" | "executing" | "complete" | "failed";

export interface SubTask {
  id: string;
  title: string;
  domain: Domain;
  description: string;
  startH: number; // offset hours from mission start
  endH: number;
  assignedAgentId: string | null;
  assignedUnitIds: string[];
  dependsOn: string[]; // subtask ids
  status: SubTaskStatus;
}

export interface Mission {
  id: string;
  scenarioId: string;
  side: SideId;
  title: string;
  intent: string; // commander's intent
  endState: string;
  status: "draft" | "decomposed" | "planned" | "executing" | "complete";
  subTasks: SubTask[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tactical agent library (L2 tactical)
// ---------------------------------------------------------------------------

export type DriveMode =
  | "knowledge-reasoning"
  | "data-learning"
  | "operations-research"
  | "large-model"
  | "hybrid";

export interface AgentDef {
  id: string;
  name: string;
  driveMode: DriveMode;
  specialty: string; // e.g. "fire-strike" | "route-planning" | "logistics" | "situation-understanding"
  description: string;
  version: string;
  status: "ready" | "training" | "offline";
  metrics: {
    winRate: number; // 0..1 in eval scenarios
    avgLatencyMs: number;
    trainingEpisodes: number;
    lastEvaluated: string;
  };
}

export interface AgentActivity {
  id: string;
  runId: string;
  branchId: string;
  agentId: string;
  tick: number;
  simTimeH: number;
  action: string;
  rationale: string;
  api: "observation" | "piece-drive";
}

// ---------------------------------------------------------------------------
// COA generation (L3 app 2)
// ---------------------------------------------------------------------------

export interface CoaTaskAssignment {
  subTaskId: string;
  unitIds: string[];
  action: string; // e.g. "advance-axis-north", "sead-sweep", "hold-and-screen"
  waypoints: LatLng[];
}

export interface CoaPhase {
  id: string;
  name: string;
  startH: number;
  endH: number;
  intent: string;
  assignments: CoaTaskAssignment[];
}

export interface CoaScores {
  feasibility: number; // 0..100
  acceptability: number;
  risk: number; // higher = riskier
  resourceCost: number;
  expectedEffect: number;
  composite: number;
}

export type CoaStatus = "candidate" | "selected" | "rejected" | "simulated";

export interface Coa {
  id: string;
  scenarioId: string;
  missionId: string;
  name: string;
  approach: string; // one-line doctrine label
  summary: string;
  generatedBy: "agent" | "planner";
  generatorAgentId?: string;
  phases: CoaPhase[];
  scores: CoaScores;
  status: CoaStatus;
  strategy?: CoaStrategy; // commander weighting strategy used at generation
  grade?: "recommended" | "steady" | "alternate";
  silentEval?: CoaSilentEval; // headless deduction projection
  color: string; // branch color for charts/map
  createdAt: string;
}

export type ExplainTopic = "adjudication" | "risk" | "next-step" | "enemy";

export interface ExplainResult {
  topic: ExplainTopic;
  answer: string;
  source: "anthropic" | "offline";
  latencyMs: number;
}

export type CoaStrategy = "results-first" | "loss-control" | "speed-first" | "balanced";

export interface CoaAnalysisStep {
  step: string;
  detail: string;
  ms: number;
}

export interface CoaGenerationResult {
  coas: Coa[];
  analysis: CoaAnalysisStep[];
  strategy: CoaStrategy;
}

export interface CoaSilentEval {
  evaluatedAt: string;
  ruleSetId: string;
  projected: {
    objectiveScore: number;
    blueStrength: number;
    redStrength: number;
    blueLosses: number;
    redLosses: number;
    supplyLevel: number;
    decisions: number;
    durationH: number;
    net: number;
  };
}

// ---------------------------------------------------------------------------
// Simulation rules + adjudication (L3 app 3)
// ---------------------------------------------------------------------------

export type RuleCategory = "detection" | "engagement" | "movement" | "logistics" | "attrition" | "victory";
export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "within-km" | "has";

export interface RuleCondition {
  fact: string; // e.g. "target.domain", "actor.supply", "range"
  op: ConditionOp;
  value: string | number | boolean;
}

export type RuleEffectType =
  | "modify-pk"
  | "modify-detection"
  | "modify-speed"
  | "apply-damage"
  | "consume-supply"
  | "reveal-unit"
  | "score-points"
  | "spawn-event"
  | "request-decision";

export interface RuleEffect {
  type: RuleEffectType;
  params: Record<string, string | number | boolean>;
}

export interface Rule {
  id: string;
  name: string;
  category: RuleCategory;
  description: string;
  conditions: RuleCondition[];
  effects: RuleEffect[];
  priority: number; // lower runs first
  enabled: boolean;
}

export interface AdjudicationConfig {
  mode: "auto" | "umpire" | "hybrid";
  dieModel: "deterministic" | "stochastic";
  seed: number;
  phaseOrder: string[]; // e.g. ["movement","detection","engagement","logistics","victory"]
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  domainFocus: "joint" | Domain;
  status: "active" | "draft" | "archived";
  rules: Rule[];
  adjudication: AdjudicationConfig;
  updatedAt: string;
  author: string;
}

export interface RuleTestTraceEntry {
  ruleId: string;
  ruleName: string;
  fired: boolean;
  detail: string;
}

export interface RuleTestResult {
  ruleSetId: string;
  situation: string;
  outcome: string;
  trace: RuleTestTraceEntry[];
  testedAt: string;
}

// ---------------------------------------------------------------------------
// Deduction runs (L3 app 4)
// ---------------------------------------------------------------------------

export type RunStatus = "initializing" | "running" | "paused" | "awaiting-decision" | "completed" | "aborted";
export type BranchStatus = "running" | "paused" | "awaiting-decision" | "completed" | "aborted";
export type EngineKind = "realtime" | "turn-based";

// Full adjudication math behind an engagement event · "show the dice".
export interface EngagementAdjudication {
  attacker: string;
  target: string;
  weapon: string; // display label, e.g. "SSM"
  weaponType: string;
  rangeKm: number;
  basePk: number;
  modifiers: Array<{ rule: string; factor: number }>;
  finalPk: number;
  roll: number;
  result: "hit" | "miss";
  damage: number; // 0 on a miss
}

export interface SimEvent {
  id: string;
  tick: number;
  simTimeH: number;
  type:
    | "detection"
    | "engagement"
    | "damage"
    | "destroyed"
    | "move"
    | "phase"
    | "decision"
    | "intervention"
    | "logistics"
    | "cyber"
    | "info"
    | "victory";
  severity: Tone;
  actorId?: string;
  targetId?: string;
  title: string;
  detail: string;
  position?: LatLng;
  adjudication?: EngagementAdjudication;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  projectedEffect: string;
  risk: "low" | "medium" | "high";
}

export interface DecisionPoint {
  id: string;
  tick: number;
  simTimeH: number;
  title: string;
  situation: string;
  options: DecisionOption[];
  aiRecommendationId: string;
  aiRationale: string;
  status: "open" | "decided" | "expired";
  decidedBy?: string;
  decidedOptionId?: string;
  decisionRationale?: string;
  followedAi?: boolean;
}

export interface BranchMetrics {
  blueStrength: number; // aggregate 0..100
  redStrength: number;
  blueLosses: number; // destroyed unit count
  redLosses: number;
  objectiveScore: number; // 0..100 blue objective completion
  supplyLevel: number; // blue average supply
}

export interface UnitSnapshot {
  id: string;
  position: LatLng;
  headingDeg: number;
  strength: number;
  status: UnitStatus;
  detectedByEnemy: boolean;
}

export interface ReplaySnapshot {
  tick: number;
  simTimeH: number;
  units: UnitSnapshot[];
  metrics: BranchMetrics;
}

// Mirrored per-side wargame scoreboard, recomputed every tick.
export interface SideScore {
  objective: number;
  force: number;
  combat: number;
  total: number;
}

export interface BranchScore {
  blue: SideScore;
  red: SideScore;
  net: number; // BLUE total minus RED total
}

export interface Branch {
  id: string;
  coaId: string;
  name: string;
  color: string;
  status: BranchStatus;
  currentPhaseId: string | null;
  currentPhaseName?: string | null; // absent on runs recorded before phase names shipped
  score?: BranchScore; // absent on runs recorded before the scoreboard shipped
  units: Unit[]; // live unit states
  recentEvents: SimEvent[]; // capped tail, newest first
  eventCount: number;
  decisions: DecisionPoint[];
  metrics: BranchMetrics;
  metricsHistory: Array<{ tick: number; simTimeH: number } & BranchMetrics>;
}


// A run is crewed: each command seat is held by a person or locked to an agent.
export interface CommandSeat {
  id: string;
  side: "blue" | "red";
  name: string;
  rank: string;
  mode: "human" | "ai";
  participant: string | null;
  agentId: string | null;
  agentName: string | null;
}
export interface SimRun {
  id: string;
  scenarioId: string;
  scenarioName: string;
  ruleSetId: string;
  engine: EngineKind;
  status: RunStatus;
  clock: {
    tick: number;
    simTimeH: number;
    hoursPerTick: number;
    speed: number; // ticks/second multiplier for realtime
  };
  branches: Branch[];
  startedAt: string;
  completedAt?: string;
  label: string;
  seats?: CommandSeat[];
  resumedFrom?: {
    runId: string;
    runLabel: string;
    branchId: string;
    branchName: string;
    tick: number;
    simTimeH: number;
  } | null;
  environment?: ScenarioEnvironment | null; // live scenario environment (reflects umpire changes)
}

export interface RunSummary {
  id: string;
  label: string;
  scenarioId: string;
  scenarioName: string;
  status: RunStatus;
  engine: EngineKind;
  branchCount: number;
  simTimeH: number;
  durationHours: number;
  startedAt: string;
  completedAt?: string;
}


// After-action report: one document per run, narrative sections composed by the
// reasoning service when available, deterministically otherwise.
export interface RunReportBranch {
  name: string;
  verdict: string;
  overall: number | null;
  dimensions: Array<{ name: string; score: number; weight: number }>;
  objectiveScore: number;
  blueStrength: number;
  redStrength: number;
  blueLosses: number;
  redLosses: number;
  supplyLevel: number;
  lossExchange: number;
  events: number;
  decisionsTotal: number;
  decisionsFollowed: number;
  decisions: Array<{ title: string; chose: string; followedAi: boolean; simTimeH: number; rationale: string }>;
}

export interface RunReport {
  runId: string;
  runLabel: string;
  scenarioName: string;
  generatedAt: string;
  source: "anthropic" | "offline";
  simTimeH: number;
  branches: RunReportBranch[];
  sections: Array<{ heading: string; body: string }>;
}
export interface ReplayData {
  runId: string;
  branchId: string;
  snapshots: ReplaySnapshot[];
  events: SimEvent[];
  decisions: DecisionPoint[];
}

export type InterventionType = "inject-event" | "move-unit" | "set-weather" | "resupply" | "withdraw-unit";

export interface InterventionRequest {
  type: InterventionType;
  params: Record<string, string | number>;
  requestedBy: string;
}

// ---------------------------------------------------------------------------
// Assessment & replay (L3 app 5)
// ---------------------------------------------------------------------------

export interface AssessmentDimension {
  name: string; // e.g. "Mission accomplishment"
  score: number; // 0..100
  weight: number;
  detail: string;
}

export interface Assessment {
  id: string;
  runId: string;
  branchId: string;
  branchName: string;
  coaName: string;
  overallScore: number;
  verdict: "decisive-success" | "success" | "marginal" | "failure";
  dimensions: AssessmentDimension[];
  objectiveResults: Array<{ objectiveId: string; title: string; achieved: boolean; completion: number }>;
  lossExchangeRatio: number; // red losses / blue losses
  decisionStats: { total: number; followedAi: number; overridden: number };
  aiCommentary: string;
  recommendations: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Platform foundation (L1)
// ---------------------------------------------------------------------------

export interface EngineInfo {
  id: string;
  name: string;
  kind: "realtime" | "turn-based" | "cgf" | "ai-runtime";
  status: "online" | "degraded" | "offline";
  loadPct: number;
  activeRuns: number;
  capabilities: string[];
  version: string;
}

export interface DataDomainInfo {
  id: string;
  name: string; // "Base data" | "Runtime data" | "Scenario data" | "Deduction process" | "Assessment data"
  store: "graph" | "timeseries" | "document" | "relational" | "object";
  records: number;
  sizeGB: number;
  health: "healthy" | "syncing" | "degraded";
  description: string;
}

export interface PlatformInfo {
  engines: EngineInfo[];
  dataDomains: DataDomainInfo[];
  lowCode: { maps: number; pieces: number; rules: number; scenarios: number };
  apiStats: { observationCalls: number; pieceDriveCalls: number; avgLatencyMs: number };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  role: string;
  org: string;
  lastActive: string;
  permissions: string[]; // page ids
  status: "active" | "suspended";
}

export interface AuditLogEntry {
  id: string;
  at: string;
  user: string;
  action: string;
  target: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------

export interface AskResult {
  answer: string | null;
  source: string; // "openai" | "offline"
  reason?: string;
  model?: string;
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Bootstrap payload
// ---------------------------------------------------------------------------

export interface Bootstrap {
  scenarios: Scenario[];
  theater: TheaterFeature[];
  missions: Mission[];
  coas: Coa[];
  ruleSets: RuleSet[];
  agents: AgentDef[];
  runs: RunSummary[];
  platform: PlatformInfo;
  users: User[];
}

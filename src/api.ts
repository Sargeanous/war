// Thin typed client for the SANDTABLE backend. In dev, Vite proxies /api -> :5189.
// Reads throw ApiError on failure; callers surface the message via notify().

import type {
  AgentActivity,
  AgentDef,
  AskResult,
  Assessment,
  Bootstrap,
  Coa,
  CollectionOptionsResult,
  CollectionTaskResult,
  CueMutationResult,
  CueScenarioResult,
  EngineKind,
  IdentifyResult,
  IntelCue,
  IntelSyncResult,
  InterrogateResult,
  InterventionRequest,
  Mission,
  Ontology,
  OpordParse,
  CoaGenerationResult,
  ExplainResult,
  RunReport,
  CommandSeat,
  AdversaryPlanSummary,
  GovernancePolicy,
  HandoffAutonomy,
  ClassificationState,
  ClassificationLevelId,
  OrdersResult,
  FragoResult,
  RequirementsBoard,
  CueRequirements,
  ExplainTopic,
  CoaStrategy,
  OntologyClass,
  PlatformInfo,
  ReplayData,
  RuleSet,
  RuleTestResult,
  RunSummary,
  Scenario,
  SimRun,
  User,
  AuditLogEntry,
  ValidationReport,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!r.ok) {
    let message = `Request failed (${r.status})`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(r.status, message);
  }
  return (await r.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });

// --- Bootstrap -------------------------------------------------------------

// Scenario Design opens whichever scenario the bootstrap payload reports as
// ready first, so a page that generates a scenario and then sends the operator
// there has no way to name the one it just made. This one-shot hand-off lets the
// sending page put its scenario at the front of that payload. It is set
// immediately before the navigation and cleared by the very next bootstrap read.
let handedOffScenarioId: string | null = null;

export function handOffScenario(id: string | null): void {
  handedOffScenarioId = id;
}

export const fetchBootstrap = async (): Promise<Bootstrap> => {
  const boot = await get<Bootstrap>("/api/bootstrap");
  const wanted = handedOffScenarioId;
  handedOffScenarioId = null;
  if (!wanted) return boot;
  const index = boot.scenarios.findIndex((scenario) => scenario.id === wanted);
  if (index <= 0) return boot;
  const picked = boot.scenarios[index];
  return {
    ...boot,
    scenarios: [picked, ...boot.scenarios.slice(0, index), ...boot.scenarios.slice(index + 1)],
  };
};

// --- Intel bridge ------------------------------------------------------------

export const fetchIntelCues = () => get<IntelCue[]>("/api/intel/cues");
export const fetchIntelCue = (id: string) => get<IntelCue>(`/api/intel/cues/${id}`);
export const interrogateCue = (id: string, question: string, askedBy?: string) =>
  post<InterrogateResult>(`/api/intel/cues/${id}/interrogate`, { question, askedBy });
export const identifyCue = (id: string, identifiedBy?: string) =>
  post<IdentifyResult>(`/api/intel/cues/${id}/identify`, identifiedBy ? { identifiedBy } : undefined);
export const fetchCollectionOptions = (id: string) =>
  post<CollectionOptionsResult>(`/api/intel/cues/${id}/collect/options`);
export const requestCollection = (id: string, optionIndex: number, requestedBy: string) =>
  post<CollectionTaskResult>(`/api/intel/cues/${id}/collect`, { optionIndex, requestedBy });
export const approveCollection = (id: string, taskId: string, approver: string) =>
  post<CollectionTaskResult>(`/api/intel/cues/${id}/collect/${taskId}/approve`, { approver });
// Landing the product is its own step: release and result are separate events
// with separate timestamps and separate hand-off records.
export const reportCollection = (id: string, taskId: string, by: string) =>
  post<CollectionTaskResult>(`/api/intel/cues/${id}/collect/${taskId}/report`, { by });
export const confirmCue = (id: string, by: string) => post<CueMutationResult>(`/api/intel/cues/${id}/confirm`, { by });
export const dismissCue = (id: string, by: string, reason: string) =>
  post<CueMutationResult>(`/api/intel/cues/${id}/dismiss`, { by, reason });
export const spawnScenarioFromCue = (id: string, createdBy: string) =>
  post<CueScenarioResult>(`/api/intel/cues/${id}/scenario`, { createdBy });
export const syncIntelFeed = () => post<IntelSyncResult>("/api/intel/feed/sync");
// The commander's standing questions, and what has answered them so far.
export const fetchRequirements = () => get<RequirementsBoard>("/api/intel/requirements");
export const fetchCueRequirements = (id: string) => get<CueRequirements>(`/api/intel/cues/${id}/requirements`);

// --- Scenarios ---------------------------------------------------------------

export const fetchScenarios = () => get<Scenario[]>("/api/scenarios");
export const fetchScenario = (id: string) => get<Scenario>(`/api/scenarios/${id}`);
export const createScenario = (payload: { name: string; codename?: string; description?: string; template?: string }) =>
  post<Scenario>("/api/scenarios", payload);
export const updateScenario = (id: string, payload: Partial<Scenario>) => put<Scenario>(`/api/scenarios/${id}`, payload);
export const validateScenario = (id: string) => post<ValidationReport>(`/api/scenarios/${id}/validate`);
export const parseOpord = (text: string) => post<OpordParse>("/api/opord/parse", { text });
export const createScenarioFromOpord = (payload: { parse: OpordParse; name?: string; codename?: string; durationHours?: number; createdBy?: string }) =>
  post<Scenario>("/api/scenarios/from-opord", payload);

// --- Missions + decomposition ------------------------------------------------

export const fetchMissions = (scenarioId?: string) =>
  get<Mission[]>(`/api/missions${scenarioId ? `?scenarioId=${encodeURIComponent(scenarioId)}` : ""}`);
export const createMission = (payload: { scenarioId: string; side: string; title: string; intent: string; endState: string }) =>
  post<Mission>("/api/missions", payload);
export const decomposeMission = (id: string) => post<Mission>(`/api/missions/${id}/decompose`);
export const updateMission = (id: string, payload: Partial<Mission>) => put<Mission>(`/api/missions/${id}`, payload);

// --- COAs --------------------------------------------------------------------

export const fetchCoas = (scenarioId?: string) =>
  get<Coa[]>(`/api/coas${scenarioId ? `?scenarioId=${encodeURIComponent(scenarioId)}` : ""}`);
export const generateCoas = (payload: { scenarioId: string; missionId: string; count: number; strategy?: CoaStrategy }) =>
  post<CoaGenerationResult>("/api/coas/generate", payload);
export const updateSeat = (runId: string, seatId: string, payload: { mode?: "human" | "ai"; agentId?: string; participant?: string }) =>
  put<SimRun>(`/api/runs/${runId}/seats/${seatId}`, payload);
export const generateReport = (runId: string) => post<RunReport>(`/api/runs/${runId}/report`);
export const resumeFromBreakpoint = (runId: string, branchId: string, tick: number, speed?: number) =>
  post<SimRun>(`/api/runs/${runId}/branches/${branchId}/resume`, { tick, speed });
export const explainBranch = (runId: string, branchId: string, topic: ExplainTopic) =>
  post<ExplainResult>(`/api/runs/${runId}/branches/${branchId}/explain`, { topic });
export const silentEvalCoa = (id: string) => post<Coa>(`/api/coas/${id}/silent-eval`);
export const updateCoa = (id: string, payload: Partial<Coa>) => put<Coa>(`/api/coas/${id}`, payload);

// --- Rule sets -----------------------------------------------------------------

export const fetchRuleSets = () => get<RuleSet[]>("/api/rulesets");
export const createRuleSet = (payload: { name: string; description: string; domainFocus: string; author: string }) =>
  post<RuleSet>("/api/rulesets", payload);
export const updateRuleSet = (id: string, payload: Partial<RuleSet>) => put<RuleSet>(`/api/rulesets/${id}`, payload);
export const testRuleSet = (id: string, situation: string) =>
  post<RuleTestResult>(`/api/rulesets/${id}/test`, { situation });

// --- Runs (deduction) ----------------------------------------------------------

export const fetchRuns = () => get<RunSummary[]>("/api/runs");
export const fetchRun = (id: string) => get<SimRun>(`/api/runs/${id}`);
export const startRun = (payload: {
  scenarioId: string;
  coaIds: string[];
  ruleSetId: string;
  engine: EngineKind;
  speed?: number;
  label?: string;
  redPlanId?: string;
}) => post<SimRun>("/api/runs", payload);

// --- Adversary plan ------------------------------------------------------------

export const fetchAdversaryPlans = () => get<AdversaryPlanSummary[]>("/api/adversary/plans");

// --- Autonomy policy -----------------------------------------------------------

export const fetchGovernance = () => get<GovernancePolicy>("/api/governance/policy");

// --- Classification and staff products -------------------------------------------

export const fetchClassification = () => get<ClassificationState>("/api/classification");
export const setClassification = (payload: {
  level: ClassificationLevelId;
  caveats?: string[];
  releasableTo?: string;
  changedBy: string;
}) => put<ClassificationState>("/api/classification", payload);
export const fetchCoaOrders = (coaId: string, issuedBy?: string) =>
  get<OrdersResult>(`/api/coas/${coaId}/orders${issuedBy ? `?issuedBy=${encodeURIComponent(issuedBy)}` : ""}`);
export const fetchRunFragos = (runId: string) => get<FragoResult>(`/api/runs/${runId}/fragos`);
export const setGovernanceAutonomy = (actionId: string, autonomy: HandoffAutonomy, changedBy: string) =>
  put<GovernancePolicy>("/api/governance/policy", { actionId, autonomy, changedBy });
export const revealAdversaryPlan = (runId: string, revealedBy: string) =>
  post<SimRun>(`/api/runs/${runId}/adversary/reveal`, { revealedBy });
export const controlRun = (id: string, action: "pause" | "resume" | "speed" | "abort" | "step", value?: number) =>
  post<SimRun>(`/api/runs/${id}/control`, { action, value });
export const decideBranch = (
  runId: string,
  branchId: string,
  payload: { decisionId: string; optionId: string; rationale: string; decidedBy: string }
) => post<SimRun>(`/api/runs/${runId}/branches/${branchId}/decide`, payload);
export const intervene = (runId: string, branchId: string, payload: InterventionRequest) =>
  post<SimRun>(`/api/runs/${runId}/branches/${branchId}/intervene`, payload);

// --- Assessment & replay ---------------------------------------------------------

export const fetchAssessments = (runId?: string) =>
  get<Assessment[]>(`/api/assessments${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
export const assessRun = (runId: string) => post<Assessment[]>(`/api/runs/${runId}/assess`);
export const fetchReplay = (runId: string, branchId: string) =>
  get<ReplayData>(`/api/runs/${runId}/replay/${branchId}`);

// --- Ontology, agents, platform ---------------------------------------------------

export const fetchOntology = () => get<Ontology>("/api/ontology");
export const createPieceType = (payload: {
  label: string;
  domain: string;
  description?: string;
  speedKts?: number;
  supply?: number;
  sensors?: Array<{ type: string; rangeKm: number }>;
  weapons?: Array<{ type: string; rangeKm: number; pk: number; ammo: number }>;
}) => post<OntologyClass>("/api/ontology/classes", payload);
export const fetchAgents = () => get<AgentDef[]>("/api/agents");
export const fetchAgentActivity = (runId?: string) =>
  get<AgentActivity[]>(`/api/agent-activity${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
export const fetchPlatform = () => get<PlatformInfo>("/api/platform");

// --- Admin -------------------------------------------------------------------------

export const fetchUsers = () => get<User[]>("/api/users");
export const updateUser = (id: string, payload: Partial<User>) => put<User>(`/api/users/${id}`, payload);
export const fetchAudit = () => get<AuditLogEntry[]>("/api/audit");
export const appendAudit = (payload: { user: string; action: string; target: string; detail: string }) =>
  post<AuditLogEntry>("/api/audit", payload);
// Wipes state.json, reseeds demo data and re-runs the historical rehearsal.
export const resetDemoData = () => post<{ ok: boolean; scenarios: number; runs: number }>("/api/admin/reset");

// --- Copilot -------------------------------------------------------------------------

export async function askCopilot(question: string, context?: string): Promise<AskResult> {
  try {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, context }),
    });
    if (!r.ok) return { answer: null, source: "offline", reason: `http_${r.status}` };
    return (await r.json()) as AskResult;
  } catch {
    return { answer: null, source: "offline", reason: "network" };
  }
}

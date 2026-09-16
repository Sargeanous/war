// CoaGeneration - mission decomposition, COA candidate
// generation and comparison for Exercise AZURE HORIZON. Data flows only
// through src/api.ts; layout uses the shared DOOH primitives.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Check,
  Compass,
  Database,
  GitCompare,
  ListChecks,
  Network,
  Plus,
  Route,
  Target,
  X,
  FlaskConical,
} from "lucide-react";
import type { PageProps } from "../shell";
import type {
  AgentDef,
  Coa,
  CoaScores,
  DataDomainInfo,
  Domain,
  Mission,
  PlatformInfo,
  RunSummary,
  Scenario,
  SubTask,
  CoaAnalysisStep,
  CoaStrategy,
} from "../types";
import {
  createMission,
  decomposeMission,
  fetchAgents,
  fetchCoas,
  fetchMissions,
  fetchPlatform,
  fetchRuns,
  fetchScenarios,
  generateCoas,
  silentEvalCoa,
  updateCoa,
} from "../api";
import {
  ActionRow,
  BarRow,
  Button,
  CompactTable,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  PageBody,
  Panel,
  Segmented,
  StatusPill,
  SvgRadar,
  Tag,
  TimelineBar,
  simClock,
  timeAgo,
} from "../components";
import { domainLabels, driveModeLabels, sideLabels, statusTone } from "../data";
import "./coageneration.css";

type CandidateCount = "2" | "3" | "4";

interface NextPlanningAction {
  status: string;
  title: string;
  detail: string;
  owner: string;
  due: string;
  action: string;
  disabled?: boolean;
  run: () => void;
}

const domainColors: Record<Domain, string> = {
  land: "#a16207",
  sea: "#1f5f99",
  air: "#0e7490",
  cyber: "#7c3aed",
  space: "#64748b",
};

const healthColors: Record<DataDomainInfo["health"], string> = {
  healthy: "var(--primary)",
  syncing: "var(--amber)",
  degraded: "var(--red)",
};

const RADAR_AXES = ["Feasibility", "Acceptability", "Safety", "Cost efficiency", "Effect"];
const ACTIVE_RUN_STATUSES = new Set<RunSummary["status"]>([
  "initializing",
  "running",
  "paused",
  "awaiting-decision",
]);

const clamp01to100 = (v: number) => Math.max(0, Math.min(100, v));

// Risk and resource cost are "lower is better"; invert them so every radar
// axis reads outward-is-good.
function radarValues(scores: CoaScores): number[] {
  return [
    clamp01to100(scores.feasibility),
    clamp01to100(scores.acceptability),
    clamp01to100(100 - scores.risk),
    clamp01to100(100 - scores.resourceCost),
    clamp01to100(scores.expectedEffect),
  ];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error";
}

export default function CoaGeneration(props: PageProps) {
  const { notify, goTo } = props;
  const alive = useRef(true);

  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [coas, setCoas] = useState<Coa[]>([]);
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [count, setCount] = useState<CandidateCount>("3");
  const [decomposing, setDecomposing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [strategy, setStrategy] = useState<CoaStrategy>("balanced");
  const [analysis, setAnalysis] = useState<CoaAnalysisStep[]>([]);
  const [analysisShown, setAnalysisShown] = useState(0);
  const [evalBusyId, setEvalBusyId] = useState<string | null>(null);
  const [creatingMission, setCreatingMission] = useState(false);
  const [busyCoaId, setBusyCoaId] = useState<string | null>(null);
  const [missionTitle, setMissionTitle] = useState("");
  const [missionIntent, setMissionIntent] = useState("");
  const [missionEndState, setMissionEndState] = useState("");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Bootstrap: scenarios, agent library and platform data domains.
  useEffect(() => {
    let live = true;
    Promise.all([fetchScenarios(), fetchAgents(), fetchPlatform(), fetchRuns()])
      .then(([scenarioList, agentList, platformInfo, runList]) => {
        if (!live) return;
        setScenarios(scenarioList);
        setAgents(agentList);
        setPlatform(platformInfo);
        setRuns(runList);
        const preferred = scenarioList.find((s) => s.status === "ready") ?? scenarioList[0];
        if (preferred) setScenarioId(preferred.id);
      })
      .catch((e) => {
        if (!live) return;
        setScenarios([]);
        notify(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [notify]);

  // Per-scenario planning data.
  useEffect(() => {
    if (!scenarioId) return;
    let live = true;
    setScenarioLoading(true);
    setMissions([]);
    setCoas([]);
    Promise.all([fetchMissions(scenarioId), fetchCoas(scenarioId)])
      .then(([missionList, coaList]) => {
        if (!live) return;
        setMissions(missionList);
        setCoas(coaList);
      })
      .catch((e) => {
        if (live) notify(errorMessage(e));
      })
      .finally(() => {
        if (live) setScenarioLoading(false);
      });
    return () => {
      live = false;
    };
  }, [scenarioId, notify]);

  const scenario = useMemo(
    () => scenarios?.find((s) => s.id === scenarioId) ?? null,
    [scenarios, scenarioId]
  );
  const mission = useMemo(
    () => missions.find((m) => m.side === "blue") ?? missions[0] ?? null,
    [missions]
  );
  const agentById = useMemo(
    () => new Map<string, AgentDef>(agents.map((a) => [a.id, a])),
    [agents]
  );
  const comparable = useMemo(() => coas.filter((c) => c.status !== "rejected"), [coas]);
  const selectedCoas = useMemo(() => coas.filter((c) => c.status === "selected"), [coas]);
  const activeRun = useMemo(
    () =>
      [...runs]
        .filter((run) => run.scenarioId === scenarioId && ACTIVE_RUN_STATUSES.has(run.status))
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null,
    [runs, scenarioId]
  );
  const planningLocked = Boolean(activeRun);

  const subTasks = mission?.subTasks ?? [];
  const subTaskTotalH = Math.max(1, ...subTasks.map((t) => t.endH), scenario?.durationHours ?? 0);
  const taskShortLabel = new Map<string, string>(subTasks.map((t, i) => [t.id, `T${i + 1}`]));
  const missionDomains = Array.from(new Set(subTasks.map((t) => t.domain)));
  const maxDomainRecords = platform
    ? Math.max(1, ...platform.dataDomains.map((d) => d.records))
    : 1;

  function handleScenarioChange(id: string) {
    setScenarioId(id);
    const picked = scenarios?.find((s) => s.id === id);
    notify(`Scenario "${picked?.name ?? id}" loaded for COA planning`);
  }

  function handleCountChange(value: CandidateCount) {
    setCount(value);
    notify(`COA candidate count set to ${value}`);
  }

  async function handleCreateMission(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!scenarioId) return;
    if (activeRun) {
      notify(`Planning package is locked while "${activeRun.label}" is ${activeRun.status}`);
      return;
    }
    const title = missionTitle.trim();
    const intent = missionIntent.trim();
    const endState = missionEndState.trim();
    if (!title || !intent || !endState) {
      notify("Provide a mission title, commander's intent and end state before filing");
      return;
    }
    setCreatingMission(true);
    try {
      const created = await createMission({ scenarioId, side: "blue", title, intent, endState });
      if (!alive.current) return;
      setMissions((prev) => [...prev, created]);
      setMissionTitle("");
      setMissionIntent("");
      setMissionEndState("");
      notify(`Mission "${created.title}" filed for BLUE, ready for strategic decomposition`);
    } catch (e2) {
      notify(errorMessage(e2));
    } finally {
      if (alive.current) setCreatingMission(false);
    }
  }

  async function handleDecompose() {
    if (!mission) return;
    if (activeRun) {
      notify(`Mission decomposition is locked while "${activeRun.label}" is ${activeRun.status}`);
      return;
    }
    setDecomposing(true);
    try {
      const updated = await decomposeMission(mission.id);
      if (!alive.current) return;
      setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      const domains = new Set(updated.subTasks.map((t) => t.domain)).size;
      notify(
        `Mission decomposed into ${updated.subTasks.length} sub-tasks across ${domains} domain${
          domains === 1 ? "" : "s"
        }, assigned to mission agents`
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (alive.current) setDecomposing(false);
    }
  }

  async function handleGenerate() {
    if (!mission || !scenarioId) return;
    if (activeRun) {
      notify(`COA generation is locked while "${activeRun.label}" is ${activeRun.status}`);
      return;
    }
    setGenerating(true);
    try {
      const result = await generateCoas({
        scenarioId,
        missionId: mission.id,
        count: Number(count),
        strategy,
      });
      const all = await fetchCoas(scenarioId);
      if (!alive.current) return;
      setCoas(all);
      setAnalysis(result.analysis);
      setAnalysisShown(0);
      result.analysis.forEach((_, i) =>
        window.setTimeout(() => {
          if (alive.current) setAnalysisShown((n) => Math.max(n, i + 1));
        }, 420 * (i + 1))
      );
      const rec = result.coas.find((c) => c.grade === "recommended");
      notify(
        `${result.coas.length} candidate COA${result.coas.length === 1 ? "" : "s"} generated under "${strategy}", ${rec ? `"${rec.name}" recommended` : "review the grades below"}`
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (alive.current) setGenerating(false);
    }
  }

  async function handleSilentEval(coa: Coa) {
    if (evalBusyId) return;
    if (activeRun) {
      notify(`Silent deduction is locked because "${activeRun.label}" has released this package to execution`);
      return;
    }
    setEvalBusyId(coa.id);
    try {
      const updated = await silentEvalCoa(coa.id);
      if (!alive.current) return;
      setCoas((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      notify(
        `Silent deduction of "${updated.name}": objectives ${updated.silentEval?.projected.objectiveScore}%, BLUE ${updated.silentEval?.projected.blueStrength}% vs RED ${updated.silentEval?.projected.redStrength}%`
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (alive.current) setEvalBusyId(null);
    }
  }

  async function handleCoaStatus(coa: Coa, status: "selected" | "rejected") {
    if (activeRun) {
      notify(`COA selection is locked because "${activeRun.label}" has released this package to execution`);
      return;
    }
    setBusyCoaId(coa.id);
    try {
      const updated = await updateCoa(coa.id, { status });
      if (!alive.current) return;
      setCoas((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      notify(
        status === "selected"
          ? `COA "${updated.name}" selected, available to Full-Process Deduction`
          : `COA "${updated.name}" rejected and removed from the comparison set`
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      if (alive.current) setBusyCoaId(null);
    }
  }

  function renderAgentCell(task: SubTask) {
    if (!task.assignedAgentId) {
      return <span className="coa-agent-cell">Unassigned</span>;
    }
    const agent = agentById.get(task.assignedAgentId);
    if (!agent) {
      return <span className="coa-agent-cell">{task.assignedAgentId}</span>;
    }
    return (
      <span className="coa-agent-cell">
        <span>{agent.name}</span>
        <Tag label={driveModeLabels[agent.driveMode]} />
      </span>
    );
  }

  function scrollToWorkspace(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const nextAction: NextPlanningAction = scenarioLoading
    ? {
        status: "SYNCHRONIZING",
        title: "Hold while the planning package is loaded",
        detail: "Mission, task and COA records are being reconciled against the selected scenario.",
        owner: "Platform services",
        due: "In progress",
        action: "Loading",
        disabled: true,
        run: () => undefined,
      }
    : activeRun
      ? {
          status: "RELEASED TO EXECUTION",
          title: `${activeRun.label} is ${activeRun.status.replace(/-/g, " ")}`,
          detail: `This planning package is locked at ${simClock(activeRun.simTimeH)} across ${activeRun.branchCount} branch${activeRun.branchCount === 1 ? "" : "es"}. Continue through the issued orders and command decision record.`,
          owner: "Simulation Control",
          due: activeRun.status === "awaiting-decision" ? "Decision required now" : "In execution",
          action: "Open decision record",
          run: () => {
            notify(`Opening the decision record for "${activeRun.label}"`);
            goTo("orders");
          },
        }
      : !mission
      ? {
          status: "ACTION REQUIRED",
          title: "File the commander's mission and desired end state",
          detail: "COA development is blocked until a mission is owned and filed against this scenario.",
          owner: "Plans Cell (J5)",
          due: "Before decomposition",
          action: "File mission",
          run: () => scrollToWorkspace("coa-mission-workspace"),
        }
      : subTasks.length === 0
        ? {
            status: "ACTION REQUIRED",
            title: "Decompose the mission into assigned sub-tasks",
            detail: "The mission is filed, but domains, dependencies and mission-agent assignments are not yet established.",
            owner: "Plans Cell (J5)",
            due: "Before COA generation",
            action: "Decompose mission",
            disabled: decomposing,
            run: () => void handleDecompose(),
          }
        : coas.length === 0
          ? {
              status: "READY",
              title: "Generate candidate courses of action",
              detail: `${subTasks.length} assigned sub-tasks are ready for candidate development and comparative scoring.`,
              owner: "Plans Cell (J5)",
              due: "Next planning action",
              action: "Generate COAs",
              disabled: generating,
              run: () => void handleGenerate(),
            }
          : selectedCoas.length === 0
            ? {
                status: "DECISION REQUIRED",
                title: "Select a COA for the execution package",
                detail: `${coas.filter((coa) => coa.status !== "rejected").length} viable candidates remain; compare risk, effect and silent-deduction evidence before selection.`,
                owner: "Plans Cell (J5)",
                due: "Before run authorization",
                action: "Review candidates",
                run: () => scrollToWorkspace("coa-candidate-workspace"),
              }
            : {
                status: "HANDOFF READY",
                title: "Confirm adjudication rules for the selected COA package",
                detail: `${selectedCoas.map((coa) => coa.name).join(", ")} ${selectedCoas.length === 1 ? "is" : "are"} selected and ready for controlled execution preparation.`,
                owner: "Exercise Control",
                due: "Before run authorization",
                action: "Open adjudication rules",
                run: () => {
                  notify("Opening adjudication rules for the selected COA package");
                  goTo("rules");
                },
              };

  const planningStages = [
    { label: "Scenario validated", complete: planningLocked || Boolean(scenario && scenario.status !== "draft") },
    { label: "Mission filed", complete: planningLocked || Boolean(mission) },
    { label: "Tasks assigned", complete: planningLocked || subTasks.length > 0 },
    {
      label: planningLocked ? "Released to execution" : "COA selected",
      complete: planningLocked || selectedCoas.length > 0,
    },
  ];
  const firstIncompleteStage = planningStages.findIndex((stage) => !stage.complete);
  const currentPlanningStage = firstIncompleteStage === -1 ? planningStages.length - 1 : firstIncompleteStage;

  if (scenarios === null) {
    return (
      <PageBody>
        <EmptyState
          icon={Compass}
          title="Contacting planning core"
          hint="Loading scenarios, the tactical agent library and unified data domains for COA generation…"
        />
      </PageBody>
    );
  }

  if (scenarios.length === 0) {
    return (
      <PageBody>
        <EmptyState
          icon={Compass}
          title="No scenarios on file"
          hint="COA generation starts from a designed scenario. Build one in Scenario Design first."
        />
        <ActionRow>
          <Button
            icon={Target}
            onClick={() => {
              notify("Opening Scenario Design");
              goTo("scenario");
            }}
          >
            Open Scenario Design
          </Button>
        </ActionRow>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <div className="coa-toolbar">
        <div className="coa-scenario-pick">
          <Field label="Exercise scenario">
            <select value={scenarioId} onChange={(e) => handleScenarioChange(e.target.value)}>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}, {s.codename}
                  {s.status === "ready" ? "" : ` (${s.status})`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {scenario ? (
          <div className="coa-toolbar-meta">
            <StatusPill label={scenario.status} tone={statusTone(scenario.status)} />
            <span>{scenario.theater}</span>
            <span>{scenario.durationHours}h planning horizon</span>
            <span>
              {scenario.units.length} units | {scenario.objectives.length} objectives
            </span>
            <span>updated {timeAgo(scenario.updatedAt)}</span>
          </div>
        ) : null}
      </div>

      {scenario ? (
        <section className="coa-package-control" aria-label="Planning package control">
          <div className="coa-package-head">
            <div>
              <span>PLANNING PACKAGE CONTROL</span>
              <strong>{scenario.name}</strong>
            </div>
            <div className="coa-package-facts">
              <span>
                Owner <strong>{scenario.createdBy || "Plans Cell (J5)"}</strong>
              </span>
              <span>
                Mission <strong>{mission?.status ?? "not filed"}</strong>
              </span>
              <span>
                COA package{" "}
                <strong>
                  {activeRun
                    ? "released to execution"
                    : selectedCoas.length > 0
                      ? "selected"
                      : coas.length > 0
                        ? "in review"
                        : "not started"}
                </strong>
              </span>
            </div>
          </div>
          <div className="coa-lifecycle">
            {planningStages.map((stage, index) => (
              <span
                key={stage.label}
                className={`${stage.complete ? "is-complete" : ""}${index === currentPlanningStage ? " is-current" : ""}`}
                aria-current={index === currentPlanningStage ? "step" : undefined}
              >
                <i />
                {stage.label}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="coa-next-action" aria-label="Next planning action">
        <div className="coa-next-copy">
          <span>{nextAction.status}</span>
          <strong>{nextAction.title}</strong>
          <p>{nextAction.detail}</p>
        </div>
        <dl>
          <div>
            <dt>Owner</dt>
            <dd>{nextAction.owner}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{nextAction.due}</dd>
          </div>
        </dl>
        <Button onClick={nextAction.run} disabled={nextAction.disabled}>
          {nextAction.action}
        </Button>
      </section>

      {activeRun ? (
        <section className="coa-execution-lock" aria-label="Released planning package">
          <div>
            <strong>PLANNING PACKAGE RELEASED</strong>
            <span>
              {activeRun.label} is {activeRun.status.replace(/-/g, " ")}. Mission decomposition, generation,
              evaluation and COA disposition are locked to protect the execution baseline.
            </span>
          </div>
          <span className="coa-execution-lock-meta">
            {activeRun.id} | {simClock(activeRun.simTimeH)} | {activeRun.branchCount} branch
            {activeRun.branchCount === 1 ? "" : "es"}
          </span>
        </section>
      ) : null}

      <div id="coa-mission-workspace" className="coa-workspace-anchor">
        <Panel
          title="Mission & decomposition"
          action={
            mission ? (
              <Button
                icon={Network}
                variant="secondary"
                onClick={handleDecompose}
                disabled={decomposing || scenarioLoading || planningLocked}
                title={activeRun ? `Locked while ${activeRun.label} is ${activeRun.status}` : undefined}
              >
                {planningLocked
                  ? "Decomposition locked"
                  : decomposing
                  ? "Decomposing…"
                  : subTasks.length > 0
                    ? "Re-run decomposition"
                    : "Decompose mission"}
              </Button>
            ) : undefined
          }
        >
        {scenarioLoading ? (
          <EmptyState
            icon={Compass}
            title="Loading mission data"
            hint="Fetching the operational mission and existing COAs for this scenario…"
          />
        ) : mission ? (
          <div className="coa-stack">
            <div className="coa-mission-head">
              <div className="coa-mission-title">
                <strong>{mission.title}</strong>
                <small>
                  Owner: Plans Cell (J5) | {sideLabels[mission.side]} | {mission.id} | updated {timeAgo(mission.updatedAt)}
                </small>
              </div>
              <StatusPill label={mission.status} tone={statusTone(mission.status)} />
            </div>
            <DetailGrid>
              <Detail label="Commander's intent" value={mission.intent} />
              <Detail label="Desired end state" value={mission.endState} />
            </DetailGrid>
            {subTasks.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="Mission not decomposed yet"
                hint="Run strategic task decomposition to break the mission into domain sub-tasks and assign hybrid-driven mission agents."
              />
            ) : (
              <>
                <TimelineBar
                  totalH={subTaskTotalH}
                  items={subTasks.map((t, i) => ({
                    id: t.id,
                    label: `T${i + 1} - ${t.title}`,
                    startH: t.startH,
                    endH: t.endH,
                    color: domainColors[t.domain],
                    meta: domainLabels[t.domain],
                  }))}
                />
                <div className="legend">
                  {missionDomains.map((d) => (
                    <span key={d}>
                      <i style={{ background: domainColors[d] }} />
                      {domainLabels[d]}
                    </span>
                  ))}
                </div>
                <CompactTable
                  columns={["Task", "Domain", "Window", "Assigned agent", "Depends on", "Status"]}
                  rows={subTasks.map((t, i) => [
                    `T${i + 1} - ${t.title}`,
                    <Tag key="domain" label={domainLabels[t.domain]} color={domainColors[t.domain]} />,
                    `H+${t.startH}-${t.endH}`,
                    renderAgentCell(t),
                    t.dependsOn.length > 0
                      ? t.dependsOn.map((id) => taskShortLabel.get(id) ?? id).join(", ")
                      : "-",
                    <StatusPill key="status" label={t.status} tone={statusTone(t.status)} />,
                  ])}
                />
              </>
            )}
          </div>
        ) : (
          <form className="coa-form" onSubmit={handleCreateMission}>
            <p className="coa-blurb">
              No BLUE mission is filed for this scenario. Draft the operational mission below;
              strategic decomposition will then break it into sub-tasks and assign mission agents.
            </p>
            <Field label="Mission title">
              <input
                value={missionTitle}
                disabled={planningLocked}
                onChange={(e) => setMissionTitle(e.target.value)}
                placeholder="e.g. Secure the Meridian central strait"
              />
            </Field>
            <Field label="Commander's intent">
              <textarea
                value={missionIntent}
                disabled={planningLocked}
                onChange={(e) => setMissionIntent(e.target.value)}
                placeholder="Purpose, key tasks and acceptable risk for the coalition task force…"
              />
            </Field>
            <Field label="Desired end state">
              <textarea
                value={missionEndState}
                disabled={planningLocked}
                onChange={(e) => setMissionEndState(e.target.value)}
                placeholder="Conditions that must hold when the operation concludes…"
              />
            </Field>
            <ActionRow>
              <Button
                icon={Plus}
                type="submit"
                disabled={creatingMission || planningLocked}
                title={activeRun ? `Locked while ${activeRun.label} is ${activeRun.status}` : undefined}
              >
                {planningLocked ? "Mission filing locked" : creatingMission ? "Filing mission…" : "Create BLUE mission"}
              </Button>
            </ActionRow>
          </form>
        )}
        </Panel>
      </div>

      <div id="coa-candidate-workspace" className="coa-workspace-anchor">
        <Panel
          title="COA candidates"
          action={
            <ActionRow>
            <Segmented
              value={strategy}
              onChange={(v) => setStrategy(v as CoaStrategy)}
              items={[
                { id: "results-first", label: "Results" },
                { id: "loss-control", label: "Loss control" },
                { id: "speed-first", label: "Speed" },
                { id: "balanced", label: "Balanced" },
              ]}
            />
            <Segmented
              value={count}
              onChange={handleCountChange}
              items={[
                { id: "2", label: "2" },
                { id: "3", label: "3" },
                { id: "4", label: "4" },
              ]}
            />
            <Button
              onClick={handleGenerate}
              disabled={generating || scenarioLoading || !mission || planningLocked}
              title={
                activeRun
                  ? `Locked while ${activeRun.label} is ${activeRun.status}`
                  : mission
                    ? undefined
                    : "File a mission before generating COAs"
              }
            >
              {planningLocked ? "Generation locked" : generating ? "Generating…" : "Generate COAs"}
            </Button>
            </ActionRow>
          }
        >
        {analysis.length ? (
          <div className="coa-analysis">
            <p className="coa-analysis-head">SAGE planning analysis</p>
            {analysis.map((step, i) => (
              <div
                key={step.step}
                className={`coa-analysis-step${i < analysisShown ? " done" : i === analysisShown ? " running" : ""}`}
              >
                <span className="coa-analysis-mark">{i < analysisShown ? "✓" : i === analysisShown ? "…" : String(i + 1)}</span>
                <span className="coa-analysis-name">{step.step}</span>
                <span className="coa-analysis-detail">{i < analysisShown ? step.detail : ""}</span>
                <span className="coa-analysis-ms">{i < analysisShown ? `${step.ms.toFixed(1)}s` : ""}</span>
              </div>
            ))}
          </div>
        ) : null}
        {scenarioLoading ? (
          <EmptyState
            icon={Compass}
            title="Loading COA data"
            hint="Fetching existing candidates for this scenario…"
          />
        ) : coas.length === 0 ? (
          <EmptyState
            icon={Route}
            title="No COA candidates yet"
            hint={
              mission
                ? "Pick a candidate count and run generation, planner and agent branches are scored on feasibility, acceptability, risk, cost and effect."
                : "File and decompose the BLUE mission first, then generate candidate courses of action."
            }
          />
        ) : (
          <div className="coa-card-grid">
            {coas.map((coa) => {
              const phaseTotalH = Math.max(
                1,
                ...coa.phases.map((p) => p.endH),
                scenario?.durationHours ?? 0
              );
              const generatorAgent = coa.generatorAgentId
                ? agentById.get(coa.generatorAgentId)
                : undefined;
              return (
                <article key={coa.id} className="coa-card">
                  <div className="coa-card-head">
                    <span className="coa-card-dot" style={{ background: coa.color }} />
                    <strong>{coa.name}</strong>
                    {coa.grade ? (
                      <Tag
                        label={coa.grade}
                        color={coa.grade === "recommended" ? "var(--primary)" : coa.grade === "steady" ? "var(--blue)" : undefined}
                      />
                    ) : null}
                    <StatusPill label={coa.status} tone={statusTone(coa.status)} />
                  </div>
                  <div className="coa-card-sub">
                    <p className="coa-approach">{coa.approach}</p>
                    <span>Owner - Plans Cell (J5)</span>
                    <span>
                      Produced by - {coa.generatedBy === "agent"
                        ? generatorAgent?.name ?? "mission agent"
                        : "Staff planner"}
                    </span>
                    <span>Maturity - {coa.status}</span>
                    <span>Created {timeAgo(coa.createdAt)}</span>
                  </div>
                  <p className="coa-summary">{coa.summary}</p>
                  <TimelineBar
                    totalH={phaseTotalH}
                    items={coa.phases.map((p) => ({
                      id: p.id,
                      label: p.name,
                      startH: p.startH,
                      endH: p.endH,
                      color: coa.color,
                      meta: p.intent,
                    }))}
                  />
                  <div className="coa-eval">
                    <SvgRadar
                      size={200}
                      axes={RADAR_AXES}
                      series={[{ name: coa.name, color: coa.color, values: radarValues(coa.scores) }]}
                    />
                    <div className="coa-score">
                      <span>Composite</span>
                      <strong>{Math.round(coa.scores.composite)}</strong>
                      <small>of 100</small>
                    </div>
                  </div>
                  {coa.silentEval ? (
                    <div className="coa-projection">
                      <span>Silent deduction @ T+{coa.silentEval.projected.durationH}h</span>
                      <strong>
                        OBJ {coa.silentEval.projected.objectiveScore}% | BLUE {Math.round(coa.silentEval.projected.blueStrength)}% | RED{" "}
                        {Math.round(coa.silentEval.projected.redStrength)}% | net {coa.silentEval.projected.net >= 0 ? "+" : ""}
                        {coa.silentEval.projected.net}
                      </strong>
                    </div>
                  ) : null}
                  <ActionRow>
                    <Button
                      icon={Check}
                      onClick={() => handleCoaStatus(coa, "selected")}
                      disabled={planningLocked || busyCoaId === coa.id || coa.status === "selected"}
                      title={activeRun ? `Selection locked by active run ${activeRun.label}` : undefined}
                    >
                      {planningLocked && coa.status === "selected" ? "Released" : "Select"}
                    </Button>
                    <Button
                      icon={FlaskConical}
                      variant="secondary"
                      onClick={() => handleSilentEval(coa)}
                      disabled={planningLocked || evalBusyId === coa.id}
                      title={activeRun ? `Evaluation locked by active run ${activeRun.label}` : undefined}
                    >
                      {evalBusyId === coa.id ? "Deduction running…" : "Silent deduction"}
                    </Button>
                    <Button
                      icon={X}
                      variant="secondary"
                      onClick={() => handleCoaStatus(coa, "rejected")}
                      disabled={planningLocked || busyCoaId === coa.id || coa.status === "rejected"}
                      title={activeRun ? `Disposition locked by active run ${activeRun.label}` : undefined}
                    >
                      Reject
                    </Button>
                  </ActionRow>
                </article>
              );
            })}
          </div>
        )}
        </Panel>
      </div>

      <div className="split-grid wide-left">
        <Panel title="COA comparison">
          {comparable.length === 0 ? (
            <EmptyState
              icon={GitCompare}
              title="Nothing to compare"
              hint="Generate candidates, every non-rejected COA is overlaid here across the five evaluation axes."
            />
          ) : (
            <div className="coa-compare">
              <div>
                <SvgRadar
                  size={280}
                  axes={RADAR_AXES}
                  series={comparable.map((c) => ({
                    name: c.name,
                    color: c.color,
                    values: radarValues(c.scores),
                  }))}
                />
                <div className="coa-legend">
                  {comparable.map((c) => (
                    <span key={c.id} className="coa-legend-chip">
                      <i style={{ background: c.color }} />
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
              <CompactTable
                columns={[
                  "COA",
                  "Feasibility",
                  "Acceptability",
                  "Risk",
                  "Resource cost",
                  "Effect",
                  "Composite",
                  "Status",
                ]}
                // Six score columns hold two digits each; the name and the
                // status pill are the only cells that need real room.
                widths={["22%", "10%", "10%", "10%", "10%", "10%", "10%", "18%"]}
                rows={comparable.map((c) => [
                  <span key="name" className="coa-series-name">
                    <i style={{ background: c.color }} />
                    {c.name}
                  </span>,
                  Math.round(c.scores.feasibility),
                  Math.round(c.scores.acceptability),
                  Math.round(c.scores.risk),
                  Math.round(c.scores.resourceCost),
                  Math.round(c.scores.expectedEffect),
                  <strong key="composite">{Math.round(c.scores.composite)}</strong>,
                  <StatusPill key="status" label={c.status} tone={statusTone(c.status)} />,
                ])}
              />
            </div>
          )}
        </Panel>

        <Panel title="Data readiness">
          {platform ? (
            <div className="coa-stack">
              <div className="coa-bars">
                {platform.dataDomains.map((d) => (
                  <BarRow
                    key={d.id}
                    label={`${d.name} | ${d.store}`}
                    value={d.records / 1000}
                    max={maxDomainRecords / 1000}
                    suffix="k"
                    color={healthColors[d.health]}
                  />
                ))}
              </div>
              <p className="coa-blurb">
                COA generation reads base data (ontology, piece catalogues) and scenario data
                (order of battle, objectives, environment) through the unified data core; generated
                branches and their scores are written back to the deduction-process store for
                replay and assessment.
              </p>
            </div>
          ) : (
            <EmptyState
              icon={Database}
              title="Querying data foundation"
              hint="Reading data-domain record counts from the platform layer…"
            />
          )}
        </Panel>
      </div>
    </PageBody>
  );
}

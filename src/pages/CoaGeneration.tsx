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
  Sparkles,
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
  timeAgo,
} from "../components";
import { domainLabels, driveModeLabels, sideLabels, statusTone } from "../data";
import "./coageneration.css";

type CandidateCount = "2" | "3" | "4";

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
    Promise.all([fetchScenarios(), fetchAgents(), fetchPlatform()])
      .then(([scenarioList, agentList, platformInfo]) => {
        if (!live) return;
        setScenarios(scenarioList);
        setAgents(agentList);
        setPlatform(platformInfo);
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

      <Panel
        icon={Target}
        title="Mission & decomposition"
        action={
          mission ? (
            <Button
              icon={Network}
              variant="secondary"
              onClick={handleDecompose}
              disabled={decomposing || scenarioLoading}
            >
              {decomposing
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
                  {sideLabels[mission.side]} | updated {timeAgo(mission.updatedAt)}
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
                onChange={(e) => setMissionTitle(e.target.value)}
                placeholder="e.g. Secure the Meridian central strait"
              />
            </Field>
            <Field label="Commander's intent">
              <textarea
                value={missionIntent}
                onChange={(e) => setMissionIntent(e.target.value)}
                placeholder="Purpose, key tasks and acceptable risk for the coalition task force…"
              />
            </Field>
            <Field label="Desired end state">
              <textarea
                value={missionEndState}
                onChange={(e) => setMissionEndState(e.target.value)}
                placeholder="Conditions that must hold when the operation concludes…"
              />
            </Field>
            <ActionRow>
              <Button icon={Plus} type="submit" disabled={creatingMission}>
                {creatingMission ? "Filing mission…" : "Create BLUE mission"}
              </Button>
            </ActionRow>
          </form>
        )}
      </Panel>

      <Panel
        icon={Route}
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
              icon={Sparkles}
              onClick={handleGenerate}
              disabled={generating || scenarioLoading || !mission}
              title={mission ? undefined : "File a mission before generating COAs"}
            >
              {generating ? "Generating…" : "Generate COAs"}
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
                    <span>
                      {coa.generatedBy === "agent"
                        ? `Agent - ${generatorAgent?.name ?? "mission agent"}`
                        : "Staff planner"}
                    </span>
                    <span>{timeAgo(coa.createdAt)}</span>
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
                      disabled={busyCoaId === coa.id || coa.status === "selected"}
                    >
                      Select
                    </Button>
                    <Button
                      icon={FlaskConical}
                      variant="secondary"
                      onClick={() => handleSilentEval(coa)}
                      disabled={evalBusyId === coa.id}
                    >
                      {evalBusyId === coa.id ? "Deduction running…" : "Silent deduction"}
                    </Button>
                    <Button
                      icon={X}
                      variant="secondary"
                      onClick={() => handleCoaStatus(coa, "rejected")}
                      disabled={busyCoaId === coa.id || coa.status === "rejected"}
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

      <div className="split-grid wide-left">
        <Panel icon={GitCompare} title="COA comparison">
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

        <Panel icon={Database} title="Data readiness">
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

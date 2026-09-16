// CommandDashboard, the commander's landing view for Exercise AZURE HORIZON.
// Metrics row, live theater picture of the focus deduction run, per-branch
// telemetry and the recent-activity stream.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Layers,
  PlayCircle,
  Radar,
  RefreshCw,
} from "lucide-react";
import type { PageId, PageProps } from "../shell";
import type { Bootstrap, SimRun, Unit } from "../types";
import { fetchBootstrap, fetchRun } from "../api";
import {
  ActionRow,
  Button,
  EmptyState,
  Metric,
  MetricGrid,
  ObjectList,
  PageBody,
  Panel,
  ProgressBar,
  StatusPill,
  simClock,
  timeAgo,
} from "../components";
import { eventTones, sideColors, statusTone } from "../data";
import { affiliationOf, frameColor } from "../milsym";
import TheaterMap from "../map";
import "./commanddashboard.css";

const DEFAULT_CENTER = { lat: 23.85, lng: 61.1 };
const DEFAULT_ZOOM = 7;

const PAGE_LABELS: Partial<Record<PageId, string>> = {
  deduction: "Full-Process Deduction",
  assessment: "Assessment & Replay",
};

function isLiveStatus(status: string): boolean {
  return status === "running" || status === "awaiting-decision";
}

type WorkPriority = "critical" | "priority" | "monitor";

interface WorkItem {
  id: string;
  priority: WorkPriority;
  label: string;
  title: string;
  changed: string;
  risk: string;
  owner: string;
  due: string;
  target: PageId;
  action: string;
}

export default function CommandDashboard(props: PageProps) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [run, setRun] = useState<SimRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const notifyRef = useRef(props.notify);
  notifyRef.current = props.notify;

  // Bootstrap load (and reload on refresh/retry).
  useEffect(() => {
    let alive = true;
    fetchBootstrap()
      .then((payload) => {
        if (!alive) return;
        setBoot(payload);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : "Failed to load dashboard data";
        setError(message);
        notifyRef.current(message);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Focus run: first running/awaiting-decision summary, else latest completed.
  const focusSummary = useMemo(() => {
    if (!boot) return null;
    const live = boot.runs.find((r) => isLiveStatus(r.status));
    if (live) return live;
    const completed = boot.runs
      .filter((r) => r.status === "completed")
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.startedAt).getTime() - new Date(a.completedAt ?? a.startedAt).getTime()
      );
    return completed.length > 0 ? completed[0] : null;
  }, [boot]);

  // Fetch the focus run; poll every 2s while it is running / awaiting decision.
  useEffect(() => {
    if (!focusSummary) {
      setRun(null);
      return;
    }
    const runId = focusSummary.id;
    let alive = true;
    let timer: number | null = null;
    const stopPolling = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const load = async () => {
      try {
        const next = await fetchRun(runId);
        if (!alive) return;
        setRun(next);
        if (!isLiveStatus(next.status)) stopPolling();
      } catch (err: unknown) {
        if (!alive) return;
        stopPolling();
        notifyRef.current(err instanceof Error ? err.message : "Unable to load deduction run");
      }
    };
    void load();
    if (isLiveStatus(focusSummary.status)) {
      timer = window.setInterval(() => {
        void load();
      }, 2000);
    }
    return () => {
      alive = false;
      stopPolling();
    };
  }, [focusSummary]);

  // Focus branch: the one awaiting a decision, else the first.
  const focusBranch = useMemo(() => {
    if (!run || run.branches.length === 0) return null;
    return run.branches.find((b) => b.status === "awaiting-decision") ?? run.branches[0];
  }, [run]);

  const fallbackScenario = useMemo(() => {
    if (!boot) return null;
    return boot.scenarios.find((s) => s.status === "ready") ?? (boot.scenarios.length > 0 ? boot.scenarios[0] : null);
  }, [boot]);

  const mapScenario = useMemo(() => {
    if (!boot) return null;
    if (run) return boot.scenarios.find((s) => s.id === run.scenarioId) ?? null;
    return fallbackScenario;
  }, [boot, run, fallbackScenario]);

  const mapUnits: Unit[] = useMemo(() => {
    if (focusBranch) return focusBranch.units;
    return mapScenario ? mapScenario.units : [];
  }, [focusBranch, mapScenario]);

  const mapEvents = useMemo(
    () => (focusBranch ? focusBranch.recentEvents.filter((e) => e.position).slice(0, 10) : []),
    [focusBranch]
  );

  const openDecisions = useMemo(() => {
    if (!run) return 0;
    return run.branches.reduce((n, b) => n + b.decisions.filter((d) => d.status === "open").length, 0);
  }, [run]);

  const workItems = useMemo<WorkItem[]>(() => {
    if (!boot) return [];
    const items: WorkItem[] = [];
    const openDecisionRows = run
      ? run.branches.flatMap((branch) =>
          branch.decisions
            .filter((decision) => decision.status === "open")
            .map((decision) => ({ branch, decision }))
        )
      : [];
    const liveRun = boot.runs.find((candidate) => isLiveStatus(candidate.status));
    const completedRun = [...boot.runs]
      .filter((candidate) => candidate.status === "completed")
      .sort(
        (a, b) =>
          new Date(b.completedAt ?? b.startedAt).getTime() -
          new Date(a.completedAt ?? a.startedAt).getTime()
      )[0];
    const draftScenario = boot.scenarios.find((scenario) => scenario.status === "draft");
    const runningScenario = boot.scenarios.find((scenario) => scenario.status === "running");
    const selectedCoas = boot.coas.filter((coa) => coa.status === "selected");
    const offlineAgents = boot.agents.filter((agent) => agent.status === "offline");
    const degradedDomains = boot.platform.dataDomains.filter((domain) => domain.health === "degraded");

    if (props.profile.id === "commander") {
      for (const { branch, decision } of openDecisionRows.slice(0, 2)) {
        items.push({
          id: decision.id,
          priority: "critical",
          label: "COMMAND DECISION",
          title: decision.title,
          changed: `${branch.name} opened a decision at ${simClock(decision.simTimeH)}, tick ${decision.tick}.`,
          risk: "The branch is held until command authority records a decision and rationale.",
          owner: props.profile.name,
          due: "Now",
          target: "deduction",
          action: "Decide",
        });
      }
      if (items.length === 0 && liveRun) {
        items.push({
          id: `watch-${liveRun.id}`,
          priority: "monitor",
          label: "COMMAND WATCH",
          title: `${liveRun.label} is in execution`,
          changed: `${liveRun.branchCount} branches are advancing at ${simClock(liveRun.simTimeH)}.`,
          risk: "No command decision is open; continue monitoring branch divergence and force preservation.",
          owner: "Simulation Control",
          due: "Continuous",
          target: "deduction",
          action: "Open run",
        });
      }
    } else if (props.profile.id === "planner") {
      if (draftScenario) {
        items.push({
          id: `validate-${draftScenario.id}`,
          priority: "priority",
          label: "PLANNING PACKAGE",
          title: `${draftScenario.name} requires validation`,
          changed: `The scenario remains in draft with ${draftScenario.units.length} units and ${draftScenario.objectives.length} objectives.`,
          risk: "COA development should not proceed from an unvalidated baseline.",
          owner: draftScenario.createdBy || props.profile.name,
          due: "Before COA generation",
          target: "scenario",
          action: "Review scenario",
        });
      }
      if (selectedCoas.length > 0) {
        items.push({
          id: `handoff-${selectedCoas[0].id}`,
          priority: "priority",
          label: "HANDOFF READY",
          title: `${selectedCoas.length} selected COA${selectedCoas.length === 1 ? "" : "s"} require execution rules`,
          changed: `${selectedCoas[0].name} is selected for the scenario package.`,
          risk: "The run package remains incomplete until adjudication rules are confirmed.",
          owner: "Plans Cell (J5)",
          due: "Before run authorization",
          target: "rules",
          action: "Configure rules",
        });
      } else if (!draftScenario) {
        items.push({
          id: "develop-coas",
          priority: "priority",
          label: "NEXT PLANNING ACTION",
          title: "Develop and select a COA package",
          changed: "A validated scenario is available; no COA is selected for execution.",
          risk: "Run control cannot assemble a launch package without a selected COA.",
          owner: "Plans Cell (J5)",
          due: "Before run authorization",
          target: "coa",
          action: "Open COA development",
        });
      }
      if (runningScenario) {
        items.push({
          id: `locked-${runningScenario.id}`,
          priority: "monitor",
          label: "BASELINE CONTROL",
          title: `${runningScenario.name} is locked in execution`,
          changed: "The active scenario baseline is now view-only.",
          risk: "Any planning change must be made in a traceable copy, not against the live baseline.",
          owner: runningScenario.createdBy || "Plans Cell (J5)",
          due: "Before next revision",
          target: "scenario",
          action: "Review baseline",
        });
      }
    } else if (props.profile.id === "operator") {
      if (openDecisionRows.length > 0 && liveRun) {
        items.push({
          id: `hold-${liveRun.id}`,
          priority: "critical",
          label: "RUN HELD",
          title: `${liveRun.label} is awaiting command authority`,
          changed: `${openDecisionRows.length} decision point${openDecisionRows.length === 1 ? " is" : "s are"} open.`,
          risk: "Simulation time is held; interventions should remain controlled until the decision is issued.",
          owner: "Joint Force Commander",
          due: "Now",
          target: "deduction",
          action: "Open run control",
        });
      } else if (liveRun) {
        items.push({
          id: `control-${liveRun.id}`,
          priority: "monitor",
          label: "RUN CONTROL",
          title: `${liveRun.label} is active`,
          changed: `${liveRun.branchCount} branches are live at ${simClock(liveRun.simTimeH)}.`,
          risk: "Monitor engine health, inject discipline and branch synchronization.",
          owner: props.profile.name,
          due: "Continuous",
          target: "deduction",
          action: "Open run control",
        });
      }
    } else if (props.profile.id === "analyst") {
      if (completedRun) {
        items.push({
          id: `aar-${completedRun.id}`,
          priority: "priority",
          label: "ASSESSMENT DUE",
          title: `${completedRun.label} is ready for after-action review`,
          changed: `The run completed ${timeAgo(completedRun.completedAt ?? completedRun.startedAt)} with ${completedRun.branchCount} branches.`,
          risk: "Findings and recommendations have not yet been released to the next planning cycle.",
          owner: props.profile.name,
          due: "Post-run",
          target: "assessment",
          action: "Open assessment",
        });
      }
      if (liveRun) {
        items.push({
          id: `observe-${liveRun.id}`,
          priority: "monitor",
          label: "EVIDENCE WATCH",
          title: `${liveRun.label} is producing assessment evidence`,
          changed: `Live telemetry is available from ${liveRun.branchCount} branches.`,
          risk: "Capture decision and adjudication context before the run closes.",
          owner: "Analysis Cell (J8)",
          due: "During execution",
          target: "orders",
          action: "Review decision record",
        });
      }
    } else {
      if (offlineAgents.length > 0) {
        items.push({
          id: "agent-health",
          priority: "priority",
          label: "SERVICE DEGRADATION",
          title: `${offlineAgents.length} mission agent${offlineAgents.length === 1 ? " is" : "s are"} offline`,
          changed: offlineAgents.map((agent) => agent.name).join(", "),
          risk: "Agent-backed planning and advisory actions may fall back or become unavailable.",
          owner: props.profile.name,
          due: "Before next run",
          target: "ailayer",
          action: "Review agents",
        });
      }
      if (degradedDomains.length > 0) {
        items.push({
          id: "data-health",
          priority: "critical",
          label: "DATA HEALTH",
          title: `${degradedDomains.length} data domain${degradedDomains.length === 1 ? " is" : "s are"} degraded`,
          changed: degradedDomains.map((domain) => domain.name).join(", "),
          risk: "Derived planning and assessment products may be incomplete or stale.",
          owner: props.profile.name,
          due: "Now",
          target: "foundation",
          action: "Inspect foundation",
        });
      }
      if (items.length === 0) {
        items.push({
          id: "platform-watch",
          priority: "monitor",
          label: "PLATFORM WATCH",
          title: "Operational services are within declared limits",
          changed: `${boot.platform.engines.filter((engine) => engine.status === "online").length}/${boot.platform.engines.length} simulation engines online.`,
          risk: "No immediate platform exception is reported.",
          owner: props.profile.name,
          due: "Continuous",
          target: "foundation",
          action: "View service status",
        });
      }
    }

    return items.slice(0, 3);
  }, [boot, props.profile.id, props.profile.name, run]);

  const canOpen = (page: PageId) => props.profile.pages.includes(page);

  const openPage = (page: PageId) => {
    props.goTo(page);
    props.notify(`Opening ${PAGE_LABELS[page] ?? page}`);
  };

  const handleRefresh = () => {
    setReloadKey((k) => k + 1);
    props.notify("Common operational picture refreshed");
  };

  const handleRetry = () => {
    setError(null);
    setReloadKey((k) => k + 1);
    props.notify("Retrying dashboard load");
  };

  const handleSelectUnit = (id: string) => {
    const unit = mapUnits.find((u) => u.id === id);
    if (unit) props.notify(`${unit.name}, ${unit.status.toUpperCase()}, strength ${Math.round(unit.strength)}%`);
  };

  if (error && !boot) {
    return (
      <PageBody>
        <EmptyState icon={AlertTriangle} title="Dashboard failed to load" hint={error} />
        <ActionRow>
          <Button icon={RefreshCw} onClick={handleRetry}>
            Retry
          </Button>
        </ActionRow>
      </PageBody>
    );
  }

  if (!boot) {
    return (
      <PageBody>
        <EmptyState
          icon={Radar}
          title="Standing up the common operational picture"
          hint="Fetching scenarios, agent library and live deduction runs for Exercise AZURE HORIZON…"
        />
      </PageBody>
    );
  }

  const scenariosReady = boot.scenarios.filter((s) => s.status === "ready").length;
  const scenariosRunning = boot.scenarios.filter((s) => s.status === "running").length;
  const activeRuns = boot.runs.filter(
    (r) => r.status === "initializing" || r.status === "running" || r.status === "paused" || r.status === "awaiting-decision"
  ).length;
  const agentsReady = boot.agents.filter((a) => a.status === "ready").length;
  const agentsTraining = boot.agents.filter((a) => a.status === "training").length;
  const agentsOffline = boot.agents.filter((a) => a.status === "offline").length;
  const actionWork = workItems.filter((item) => item.priority !== "monitor").length;
  const atRiskBranches = run
    ? run.branches.filter(
        (branch) =>
          branch.metrics.blueStrength < 70 ||
          branch.metrics.supplyLevel < 55 ||
          branch.status === "awaiting-decision"
      ).length
    : 0;

  return (
    <PageBody>
      <Panel
        title="My work / decision queue"
        action={<span className="cmd-work-role">{props.profile.name}</span>}
      >
        <div className="cmd-work-summary" aria-label="Command attention summary">
          <div>
            <span>Needs me</span>
            <strong>{actionWork}</strong>
          </div>
          <div>
            <span>Changed</span>
            <strong>
              {run && ["commander", "operator", "analyst"].includes(props.profile.id)
                ? `Run at tick ${run.clock.tick}`
                : `${workItems.length} queue update${workItems.length === 1 ? "" : "s"}`}
            </strong>
          </div>
          <div>
            <span>At risk</span>
            <strong>
              {atRiskBranches > 0
                ? `${atRiskBranches} branch${atRiskBranches === 1 ? "" : "es"}`
                : actionWork > 0
                  ? `${actionWork} package${actionWork === 1 ? "" : "s"}`
                  : "None declared"}
            </strong>
          </div>
        </div>
        <div className="cmd-work-list">
          {workItems.map((item) => (
            <article key={item.id} className={`cmd-work-item is-${item.priority}`}>
              <div className="cmd-work-main">
                <span className="cmd-work-label">{item.label}</span>
                <strong>{item.title}</strong>
                <p>{item.changed}</p>
              </div>
              <div className="cmd-work-risk">
                <span>Operational effect</span>
                <p>{item.risk}</p>
              </div>
              <dl className="cmd-work-meta">
                <div>
                  <dt>Owner</dt>
                  <dd>{item.owner}</dd>
                </div>
                <div>
                  <dt>Due</dt>
                  <dd>{item.due}</dd>
                </div>
              </dl>
              <Button
                variant={item.priority === "critical" ? "primary" : "secondary"}
                onClick={() => openPage(item.target)}
                disabled={!canOpen(item.target)}
              >
                {item.action}
              </Button>
            </article>
          ))}
        </div>
      </Panel>

      <MetricGrid>
        <Metric
          label="Scenario library"
          value={String(boot.scenarios.length)}
          helper={`${scenariosRunning} in execution | ${scenariosReady} ready`}
          tone={scenariosRunning > 0 || scenariosReady > 0 ? "good" : "neutral"}
        />
        <Metric
          label="Active runs"
          value={String(activeRuns)}
          helper={`${boot.runs.length} total deductions`}
          tone={activeRuns > 0 ? "info" : "neutral"}
        />
        <Metric
          label="Agents ready"
          value={String(agentsReady)}
          helper={`${agentsTraining} training | ${agentsOffline} offline`}
          tone={agentsReady > 0 ? "good" : "warn"}
        />
        <Metric
          label="Open decisions"
          value={String(openDecisions)}
          helper={run ? run.label : "no active deduction"}
          tone={openDecisions > 0 ? "warn" : "neutral"}
        />
      </MetricGrid>

      <div className="split-grid wide-left">
        <Panel
          title="Theater situation"
          action={
            <Button icon={RefreshCw} variant="secondary" onClick={handleRefresh}>
              Refresh
            </Button>
          }
        >
          <TheaterMap
            center={mapScenario ? mapScenario.mapCenter : DEFAULT_CENTER}
            zoom={mapScenario ? mapScenario.mapZoom : DEFAULT_ZOOM}
            units={mapUnits}
            theater={boot.theater}
            objectives={mapScenario ? mapScenario.objectives : undefined}
            onSelectUnit={handleSelectUnit}
            events={mapEvents}
            worldKey={focusBranch ? `${run?.id}:${focusBranch.id}` : `scenario:${mapScenario?.id}`}
            height={440}
          />
          <div className="cmd-map-foot">
            <div className="legend">
              <span>
                <i style={{ background: frameColor(affiliationOf("blue")) }} />
                BLUE - Coalition Task Force
              </span>
              <span>
                <i style={{ background: frameColor(affiliationOf("red")) }} />
                RED - OPFOR
              </span>
              {focusBranch ? (
                <span>
                  <i style={{ background: focusBranch.color }} />
                  Branch, {focusBranch.name}
                </span>
              ) : null}
            </div>
            <span className="cmd-map-source">
              {focusBranch && run
                ? `Live pieces - ${run.scenarioName}`
                : mapScenario
                  ? `Order of battle - ${mapScenario.name}`
                  : "Meridian Archipelago, no scenario loaded"}
            </span>
          </div>
        </Panel>

        <Panel
          title="Live deduction"
          action={
            run ? (
              <div className="cmd-panel-actions">
                <StatusPill label={run.status.replace(/-/g, " ")} tone={statusTone(run.status)} />
                {run.status === "completed" ? (
                  <Button
                    icon={Layers}
                    variant="secondary"
                    onClick={() => openPage("assessment")}
                    disabled={!canOpen("assessment")}
                  >
                    Open assessment
                  </Button>
                ) : (
                  <Button
                    icon={PlayCircle}
                    variant="secondary"
                    onClick={() => openPage("deduction")}
                    disabled={!canOpen("deduction")}
                  >
                    Open deduction
                  </Button>
                )}
              </div>
            ) : undefined
          }
        >
          {run ? (
            <div className="cmd-live-stack">
              <div className="cmd-clock-row">
                <div className="sim-clock">
                  {simClock(run.clock.simTimeH)}
                  <small>
                    tick {run.clock.tick} | {run.engine === "realtime" ? `×${run.clock.speed}` : "turn-based"}
                  </small>
                </div>
                <span className="cmd-map-source">
                  started {new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 16)}Z · {timeAgo(run.startedAt)}
                </span>
              </div>
              <div className="cmd-run-meta">
                <strong>{run.label}</strong>
                <small>
                  {run.scenarioName} | {run.branches.length} branch{run.branches.length === 1 ? "" : "es"} in parallel
                </small>
              </div>
              {run.branches.map((branch) => (
                <div className="cmd-branch" key={branch.id}>
                  <div className="cmd-branch-head">
                    <span className="cmd-branch-dot" style={{ background: branch.color }} />
                    <strong>{branch.name}</strong>
                    <StatusPill label={branch.status.replace(/-/g, " ")} tone={statusTone(branch.status)} />
                  </div>
                  <ProgressBar label="BLUE strength" value={branch.metrics.blueStrength} tone="info" />
                  <ProgressBar label="RED strength" value={branch.metrics.redStrength} tone="danger" />
                  <span className="cmd-branch-foot">
                    Objectives {Math.round(branch.metrics.objectiveScore)}% | losses B{branch.metrics.blueLosses}/R
                    {branch.metrics.redLosses} | {branch.eventCount} events
                  </span>
                </div>
              ))}
              {focusBranch && focusBranch.recentEvents.length > 0 ? (
                <ObjectList
                  rows={focusBranch.recentEvents.slice(0, 8).map((event) => ({
                    id: event.id,
                    title: event.title,
                    meta: `${simClock(event.simTimeH)} | ${event.detail}`,
                    tone: eventTones[event.type] ?? "neutral",
                    status: event.type,
                  }))}
                />
              ) : (
                <EmptyState icon={Radar} title="No events yet" hint="The engine has not emitted events for this branch." />
              )}
            </div>
          ) : focusSummary ? (
            <EmptyState
              icon={Activity}
              title="Contacting simulation engine"
              hint={`Pulling branch telemetry for ${focusSummary.label}…`}
            />
          ) : (
            <div className="cmd-live-stack">
              <EmptyState
                icon={Radar}
                title="No deduction on the board"
                hint="Start a run from Full-Process Deduction to stream live branch telemetry here."
              />
              <ActionRow>
                <Button icon={PlayCircle} onClick={() => openPage("deduction")} disabled={!canOpen("deduction")}>
                  Launch deduction
                </Button>
              </ActionRow>
            </div>
          )}
        </Panel>
      </div>

    </PageBody>
  );
}

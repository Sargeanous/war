// CommandDashboard — the commander's landing view for Exercise AZURE HORIZON.
// Metrics row, live theater picture of the focus deduction run, per-branch
// telemetry, the L3/L2/L1 layer cards and the recent-activity stream.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Database,
  History,
  Layers,
  Map as MapIcon,
  PlayCircle,
  Radar,
  RefreshCw,
} from "lucide-react";
import type { PageId, PageProps } from "../shell";
import type { Bootstrap, SimEvent, SimRun, Unit } from "../types";
import { fetchBootstrap, fetchRun } from "../api";
import {
  ActionRow,
  Button,
  Detail,
  DetailGrid,
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
import TheaterMap from "../map";
import "./commanddashboard.css";

const DEFAULT_CENTER = { lat: 34.0, lng: -40.0 };
const DEFAULT_ZOOM = 7;

const PAGE_LABELS: Partial<Record<PageId, string>> = {
  scenario: "Scenario Design",
  deduction: "Full-Process Deduction",
  assessment: "Assessment & Replay",
  ailayer: "AI Command Layer",
  foundation: "Platform Foundation",
};

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function isLiveStatus(status: string): boolean {
  return status === "running" || status === "awaiting-decision";
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

  // Recent activity: merged event tails across all branches, newest first.
  const activity = useMemo(() => {
    if (!run) return [];
    const rows: Array<{ key: string; event: SimEvent; branchName: string }> = [];
    for (const branch of run.branches) {
      for (const event of branch.recentEvents) {
        rows.push({ key: `${branch.id}:${event.id}`, event, branchName: branch.name });
      }
    }
    rows.sort((a, b) => b.event.tick - a.event.tick || b.event.simTimeH - a.event.simTimeH);
    return rows.slice(0, 10);
  }, [run]);

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
    if (unit) props.notify(`${unit.name} — ${unit.status.toUpperCase()}, strength ${Math.round(unit.strength)}%`);
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
  const activeRuns = boot.runs.filter(
    (r) => r.status === "initializing" || r.status === "running" || r.status === "paused" || r.status === "awaiting-decision"
  ).length;
  const agentsReady = boot.agents.filter((a) => a.status === "ready").length;
  const agentsTraining = boot.agents.filter((a) => a.status === "training").length;
  const agentsOffline = boot.agents.filter((a) => a.status === "offline").length;
  const enginesOnline = boot.platform.engines.filter((e) => e.status === "online").length;
  const totalRecords = boot.platform.dataDomains.reduce((n, d) => n + d.records, 0);
  const lowCodeAssets =
    boot.platform.lowCode.maps + boot.platform.lowCode.pieces + boot.platform.lowCode.rules + boot.platform.lowCode.scenarios;

  return (
    <PageBody>
      <MetricGrid>
        <Metric
          label="Scenarios ready"
          value={String(scenariosReady)}
          helper={`${boot.scenarios.length} in library`}
          tone={scenariosReady > 0 ? "good" : "neutral"}
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
          helper={`${agentsTraining} training · ${agentsOffline} offline`}
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
          icon={MapIcon}
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
            height={440}
          />
          <div className="cmd-map-foot">
            <div className="legend">
              <span>
                <i style={{ background: sideColors.blue }} />
                BLUE — Coalition Task Force
              </span>
              <span>
                <i style={{ background: sideColors.red }} />
                RED — OPFOR
              </span>
              {focusBranch ? (
                <span>
                  <i style={{ background: focusBranch.color }} />
                  Branch — {focusBranch.name}
                </span>
              ) : null}
            </div>
            <span className="cmd-map-source">
              {focusBranch && run
                ? `Live pieces · ${run.scenarioName}`
                : mapScenario
                  ? `Order of battle · ${mapScenario.name}`
                  : "Meridian Archipelago — no scenario loaded"}
            </span>
          </div>
        </Panel>

        <Panel
          icon={Activity}
          title="Live deduction"
          action={run ? <StatusPill label={run.status.replace(/-/g, " ")} tone={statusTone(run.status)} /> : undefined}
        >
          {run ? (
            <div className="cmd-live-stack">
              <div className="cmd-clock-row">
                <div className="sim-clock">
                  {simClock(run.clock.simTimeH)}
                  <small>
                    tick {run.clock.tick} · {run.engine === "realtime" ? `×${run.clock.speed}` : "turn-based"}
                  </small>
                </div>
                <span className="cmd-map-source">started {timeAgo(run.startedAt)}</span>
              </div>
              <div className="cmd-run-meta">
                <strong>{run.label}</strong>
                <small>
                  {run.scenarioName} · {run.branches.length} branch{run.branches.length === 1 ? "" : "es"} in parallel
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
                    Objectives {Math.round(branch.metrics.objectiveScore)}% · losses B{branch.metrics.blueLosses}/R
                    {branch.metrics.redLosses} · {branch.eventCount} events
                  </span>
                </div>
              ))}
              {focusBranch && focusBranch.recentEvents.length > 0 ? (
                <ObjectList
                  rows={focusBranch.recentEvents.slice(0, 8).map((event) => ({
                    id: event.id,
                    title: event.title,
                    meta: `${simClock(event.simTimeH)} · ${event.detail}`,
                    tone: eventTones[event.type] ?? "neutral",
                    status: event.type,
                  }))}
                />
              ) : (
                <EmptyState icon={Radar} title="No events yet" hint="The engine has not emitted events for this branch." />
              )}
              <ActionRow>
                <Button
                  icon={PlayCircle}
                  variant="secondary"
                  onClick={() => openPage("deduction")}
                  disabled={!canOpen("deduction")}
                >
                  Open deduction
                </Button>
                {run.status === "completed" ? (
                  <Button icon={Layers} variant="secondary" onClick={() => openPage("assessment")} disabled={!canOpen("assessment")}>
                    Open assessment
                  </Button>
                ) : null}
              </ActionRow>
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

      <div className="cmd-layer-grid">
        <section className="panel cmd-layer-card">
          <header className="cmd-layer-head">
            <h3>Planning &amp; Simulation</h3>
          </header>
          <p className="cmd-layer-sub">From scenario to assessment — design, generate COAs, configure rules, deduce, assess.</p>
          <DetailGrid>
            <Detail label="Scenarios" value={String(boot.scenarios.length)} />
            <Detail label="COA candidates" value={String(boot.coas.length)} />
            <Detail label="Rule sets" value={String(boot.ruleSets.length)} />
            <Detail label="Deduction runs" value={String(boot.runs.length)} />
          </DetailGrid>
          <ActionRow>
            <Button icon={MapIcon} variant="secondary" onClick={() => openPage("scenario")} disabled={!canOpen("scenario")}>
              Scenario design
            </Button>
          </ActionRow>
        </section>

        <section className="panel cmd-layer-card">
          <header className="cmd-layer-head">
            <h3>AI Command</h3>
          </header>
          <p className="cmd-layer-sub">
            Strategic task decomposition, tactical agent library and human-AI collaborative decision over the OODA loop.
          </p>
          <DetailGrid>
            <Detail label="Agents ready" value={String(agentsReady)} />
            <Detail label="Training" value={String(agentsTraining)} />
            <Detail label="Offline" value={String(agentsOffline)} />
            <Detail label="Open decisions" value={String(openDecisions)} />
          </DetailGrid>
          <ActionRow>
            <Button icon={BrainCircuit} variant="secondary" onClick={() => openPage("ailayer")} disabled={!canOpen("ailayer")}>
              AI Command Layer
            </Button>
          </ActionRow>
        </section>

        <section className="panel cmd-layer-card">
          <header className="cmd-layer-head">
            <h3>Platform Foundation</h3>
          </header>
          <p className="cmd-layer-sub">
            One platform, multiple simulation engines and a unified data foundation with ontology-backed low-code design.
          </p>
          <DetailGrid>
            <Detail label="Engines online" value={`${enginesOnline} / ${boot.platform.engines.length}`} />
            <Detail label="Data records" value={formatCount(totalRecords)} />
            <Detail label="Data domains" value={String(boot.platform.dataDomains.length)} />
            <Detail label="Low-code assets" value={formatCount(lowCodeAssets)} />
          </DetailGrid>
          <ActionRow>
            <Button icon={Database} variant="secondary" onClick={() => openPage("foundation")} disabled={!canOpen("foundation")}>
              Foundation
            </Button>
          </ActionRow>
        </section>
      </div>

      <Panel
        icon={History}
        title="Recent activity"
        action={run ? <span className="cmd-map-source">{run.label}</span> : undefined}
      >
        {activity.length > 0 ? (
          <ObjectList
            rows={activity.map((row) => ({
              id: row.key,
              title: row.event.title,
              meta: `${simClock(row.event.simTimeH)} · ${row.branchName} · ${row.event.detail}`,
              tone: eventTones[row.event.type] ?? "neutral",
              status: row.event.type,
            }))}
          />
        ) : (
          <EmptyState
            icon={History}
            title="No recent activity"
            hint="Deduction events will appear here as soon as an engine starts adjudicating a run."
          />
        )}
      </Panel>
    </PageBody>
  );
}

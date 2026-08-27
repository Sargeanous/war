import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronLeft,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Radar,
  Rocket,
  ScrollText,
  ShieldAlert,
  SkipForward,
  Swords,
  Trophy,
  Wand2,
  X,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./deduction.css";
import {
  ApiError,
  controlRun,
  decideBranch,
  explainBranch,
  fetchAdversaryPlans,
  fetchAgents,
  fetchBootstrap,
  fetchCoas,
  fetchRun,
  fetchRuns,
  fetchRuleSets,
  intervene,
  revealAdversaryPlan,
  startRun,
  updateSeat,
} from "../api";
import {
  ActionRow,
  Button,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  FormGrid,
  Modal,
  ObjectList,
  Panel,
  ProgressBar,
  Segmented,
  Sparkline,
  StatusPill,
  Tag,
  simClock,
  timeAgo,
  plural,
} from "../components";
import { eventTones, sideColors, statusTone } from "../data";
import { affiliationOf, frameColor } from "../milsym";
import TheaterMap from "../map";
import type { MapFocus } from "../map";
import type { PageProps } from "../shell";
import type {
  Bootstrap,
  Branch,
  ExplainTopic,
  Coa,
  EngineKind,
  InterventionType,
  LatLng,
  RuleSet,
  RunSummary,
  Scenario,
  SimRun,
  Unit,
  AgentDef,
  AdversaryPlanSummary,
  AdversaryView,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

type ViewSide = "all" | "blue" | "red";
type DrawerId = "score" | "events" | "adjudication" | "decisions" | "sage" | "seats" | "opfor";

export default function Deduction({ notify, goTo, profile }: PageProps) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [run, setRun] = useState<SimRun | null>(null);
  const [branchId, setBranchId] = useState<string>("");
  const [rationale, setRationale] = useState("");
  const [showIntervene, setShowIntervene] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [viewSide, setViewSide] = useState<ViewSide>("all");
  const [drawer, setDrawer] = useState<DrawerId | null>("score");
  const [orbatSide, setOrbatSide] = useState<"blue" | "red">("blue");
  const [orbatOpen, setOrbatOpen] = useState(true);
  const [sageLog, setSageLog] = useState<Array<{ topic: ExplainTopic; label: string; answer: string; source: string }>>([]);
  const [sageBusy, setSageBusy] = useState<ExplainTopic | null>(null);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [seatBusy, setSeatBusy] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  // Id of a decision that opened live while watching (drives the alarm pulse
  // and the auto-scroll; decisions that were already open when the page or
  // run was entered get neither).
  const [freshDecisionId, setFreshDecisionId] = useState<string | null>(null);
  const trailsRef = useRef<Record<string, LatLng[]>>({});
  const prevOpenDecisionsRef = useRef<Set<string> | null>(null);
  const branchIdRef = useRef<string>("");
  const decisionBlockRef = useRef<HTMLDivElement | null>(null);
  const canIntervene = profile.id === "operator" || profile.id === "admin";
  branchIdRef.current = branchId;

  // Launcher state
  const [scenarioId, setScenarioId] = useState("");
  const [launchCoas, setLaunchCoas] = useState<Coa[]>([]);
  const [pickedCoaIds, setPickedCoaIds] = useState<string[]>([]);
  const [ruleSetId, setRuleSetId] = useState("");
  const [engine, setEngine] = useState<EngineKind>("realtime");
  const [speed, setSpeed] = useState<"1" | "2" | "4">("2");
  const [label, setLabel] = useState("");
  // The adversary plan is a white-cell choice made at launch. Players are told a
  // plan exists; they are not told which one until the reveal.
  const [adversaryPlans, setAdversaryPlans] = useState<AdversaryPlanSummary[]>([]);
  const [redPlanId, setRedPlanId] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchBootstrap(), fetchRuns(), fetchRuleSets()])
      .then(([b, r, rs]) => {
        if (!alive) return;
        setBoot(b);
        setRuns(r);
        setRuleSets(rs);
        const active = rs.find((x) => x.status === "active");
        setRuleSetId(active ? active.id : rs[0]?.id ?? "");
        const ready = b.scenarios.find((s) => s.status === "ready");
        setScenarioId(ready ? ready.id : b.scenarios[0]?.id ?? "");
        const live = r.find((x) => x.status === "running" || x.status === "awaiting-decision" || x.status === "paused");
        if (live) setActiveRunId(live.id);
        setLoading(false);
      })
      .catch((error) => {
        if (alive) {
          setLoading(false);
          notify(errMsg(error));
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent library, for crewing seats.
  useEffect(() => {
    let alive = true;
    fetchAgents()
      .then((list) => alive && setAgents(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Adversary plan catalogue for the launcher.
  useEffect(() => {
    let alive = true;
    fetchAdversaryPlans()
      .then((list) => {
        if (!alive) return;
        setAdversaryPlans(list);
        setRedPlanId((current) => current || list[0]?.id || "");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // COAs for launcher
  useEffect(() => {
    if (!scenarioId) return;
    let alive = true;
    fetchCoas(scenarioId)
      .then((coas) => {
        if (!alive) return;
        const eligible = coas.filter((c) => c.status === "selected" || c.status === "simulated");
        setLaunchCoas(eligible);
        setPickedCoaIds(eligible.filter((c) => c.status === "selected").map((c) => c.id));
      })
      .catch(() => alive && setLaunchCoas([]));
    return () => {
      alive = false;
    };
  }, [scenarioId]);

  const applyRun = useCallback(
    (next: SimRun) => {
      setRun(next);
      setBranchId((current) => (next.branches.some((b) => b.id === current) ? current : next.branches[0]?.id ?? ""));
      for (const branch of next.branches) {
        for (const unit of branch.units) {
          const key = `${branch.id}:${unit.id}`;
          const trail = trailsRef.current[key] ?? [];
          const last = trail[trail.length - 1];
          if (!last || last.lat !== unit.position.lat || last.lng !== unit.position.lng) {
            trail.push({ ...unit.position });
            if (trail.length > 12) trail.shift();
            trailsRef.current[key] = trail;
          }
        }
      }
      // A decision point OPENING live is the moment the run interrupts the
      // commander; decisions that were already open when the page or run was
      // entered get no fanfare (first pass only seeds the set).
      const openNow = next.branches.flatMap((b) =>
        b.decisions.filter((d) => d.status === "open").map((d) => ({ id: d.id, title: d.title, branch: b }))
      );
      const before = prevOpenDecisionsRef.current;
      prevOpenDecisionsRef.current = new Set(openNow.map((d) => d.id));
      if (before) {
        const fresh = openNow.filter((d) => !before.has(d.id));
        if (fresh.length) {
          const first = fresh[0];
          const inActive = first.branch.id === branchIdRef.current;
          const where = inActive ? "" : ` in ${first.branch.name}`;
          const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
          notify(`Commander decision required${where}: ${first.title}${more}`);
          const activeFresh = fresh.find((d) => d.branch.id === branchIdRef.current);
          if (activeFresh) setFreshDecisionId(activeFresh.id);
        }
      }
    },
    [notify]
  );

  // Bring a decision that opened LIVE into view (the poll can land it while
  // the presenter is scrolled into the map or a drawer). Branch tab switches
  // and page loads with long-open decisions must not scroll-hijack.
  useEffect(() => {
    if (freshDecisionId) decisionBlockRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [freshDecisionId]);

  // Poll the active run
  useEffect(() => {
    if (!activeRunId) return;
    let alive = true;
    let timer: number | undefined;
    const poll = () => {
      fetchRun(activeRunId)
        .then((next) => {
          if (!alive) return;
          applyRun(next);
          if (next.status === "completed" || next.status === "aborted") {
            window.clearInterval(timer);
          }
        })
        .catch((error) => {
          if (alive) {
            window.clearInterval(timer);
            notify(errMsg(error));
          }
        });
    };
    poll();
    timer = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  const scenario: Scenario | undefined = useMemo(
    () => boot?.scenarios.find((s) => s.id === (run ? run.scenarioId : scenarioId)),
    [boot, run, scenarioId]
  );
  const branch = run?.branches.find((b) => b.id === branchId) ?? run?.branches[0];

  async function doControl(action: "pause" | "resume" | "speed" | "abort" | "step", value?: number) {
    if (!run) return;
    if (action === "abort" && !window.confirm("Abort this deduction run? Branch states will be frozen.")) return;
    try {
      applyRun(await controlRun(run.id, action, value));
      notify(
        action === "speed"
          ? `Simulation speed set to ${value}x`
          : action === "step"
            ? "Advanced one turn"
            : `Run ${action}${action === "abort" ? "ed" : action === "pause" ? "d" : "d"}`
      );
    } catch (error) {
      notify(errMsg(error));
    }
  }

  async function doLaunch() {
    if (!scenarioId || !pickedCoaIds.length || !ruleSetId) {
      notify("Pick a scenario, at least one COA and a rule set");
      return;
    }
    try {
      const next = await startRun({
        scenarioId,
        coaIds: pickedCoaIds,
        ruleSetId,
        engine,
        speed: Number(speed),
        label: label.trim() || undefined,
        redPlanId: redPlanId || undefined,
      });
      trailsRef.current = {};
      applyRun(next);
      setActiveRunId(next.id);
      notify(
        next.branches.length === 1
          ? "Deduction started, one branch against the OPFOR plan"
          : `Deduction started, ${next.branches.length} branches in parallel on one seed`
      );
    } catch (error) {
      notify(errMsg(error));
    }
  }

  // Showing the players what RED was trying to do is an umpire call, and the
  // backend signs it with a name rather than accepting an anonymous reveal.
  async function doRevealAdversary() {
    if (!run) return;
    if (!window.confirm("Reveal the OPFOR plan to the players? Once shown it cannot be hidden again for this run.")) return;
    setRevealBusy(true);
    try {
      applyRun(await revealAdversaryPlan(run.id, profile.name));
      notify("OPFOR plan revealed to the players");
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setRevealBusy(false);
    }
  }

  async function doDecide(decisionId: string, optionId: string) {
    if (!run || !branch) return;
    try {
      applyRun(
        await decideBranch(run.id, branch.id, {
          decisionId,
          optionId,
          rationale: rationale.trim(),
          decidedBy: profile.name,
        })
      );
      setRationale("");
      notify("Decision issued, branch resuming");
    } catch (error) {
      notify(errMsg(error));
    }
  }
  async function doSeat(seatId: string, payload: { mode?: "human" | "ai"; agentId?: string }) {
    if (!run || seatBusy) return;
    setSeatBusy(seatId);
    try {
      applyRun(await updateSeat(run.id, seatId, payload));
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setSeatBusy(null);
    }
  }

  async function doExplain(topic: ExplainTopic, label: string) {
    if (!run || !branch || sageBusy) return;
    setSageBusy(topic);
    try {
      const result = await explainBranch(run.id, branch.id, topic);
      setSageLog((log) => [{ topic, label, answer: result.answer, source: result.source }, ...log].slice(0, 8));
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setSageBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={Radar} title="Contacting the wargame system" hint="Loading runs, scenarios and rule sets from the simulation backend." />
      </div>
    );
  }

  if (!run || !activeRunId) {
    return (
      <Launcher
        runs={runs}
        boot={boot}
        scenarioId={scenarioId}
        setScenarioId={setScenarioId}
        launchCoas={launchCoas}
        pickedCoaIds={pickedCoaIds}
        setPickedCoaIds={setPickedCoaIds}
        ruleSets={ruleSets}
        ruleSetId={ruleSetId}
        whiteCell={canIntervene}
        adversaryPlans={adversaryPlans}
        redPlanId={redPlanId}
        setRedPlanId={setRedPlanId}
        setRuleSetId={setRuleSetId}
        engine={engine}
        setEngine={setEngine}
        speed={speed}
        setSpeed={setSpeed}
        label={label}
        setLabel={setLabel}
        onLaunch={doLaunch}
        onOpen={(id) => {
          trailsRef.current = {};
          setActiveRunId(id);
        }}
        goToAssessment={() => goTo("assessment")}
      />
    );
  }

  const openDecision = branch?.decisions.find((d) => d.status === "open");
  const decidedDecisions = (branch?.decisions ?? []).filter((d) => d.status === "decided");
  const isLive = run.status === "running" || run.status === "awaiting-decision";
  const trails: Record<string, LatLng[]> = {};
  if (branch) {
    for (const unit of branch.units) {
      const t = trailsRef.current[`${branch.id}:${unit.id}`];
      if (t && t.length > 1) trails[unit.id] = t;
    }
  }

  const simTimeH = run.clock.simTimeH;
  const round = Math.floor(simTimeH / 24) + 1;
  const phaseName = branch?.currentPhaseName ?? "Free play";
  const hourOfDay = simTimeH % 24;
  const daylight = hourOfDay >= 6 && hourOfDay < 18;
  const env = run.environment ?? scenario?.environment;
  const fogSide = viewSide === "all" ? null : viewSide;

  // Fog of war applies to the ORBAT roster too, a side only lists what it sees.
  const rosterVisible = (u: Unit) =>
    !fogSide || u.side === fogSide || u.detectedByEnemy || u.status === "destroyed";
  const roster = (branch?.units ?? []).filter((u) => u.side === orbatSide && rosterVisible(u));
  const selectedUnit = branch?.units.find((u) => u.id === selectedUnitId && rosterVisible(u)) ?? null;
  const adjudicated = (branch?.recentEvents ?? []).filter((e) => e.adjudication);

  return (
    <div className="page-body">
      <div className="ded-header">
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            setActiveRunId(null);
            setRun(null);
            setSelectedUnitId(null);
            setMapFocus(null);
            setFreshDecisionId(null);
            prevOpenDecisionsRef.current = null;
            fetchRuns().then(setRuns).catch(() => undefined);
          }}
        >
          <ChevronLeft size={16} />
          Runs
        </button>
        <div className="ded-phase-banner">
          <span className="k">Exercise clock</span>
          <strong className="v">{simClock(simTimeH)}</strong>
          <span className="m">
            R{round} | {phaseName} | tick {run.clock.tick}
          </span>
        </div>
        {env ? (
          <div className="ded-env-pills">
            <span className="ded-env-pill">{env.weather}</span>
            <span className="ded-env-pill">sea {env.seaState}</span>
            <span className="ded-env-pill">EMCON {env.emcon}</span>
            <span className="ded-env-pill">{daylight ? "day" : "night"}</span>
          </div>
        ) : null}
        <StatusPill label={run.status} tone={statusTone(run.status)} />
        <Tag label={`${run.engine} | ${run.clock.speed}x`} />
        <span className="spacer" />
        {run.status === "paused" ? (
          <Button icon={Play} onClick={() => doControl("resume")}>
            Resume
          </Button>
        ) : isLive ? (
          <Button icon={Pause} variant="secondary" onClick={() => doControl("pause")}>
            Pause
          </Button>
        ) : null}
        {run.engine === "turn-based" && isLive ? (
          <Button icon={SkipForward} variant="secondary" onClick={() => doControl("step")}>
            Step
          </Button>
        ) : null}
        {isLive || run.status === "paused" ? (
          <>
            <Segmented
              value={String(run.clock.speed) as "1" | "2" | "4"}
              onChange={(v) => doControl("speed", Number(v))}
              items={[
                { id: "1", label: "1x" },
                { id: "2", label: "2x" },
                { id: "4", label: "4x" },
              ]}
            />
            {canIntervene ? (
              <Button icon={Wand2} variant="secondary" onClick={() => setShowIntervene(true)}>
                Intervene
              </Button>
            ) : null}
            <Button icon={X} variant="danger" onClick={() => doControl("abort")}>
              Abort
            </Button>
          </>
        ) : null}
      </div>

      <div className="ded-branch-tabs">
        {run.branches.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`ded-branch-tab${b.id === branch?.id ? " active" : ""}`}
            onClick={() => setBranchId(b.id)}
          >
            <span className="ded-branch-dot" style={{ background: b.color }} />
            {b.name}
            <StatusPill label={b.status} tone={statusTone(b.status)} />
          </button>
        ))}
      </div>

      {run.status === "completed" && branch ? (
        <div className="ded-complete">
          <strong>
            <CheckCircle2 size={17} style={{ verticalAlign: "-3px" }} /> Deduction complete, {run.label}
          </strong>
          <div className="ded-complete-grid">
            {run.branches.map((b) => (
              <div key={b.id}>
                <Detail label={b.name} value={`Objectives ${b.metrics.objectiveScore}% | BLUE ${b.metrics.blueStrength}% | RED ${b.metrics.redStrength}%`} />
              </div>
            ))}
          </div>
          <ActionRow>
            <Button icon={ListChecks} onClick={() => goTo("assessment")}>
              Open Assessment &amp; Replay
            </Button>
          </ActionRow>
        </div>
      ) : null}

      {openDecision && branch ? (
        <div
          key={openDecision.id}
          className={`ded-decision${openDecision.id === freshDecisionId ? " fresh" : ""}`}
          ref={decisionBlockRef}
        >
          <div className="ded-decision-head">
            <AlertTriangle size={19} color="var(--amber)" />
            <strong>Commander decision required, {openDecision.title}</strong>
            <span className="ded-decision-time">{simClock(openDecision.simTimeH)}</span>
          </div>
          <p className="ded-situation">{openDecision.situation}</p>
          <p className="ded-sage-quote">
            <BrainCircuit size={14} style={{ verticalAlign: "-2px" }} />{" "}
            <strong>SAGE recommends “{openDecision.options.find((o) => o.id === openDecision.aiRecommendationId)?.label}”.</strong>{" "}
            {openDecision.aiRationale}
          </p>
          <div className="ded-options">
            {openDecision.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`ded-option${option.id === openDecision.aiRecommendationId ? " recommended" : ""}`}
                onClick={() => doDecide(openDecision.id, option.id)}
              >
                <strong>{option.label}</strong>
                {option.id === openDecision.aiRecommendationId ? <Tag label="SAGE recommends" color="var(--blue)" /> : null}
                <small>{option.description}</small>
                <span className="ded-effect">{option.projectedEffect}</span>
                <StatusPill label={`${option.risk} risk`} tone={option.risk === "low" ? "good" : option.risk === "medium" ? "warn" : "danger"} />
              </button>
            ))}
          </div>
          <Field label="Commander rationale (retained with the decision record)">
            <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Optional, why this option…" />
          </Field>
        </div>
      ) : null}

      {branch && scenario ? (
        <div className={`ded-console${orbatOpen ? "" : " orbat-closed"}`}>
          {orbatOpen ? (
            <aside className="ded-orbat">
              <div className="ded-orbat-head">
                <button
                  type="button"
                  className={`ded-orbat-side blue${orbatSide === "blue" ? " active" : ""}`}
                  onClick={() => setOrbatSide("blue")}
                >
                  BLUE {branch.units.filter((u) => u.side === "blue" && u.status !== "destroyed").length}
                </button>
                <button
                  type="button"
                  className={`ded-orbat-side red${orbatSide === "red" ? " active" : ""}`}
                  onClick={() => setOrbatSide("red")}
                >
                  RED {branch.units.filter((u) => u.side === "red" && u.status !== "destroyed").length}
                </button>
                <button type="button" className="ded-orbat-collapse" title="Collapse ORBAT" onClick={() => setOrbatOpen(false)}>
                  <PanelLeftClose size={15} />
                </button>
              </div>
              <div className="ded-orbat-list">
                {roster.length ? (
                  roster.map((unit) => (
                    <button
                      key={unit.id}
                      type="button"
                      className={`ded-orbat-row${unit.id === selectedUnitId ? " active" : ""}${unit.status === "destroyed" ? " dead" : ""}`}
                      onClick={() => setSelectedUnitId(unit.id === selectedUnitId ? null : unit.id)}
                    >
                      <span
                        className="ded-orbat-chip"
                        style={
                          unit.status === "destroyed"
                            ? { background: "#5b6663" }
                            : { background: frameColor(affiliationOf(unit.side)), color: "#10100E", borderColor: "rgba(0, 0, 0, 0.45)" }
                        }
                      >
                        {unit.domain[0].toUpperCase()}
                      </span>
                      <span className="ded-orbat-name">{unit.name}</span>
                      <span className="ded-orbat-str">
                        <i
                          style={{
                            width: `${Math.max(0, Math.min(100, unit.strength))}%`,
                            background: unit.strength > 60 ? "#35c26e" : unit.strength > 30 ? "#f5a524" : "#f04438",
                          }}
                        />
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="ded-orbat-empty">
                    {fogSide ? `No ${orbatSide.toUpperCase()} contacts held in the ${fogSide.toUpperCase()} picture.` : "No units."}
                  </p>
                )}
              </div>
              {selectedUnit ? (
                <div className="ded-unit-card">
                  <strong>{selectedUnit.name}</strong>
                  <DetailGrid>
                    <Detail label="Status" value={selectedUnit.status} />
                    <Detail label="Strength" value={`${Math.round(selectedUnit.strength)}%`} />
                    <Detail label="Supply" value={`${Math.round(selectedUnit.supply)}%`} />
                    <Detail label="Speed" value={`${Math.round(selectedUnit.speedKts)} kts`} />
                  </DetailGrid>
                  <small>
                    {selectedUnit.taskForce ?? selectedUnit.domain} | {selectedUnit.position.lat.toFixed(2)},{" "}
                    {selectedUnit.position.lng.toFixed(2)}
                  </small>
                </div>
              ) : null}
            </aside>
          ) : null}

          <div className="ded-map-zone">
            <TheaterMap
              center={scenario.mapCenter}
              zoom={scenario.mapZoom}
              units={branch.units}
              theater={boot?.theater ?? []}
              objectives={scenario.objectives}
              trails={trails}
              events={branch.recentEvents.filter((e) => e.position).slice(0, 6)}
              selectedUnitId={selectedUnitId}
              onSelectUnit={(id) => setSelectedUnitId(id)}
              showHexGrid
              fogSide={fogSide}
              weather={env?.weather}
              daylight={daylight}
              showLabels
              focusOn={mapFocus}
              worldKey={`${run.id}:${branchId}:${viewSide}`}
              height={560}
            />
            {branch.recentEvents.length ? (
              <div className="ded-ticker" aria-live="polite">
                {branch.recentEvents.slice(0, 3).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={`ded-ticker-item tone-${eventTones[event.type] ?? "neutral"}${event.position ? "" : " no-pos"}`}
                    title={event.position ? "Fly to the action" : undefined}
                    onClick={() => {
                      if (event.position) {
                        setMapFocus({ lat: event.position.lat, lng: event.position.lng, zoom: 9, token: Date.now() });
                      }
                    }}
                  >
                    <i />
                    <span className="ded-ticker-time">{simClock(event.simTimeH)}</span>
                    <span className="ded-ticker-title">{event.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {!orbatOpen ? (
              <button type="button" className="ded-map-reopen" title="Open ORBAT" onClick={() => setOrbatOpen(true)}>
                <PanelLeftOpen size={15} />
              </button>
            ) : null}
            <div className="ded-map-float">
              <Segmented
                value={viewSide}
                onChange={(v) => setViewSide(v as ViewSide)}
                items={[
                  { id: "blue", label: "BLUE view" },
                  { id: "all", label: "Umpire" },
                  { id: "red", label: "RED view" },
                ]}
              />
            </div>
            <div className="ded-hintbar">
              wheel zoom | drag pan | click a counter or ORBAT row to inspect | hex coordinates appear at close zoom
              {fogSide ? ` | ${fogSide.toUpperCase()} picture: undetected enemy pieces are hidden` : ""}
            </div>
          </div>

          <div className="ded-drawer-zone">
            {drawer ? (
              <div className="ded-drawer">
                {drawer === "score" ? <ScoreDrawer branch={branch} decidedCount={decidedDecisions.length} /> : null}
                {drawer === "events" ? (
                  <div className="ded-drawer-body">
                    <ObjectList
                      rows={branch.recentEvents.map((event) => ({
                        id: event.id,
                        title: event.title,
                        meta: `${simClock(event.simTimeH)} | ${event.detail}`,
                        tone: eventTones[event.type] ?? "neutral",
                        status: event.type,
                      }))}
                    />
                  </div>
                ) : null}
                {drawer === "adjudication" ? (
                  <div className="ded-drawer-body">
                    {adjudicated.length ? (
                      adjudicated.map((event) => {
                        const a = event.adjudication!;
                        return (
                          <div key={event.id} className={`ded-adj-card ${a.result}`}>
                            <header>
                              <strong>
                                {a.attacker} → {a.target}
                              </strong>
                              <Tag label={a.result.toUpperCase()} color={a.result === "hit" ? "var(--red)" : "var(--muted)"} />
                            </header>
                            <div className="ded-adj-grid">
                              <span>Weapon</span>
                              <em>
                                {a.weapon} | {a.rangeKm} km
                              </em>
                              <span>Base pk</span>
                              <em>{a.basePk.toFixed(2)}</em>
                              {a.modifiers.map((m) => (
                                <FragmentRow key={m.rule} rule={m.rule} factor={m.factor} />
                              ))}
                              <span>Final pk</span>
                              <em>{a.finalPk.toFixed(2)}</em>
                              <span>Random roll</span>
                              <em>
                                {a.roll.toFixed(2)} {a.roll < a.finalPk ? "<" : "≥"} {a.finalPk.toFixed(2)} → {a.result.toUpperCase()}
                              </em>
                              {a.result === "hit" ? (
                                <>
                                  <span>Raw damage</span>
                                  <em>{a.damage}%</em>
                                </>
                              ) : null}
                            </div>
                            <small>{simClock(event.simTimeH)}</small>
                          </div>
                        );
                      })
                    ) : (
                      <EmptyState
                        icon={Swords}
                        title="No adjudicated engagements yet"
                        hint="Every salvo is resolved openly: weapon, range, rule modifiers, the random roll and raw damage appear here as they happen."
                      />
                    )}
                  </div>
                ) : null}
                {drawer === "opfor" ? (
                  <div className="ded-drawer-body">
                    <AdversaryPanel
                      adversary={branch?.adversary ?? null}
                      canReveal={canIntervene && run.status !== "completed" && run.status !== "aborted"}
                      busy={revealBusy}
                      onReveal={doRevealAdversary}
                    />
                  </div>
                ) : null}
                {drawer === "seats" ? (
                  <div className="ded-drawer-body">
                    {(run.seats ?? []).length ? (
                      (["blue", "red"] as const).map((side) => (
                        <div key={side} className="ded-seat-group">
                          <p className={`ded-seat-side ${side}`}>{side === "blue" ? "BLUE CREW" : "RED CREW"}</p>
                          {(run.seats ?? [])
                            .filter((seat) => seat.side === side)
                            .map((seat) => (
                              <div key={seat.id} className="ded-seat">
                                <div className="ded-seat-head">
                                  <strong>{seat.name}</strong>
                                  <Tag label={seat.rank} />
                                </div>
                                <div className="ded-seat-crew">
                                  <Segmented
                                    value={seat.mode}
                                    onChange={(v) => doSeat(seat.id, { mode: v as "human" | "ai" })}
                                    items={[
                                      { id: "human", label: "Human" },
                                      { id: "ai", label: "Agent" },
                                    ]}
                                  />
                                  {seat.mode === "ai" ? (
                                    <select
                                      className="ded-seat-agent"
                                      value={seat.agentId ?? ""}
                                      disabled={seatBusy === seat.id}
                                      onChange={(e) => doSeat(seat.id, { mode: "ai", agentId: e.target.value })}
                                    >
                                      {agents.map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.name}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="ded-seat-person">{seat.participant ?? "Unassigned"}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      ))
                    ) : (
                      <EmptyState
                        icon={Users}
                        title="No seat roster"
                        hint="Runs launched before crewing shipped have no roster. Start a new deduction to crew its command seats."
                      />
                    )}
                  </div>
                ) : null}
                {drawer === "sage" ? (
                  <div className="ded-drawer-body">
                    <div className="ded-sage-chips">
                      {(
                        [
                          { topic: "adjudication" as const, label: "Why this adjudication?" },
                          { topic: "risk" as const, label: "Biggest risk?" },
                          { topic: "next-step" as const, label: "Suggest next step" },
                          { topic: "enemy" as const, label: "Explain RED" },
                        ] as Array<{ topic: ExplainTopic; label: string }>
                      ).map((chip) => (
                        <button
                          key={chip.topic}
                          type="button"
                          className="ded-sage-chip"
                          disabled={sageBusy !== null}
                          onClick={() => doExplain(chip.topic, chip.label)}
                        >
                          {sageBusy === chip.topic ? "Thinking…" : chip.label}
                        </button>
                      ))}
                    </div>
                    {sageLog.length ? (
                      sageLog.map((entry, i) => (
                        <div key={i} className="ded-sage-answer">
                          <header>
                            <strong>{entry.label}</strong>
                            <Tag
                              label={entry.source === "anthropic" ? "reasoning service" : "offline knowledge"}
                              color={entry.source === "anthropic" ? "var(--blue)" : undefined}
                            />
                          </header>
                          <p>{entry.answer}</p>
                        </div>
                      ))
                    ) : (
                      <EmptyState
                        icon={BrainCircuit}
                        title="Ask SAGE about the battle"
                        hint="Answers are grounded in this branch's live state: the latest adjudication, metrics, supply, detections and doctrine."
                      />
                    )}
                  </div>
                ) : null}
                {drawer === "decisions" ? (
                  <div className="ded-drawer-body">
                    {decidedDecisions.length ? (
                      <div className="ded-decided-list">
                        {decidedDecisions.map((d) => (
                          <div key={d.id} className="ded-decided-row">
                            <strong>{d.title}</strong>
                            <span>→ {d.options.find((o) => o.id === d.decidedOptionId)?.label}</span>
                            <span className="spacer" />
                            <Tag label={d.followedAi ? "Followed SAGE" : "Commander override"} color={d.followedAi ? "var(--blue)" : "var(--amber)"} />
                            <small>{simClock(d.simTimeH)}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        icon={BrainCircuit}
                        title="No decisions yet"
                        hint="Decision points pause the branch and surface options with a SAGE recommendation. Intent and decision are retained by the commander."
                      />
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="ded-drawer-rail">
              {(
                [
                  { id: "score" as const, label: "Score", icon: Trophy },
                  { id: "events" as const, label: "Orders", icon: ScrollText },
                  { id: "adjudication" as const, label: "Adjudication", icon: Swords },
                  { id: "decisions" as const, label: "Decisions", icon: ListChecks },
                  { id: "sage" as const, label: "SAGE", icon: BrainCircuit },
                  { id: "opfor" as const, label: "OPFOR", icon: ShieldAlert },
                  { id: "seats" as const, label: "Seats", icon: Users },
                ] as Array<{ id: DrawerId; label: string; icon: typeof Trophy }>
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`ded-drawer-tab${drawer === tab.id ? " active" : ""}`}
                  onClick={() => setDrawer(drawer === tab.id ? null : tab.id)}
                >
                  <tab.icon size={13} />
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showIntervene && branch ? (
        <InterventionModal
          branchUnits={branch.units.filter((u) => u.status === "active" || u.status === "damaged")}
          onClose={() => setShowIntervene(false)}
          onSubmit={async (type, params) => {
            try {
              applyRun(await intervene(run.id, branch.id, { type, params, requestedBy: profile.name }));
              setShowIntervene(false);
              notify("Intervention applied to the world state");
            } catch (error) {
              notify(errMsg(error));
            }
          }}
        />
      ) : null}
    </div>
  );
}

// What RED is playing. Masked while the run is live, so the panel shows the
// indicators BLUE could legitimately have read rather than the plan itself.
function AdversaryPanel({
  adversary,
  canReveal,
  busy,
  onReveal,
}: {
  adversary: AdversaryView | null | undefined;
  canReveal: boolean;
  busy: boolean;
  onReveal: () => void;
}) {
  if (!adversary) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No OPFOR plan on this branch"
        hint="Runs adjudicated before the adversary planner shipped have RED reacting to contact. Start a new deduction to give RED a scheme of manoeuvre."
      />
    );
  }
  return (
    <div className="ded-opfor">
      <div className="ded-opfor-head">
        <div>
          <strong>{adversary.codename}</strong>
          <small>{adversary.name}</small>
        </div>
        <div className="ded-opfor-tags">
          <StatusPill label={adversary.revealed ? "revealed" : "masked"} tone={adversary.revealed ? "info" : "warn"} />
          <StatusPill
            label={adversary.firesReleased ? `fires released T+${adversary.firesReleasedAtH}h` : "fires held"}
            tone={adversary.firesReleased ? "danger" : "neutral"}
          />
        </div>
      </div>
      <p className="ded-opfor-summary">{adversary.summary}</p>

      {adversary.revealed ? (
        <>
          <DetailGrid>
            <Detail label="Posture" value={adversary.posture === "defensive-ambush" ? "Defensive ambush" : "Offensive screen"} />
            <Detail label="Fires policy" value={adversary.firesNote ?? "not recorded"} />
          </DetailGrid>
          <div className="ded-opfor-block">
            <p className="ded-opfor-label">Intent</p>
            <p>{adversary.intent}</p>
          </div>
          <div className="ded-opfor-block">
            <p className="ded-opfor-label">Risk RED accepted</p>
            <p>{adversary.risk}</p>
          </div>
          <div className="ded-opfor-block">
            <p className="ded-opfor-label">What would have broken it</p>
            <p>{adversary.counter}</p>
          </div>
          <div className="ded-opfor-phases">
            {adversary.phases.map((phase) => (
              <div key={phase.id} className={`ded-opfor-phase${adversary.currentPhase?.id === phase.id ? " current" : ""}`}>
                <div className="ded-opfor-phase-head">
                  <strong>{phase.name}</strong>
                  <small>
                    T+{phase.startH}h to T+{phase.endH}h
                  </small>
                </div>
                <p>{phase.intent}</p>
                <div className="ded-opfor-tasks">
                  {phase.tasks.map((task) => (
                    <div key={task.role} className="ded-opfor-task">
                      <span>{task.roleLabel}</span>
                      <em>{task.taskLabel}</em>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="ded-opfor-block">
            <p className="ded-opfor-label">Indicators BLUE can read</p>
            {adversary.indicators.length ? (
              <ul className="ded-opfor-indicators">
                {[...adversary.indicators].reverse().map((indicator, i) => (
                  <li key={`${indicator.atH}-${i}`}>
                    <span>T+{indicator.atH}h</span>
                    {indicator.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ded-opfor-quiet">
                RED has given nothing away yet. Against a coastal force that is itself worth noticing.
              </p>
            )}
          </div>
          {canReveal ? (
            <ActionRow>
              <Button icon={ShieldAlert} variant="secondary" onClick={onReveal} disabled={busy}>
                {busy ? "Revealing" : "Reveal to players"}
              </Button>
            </ActionRow>
          ) : null}
        </>
      )}
    </div>
  );
}

// Adjudication modifier row (keeps the two-column key/value rhythm).
function FragmentRow({ rule, factor }: { rule: string; factor: number }) {
  return (
    <>
      <span className="ded-adj-rule">{rule}</span>
      <em>× {factor.toFixed(2)}</em>
    </>
  );
}

function ScoreDrawer({ branch, decidedCount }: { branch: Branch; decidedCount: number }) {
  const score = branch.score;
  return (
    <div className="ded-drawer-body">
      {score ? (
        <>
          <div className="ded-score-head">
            <span className="blue">{score.blue.total}</span>
            <span className="ded-score-net">{score.net >= 0 ? `BLUE +${score.net}` : `RED +${Math.abs(score.net)}`}</span>
            <span className="red">{score.red.total}</span>
          </div>
          <div className="ded-score-rows">
            {(
              [
                ["Objective points", score.blue.objective, score.red.objective],
                ["Remaining force", score.blue.force, score.red.force],
                ["Combat score", score.blue.combat, score.red.combat],
                ["Total", score.blue.total, score.red.total],
              ] as Array<[string, number, number]>
            ).map(([label, blue, red]) => (
              <div key={label} className="ded-score-row">
                <span className="blue">{blue}</span>
                <span className="ded-score-label">{label}</span>
                <span className="red">{red}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="ded-orbat-empty">Scoreboard is computed live for runs started after this update.</p>
      )}
      <div className="detail-stack">
        <ProgressBar label="Objectives" value={branch.metrics.objectiveScore} tone="good" />
        <ProgressBar label="BLUE strength" value={branch.metrics.blueStrength} tone="info" />
        <ProgressBar label="RED strength" value={branch.metrics.redStrength} tone="danger" />
        <ProgressBar label="BLUE supply" value={branch.metrics.supplyLevel} tone="warn" />
        <DetailGrid>
          <Detail label="BLUE losses" value={String(branch.metrics.blueLosses)} />
          <Detail label="RED losses" value={String(branch.metrics.redLosses)} />
          <Detail label="Events" value={String(branch.eventCount)} />
          <Detail label="Decisions" value={`${decidedCount}/${branch.decisions.length}`} />
        </DetailGrid>
        <div className="ded-spark-row">
          <small>BLUE strength over time</small>
          <Sparkline values={branch.metricsHistory.map((m) => m.blueStrength)} color={sideColors.blue} />
        </div>
        <div className="ded-spark-row">
          <small>RED strength over time</small>
          <Sparkline values={branch.metricsHistory.map((m) => m.redStrength)} color={sideColors.red} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Launcher({
  runs,
  boot,
  scenarioId,
  setScenarioId,
  launchCoas,
  pickedCoaIds,
  setPickedCoaIds,
  ruleSets,
  ruleSetId,
  setRuleSetId,
  whiteCell,
  adversaryPlans,
  redPlanId,
  setRedPlanId,
  engine,
  setEngine,
  speed,
  setSpeed,
  label,
  setLabel,
  onLaunch,
  onOpen,
  goToAssessment,
}: {
  runs: RunSummary[];
  boot: Bootstrap | null;
  scenarioId: string;
  setScenarioId: (v: string) => void;
  launchCoas: Coa[];
  pickedCoaIds: string[];
  setPickedCoaIds: (v: string[]) => void;
  ruleSets: RuleSet[];
  ruleSetId: string;
  setRuleSetId: (v: string) => void;
  whiteCell: boolean;
  adversaryPlans: AdversaryPlanSummary[];
  redPlanId: string;
  setRedPlanId: (v: string) => void;
  engine: EngineKind;
  setEngine: (v: EngineKind) => void;
  speed: "1" | "2" | "4";
  setSpeed: (v: "1" | "2" | "4") => void;
  label: string;
  setLabel: (v: string) => void;
  onLaunch: () => void;
  onOpen: (id: string) => void;
  goToAssessment: () => void;
}) {
  const scenarios = (boot?.scenarios ?? []).filter((s) => s.status === "ready" || s.status === "running");
  const openRuns = runs.filter((r) => r.status !== "completed" && r.status !== "aborted");
  const doneRuns = runs.filter((r) => r.status === "completed" || r.status === "aborted");
  const activePlan = adversaryPlans.find((p) => p.id === redPlanId) ?? null;

  return (
    <div className="page-body">
      <div className="split-grid wide-left">
        <Panel icon={Rocket} title="Launch a deduction run">
          <div className="detail-stack">
            <FormGrid columns={2}>
              <Field label="Scenario">
                <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.codename}, {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Rule set">
                <select value={ruleSetId} onChange={(e) => setRuleSetId(e.target.value)}>
                  {ruleSets.map((rs) => (
                    <option key={rs.id} value={rs.id}>
                      {rs.name} ({rs.status})
                    </option>
                  ))}
                </select>
              </Field>
            </FormGrid>
            <Field label={`COA branches to run in parallel (${pickedCoaIds.length} picked)`}>
              <div className="ded-launch-coas">
                {launchCoas.length ? (
                  launchCoas.map((coa) => {
                    const checked = pickedCoaIds.includes(coa.id);
                    return (
                      <label key={coa.id} className={`ded-coa-check${checked ? " checked" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setPickedCoaIds(checked ? pickedCoaIds.filter((x) => x !== coa.id) : [...pickedCoaIds, coa.id])
                          }
                        />
                        <span className="ded-branch-dot" style={{ background: coa.color }} />
                        <span className="ded-coa-name">
                          <strong>{coa.name}</strong>
                          <small>{coa.approach}</small>
                        </span>
                        <Tag label={`composite ${coa.scores.composite}`} />
                      </label>
                    );
                  })
                ) : (
                  <EmptyState
                    icon={Radar}
                    title="No selected COAs for this scenario"
                    hint="Select or generate COAs in Data & COA Generation first, only selected or previously simulated COAs can be committed to deduction."
                  />
                )}
              </div>
            </Field>
            <Field label="OPFOR plan">
              <div className="ded-advplan">
                {whiteCell ? (
                  <>
                    <select value={redPlanId} onChange={(e) => setRedPlanId(e.target.value)}>
                      {adversaryPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.codename}, {plan.name}
                        </option>
                      ))}
                    </select>
                    {activePlan ? (
                      <div className="ded-advplan-brief">
                        <p>{activePlan.summary}</p>
                        <DetailGrid>
                          <Detail label="Fires" value={activePlan.firesNote} />
                          <Detail label="Risk RED accepts" value={activePlan.risk} />
                        </DetailGrid>
                        <small>
                          Every branch faces this same plan and meets the same dice on the same events, so what separates them is the
                          friendly plan. This brief is white-cell material and is not shown to a commander.
                        </small>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="ded-advplan-withheld">
                    Exercise control sets the opposing plan. You are told one exists, which is the whole of what a commander is
                    entitled to before the reveal.
                  </p>
                )}
              </div>
            </Field>
            <FormGrid columns={3}>
              <Field label="Engine">
                <select value={engine} onChange={(e) => setEngine(e.target.value as EngineKind)}>
                  <option value="realtime">Real-time engine</option>
                  <option value="turn-based">Turn-based engine</option>
                </select>
              </Field>
              <Field label="Speed">
                <select value={speed} onChange={(e) => setSpeed(e.target.value as "1" | "2" | "4")}>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="4">4x</option>
                </select>
              </Field>
              <Field label="Run label">
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Strait rehearsal 3" />
              </Field>
            </FormGrid>
            <ActionRow>
              <Button icon={Play} onClick={onLaunch} disabled={!pickedCoaIds.length}>
                Start deduction
              </Button>
            </ActionRow>
          </div>
        </Panel>

        <Panel icon={Radar} title="Runs">
          <div className="detail-stack">
            {openRuns.length ? (
              <ObjectList
                rows={openRuns.map((r) => ({
                  id: r.id,
                  title: r.label,
                  meta: `${r.scenarioName} | ${plural(r.branchCount, "branch", "branches")} | T+${Math.round(r.simTimeH)}h`,
                  tone: statusTone(r.status),
                  status: r.status,
                }))}
                onSelect={onOpen}
              />
            ) : (
              <EmptyState icon={Radar} title="No live runs" hint="Start a deduction on the left, branches run in parallel, one per COA." />
            )}
            {doneRuns.length ? (
              <>
                <p className="rc-subhead" style={{ margin: "6px 0 0" }}>
                  Completed
                </p>
                <ObjectList
                  rows={doneRuns.slice(0, 5).map((r) => ({
                    id: r.id,
                    title: r.label,
                    meta: `${r.scenarioName} | finished ${r.completedAt ? timeAgo(r.completedAt) : "-"}`,
                    tone: statusTone(r.status),
                    status: r.status,
                  }))}
                  onSelect={onOpen}
                />
                <ActionRow>
                  <Button icon={ListChecks} variant="secondary" onClick={goToAssessment}>
                    Assessment &amp; Replay
                  </Button>
                </ActionRow>
              </>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InterventionModal({
  branchUnits,
  onClose,
  onSubmit,
}: {
  branchUnits: Array<{ id: string; name: string; side: string; position: LatLng }>;
  onClose: () => void;
  onSubmit: (type: InterventionType, params: Record<string, string | number>) => void;
}) {
  const [type, setType] = useState<InterventionType>("inject-event");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("warn");
  const [unitId, setUnitId] = useState("");
  const [amount, setAmount] = useState("40");
  const [lat, setLat] = useState("23.85");
  const [lng, setLng] = useState("61.5");
  const [weather, setWeather] = useState("storm");
  const blueUnits = branchUnits.filter((u) => u.side === "blue");

  function submit() {
    const params: Record<string, string | number> = {};
    if (type === "inject-event") {
      if (!title.trim()) return;
      params.title = title.trim();
      params.severity = severity;
    }
    if (type === "resupply") {
      if (unitId) params.unitId = unitId;
      params.amount = Number(amount) || 40;
    }
    if (type === "withdraw-unit" || type === "move-unit") {
      if (!unitId) return;
      params.unitId = unitId;
    }
    if (type === "move-unit") {
      params.lat = Number(lat);
      params.lng = Number(lng);
    }
    if (type === "set-weather") params.weather = weather;
    onSubmit(type, params);
  }

  return (
    <Modal title="White-cell intervention" onClose={onClose}>
      <Field label="Intervention type">
        <select value={type} onChange={(e) => setType(e.target.value as InterventionType)}>
          <option value="inject-event">Inject event</option>
          <option value="resupply">Emergency resupply</option>
          <option value="move-unit">Retask unit</option>
          <option value="withdraw-unit">Withdraw unit</option>
          <option value="set-weather">Set weather</option>
        </select>
      </Field>
      {type === "inject-event" ? (
        <FormGrid columns={2}>
          <Field label="Event title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Merchant traffic enters the strait" />
          </Field>
          <Field label="Severity">
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="danger">Critical</option>
              <option value="good">Positive</option>
            </select>
          </Field>
        </FormGrid>
      ) : null}
      {type === "resupply" || type === "withdraw-unit" || type === "move-unit" ? (
        <Field label={type === "resupply" ? "Unit (blank = whole BLUE force)" : "Unit"}>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">{type === "resupply" ? "Entire BLUE force" : "Choose a unit…"}</option>
            {(type === "resupply" ? blueUnits : branchUnits).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {type === "resupply" ? (
        <Field label="Amount (supply points)">
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min={5} max={100} />
        </Field>
      ) : null}
      {type === "move-unit" ? (
        <FormGrid columns={2}>
          <Field label="Latitude">
            <input type="number" step="0.05" value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Longitude">
            <input type="number" step="0.05" value={lng} onChange={(e) => setLng(e.target.value)} />
          </Field>
        </FormGrid>
      ) : null}
      {type === "set-weather" ? (
        <Field label="Weather">
          <select value={weather} onChange={(e) => setWeather(e.target.value)}>
            <option value="clear">Clear</option>
            <option value="overcast">Overcast</option>
            <option value="storm">Storm</option>
          </select>
        </Field>
      ) : null}
      <ActionRow>
        <Button icon={Wand2} onClick={submit}>
          Apply intervention
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

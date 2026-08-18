import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Crosshair,
  Gauge,
  ListChecks,
  MapPinned,
  Pause,
  Play,
  Radar,
  Rocket,
  SkipForward,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./deduction.css";
import {
  ApiError,
  controlRun,
  decideBranch,
  fetchBootstrap,
  fetchCoas,
  fetchRun,
  fetchRuns,
  fetchRuleSets,
  intervene,
  startRun,
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
} from "../components";
import { eventTones, sideColors, statusTone } from "../data";
import TheaterMap from "../map";
import type { PageProps } from "../shell";
import type {
  Bootstrap,
  Coa,
  EngineKind,
  InterventionType,
  LatLng,
  RuleSet,
  RunSummary,
  Scenario,
  SimRun,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

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
  const trailsRef = useRef<Record<string, LatLng[]>>({});
  const canIntervene = profile.id === "operator" || profile.id === "admin";

  // Launcher state
  const [scenarioId, setScenarioId] = useState("");
  const [launchCoas, setLaunchCoas] = useState<Coa[]>([]);
  const [pickedCoaIds, setPickedCoaIds] = useState<string[]>([]);
  const [ruleSetId, setRuleSetId] = useState("");
  const [engine, setEngine] = useState<EngineKind>("realtime");
  const [speed, setSpeed] = useState<"1" | "2" | "4">("2");
  const [label, setLabel] = useState("");

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

  const applyRun = useCallback((next: SimRun) => {
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
  }, []);

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
      });
      trailsRef.current = {};
      applyRun(next);
      setActiveRunId(next.id);
      notify(`Deduction started — ${next.branches.length} branch(es) in parallel`);
    } catch (error) {
      notify(errMsg(error));
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
      notify("Decision issued — branch resuming");
    } catch (error) {
      notify(errMsg(error));
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

  return (
    <div className="page-body">
      <div className="ded-header">
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            setActiveRunId(null);
            setRun(null);
            fetchRuns().then(setRuns).catch(() => undefined);
          }}
        >
          <ChevronLeft size={16} />
          Runs
        </button>
        <span className="sim-clock">
          <Clock size={15} />
          {simClock(run.clock.simTimeH)}
          <small>tick {run.clock.tick}</small>
        </span>
        <StatusPill label={run.status} tone={statusTone(run.status)} />
        <Tag label={`${run.engine} · ${run.clock.speed}x`} />
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
            <CheckCircle2 size={17} style={{ verticalAlign: "-3px" }} /> Deduction complete — {run.label}
          </strong>
          <div className="ded-complete-grid">
            {run.branches.map((b) => (
              <div key={b.id}>
                <Detail label={b.name} value={`Objectives ${b.metrics.objectiveScore}% · BLUE ${b.metrics.blueStrength}% · RED ${b.metrics.redStrength}%`} />
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
        <div className="ded-decision">
          <div className="ded-decision-head">
            <AlertTriangle size={19} color="var(--amber)" />
            <strong>Commander decision required — {openDecision.title}</strong>
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
            <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Optional — why this option…" />
          </Field>
        </div>
      ) : null}

      {branch && scenario ? (
        <div className="split-grid wide-left">
          <Panel icon={MapPinned} title={`Theater — ${branch.name}`} action={<Tag label={`${branch.units.filter((u) => u.status === "active" || u.status === "damaged").length} pieces active`} />}>
            <TheaterMap
              center={scenario.mapCenter}
              zoom={scenario.mapZoom}
              units={branch.units}
              theater={boot?.theater ?? []}
              objectives={scenario.objectives}
              trails={trails}
              events={branch.recentEvents.filter((e) => e.position).slice(0, 6)}
              height={470}
            />
          </Panel>
          <div className="ded-metric-stack">
            <Panel icon={Gauge} title="Correlation of forces">
              <div className="detail-stack">
                <ProgressBar label="BLUE strength" value={branch.metrics.blueStrength} tone="info" />
                <ProgressBar label="RED strength" value={branch.metrics.redStrength} tone="danger" />
                <ProgressBar label="Objectives" value={branch.metrics.objectiveScore} tone="good" />
                <ProgressBar label="BLUE supply" value={branch.metrics.supplyLevel} tone="warn" />
                <DetailGrid>
                  <Detail label="BLUE losses" value={String(branch.metrics.blueLosses)} />
                  <Detail label="RED losses" value={String(branch.metrics.redLosses)} />
                  <Detail label="Events" value={String(branch.eventCount)} />
                  <Detail label="Decisions" value={`${decidedDecisions.length}/${branch.decisions.length}`} />
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
            </Panel>
          </div>
        </div>
      ) : null}

      {branch ? (
        <div className="split-grid equal">
          <Panel icon={Activity} title="Event stream" action={<Tag label={`${branch.eventCount} total`} />}>
            <div className="ded-event-list">
              <ObjectList
                rows={branch.recentEvents.map((event) => ({
                  id: event.id,
                  title: event.title,
                  meta: `${simClock(event.simTimeH)} · ${event.detail}`,
                  tone: eventTones[event.type] ?? "neutral",
                  status: event.type,
                }))}
              />
            </div>
          </Panel>
          <Panel icon={Crosshair} title="Decision record">
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
              <EmptyState icon={BrainCircuit} title="No decisions yet" hint="Decision points pause the branch and surface options with a SAGE recommendation. Intent and decision are retained by the commander." />
            )}
          </Panel>
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
                      {s.codename} — {s.name}
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
                    hint="Select or generate COAs in Data & COA Generation first — only selected or previously simulated COAs can be committed to deduction."
                  />
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
                  meta: `${r.scenarioName} · ${r.branchCount} branch(es) · T+${Math.round(r.simTimeH)}h`,
                  tone: statusTone(r.status),
                  status: r.status,
                }))}
                onSelect={onOpen}
              />
            ) : (
              <EmptyState icon={Radar} title="No live runs" hint="Start a deduction on the left — branches run in parallel, one per COA." />
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
                    meta: `${r.scenarioName} · finished ${r.completedAt ? timeAgo(r.completedAt) : "-"}`,
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
  const [lat, setLat] = useState("34.0");
  const [lng, setLng] = useState("-40.5");
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

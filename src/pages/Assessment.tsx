import {
  Activity,
  BarChart3,
  BrainCircuit,
  Clock,
  FileCheck2,
  ListChecks,
  MapPinned,
  Pause,
  Play,
  Split,
  Target,
  FileText,
  Rewind,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./assessment.css";
import {
  ApiError,
  assessRun,
  fetchAssessments,
  fetchBootstrap,
  fetchReplay,
  fetchRuns,
  generateReport,
  resumeFromBreakpoint,
} from "../api";
import {
  ActionRow,
  BarRow,
  Button,
  CompactTable,
  Detail,
  DetailGrid,
  EmptyState,
  Metric,
  MetricGrid,
  ObjectList,
  Panel,
  Segmented,
  StatusPill,
  SvgRadar,
  Tag,
  simClock,
  timeAgo,
} from "../components";
import { eventTones, sideColors, statusTone } from "../data";
import TheaterMap, { type MapUnit } from "../map";
import type { PageProps } from "../shell";
import type {
  Assessment as AssessmentRecord,
  Bootstrap,
  Domain,
  ReplayData,
  RunReport,
  RunSummary,
  SideId,
  Unit,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

const dimTone = (score: number) => (score >= 75 ? "var(--primary)" : score >= 50 ? "var(--blue)" : score >= 35 ? "var(--amber)" : "var(--red)");

export default function Assessment({ notify, goTo }: PageProps) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState("");
  const [assessments, setAssessments] = useState<AssessmentRecord[]>([]);
  const [branchId, setBranchId] = useState("");
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [frame, setFrame] = useState(0);
  const [report, setReport] = useState<RunReport | null>(null);
  const [reporting, setReporting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const playTimer = useRef<number | undefined>(undefined);

  const completedRuns = useMemo(() => runs.filter((r) => r.status === "completed"), [runs]);
  const run = completedRuns.find((r) => r.id === runId);
  const runAssessments = assessments.filter((a) => a.runId === runId);
  const assessment = runAssessments.find((a) => a.branchId === branchId) ?? runAssessments[0];

  useEffect(() => {
    let alive = true;
    Promise.all([fetchBootstrap(), fetchRuns()])
      .then(([b, r]) => {
        if (!alive) return;
        setBoot(b);
        setRuns(r);
        const done = r.filter((x) => x.status === "completed");
        if (done.length) setRunId(done[done.length - 1].id);
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

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    fetchAssessments(runId)
      .then((data) => {
        if (!alive) return;
        setAssessments((list) => [...list.filter((a) => a.runId !== runId), ...data]);
        if (data.length) setBranchId(data[0].branchId);
      })
      .catch((error) => alive && notify(errMsg(error)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Replay data per branch
  useEffect(() => {
    if (!runId || !assessment) {
      setReplay(null);
      return;
    }
    let alive = true;
    setPlaying(false);
    setFrame(0);
    fetchReplay(runId, assessment.branchId)
      .then((data) => alive && setReplay(data))
      .catch(() => alive && setReplay(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, assessment?.branchId]);

  // Play loop
  useEffect(() => {
    window.clearInterval(playTimer.current);
    if (!playing || !replay) return;
    playTimer.current = window.setInterval(() => {
      setFrame((f) => {
        if (!replay || f >= replay.snapshots.length - 1) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, 550);
    return () => window.clearInterval(playTimer.current);
  }, [playing, replay]);

  const scenario = boot?.scenarios.find((s) => s.id === run?.scenarioId);
  const unitIndex = useMemo(() => {
    const index: Record<string, Unit> = {};
    for (const s of boot?.scenarios ?? []) for (const u of s.units) index[u.id] = u;
    return index;
  }, [boot]);

  const snapshot = replay?.snapshots[Math.min(frame, (replay?.snapshots.length ?? 1) - 1)];
  const replayUnits: MapUnit[] = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.units.map((u) => {
      const base = unitIndex[u.id];
      const side: SideId = base?.side ?? (u.id.startsWith("red") ? "red" : "blue");
      const domain: Domain = base?.domain ?? "sea";
      return {
        id: u.id,
        side,
        name: base?.name ?? u.id,
        domain,
        position: u.position,
        headingDeg: u.headingDeg,
        status: u.status,
        strength: u.strength,
        detectedByEnemy: u.detectedByEnemy,
      };
    });
  }, [snapshot, unitIndex]);

  const snapshotEvents = useMemo(() => {
    if (!replay || !snapshot) return [];
    return replay.events.filter((e) => e.tick <= snapshot.tick).slice(-10).reverse();
  }, [replay, snapshot]);

  async function generate() {
    if (!runId) return;
    setGenerating(true);
    try {
      const data = await assessRun(runId);
      setAssessments((list) => [...list.filter((a) => a.runId !== runId), ...data]);
      if (data.length) setBranchId(data[0].branchId);
      notify(`${data.length} branch assessment(s) generated`);
    } catch (error) {
      notify(errMsg(error));
    }
    setGenerating(false);
  }
  async function handleGenerateReport() {
    if (!runId || reporting) return;
    setReporting(true);
    try {
      const next = await generateReport(runId);
      setReport(next);
      notify(
        next.source === "anthropic"
          ? "After-action report written by the reasoning service"
          : "After-action report composed from the run figures"
      );
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setReporting(false);
    }
  }

  async function handleResume() {
    if (!runId || !branchId || !snapshot || resuming) return;
    setResuming(true);
    try {
      const next = await resumeFromBreakpoint(runId, branchId, snapshot.tick, 4);
      notify(`Forked a live run from T+${Math.round(snapshot.simTimeH)}h, opening the war room`);
      goTo("deduction");
      void next;
    } catch (e) {
      notify(errMsg(e));
    } finally {
      setResuming(false);
    }
  }


  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={BarChart3} title="Loading assessment data" hint="Fetching completed runs and computed assessments." />
      </div>
    );
  }

  if (!completedRuns.length) {
    return (
      <div className="page-body">
        <EmptyState
          icon={BarChart3}
          title="No completed deduction runs yet"
          hint="Run a full-process deduction to completion and its branches will be assessed here."
        />
        <ActionRow>
          <Button icon={Activity} onClick={() => goTo("deduction")}>
            Open Full-Process Deduction
          </Button>
        </ActionRow>
      </div>
    );
  }

  return (
    <div className="page-body">
      <div className="asm-verdict-row">
        <label className="field" style={{ minWidth: 320 }}>
          <span>Completed run</span>
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            {completedRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}, {r.scenarioName} ({r.completedAt ? timeAgo(r.completedAt) : "…"})
              </option>
            ))}
          </select>
        </label>
        {runAssessments.length > 1 ? (
          <Segmented
            value={assessment?.branchId ?? ""}
            onChange={setBranchId}
            items={runAssessments.map((a) => ({ id: a.branchId, label: a.branchName }))}
          />
        ) : null}
        {!runAssessments.length ? (
          <Button icon={FileCheck2} onClick={generate} disabled={generating}>
            {generating ? "Scoring…" : "Generate assessment"}
          </Button>
        ) : null}
      </div>

      {assessment ? (
        <>
          <MetricGrid>
            <Metric label="Overall score" value={`${assessment.overallScore}/100`} helper={assessment.coaName} tone={statusTone(assessment.verdict)} />
            <Metric label="Verdict" value={assessment.verdict.replace("-", " ")} helper="Weighted across 5 dimensions" tone={statusTone(assessment.verdict)} />
            <Metric label="Loss exchange" value={`${assessment.lossExchangeRatio.toFixed(1)} : 1`} helper="RED losses per BLUE loss" tone={assessment.lossExchangeRatio >= 2 ? "good" : "warn"} />
            <Metric
              label="Decisions"
              value={`${assessment.decisionStats.followedAi}/${assessment.decisionStats.total} with AI`}
              helper={`${assessment.decisionStats.overridden} commander override(s)`}
              tone="info"
            />
          </MetricGrid>

          <div className="split-grid equal">
            <Panel icon={BarChart3} title="Assessment dimensions">
              <div className="detail-stack">
                {assessment.dimensions.map((dim) => (
                  <div key={dim.name}>
                    <BarRow label={`${dim.name} (${Math.round(dim.weight * 100)}%)`} value={dim.score} max={100} color={dimTone(dim.score)} />
                    <small style={{ color: "var(--muted)", fontSize: 12 }}>{dim.detail}</small>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel icon={Target} title="Objective results">
              <CompactTable
                columns={["Objective", "Result", "Completion"]}
                rows={assessment.objectiveResults.map((obj) => [
                  obj.title,
                  <StatusPill key="s" label={obj.achieved ? "achieved" : "not achieved"} tone={obj.achieved ? "good" : "danger"} />,
                  <span key="c" className="asm-obj-completion">
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${obj.completion}%`, background: obj.achieved ? "var(--primary)" : "var(--amber)", display: "block", height: "100%" }} />
                    </span>
                    {obj.completion}%
                  </span>,
                ])}
              />
              <div style={{ marginTop: 12 }}>
                <DetailGrid>
                  <Detail label="Branch" value={assessment.branchName} />
                  <Detail label="Generated" value={timeAgo(assessment.generatedAt)} />
                </DetailGrid>
              </div>
            </Panel>
          </div>

          <Panel icon={BrainCircuit} title="SAGE commentary & recommendations">
            <div className="detail-stack">
              <p className="asm-commentary">{assessment.aiCommentary}</p>
              <ul className="asm-recs">
                {assessment.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            </div>
          </Panel>

          {replay && snapshot && scenario ? (
            <Panel
              icon={MapPinned}
              title="Replay"
              action={
                <span className="sim-clock">
                  <Clock size={14} />
                  {simClock(snapshot.simTimeH)}
                  <small>
                    frame {frame + 1}/{replay.snapshots.length}
                  </small>
                </span>
              }
            >
              <div className="detail-stack">
                <div className="asm-replay-controls">
                  <Button icon={playing ? Pause : Play} variant="secondary" onClick={() => setPlaying((p) => !p)}>
                    {playing ? "Pause" : "Play"}
                  </Button>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, replay.snapshots.length - 1)}
                    value={frame}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrame(Number(e.target.value));
                    }}
                  />
                  <Tag label={`BLUE ${Math.round(snapshot.metrics.blueStrength)}%`} color={sideColors.blue} />
                  <Tag label={`RED ${Math.round(snapshot.metrics.redStrength)}%`} color={sideColors.red} />
                  <Tag label={`OBJ ${snapshot.metrics.objectiveScore}%`} />
                  <Button
                    icon={Rewind}
                    variant="secondary"
                    onClick={handleResume}
                    disabled={resuming}
                    title="Fork a live run from this moment and take a different decision path"
                  >
                    {resuming ? "Forking run…" : "Resume from here"}
                  </Button>
                </div>
                <div className="split-grid wide-left">
                  <TheaterMap
                    center={scenario.mapCenter}
                    zoom={scenario.mapZoom}
                    units={replayUnits}
                    theater={boot?.theater ?? []}
                    objectives={scenario.objectives}
                    worldKey={`replay:${runId}:${assessment?.branchId ?? ""}`}
                    glideSpeed="fast"
                    height={430}
                  />
                  <div className="asm-events">
                    <ObjectList
                      rows={snapshotEvents.map((event) => ({
                        id: event.id,
                        title: event.title,
                        meta: `${simClock(event.simTimeH)} · ${event.detail}`,
                        tone: eventTones[event.type] ?? "neutral",
                        status: event.type,
                      }))}
                    />
                  </div>
                </div>
              </div>
            </Panel>
          ) : null}

          {runAssessments.length > 1 ? (
            <Panel icon={Split} title="Branch comparison">
              <div className="detail-stack">
                <div className="asm-compare-radar">
                  <SvgRadar
                    axes={runAssessments[0].dimensions.map((d) => d.name.split(" ")[0])}
                    series={runAssessments.map((a, i) => ({
                      name: a.branchName,
                      color: ["#1f5f99", "#7c3aed", "#0d8a8a", "#b45309"][i % 4],
                      values: a.dimensions.map((d) => d.score),
                    }))}
                    size={260}
                  />
                  <div className="detail-stack">
                    <div className="asm-legend">
                      {runAssessments.map((a, i) => (
                        <span key={a.id}>
                          <i style={{ background: ["#1f5f99", "#7c3aed", "#0d8a8a", "#b45309"][i % 4] }} />
                          {a.branchName}, {a.overallScore}/100 ({a.verdict.replace("-", " ")})
                        </span>
                      ))}
                    </div>
                    <CompactTable
                      columns={["Branch", "Overall", "Verdict", "LER", ...runAssessments[0].dimensions.map((d) => d.name.split(" ")[0])]}
                      rows={runAssessments.map((a) => [
                        a.branchName,
                        `${a.overallScore}`,
                        a.verdict.replace("-", " "),
                        `${a.lossExchangeRatio.toFixed(1)}:1`,
                        ...a.dimensions.map((d) => String(Math.round(d.score))),
                      ])}
                    />
                  </div>
                </div>
              </div>
            </Panel>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={ListChecks}
          title="No assessment for this run yet"
          hint="Generate the assessment to score every branch across mission accomplishment, force preservation, tempo, resource efficiency and decision quality."
        />
      )}

      <Panel
        icon={FileText}
        title="After-action report"
        action={
          <ActionRow>
            {report ? (
              <Tag
                label={report.source === "anthropic" ? "reasoning service" : "composed from figures"}
                color={report.source === "anthropic" ? "var(--blue)" : undefined}
              />
            ) : null}
            <Button icon={FileText} onClick={handleGenerateReport} disabled={reporting || !runId}>
              {reporting ? "Writing report…" : report ? "Regenerate" : "Generate report"}
            </Button>
          </ActionRow>
        }
      >
        {report ? (
          <div className="asm-report">
            <header className="asm-report-head">
              <strong>{report.runLabel}</strong>
              <span>
                {report.scenarioName} · T+{Math.round(report.simTimeH)}h · generated {timeAgo(report.generatedAt)}
              </span>
            </header>
            <div className="asm-report-figures">
              {report.branches.map((b) => (
                <div key={b.name} className="asm-report-figure">
                  <strong>{b.name}</strong>
                  <span>
                    {b.verdict}
                    {b.overall !== null ? ` · ${b.overall}/100` : ""}
                  </span>
                  <em>
                    OBJ {b.objectiveScore}% · BLUE {Math.round(b.blueStrength)}% · RED {Math.round(b.redStrength)}% · LER {b.lossExchange}:1 ·
                    {" "}
                    {b.decisionsFollowed}/{b.decisionsTotal} with AI
                  </em>
                </div>
              ))}
            </div>
            {report.sections.map((sec) => (
              <section key={sec.heading} className="asm-report-section">
                <h4>{sec.heading}</h4>
                <p>{sec.body}</p>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title="No report generated yet"
            hint="Generates a director-ready document from this run: verdicts per branch, the decision record, and observations with optimisation recommendations."
          />
        )}
      </Panel>
    </div>
  );
}

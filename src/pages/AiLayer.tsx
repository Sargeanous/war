import { Activity, Bot, BrainCircuit, Eye, GitBranch, Joystick, Landmark, Network, Target, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "./ailayer.css";
import { ApiError, fetchAgentActivity, fetchBootstrap, fetchRun } from "../api";
import {
  Detail,
  DetailGrid,
  EmptyState,
  Metric,
  MetricGrid,
  Modal,
  Panel,
  ProgressBar,
  StatusPill,
  Tag,
  simClock,
  timeAgo,
  plural,
} from "../components";
import { driveModeHints, driveModeLabels, statusTone } from "../data";
import type { PageProps } from "../shell";
import type { AgentActivity, AgentDef, Bootstrap, DecisionPoint, DriveMode, SimRun } from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

const DRIVE_ORDER: DriveMode[] = ["knowledge-reasoning", "data-learning", "operations-research", "large-model", "hybrid"];

interface DecisionRow {
  runLabel: string;
  branchName: string;
  decision: DecisionPoint;
}

export default function AiLayer({ notify }: PageProps) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [decisionRows, setDecisionRows] = useState<DecisionRow[]>([]);
  const [inspecting, setInspecting] = useState<AgentDef | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchBootstrap(), fetchAgentActivity().catch(() => [] as AgentActivity[])])
      .then(async ([b, acts]) => {
        if (!alive) return;
        setBoot(b);
        setActivity(acts);
        // Decision history: pull the 3 most recent runs in detail.
        const recent = [...b.runs].sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt))).slice(-3);
        const rows: DecisionRow[] = [];
        for (const summary of recent) {
          try {
            const run: SimRun = await fetchRun(summary.id);
            for (const branch of run.branches) {
              for (const decision of branch.decisions) {
                if (decision.status === "decided") rows.push({ runLabel: run.label, branchName: branch.name, decision });
              }
            }
          } catch {
            /* run may have been pruned */
          }
        }
        if (alive) {
          rows.sort((a, b) => b.decision.tick - a.decision.tick);
          setDecisionRows(rows);
          setLoading(false);
        }
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

  const agents = boot?.agents ?? [];
  const missions = boot?.missions ?? [];
  const platform = boot?.platform;
  const readyCount = agents.filter((a) => a.status === "ready").length;
  const followed = decisionRows.filter((r) => r.decision.followedAi).length;

  const agentActivity = useMemo(
    () => (inspecting ? activity.filter((a) => a.agentId === inspecting.id).slice(0, 8) : []),
    [inspecting, activity]
  );

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={BrainCircuit} title="Loading the AI layer" hint="Fetching missions, the agent library and decision history." />
      </div>
    );
  }

  return (
    <div className="page-body">
      <MetricGrid>
        <Metric label="Agents ready" value={`${readyCount}/${agents.length}`} helper="Tactical agent library" tone="good" />
        <Metric label="Missions decomposed" value={String(missions.filter((m) => m.subTasks.length).length)} helper="Strategic tasking" tone="info" />
        <Metric
          label="Decisions with AI"
          value={decisionRows.length ? `${followed}/${decisionRows.length}` : "-"}
          helper="Across recent runs"
          tone={decisionRows.length && followed / Math.max(decisionRows.length, 1) >= 0.5 ? "good" : "neutral"}
        />
        <Metric
          label="API calls"
          value={platform ? formatCount(platform.apiStats.observationCalls + platform.apiStats.pieceDriveCalls) : "-"}
          helper="Observation + piece-drive"
          tone="info"
        />
      </MetricGrid>

      <div className="ail-columns">
        {/* Column 1, strategic */}
        <div className="ail-col">
          <Panel icon={Target} title="Strategic - Task decomposition">
            <div className="detail-stack">
              <div className="ail-flow">
                <span className="ail-flow-chip" style={{ borderColor: "var(--primary)", background: "var(--primary-soft)" }}>
                  Operational Mission
                </span>
                <span className="ail-flow-arrow">→</span>
                <span className="ail-flow-chip" style={{ borderColor: "var(--primary)", background: "var(--primary-soft)" }}>
                  Sub-tasks
                </span>
                <span className="ail-flow-arrow">→</span>
                <span className="ail-flow-chip" style={{ borderColor: "var(--primary)", background: "var(--primary-soft)" }}>
                  Mission agents
                </span>
              </div>
              {missions.map((mission) => (
                <article key={mission.id} className="ail-mission-card">
                  <header>
                    <Landmark size={15} />
                    <strong>{mission.title}</strong>
                    <StatusPill label={mission.status} tone={statusTone(mission.status)} />
                  </header>
                  <p className="ail-intent">{mission.intent}</p>
                  {mission.subTasks.length ? (
                    <div className="ail-task-mini">
                      {mission.subTasks.slice(0, 6).map((task) => (
                        <span key={task.id}>
                          <GitBranch size={12} />
                          {task.title}
                          <em>{task.assignedAgentId ? task.assignedAgentId.replace("agt-", "").replace(/-\d+$/, "") : "unassigned"}</em>
                        </span>
                      ))}
                      {mission.subTasks.length > 6 ? (
                        <span>
                          <GitBranch size={12} />… {plural(mission.subTasks.length - 6, "more sub-task")}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="ail-note">Not decomposed yet, run decomposition from Data &amp; COA Generation.</p>
                  )}
                </article>
              ))}
            </div>
          </Panel>
        </div>

        {/* Column 2, tactical agent library */}
        <div className="ail-col">
          <Panel icon={Bot} title="Tactical - Agent library by drive mode">
            <div className="detail-stack">
              {DRIVE_ORDER.map((mode) => {
                const group = agents.filter((a) => a.driveMode === mode);
                if (!group.length) return null;
                return (
                  <div key={mode} className="ail-drive-group">
                    <div className="ail-drive-head">
                      <strong>{driveModeLabels[mode]}</strong>
                      <small>{driveModeHints[mode]}</small>
                    </div>
                    <div className="ail-agent-grid">
                      {group.map((agent) => (
                        <button key={agent.id} type="button" className="ail-agent-card" onClick={() => setInspecting(agent)}>
                          <header>
                            <Bot size={15} />
                            <strong>{agent.name}</strong>
                            <StatusPill label={agent.status} tone={statusTone(agent.status)} />
                          </header>
                          <Tag label={agent.specialty} />
                          <ProgressBar label="Win rate" value={agent.metrics.winRate * 100} tone={agent.metrics.winRate >= 0.7 ? "good" : "warn"} />
                          <span className="ail-agent-meta">
                            {agent.metrics.avgLatencyMs} ms | {formatCount(agent.metrics.trainingEpisodes)} episodes | v{agent.version}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        {/* Column 3, human + AI decision */}
        <div className="ail-col">
          <Panel icon={Workflow} title="Human + AI collaborative decision">
            <div className="detail-stack">
              <div className="ail-flow">
                <span className="ail-flow-chip">Situation analysis (O)</span>
                <span className="ail-flow-arrow">→</span>
                <span className="ail-flow-chip">Mission planning (O)</span>
                <span className="ail-flow-arrow">→</span>
                <span className="ail-flow-chip">Human-AI decision (D)</span>
                <span className="ail-flow-arrow">→</span>
                <span className="ail-flow-chip">Action (A)</span>
              </div>
              <p className="ail-note">↻ Effectiveness assessment feeds back, intent &amp; decision retained by the commander.</p>
              {decisionRows.length ? (
                decisionRows.slice(0, 8).map(({ runLabel, branchName, decision }) => (
                  <article key={decision.id} className="ail-decision-row">
                    <header>
                      <BrainCircuit size={14} />
                      <strong>{decision.title}</strong>
                      <Tag
                        label={decision.followedAi ? "Followed SAGE" : "Commander override"}
                        color={decision.followedAi ? "var(--blue)" : "var(--amber)"}
                      />
                    </header>
                    <small>
                      {runLabel} | {branchName} | {simClock(decision.simTimeH)}, chose “
                      {decision.options.find((o) => o.id === decision.decidedOptionId)?.label ?? decision.decidedOptionId}”
                      {decision.decisionRationale ? ` | “${decision.decisionRationale}”` : ""}
                    </small>
                  </article>
                ))
              ) : (
                <EmptyState icon={BrainCircuit} title="No decision history yet" hint="Commander decisions from deduction runs appear here with their AI-recommendation outcomes." />
              )}
            </div>
          </Panel>

          <Panel icon={Network} title="Wargame system APIs">
            <div className="detail-stack">
              <DetailGrid>
                <Detail label="Observation API" value={platform ? `${formatCount(platform.apiStats.observationCalls)} calls` : "-"} />
                <Detail label="Piece-drive API" value={platform ? `${formatCount(platform.apiStats.pieceDriveCalls)} calls` : "-"} />
                <Detail label="Avg latency" value={platform ? `${platform.apiStats.avgLatencyMs} ms` : "-"} />
              </DetailGrid>
              <p className="ail-note">
                <Eye size={13} style={{ verticalAlign: "-2px" }} /> Observation API ↑ sense | <Joystick size={13} style={{ verticalAlign: "-2px" }} /> Piece-drive API ↓ execute
              </p>
            </div>
          </Panel>
        </div>
      </div>

      {inspecting ? (
        <Modal title={inspecting.name} onClose={() => setInspecting(null)} wide>
          <DetailGrid>
            <Detail label="Drive mode" value={driveModeLabels[inspecting.driveMode]} />
            <Detail label="Specialty" value={inspecting.specialty} />
            <Detail label="Version" value={inspecting.version} />
            <Detail label="Status" value={inspecting.status} />
            <Detail label="Win rate" value={`${Math.round(inspecting.metrics.winRate * 100)}%`} />
            <Detail label="Latency" value={`${inspecting.metrics.avgLatencyMs} ms`} />
            <Detail label="Episodes" value={formatCount(inspecting.metrics.trainingEpisodes)} />
            <Detail label="Last evaluated" value={timeAgo(inspecting.metrics.lastEvaluated)} />
          </DetailGrid>
          <p className="ail-intent">{inspecting.description}</p>
          <div>
            <p className="rc-subhead" style={{ margin: "0 0 8px" }}>
              Recent activity (latest run)
            </p>
            {agentActivity.length ? (
              agentActivity.map((entry) => (
                <div key={entry.id} className="ail-activity-row">
                  <Tag label={entry.api} color={entry.api === "observation" ? "var(--blue)" : "var(--primary)"} />
                  <div className="ail-activity-main">
                    <strong>{entry.action}</strong>
                    <small>
                      {simClock(entry.simTimeH)}, {entry.rationale}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="ail-note">
                <Activity size={13} style={{ verticalAlign: "-2px" }} /> No calls recorded for this agent in the latest run.
              </p>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Orders and staff products. The platform could read an operational order and
// could not write one, and the phase-to-assignment-to-subtask join it already
// computed rendered nowhere. This page is where a plan leaves the machine as
// paper: the five-paragraph order, the synchronisation matrix, the decision
// support matrix, and the fragmentary orders cut when a commander overrides.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCopy,
  Download,
  FileText,
  GitBranch,
  Grid3x3,
  ListChecks,
  Printer,
  ScrollText,
} from "lucide-react";
import "./orders.css";
import { ApiError, fetchBootstrap, fetchClassification, fetchCoaOrders, fetchRunFragos, fetchRuns } from "../api";
import {
  ActionRow,
  Button,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  FormGrid,
  Panel,
  Segmented,
  StatusPill,
  Tag,
  plural,
  timeAgo,
} from "../components";
import type { PageProps } from "../shell";
import type {
  Bootstrap,
  Coa,
  ClassificationState,
  Frago,
  OpordParagraph,
  OrdersResult,
  RunSummary,
  SyncRow,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

type Tab = "order" | "sync" | "dsm" | "frago";

const SOURCE_LABEL: Record<string, string> = {
  "phase boundary": "Phase boundary",
  contact: "First contact",
  attrition: "Attrition threshold",
  "rule set": "Rule set",
};

export default function Orders({ notify, profile }: PageProps) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [classification, setClassification] = useState<ClassificationState | null>(null);
  const [scenarioId, setScenarioId] = useState("");
  const [coaId, setCoaId] = useState("");
  const [orders, setOrders] = useState<OrdersResult | null>(null);
  const [tab, setTab] = useState<Tab>("order");
  const [syncBy, setSyncBy] = useState<"formation" | "unit">("formation");
  const [runId, setRunId] = useState("");
  const [fragos, setFragos] = useState<Frago[]>([]);
  const [fragoText, setFragoText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchBootstrap(), fetchRuns(), fetchClassification()])
      .then(([b, r, c]) => {
        if (!alive) return;
        setBoot(b);
        setRuns(r);
        setClassification(c);
        const ready = b.scenarios.find((s) => s.status === "ready") ?? b.scenarios[0];
        setScenarioId(ready ? ready.id : "");
        const done = r.find((x) => x.status === "completed") ?? r[0];
        setRunId(done ? done.id : "");
        setLoading(false);
      })
      .catch((error) => {
        if (!alive) return;
        setLoading(false);
        notify(errMsg(error));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coas: Coa[] = useMemo(() => {
    if (!boot || !scenarioId) return [];
    return boot.coas.filter((c) => c.scenarioId === scenarioId);
  }, [boot, scenarioId]);

  useEffect(() => {
    if (!coas.length) {
      setCoaId("");
      return;
    }
    setCoaId((current) => (coas.some((c) => c.id === current) ? current : (coas.find((c) => c.status === "selected") ?? coas[0]).id));
  }, [coas]);

  const loadOrders = useCallback(
    async (id: string) => {
      if (!id) {
        setOrders(null);
        return;
      }
      setBusy(true);
      try {
        setOrders(await fetchCoaOrders(id, `${profile.name}, ${profile.role}`));
      } catch (error) {
        setOrders(null);
        notify(errMsg(error));
      } finally {
        setBusy(false);
      }
    },
    [notify, profile.name, profile.role]
  );

  useEffect(() => {
    loadOrders(coaId);
  }, [coaId, loadOrders]);

  useEffect(() => {
    if (!runId) {
      setFragos([]);
      setFragoText("");
      return;
    }
    let alive = true;
    fetchRunFragos(runId)
      .then((result) => {
        if (!alive) return;
        setFragos(result.fragos);
        setFragoText(result.text);
      })
      .catch(() => {
        if (alive) {
          setFragos([]);
          setFragoText("");
        }
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  function copyText(text: string, what: string) {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => notify(`${what} copied to the clipboard`))
      .catch(() => notify("The browser refused clipboard access"));
  }

  function downloadText(text: string, filename: string) {
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    notify(`${filename} saved`);
  }

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={ScrollText} title="Loading staff products" hint="Fetching scenarios, courses of action and the platform marking." />
      </div>
    );
  }

  const marking = classification ? classification.marking : "MARKING UNAVAILABLE";
  const scenarios = boot?.scenarios ?? [];
  const syncRows: SyncRow[] = orders ? (syncBy === "formation" ? orders.sync.rows : orders.sync.unitRows) : [];
  const idle = orders ? (syncBy === "formation" ? orders.sync.idle : orders.sync.idleUnits) : [];

  return (
    <div className="page-body ord-page">
      <div className="ord-marking top">{marking}</div>

      <Panel icon={FileText} title="Plan products">
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
            <Field label="Course of action">
              <select value={coaId} onChange={(e) => setCoaId(e.target.value)}>
                {coas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.status})
                  </option>
                ))}
              </select>
            </Field>
          </FormGrid>
          {orders ? (
            <DetailGrid>
              <Detail label="Order" value={orders.opord.title} />
              <Detail label="DTG" value={orders.opord.dtg} />
              <Detail label="Issued by" value={orders.opord.issuedBy} />
              <Detail label="Marking" value={orders.opord.marking} />
            </DetailGrid>
          ) : null}
          <div className="ord-tabs">
            {(
              [
                { id: "order" as const, label: "Operation order", icon: ScrollText },
                { id: "sync" as const, label: "Synchronisation matrix", icon: Grid3x3 },
                { id: "dsm" as const, label: "Decision support", icon: ListChecks },
                { id: "frago" as const, label: "Fragmentary orders", icon: GitBranch },
              ] as Array<{ id: Tab; label: string; icon: typeof ScrollText }>
            ).map((entry) => (
              <button key={entry.id} type="button" className={`ord-tab${tab === entry.id ? " active" : ""}`} onClick={() => setTab(entry.id)}>
                <entry.icon size={13} />
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {tab === "order" ? (
        <Panel icon={ScrollText} title={orders ? orders.opord.title : "Operation order"}>
          {orders ? (
            <div className="detail-stack">
              <ActionRow>
                <Button icon={ClipboardCopy} variant="secondary" onClick={() => copyText(orders.text, "Operation order")} disabled={busy}>
                  Copy
                </Button>
                <Button
                  icon={Download}
                  variant="secondary"
                  onClick={() => downloadText(orders.text, `OPORD-${orders.opord.number}-${orders.opord.scenarioId}.txt`)}
                  disabled={busy}
                >
                  Download
                </Button>
                <Button icon={Printer} variant="secondary" onClick={() => window.print()} disabled={busy}>
                  Print
                </Button>
              </ActionRow>
              <div className="ord-doc">
                <div className="ord-doc-head">
                  <strong>{orders.opord.title}</strong>
                  <span>{orders.opord.issuedBy}</span>
                  <span>DTG {orders.opord.dtg}</span>
                </div>
                {orders.opord.references.length ? (
                  <div className="ord-refs">
                    <p className="ord-label">References</p>
                    <ul>
                      {orders.opord.references.map((ref) => (
                        <li key={ref}>{ref}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {orders.opord.paragraphs.map((paragraph) => (
                  <Paragraph key={paragraph.id} paragraph={paragraph} />
                ))}
                <div className="ord-annex-list">
                  <p className="ord-label">Annexes</p>
                  <ul>
                    {orders.opord.annexes.map((annex) => (
                      <li key={annex.id}>
                        <span className="ord-mark">{annex.mark}</span> Annex {annex.id}, {annex.title}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={ScrollText}
              title="No course of action selected"
              hint="Pick a scenario and a course of action above. The order is composed from the plan that already exists, so it can never claim something the simulation does not hold."
            />
          )}
        </Panel>
      ) : null}

      {tab === "sync" ? (
        <Panel icon={Grid3x3} title="Synchronisation matrix">
          {orders && orders.sync.phases.length ? (
            <div className="detail-stack">
              <div className="ord-sync-controls">
                <Segmented
                  value={syncBy}
                  onChange={(v) => setSyncBy(v as "formation" | "unit")}
                  items={[
                    { id: "formation", label: "By task organisation" },
                    { id: "unit", label: "By unit" },
                  ]}
                />
                <small>
                  Phases across the top, the force down the side, what each element is doing in each phase in the cells. Every cell names
                  the mission sub-task the tasking serves, which is the join the plan already carried and never showed.
                </small>
              </div>
              <div className="ord-matrix-scroll">
                <table className="ord-matrix">
                  <thead>
                    <tr>
                      <th className="ord-matrix-corner">{syncBy === "formation" ? "Task organisation" : "Unit"}</th>
                      {orders.sync.phases.map((phase) => (
                        <th key={phase.id}>
                          <strong>{phase.name}</strong>
                          <small>{phase.window}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {syncRows.map((row) => (
                      <tr key={row.groupId}>
                        <th scope="row">
                          <strong>{row.group}</strong>
                          <small>{syncBy === "formation" ? plural(row.units.length, "unit") : row.taskForce ?? "unassigned"}</small>
                        </th>
                        {row.cells.map((cell) => (
                          <td key={cell.phaseId} className={cell.tasks.length ? "" : "empty"}>
                            {cell.tasks.length ? (
                              cell.tasks.map((task, i) => (
                                <div key={`${task.action}-${i}`} className="ord-cell-task">
                                  <strong>{task.action}</strong>
                                  {task.subTaskTitle ? <em>{task.subTaskTitle}</em> : null}
                                  {task.legs ? <small>{plural(task.legs, "leg")}</small> : null}
                                </div>
                              ))
                            ) : (
                              <span className="ord-cell-empty">holds</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {idle.length ? (
                <p className="ord-gap">
                  Tasked in no phase at all: {idle.join(", ")}. That is a planning gap, not a rendering one.
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState icon={Grid3x3} title="No phases to synchronise" hint="The selected course of action carries no phases." />
          )}
        </Panel>
      ) : null}

      {tab === "dsm" ? (
        <Panel icon={ListChecks} title="Decision support matrix">
          {orders ? (
            <div className="detail-stack">
              <p className="ord-lead">
                The decisions this plan will force, written down before it is run. The engine raises these same four families at
                execution: a phase commitment, first contact, an attrition threshold, and anything the rule set asks the commander to
                rule on. Deciding the criteria now, in the quiet, is the whole point.
              </p>
              {orders.dsm.rows.map((row) => (
                <div key={row.id} className="ord-dsm">
                  <header>
                    <strong>{row.decision}</strong>
                    <Tag label={SOURCE_LABEL[row.source] ?? row.source} />
                  </header>
                  <DetailGrid>
                    <Detail label="Trigger" value={row.trigger} />
                    <Detail label="Latest time to decide" value={row.ltiov} />
                    <Detail label="What to watch" value={row.watch} />
                    <Detail label="Decision authority" value={row.decider} />
                  </DetailGrid>
                  <div className="ord-dsm-criteria">
                    <p className="ord-label">Criteria</p>
                    <ul>
                      {row.criteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="ord-dsm-options">
                    {row.options.map((option) => (
                      <span key={option} className="ord-option">
                        {option}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {orders.dsm.namedAreas.length ? (
                <div className="ord-nai">
                  <p className="ord-label">Named areas of interest</p>
                  {orders.dsm.namedAreas.map((area) => (
                    <div key={area.id} className="ord-nai-row">
                      <strong>{area.title}</strong>
                      <small>
                        {area.radiusKm} km around {area.centre.lat.toFixed(2)}N {area.centre.lng.toFixed(2)}E
                      </small>
                      <p>{area.why}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState icon={ListChecks} title="No plan selected" hint="Pick a course of action to see the decisions it will force." />
          )}
        </Panel>
      ) : null}

      {tab === "frago" ? (
        <Panel icon={GitBranch} title="Fragmentary orders">
          <div className="detail-stack">
            <Field label="Run">
              <select value={runId} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} ({r.status})
                  </option>
                ))}
              </select>
            </Field>
            {fragos.length ? (
              <>
                <ActionRow>
                  <Button icon={ClipboardCopy} variant="secondary" onClick={() => copyText(fragoText, plural(fragos.length, "fragmentary order"))}>
                    Copy all
                  </Button>
                  <Button icon={Download} variant="secondary" onClick={() => downloadText(fragoText, `FRAGO-${runId}.txt`)}>
                    Download
                  </Button>
                </ActionRow>
                {fragos.map((frago) => (
                  <div key={frago.id} className={`ord-frago${frago.followedMachine ? "" : " override"}`}>
                    <header>
                      <div>
                        <strong>{frago.title}</strong>
                        <small>
                          {frago.branchName} | DTG {frago.dtg} | {timeAgo(frago.issuedAt)}
                        </small>
                      </div>
                      <StatusPill
                        label={frago.followedMachine ? "followed the machine" : "commander override"}
                        tone={frago.followedMachine ? "info" : "warn"}
                      />
                    </header>
                    <p className="ord-frago-line">{frago.situation}</p>
                    <p className="ord-frago-line change">{frago.change}</p>
                    <p className="ord-frago-line">{frago.unchanged}</p>
                    <p className="ord-frago-line quiet">{frago.rationale}</p>
                    <p className="ord-frago-line quiet">{frago.machineLine}</p>
                    <footer>Issued by {frago.issuedBy}</footer>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState
                icon={GitBranch}
                title="No fragmentary orders on this run"
                hint="A fragmentary order is cut every time a commander rules on a decision point. Run a deduction and resolve a decision to see one here."
              />
            )}
          </div>
        </Panel>
      ) : null}

      <div className="ord-marking bottom">{marking}</div>
    </div>
  );
}

// Paragraphs carry their own portion mark, so a reader can see which part of the
// document earned the marking at the head and foot of it.
function Paragraph({ paragraph, depth = 0 }: { paragraph: OpordParagraph; depth?: number }) {
  return (
    <div className={`ord-para depth-${depth}`}>
      <p className="ord-para-head">
        {paragraph.id}. {depth === 0 ? paragraph.title.toUpperCase() : paragraph.title}
      </p>
      {paragraph.text ? (
        <p className="ord-para-text">
          <span className="ord-mark">{paragraph.mark}</span> {paragraph.text}
        </p>
      ) : null}
      {(paragraph.sub ?? []).map((sub) => (
        <Paragraph key={sub.id} paragraph={sub} depth={depth + 1} />
      ))}
    </div>
  );
}

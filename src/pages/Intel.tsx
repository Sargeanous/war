// Intel - the intel-to-COA bridge. BASEER pushes normalised cues, SANDTABLE works
// one cue from arrival to a live scenario: identify the contact, task collection,
// release it under a named human, log the product, confirm the target, then
// generate the scenario. SANDTABLE runs no detection of its own, it only consumes
// cues. Every step that commits anything is signed by a person, never by a seat.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FileCheck,
  Inbox,
  Radar,
  RefreshCw,
  Satellite,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import "./intel.css";
import {
  ApiError,
  approveCollection,
  confirmCue,
  dismissCue,
  fetchBootstrap,
  fetchCollectionOptions,
  fetchIntelCue,
  fetchIntelCues,
  handOffScenario,
  fetchGovernance,
  fetchRequirements,
  identifyCue,
  interrogateCue,
  reportCollection,
  requestCollection,
  spawnScenarioFromCue,
  syncIntelFeed,
} from "../api";
import {
  ActionRow,
  Button,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  Modal,
  StatusPill,
  Tag,
  timeAgo,
} from "../components";
import TheaterMap from "../map";
import type { MapFocus, MapUnit } from "../map";
import { frameColor } from "../milsym";
import type { PageProps } from "../shell";
import type {
  CollectionOption,
  CollectionTask,
  HandoffRecord,
  IntelCue,
  IntelEntity,
  Objective,
  TheaterFeature,
  Tone,
  GovernancePolicy,
  RequirementsBoard,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

type LadderStep = "cued" | "identified" | "tasked" | "collected" | "confirmed" | "scenario";
type ActionId = "identify" | "request" | "approve" | "report" | "confirm" | "spawn" | "dismiss";
// The steps that end with a person's name on the record. Identify joins them only
// when the autonomy policy makes it human-required.
type SignedAction = "confirm" | "spawn" | "identify";

interface AskTurn {
  id: string;
  question: string;
  askedAt: string;
  answer: string | null;
  source: string | null;
  latencyMs: number | null;
  answeredAt: string | null;
  handoff: HandoffRecord | null;
}

const THEATER_CENTER = { lat: 23.85, lng: 61.1 };

const severityColors: Record<IntelCue["severity"], string> = {
  critical: "var(--red)",
  high: "var(--amber)",
  medium: "var(--blue)",
  low: "var(--muted)",
};

const severityTones: Record<IntelCue["severity"], Tone> = {
  critical: "danger",
  high: "warn",
  medium: "info",
  low: "neutral",
};

const stateTones: Record<IntelCue["state"], Tone> = {
  new: "info",
  reviewing: "warn",
  confirmed: "good",
  spawned: "good",
  dismissed: "neutral",
};

const originLabels: Record<IntelCue["origin"], string> = {
  focalpoint: "Focal point",
  chokepoint: "Chokepoint",
  surge: "Traffic surge",
  conflict: "Conflict signal",
  event: "Event feed",
};

const kindDomains: Record<IntelEntity["kind"], MapUnit["domain"]> = {
  vessel: "sea",
  aircraft: "air",
  ground: "land",
  facility: "land",
};

const ladder: Array<{ id: LadderStep; label: string }> = [
  { id: "cued", label: "Cued" },
  { id: "identified", label: "Identified" },
  { id: "tasked", label: "Collection tasked" },
  { id: "collected", label: "Collected" },
  { id: "confirmed", label: "Confirmed" },
  { id: "scenario", label: "Scenario" },
];

const starters = [
  "What is the most likely intent?",
  "What would raise confidence fastest?",
  "What in the evidence argues against this reading?",
];

const modelLabel = (source: string | null) =>
  source === "anthropic" ? "reasoning service" : source === "offline" ? "offline knowledge" : "not applicable";

// Audit rows need the exact moment rather than a relative one.
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const text = at.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)}Z`;
}

function zoomForRadius(radiusKm: number): number {
  if (radiusKm <= 15) return 10;
  if (radiusKm <= 35) return 9;
  if (radiusKm <= 70) return 8;
  return 7;
}

function reachedSteps(cue: IntelCue): Set<LadderStep> {
  const reached = new Set<LadderStep>(["cued"]);
  if (cue.assessment) reached.add("identified");
  if (cue.collection.length) reached.add("tasked");
  if (cue.collection.some((task) => task.status === "collected")) reached.add("collected");
  if (cue.state === "confirmed" || cue.state === "spawned") reached.add("confirmed");
  if (cue.state === "spawned") reached.add("scenario");
  return reached;
}

// The records behind a card are the ones the backend addressed to that step by
// id. Nothing is matched on the wording of the action verb: that text is free
// prose, the verbs overlap, and a guessed row in an audit trail is worse than an
// honest gap. A step with no logged record renders as exactly that.
function recordsFor(cue: IntelCue, ids: Array<string | null | undefined>): HandoffRecord[] {
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0));
  if (!wanted.size) return [];
  const seen = new Set<string>();
  const found: HandoffRecord[] = [];
  for (const record of cue.handoffs) {
    if (!wanted.has(record.id) || seen.has(record.id)) continue;
    seen.add(record.id);
    found.push(record);
  }
  return found;
}

function taskRecords(cue: IntelCue, task: CollectionTask): HandoffRecord[] {
  return recordsFor(cue, [task.requestHandoffId, task.approveHandoffId, task.collectHandoffId]);
}

// A dismissed cue is terminal, so the dismissal is the last thing a human did to
// it. That is a fact about the shape of the trail, not a guess about its wording.
function dismissalRecord(cue: IntelCue): HandoffRecord | null {
  if (cue.state !== "dismissed") return null;
  for (let i = cue.handoffs.length - 1; i >= 0; i -= 1) {
    if (cue.handoffs[i].kind === "human") return cue.handoffs[i];
  }
  return null;
}

// A side answers "whose force is this", and for a track BASEER has not
// identified there is no answer, so an unidentified track sits with the tracks
// that are not ours and takes the APP-6 unknown frame rather than the hostile
// diamond. Neutral is a positive call with consequences of its own, so only a
// declared neutral plots neutral. Map and list then read the track the same way.
function trackSide(entity: IntelEntity): MapUnit["side"] {
  return entity.affiliation === "neutral" ? "neutral" : "red";
}

function trackLabel(entity: IntelEntity, confirmed: boolean): string {
  if (entity.affiliation === "neutral") return entity.name;
  if (entity.affiliation === "unknown") return `UNID ${entity.name}`;
  return confirmed ? entity.name : `POSS ${entity.name}`;
}

function affiliationReading(entity: IntelEntity, confirmed: boolean): string {
  if (entity.affiliation === "neutral") return "declared neutral";
  if (entity.affiliation === "unknown") return "unidentified";
  return confirmed ? "confirmed hostile" : "possible hostile";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const indicatorTones: Record<string, Tone> = {
  open: "neutral",
  indicated: "warn",
  answered: "good",
};

// The commander's standing questions, above the feed rather than beside it. A cue
// that answers indicator 2A inside NORTH CHANNEL is intelligence; the same cue with
// nothing to anchor it to is a notification.
function RequirementsBanner({
  board,
  open,
  onToggle,
  onFocus,
}: {
  board: RequirementsBoard | null;
  open: boolean;
  onToggle: () => void;
  onFocus: (focus: MapFocus) => void;
}) {
  if (!board) return null;
  const answered = board.pirs.reduce((sum, p) => sum + p.answered, 0);
  const total = board.pirs.reduce((sum, p) => sum + p.total, 0);
  return (
    <section className="intel-pir">
      <header className="intel-pir-head">
        <button type="button" className="intel-pir-toggle" onClick={onToggle}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Commander's priority intelligence requirements</span>
        </button>
        <div className="intel-pir-summary">
          <StatusPill label={`${answered} of ${total} indicators answered`} tone={answered === total ? "good" : "warn"} />
          {board.outstanding.length ? (
            <StatusPill label={`${plural(board.outstanding.length, "indicator")} still open`} tone="neutral" />
          ) : null}
        </div>
      </header>
      {open ? (
        <div className="intel-pir-body">
          {board.pirs.map((pir) => (
            <article key={pir.id} className={`intel-pir-card ${pir.status}`}>
              <div className="intel-pir-question">
                <span className="intel-pir-number">PIR {pir.number}</span>
                <strong>{pir.question}</strong>
              </div>
              <div className="intel-pir-progress" aria-hidden="true">
                <i style={{ width: `${pir.total ? (pir.answered / pir.total) * 100 : 0}%` }} />
              </div>
              <p className="intel-pir-decision">Feeds the decision: {pir.decision}</p>
              <div className="intel-pir-indicators">
                {pir.indicators.map((indicator) => {
                  const area = board.namedAreas.find((a) => a.id === indicator.naiId);
                  return (
                    <div key={indicator.id} className={`intel-pir-ind ${indicator.status}`}>
                      <div className="intel-pir-ind-head">
                        <span className="intel-pir-letter">{indicator.letter}</span>
                        <StatusPill label={indicator.status} tone={indicatorTones[indicator.status] ?? "neutral"} />
                        <button
                          type="button"
                          className="intel-pir-nai"
                          onClick={() => (area ? onFocus({ ...area.centre, zoom: zoomForRadius(area.radiusKm), token: Date.now() }) : undefined)}
                          title={area ? area.why : undefined}
                        >
                          NAI {indicator.naiName}
                        </button>
                      </div>
                      <p>{indicator.text}</p>
                      {indicator.cues.length ? (
                        indicator.cues.map((hit) => (
                          <p key={hit.cueId} className="intel-pir-hit">
                            <span>{hit.title}</span>
                            {hit.because.join(" ")}
                          </p>
                        ))
                      ) : (
                        <p className="intel-pir-hit open">Nothing has answered this. It is what collection should be pointed at.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function Intel({ notify, goTo, profile }: PageProps) {
  const [cues, setCues] = useState<IntelCue[]>([]);
  const [cueId, setCueId] = useState<string | null>(null);
  const [cue, setCue] = useState<IntelCue | null>(null);
  const [theater, setTheater] = useState<TheaterFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [cueLoading, setCueLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Record<string, AskTurn[]>>({});
  const [options, setOptions] = useState<CollectionOption[] | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [approveTaskId, setApproveTaskId] = useState<string | null>(null);
  const [signFor, setSignFor] = useState<SignedAction | null>(null);
  // The name typed into whichever gate is open. Prefilled from the access profile
  // and editable, because the record has to name the person, not the seat.
  const [signer, setSigner] = useState(profile.name);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [spawnedNames, setSpawnedNames] = useState<Record<string, string>>({});
  const [entityId, setEntityId] = useState<string | null>(null);
  // The autonomy policy in force. It decides which of these buttons will run on
  // their own and which refuse without a name, so the page reads it rather than
  // hard-coding the answer it was written with.
  const [governance, setGovernance] = useState<GovernancePolicy | null>(null);
  // The commander's standing questions. Every cue is anchored to the indicator it
  // answers, so an alert arrives as intelligence rather than as a notification.
  const [board, setBoard] = useState<RequirementsBoard | null>(null);
  const [boardOpen, setBoardOpen] = useState(true);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  // Cue ids already seen by this page. Seeded on the first pass so entering the
  // page never announces the backlog, only a cue that lands while watching.
  const knownIdsRef = useRef<Set<string> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // The cue the operator is looking at right now, read by responses that were
  // already in flight when they moved on.
  const selectedRef = useRef<string | null>(null);
  // Every inbox read carries a token. A response is applied only if it is still
  // the newest read issued and no cue mutation landed while it was in flight, so
  // a slow poll can never paint over a state the operator just changed.
  const listTokenRef = useRef(0);
  const listAppliedRef = useRef(0);
  const mutationsRef = useRef(0);
  // A counter rather than a clock, so two turns can never share a key.
  const turnSeqRef = useRef(0);

  /** Is this action currently gated on a named human? */
  const requiresHuman = useCallback(
    (actionId: string) => {
      const action = governance?.actions.find((a) => a.id === actionId);
      return action ? action.autonomy === "human-required" : false;
    },
    [governance]
  );

  const applyList = useCallback(
    (list: IntelCue[], announce: boolean) => {
      setCues(list);
      const before = knownIdsRef.current;
      knownIdsRef.current = new Set(list.map((item) => item.id));
      if (!announce || !before) return;
      const fresh = list.filter((item) => !before.has(item.id));
      if (fresh.length) {
        const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
        notify(`BASEER pushed a cue: ${fresh[0].title}${more}`);
      }
    },
    [notify]
  );

  const loadList = useCallback(
    async (announce: boolean): Promise<IntelCue[] | null> => {
      const token = (listTokenRef.current += 1);
      const mutations = mutationsRef.current;
      const list = await fetchIntelCues();
      if (token <= listAppliedRef.current || mutationsRef.current !== mutations) return null;
      listAppliedRef.current = token;
      applyList(list, announce);
      return list;
    },
    [applyList]
  );

  useEffect(() => {
    let alive = true;
    Promise.all([loadList(false), fetchBootstrap(), fetchGovernance(), fetchRequirements()])
      .then(([, boot, policy, requirements]) => {
        if (!alive) return;
        setTheater(boot.theater);
        setGovernance(policy);
        setBoard(requirements);
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

  // The feed keeps arriving while the operator works a cue, so the inbox polls
  // and announces anything that lands unprompted.
  useEffect(() => {
    const timer = window.setInterval(() => {
      loadList(true).catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadList]);

  useEffect(() => {
    selectedRef.current = cueId;
    if (!cueId) {
      setCue(null);
      return;
    }
    let alive = true;
    setCueLoading(true);
    fetchIntelCue(cueId)
      .then((fresh) => {
        if (!alive) return;
        setCue(fresh);
        setEntityId(null);
        setMapFocus({ lat: fresh.geo.lat, lng: fresh.geo.lng, zoom: zoomForRadius(fresh.geo.radiusKm), token: Date.now() });
      })
      .catch((error) => {
        if (alive) notify(errMsg(error));
      })
      .finally(() => {
        if (alive) setCueLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueId]);

  const turnCount = cueId ? (turns[cueId] ?? []).length : 0;
  useEffect(() => {
    const node = transcriptRef.current;
    if (node && turnCount) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [turnCount, asking]);

  // Every mutation is re-read through fetchIntelCue so the transcript, the
  // inbox row and the map all render one payload. The operator may have moved to
  // another cue while the read was in flight: the inbox row still takes the
  // update, the open investigation only if it is still the same cue.
  // The board is derived from every cue's state, so anything that moves a cue
  // moves the board. Fetched once at mount it would sit frozen through the exact
  // demo it exists for: confirm the target, watch the commander's question get
  // answered. Failures are swallowed on purpose; a stale board is worth more than
  // a page that falls over because a secondary read failed.
  const refreshBoard = useCallback(() => {
    fetchRequirements()
      .then(setBoard)
      .catch(() => undefined);
  }, []);

  const reload = useCallback(
    async (id: string) => {
      const fresh = await fetchIntelCue(id);
      mutationsRef.current += 1;
      if (selectedRef.current === fresh.id) setCue(fresh);
      setCues((list) => list.map((item) => (item.id === fresh.id ? fresh : item)));
      refreshBoard();
      return fresh;
    },
    [refreshBoard]
  );

  function selectCue(id: string) {
    selectedRef.current = id;
    setCueId(id);
  }

  async function runAction(action: ActionId, work: () => Promise<void>) {
    if (busy) return;
    setBusy(action);
    try {
      await work();
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function doSync() {
    if (syncing) return;
    setSyncing(true);
    const before = new Set(cues.map((item) => item.id));
    try {
      const sync = await syncIntelFeed();
      const list = await loadList(false);
      refreshBoard();
      const fresh = list ? list.filter((item) => !before.has(item.id)) : [];
      notify(
        fresh.length
          ? `${plural(fresh.length, "new cue")} from ${sync.source === "baseer" ? "BASEER" : "the replay feed"}, latest ${fresh[0].title}`
          : `Feed synced, ${plural(sync.count, "cue")} offered, nothing new`
      );
    } catch (error) {
      notify(errMsg(error));
    } finally {
      setSyncing(false);
    }
  }

  function doIdentify() {
    if (!cue) return;
    // Under a human-required policy the name has to be typed deliberately for this
    // step. Reading whatever is left in `signer` would sign one person's name to
    // another person's act.
    if (requiresHuman("intel.identify") && signFor !== "identify") {
      setSigner(profile.name);
      setSignFor("identify");
      return;
    }
    const id = cue.id;
    const identifiedBy = requiresHuman("intel.identify") ? signer.trim() : "";
    if (requiresHuman("intel.identify") && !identifiedBy) {
      notify("Enter your name, this identification is governed as human required");
      return;
    }
    runAction("identify", async () => {
      await identifyCue(id, identifiedBy || undefined);
      const fresh = await reload(id);
      setSignFor((current) => (current === "identify" ? null : current));
      notify(
        fresh.assessment
          ? `SAGE reads this as ${fresh.assessment.unitType}, ${fresh.assessment.confidence}% confidence`
          : "Identification returned no assessment"
      );
    });
  }

  function openOptions() {
    if (!cue) return;
    setOptions(null);
    setOptionsOpen(true);
    fetchCollectionOptions(cue.id)
      .then((result) => setOptions(result.options))
      .catch((error) => {
        setOptionsOpen(false);
        notify(errMsg(error));
      });
  }

  function doRequest(optionIndex: number) {
    if (!cue) return;
    const id = cue.id;
    runAction("request", async () => {
      await requestCollection(id, optionIndex, profile.name);
      const fresh = await reload(id);
      setOptionsOpen(false);
      const task = fresh.collection[fresh.collection.length - 1];
      notify(task ? `Tasking ${task.taskingId} raised on ${task.asset}, held for approval` : "Collection requested");
    });
  }

  function doApprove() {
    if (!cue || !approveTaskId) return;
    const name = signer.trim();
    if (!name) {
      notify("Enter the approver name, collection is never released unattributed");
      return;
    }
    const id = cue.id;
    const taskId = approveTaskId;
    runAction("approve", async () => {
      await approveCollection(id, taskId, name);
      const fresh = await reload(id);
      setApproveTaskId(null);
      notify(`Collection released by ${name}, confidence now ${fresh.confidence}%`);
    });
  }

  // The asset flew and reported. Landing the product is its own operator step, so
  // the release and the result never share a timestamp or a record.
  function doReport() {
    if (!cue || !flyingTask) return;
    const id = cue.id;
    const taskId = flyingTask.id;
    const asset = flyingTask.asset;
    runAction("report", async () => {
      await reportCollection(id, taskId, profile.name);
      const fresh = await reload(id);
      notify(`Product from ${asset} logged against the tasking, confidence now ${fresh.confidence}%`);
    });
  }

  function doConfirm() {
    if (!cue) return;
    const name = signer.trim();
    if (!name) {
      notify("Enter your name, a target is never confirmed unattributed");
      return;
    }
    const id = cue.id;
    runAction("confirm", async () => {
      await confirmCue(id, name);
      const fresh = await reload(id);
      setSignFor(null);
      notify(`Target confirmed by ${name} at ${fresh.confidence}%, the contact now reads Confirmed`);
    });
  }

  function doSpawn() {
    if (!cue) return;
    const name = signer.trim();
    if (!name) {
      notify("Enter your name, the scenario is generated under a person, not a seat");
      return;
    }
    const id = cue.id;
    runAction("spawn", async () => {
      const result = await spawnScenarioFromCue(id, name);
      setSpawnedNames((names) => ({ ...names, [id]: result.scenario.name }));
      await reload(id);
      setSignFor(null);
      notify(`Scenario generated by ${name}, ${result.scenario.name}`);
    });
  }

  function doDismiss() {
    if (!cue) return;
    const name = signer.trim();
    if (!name) {
      notify("Enter your name, a cue is never closed unattributed");
      return;
    }
    const why = reason.trim();
    if (!why) {
      notify("Give a reason, the dismissal is recorded against your name");
      return;
    }
    const id = cue.id;
    runAction("dismiss", async () => {
      await dismissCue(id, name, why);
      await reload(id);
      setDismissOpen(false);
      setReason("");
      notify(`Cue dismissed by ${name}, the reason is retained in the hand-off record`);
    });
  }

  async function doAsk(text: string) {
    if (!cue || asking) return;
    const asked = text.trim();
    if (!asked) return;
    const id = cue.id;
    const turnId = `q-${(turnSeqRef.current += 1)}`;
    setTurns((all) => ({
      ...all,
      [id]: [
        ...(all[id] ?? []),
        {
          id: turnId,
          question: asked,
          askedAt: new Date().toISOString(),
          answer: null,
          source: null,
          latencyMs: null,
          answeredAt: null,
          handoff: null,
        },
      ],
    }));
    setQuestion("");
    setAsking(true);
    try {
      const result = await interrogateCue(id, asked, requiresHuman("intel.interrogate") ? profile.name : undefined);
      setTurns((all) => ({
        ...all,
        [id]: (all[id] ?? []).map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                answer: result.answer,
                source: result.source,
                latencyMs: result.latencyMs,
                answeredAt: new Date().toISOString(),
                handoff: result.handoff,
              }
            : turn
        ),
      }));
      await reload(id);
    } catch (error) {
      setTurns((all) => ({ ...all, [id]: (all[id] ?? []).filter((turn) => turn.id !== turnId) }));
      notify(errMsg(error));
    } finally {
      setAsking(false);
    }
  }

  const inbox = useMemo(() => [...cues].sort((a, b) => b.observedAt.localeCompare(a.observedAt)), [cues]);
  const newCount = cues.filter((item) => item.state === "new").length;
  const confirmedRead = cue ? cue.state === "confirmed" || cue.state === "spawned" : false;

  const mapUnits: MapUnit[] = useMemo(() => {
    if (!cue) return [];
    return cue.entities.map((entity) => ({
      id: entity.id,
      side: trackSide(entity),
      affiliation: entity.affiliation,
      name: trackLabel(entity, confirmedRead),
      domain: kindDomains[entity.kind],
      position: { lat: entity.lat, lng: entity.lng },
      headingDeg: entity.courseDeg ?? 0,
      status: "active",
      strength: 100,
      classId: entity.classHint ?? undefined,
    }));
  }, [cue, confirmedRead]);

  const cueArea: Objective[] = useMemo(() => {
    if (!cue) return [];
    return [
      {
        id: `${cue.id}-area`,
        side: "neutral",
        title: cue.title,
        description: cue.narrative,
        kind: "control-area",
        area: { center: { lat: cue.geo.lat, lng: cue.geo.lng }, radiusKm: cue.geo.radiusKm },
        weight: 1,
      },
    ];
  }, [cue]);

  const pendingTask = cue ? cue.collection.find((task) => task.status === "requested") ?? null : null;
  const flyingTask = cue ? cue.collection.find((task) => task.status === "approved") ?? null : null;
  const approveTask = cue && approveTaskId ? cue.collection.find((task) => task.id === approveTaskId) ?? null : null;
  const collected = cue ? cue.collection.some((task) => task.status === "collected") : false;
  // A product that could not settle the question the cue was carrying does not
  // unlock confirmation, and the server enforces the same rule.
  const resolved = cue ? cue.collection.some((task) => task.status === "collected" && task.outcome !== "inconclusive") : false;
  const allInconclusive = collected && !resolved;
  const canIdentify = cue?.state === "new";
  const canRequest = cue?.state === "reviewing" && !pendingTask;
  const canApprove = cue?.state === "reviewing" && pendingTask !== null;
  const canReport = cue?.state === "reviewing" && flyingTask !== null;
  const canConfirm = cue?.state === "reviewing" && resolved;
  const canSpawn = cue?.state === "confirmed";
  const canOpenScenario = profile.pages.includes("scenario");
  const canDismiss = cue !== null && cue.state !== "dismissed" && cue.state !== "spawned";
  const locked = busy !== null || cueLoading;

  // Scenario Design opens whichever scenario the bootstrap payload reports as
  // ready first, so the one this cue produced is named before the navigation.
  function openGeneratedScenario(scenarioId: string | null) {
    handOffScenario(scenarioId);
    goTo("scenario");
  }

  function focusEntity(id: string) {
    const entity = cue?.entities.find((item) => item.id === id);
    if (!entity) return;
    setEntityId(id === entityId ? null : id);
    setMapFocus({ lat: entity.lat, lng: entity.lng, zoom: 10, token: Date.now() });
  }

  function ladderHint(current: IntelCue): string {
    if (current.state === "dismissed") return "Cue dismissed. The reason stays with the hand-off record.";
    if (current.state === "spawned") return "Scenario generated. Course of action work continues in Scenario Design.";
    if (current.state === "confirmed") return "Target confirmed. Generate the scenario to put it in front of the planners.";
    if (current.state === "new") return "SAGE can classify this contact from the cue evidence alone.";
    if (pendingTask) return `Tasking ${pendingTask.taskingId} is held. A named human releases the asset, the AI does not.`;
    if (flyingTask)
      return `Tasking ${flyingTask.taskingId} is released and out. Log the product when the asset reports, the release and the product stay separate records.`;
    if (allInconclusive)
      return "The product came back inconclusive, so the cue stays possible. Task a sensor that can resolve the question, or dismiss the cue.";
    if (collected) return "Collection is in. Confirm the target or dismiss the cue.";
    return "Task a sensor to close the gap between possible and confirmed.";
  }

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={Radar} title="Contacting the cue feed" hint="Loading cues pushed by BASEER and the theater outline the map needs." />
      </div>
    );
  }

  // What standing requirement this cue speaks to, read off the board rather than
  // fetched again: the board already carries the anchor and the reasoning.
  const cueAnchors = !cue || !board
    ? []
    : board.pirs.flatMap((pir) =>
        pir.indicators
          .filter((indicator) => indicator.cues.some((hit) => hit.cueId === cue.id))
          .map((indicator) => ({
            key: `${pir.id}-${indicator.id}`,
            pirNumber: pir.number,
            letter: indicator.letter,
            naiName: indicator.naiName,
            text: indicator.text,
          }))
      );

  const reached = cue ? reachedSteps(cue) : new Set<LadderStep>();
  const cueTurns = cue ? turns[cue.id] ?? [] : [];
  const dismissRecord = cue ? dismissalRecord(cue) : null;

  return (
    <div className="page-body">
      <RequirementsBanner board={board} open={boardOpen} onToggle={() => setBoardOpen((v) => !v)} onFocus={setMapFocus} />
      <div className="intel-console">
        <aside className="intel-inbox">
          <div className="intel-inbox-head">
            <span className="intel-inbox-count">
              <Inbox size={13} />
              {cues.length} cue{cues.length === 1 ? "" : "s"} held | {newCount} new
            </span>
            <Button icon={RefreshCw} variant="secondary" onClick={doSync} disabled={syncing}>
              {syncing ? "Syncing" : "Sync feed"}
            </Button>
          </div>
          <div className="intel-inbox-list">
            {inbox.length ? (
              inbox.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`intel-cue-row${item.id === cueId ? " active" : ""}`}
                  onClick={() => selectCue(item.id)}
                >
                  <span className="intel-sev" style={{ background: severityColors[item.severity] }} />
                  <span className="intel-cue-main">
                    <strong>{item.title}</strong>
                    <small>
                      <span className="intel-origin">{originLabels[item.origin]}</span>
                      {item.confidence}% | {timeAgo(item.observedAt)}
                    </small>
                  </span>
                  <StatusPill label={item.state.toUpperCase()} tone={stateTones[item.state]} />
                </button>
              ))
            ) : (
              <p className="intel-inbox-empty">No cues held. Sync the feed to pull what BASEER is holding.</p>
            )}
          </div>
        </aside>

        <section className="intel-invest">
          {cue ? (
            <>
              <header className="intel-invest-head">
                <div className="intel-invest-title">
                  <strong>{cue.title}</strong>
                  <span>
                    {originLabels[cue.origin]} | {cue.geo.lat.toFixed(2)}, {cue.geo.lng.toFixed(2)} | radius {cue.geo.radiusKm} km |
                    observed {timeAgo(cue.observedAt)}
                  </span>
                </div>
                <StatusPill label={cue.severity} tone={severityTones[cue.severity]} />
                <StatusPill label={cue.state.toUpperCase()} tone={stateTones[cue.state]} />
                <span className="intel-conf">
                  {cue.confidence}%<small>confidence</small>
                </span>
              </header>

              <ol className="intel-ladder">
                {ladder.map((step) => (
                  <li key={step.id} className={reached.has(step.id) ? "done" : ""}>
                    {step.label}
                  </li>
                ))}
              </ol>

              <div className="intel-transcript" ref={transcriptRef}>
                <Card
                  kind="alert"
                  kicker={`Pushed alert | ${originLabels[cue.origin]} | BASEER`}
                  time={timeAgo(cue.observedAt)}
                  records={recordsFor(cue, [cue.ingestHandoffId])}
                >
                  <strong className="intel-card-title">{cue.title}</strong>
                  <p className="intel-narrative">{cue.narrative}</p>
                  {cueAnchors.length ? (
                    <p className="intel-anchor">
                      {cueAnchors.map((anchor) => (
                        <span key={anchor.key}>
                          Answers PIR {anchor.pirNumber}, indicator {anchor.letter}, inside NAI {anchor.naiName}: {anchor.text}
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className="intel-anchor none">
                      This cue answers no standing requirement. It is worth working anyway, and it is worth asking whether the
                      requirements are missing something.
                    </p>
                  )}
                  <DetailGrid>
                    <Detail label="Severity" value={cue.severity} />
                    <Detail label="Cue confidence" value={`${cue.confidence}%`} />
                    <Detail label="Observed" value={stamp(cue.observedAt)} />
                    <Detail label="Cue area" value={`${cue.geo.radiusKm} km radius`} />
                  </DetailGrid>
                </Card>

                <Card kind="evidence" kicker="Evidence, as received">
                  <DetailGrid>
                    <Detail label="Sensor" value={cue.provenance.sensor} />
                    <Detail label="Detector" value={cue.provenance.detector} />
                    <Detail label="Collected" value={stamp(cue.provenance.collectedAt)} />
                    <Detail label="Sources" value={cue.provenance.sources.join(", ") || "not stated"} />
                  </DetailGrid>
                  <p className="intel-subhead">
                    Tracks in the cue ({cue.entities.length}),{" "}
                    {confirmedRead ? "confirmed by collection" : "possible until collection closes"}
                  </p>
                  <div className="intel-entity-list">
                    {cue.entities.length ? (
                      cue.entities.map((entity) => (
                        <button
                          key={entity.id}
                          type="button"
                          className={`intel-entity${entity.id === entityId ? " active" : ""}`}
                          onClick={() => focusEntity(entity.id)}
                        >
                          <span
                            className={`intel-aff ${entity.affiliation}`}
                            style={{ background: frameColor(entity.affiliation) }}
                          />
                          <span className="intel-entity-main">
                            <strong>{entity.name}</strong>
                            <small>
                              {entity.kind} | {affiliationReading(entity, confirmedRead)} | {entity.lat.toFixed(2)},{" "}
                              {entity.lng.toFixed(2)}
                              {entity.courseDeg === null ? "" : ` | course ${Math.round(entity.courseDeg)} deg`}
                              {entity.speedKts === null ? "" : ` | ${Math.round(entity.speedKts)} kts`}
                            </small>
                          </span>
                          {entity.classHint ? <Tag label={entity.classHint} /> : null}
                        </button>
                      ))
                    ) : (
                      <p className="intel-inbox-empty">The cue carries no discrete tracks, only the area.</p>
                    )}
                  </div>
                </Card>

                {cue.assessment ? (
                  <Card
                    kind="assess"
                    kicker="SAGE identification"
                    time={timeAgo(cue.assessment.atIso)}
                    records={recordsFor(cue, [cue.assessment.handoffId])}
                  >
                    <strong className="intel-card-title">{cue.assessment.unitType}</strong>
                    <p className="intel-narrative">{cue.assessment.intent}</p>
                    <p className="intel-reasoning">{cue.assessment.reasoning}</p>
                    <DetailGrid>
                      <Detail label="Confidence" value={`${cue.assessment.confidence}%`} />
                      <Detail label="Sources" value={cue.assessment.sources.join(", ") || "cue evidence only"} />
                      <Detail label="Model" value={modelLabel(cue.assessment.source)} />
                      <Detail label="Latency" value={`${cue.assessment.latencyMs} ms`} />
                    </DetailGrid>
                  </Card>
                ) : null}

                {cue.collection.map((task) => (
                  <Card
                    key={task.id}
                    kind={`task ${task.status}`}
                    kicker={`Collection order - ${task.taskingId}`}
                    time={timeAgo(task.requestedAt)}
                    records={taskRecords(cue, task)}
                  >
                    <strong className="intel-card-title">
                      {task.asset}, {task.mode}
                    </strong>
                    <DetailGrid>
                      <Detail label="Resolution" value={`${task.resolutionM} m`} />
                      <Detail label="ETA" value={`${task.etaMinutes} min`} />
                      <Detail label="Priority" value={task.priority} />
                      <Detail
                        label="Status"
                        value={task.outcome ? `${task.status}, ${task.outcome}` : task.status}
                      />
                    </DetailGrid>
                    {task.note ? <p className="intel-note">Accepted trade-off: {task.note}</p> : null}
                    {task.approvedBy ? (
                      <p className="intel-approval">
                        <ShieldCheck size={13} /> Released by {task.approvedBy}
                        {task.approvedAt ? ` at ${stamp(task.approvedAt)}` : ""}
                      </p>
                    ) : (
                      <p className="intel-held">
                        <AlertTriangle size={13} /> Held for a named approver. The asset does not move until a human releases it.
                      </p>
                    )}
                    {task.approvedBy && !task.collectedAt ? (
                      <p className="intel-held">
                        <AlertTriangle size={13} /> Released, product outstanding. The result is logged as its own step when the asset
                        reports.
                      </p>
                    ) : null}
                    {task.collectedAt ? (
                      <p className="intel-approval">
                        <FileCheck size={13} /> Product logged at {stamp(task.collectedAt)}
                      </p>
                    ) : null}
                    {task.outcome === "inconclusive" ? (
                      <p className="intel-held">
                        <AlertTriangle size={13} /> Inconclusive. This asset could not settle the question the cue is carrying, so the
                        contact stays possible.
                      </p>
                    ) : null}
                    {task.result ? <p className="intel-narrative">{task.result}</p> : null}
                  </Card>
                ))}

                {cueTurns.map((turn) => (
                  <Fragment key={turn.id}>
                    <article className="intel-card question">
                      <header>
                        <span className="intel-card-kicker">{profile.name} asked</span>
                        <span className="intel-card-time">{timeAgo(turn.askedAt)}</span>
                      </header>
                      <p className="intel-narrative">{turn.question}</p>
                    </article>
                    {turn.answer === null ? (
                      <article className="intel-card thinking">
                        <span className="intel-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                        SAGE is reading the cue, the tracks and the collection record
                      </article>
                    ) : (
                      <Card
                        kind="answer"
                        kicker="SAGE answer"
                        time={turn.answeredAt ? timeAgo(turn.answeredAt) : undefined}
                        records={turn.handoff ? [turn.handoff] : []}
                      >
                        <p className="intel-narrative">{turn.answer}</p>
                        <DetailGrid>
                          <Detail label="Model" value={modelLabel(turn.source)} />
                          <Detail label="Latency" value={turn.latencyMs === null ? "not recorded" : `${turn.latencyMs} ms`} />
                        </DetailGrid>
                      </Card>
                    )}
                  </Fragment>
                ))}

                {cue.state === "dismissed" ? (
                  <div className="intel-closed">
                    <strong>{dismissRecord ? `Cue dismissed by ${dismissRecord.actor}` : "Cue dismissed"}</strong>
                    <p>{dismissRecord ? dismissRecord.detail : "No hand-off record is held for the dismissal."}</p>
                  </div>
                ) : null}

                {cue.state === "spawned" ? (
                  <div className="intel-payoff">
                    <strong>
                      <CheckCircle2 size={17} /> Scenario generated from this cue
                    </strong>
                    <p>
                      {spawnedNames[cue.id] ?? cue.scenarioId ?? "The new scenario"} carries the confirmed contact, the cue area and the
                      collection record. Course of action generation now runs against a real situation instead of a blank map.
                    </p>
                    {canOpenScenario ? (
                      <ActionRow>
                        <Button onClick={() => openGeneratedScenario(cue.scenarioId)}>
                          Open this scenario
                        </Button>
                      </ActionRow>
                    ) : (
                      <p>
                        Your access profile does not carry Scenario Design. The scenario is in the library for the planning cell to take
                        forward.
                      </p>
                    )}
                  </div>
                ) : null}

                {cue.state === "dismissed" ? null : (
                  <form
                    className="intel-ask"
                    onSubmit={(event) => {
                      event.preventDefault();
                      doAsk(question);
                    }}
                  >
                    <div className="intel-ask-chips">
                      {starters.map((starter) => (
                        <button key={starter} type="button" className="intel-chip" disabled={asking} onClick={() => doAsk(starter)}>
                          {starter}
                        </button>
                      ))}
                    </div>
                    <div className="intel-ask-row">
                      <input
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        placeholder="Ask about this cue, the answer is grounded in its evidence"
                        disabled={asking}
                      />
                      <Button icon={Send} type="submit" disabled={asking || !question.trim()}>
                        {asking ? "Thinking" : "Ask"}
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              <div className="intel-actionbar">
                <p className="intel-actionbar-hint">{ladderHint(cue)}</p>
                <div className="intel-actionbar-row">
                  <Button
                    variant={canIdentify ? "primary" : "secondary"}
                    onClick={doIdentify}
                    disabled={!canIdentify || locked}
                  >
                    {busy === "identify" ? "Identifying" : "Identify unit"}
                  </Button>
                  <Button
                    icon={Satellite}
                    variant={canRequest ? "primary" : "secondary"}
                    onClick={openOptions}
                    disabled={!canRequest || locked}
                  >
                    Request collection
                  </Button>
                  <Button
                    icon={ShieldCheck}
                    variant={canApprove ? "primary" : "secondary"}
                    onClick={() => {
                      setSigner(profile.name);
                      setApproveTaskId(pendingTask ? pendingTask.id : null);
                    }}
                    disabled={!canApprove || locked}
                  >
                    Approve collection
                  </Button>
                  <Button
                    icon={FileCheck}
                    variant={canReport ? "primary" : "secondary"}
                    onClick={doReport}
                    disabled={!canReport || locked}
                  >
                    {busy === "report" ? "Logging" : "Log collection product"}
                  </Button>
                  <Button
                    icon={Crosshair}
                    variant={canConfirm ? "primary" : "secondary"}
                    onClick={() => {
                      setSigner(profile.name);
                      setSignFor("confirm");
                    }}
                    disabled={!canConfirm || locked}
                  >
                    Confirm target
                  </Button>
                  <Button
                    variant={canSpawn ? "primary" : "secondary"}
                    onClick={() => {
                      setSigner(profile.name);
                      setSignFor("spawn");
                    }}
                    disabled={!canSpawn || locked}
                  >
                    Generate scenario
                  </Button>
                  <Button
                    icon={X}
                    variant="secondary"
                    onClick={() => {
                      setSigner(profile.name);
                      setDismissOpen(true);
                    }}
                    disabled={!canDismiss || locked}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="intel-blank">
              <EmptyState
                icon={Radar}
                title={cueLoading ? "Opening the cue" : "Pick a cue to open the investigation"}
                hint="One chain per cue: identify the contact, task collection, release it under a named human, log the product, confirm the target, then generate the scenario."
              />
            </div>
          )}
        </section>

        <div className="intel-map-zone">
          <TheaterMap
            center={cue ? { lat: cue.geo.lat, lng: cue.geo.lng } : THEATER_CENTER}
            zoom={cue ? zoomForRadius(cue.geo.radiusKm) : 7}
            units={mapUnits}
            theater={theater}
            objectives={cueArea}
            namedAreas={board?.namedAreas.map((a) => ({ id: a.id, name: a.name, centre: a.centre, radiusKm: a.radiusKm }))}
            selectedUnitId={entityId}
            onSelectUnit={focusEntity}
            showLabels
            focusOn={mapFocus}
            worldKey={cue ? `${cue.id}:${cue.state}` : "no-cue"}
            height={560}
          />
          <div className="intel-map-hint">
            {cue
              ? `Cue area ${cue.geo.radiusKm} km, ${plural(cue.entities.length, "track")} read from BASEER. An unidentified track plots on the yellow unknown frame, never the hostile diamond, and only a declared neutral plots neutral. Click a counter to inspect it.`
              : "Meridian Archipelago theater. Select a cue to plot its tracks."}
            {board ? " Dashed amber rings are the named areas of interest the commander asked to be watched." : ""}
          </div>
        </div>
      </div>

      {optionsOpen && cue ? (
        <Modal title="Choose a collection option" onClose={() => setOptionsOpen(false)}>
          <p className="intel-modal-note">
            SAGE drafted these against the cue area, and each one states what it costs to use. The operator picks one, then a named human
            releases the asset.
          </p>
          {options === null ? (
            <EmptyState icon={Satellite} title="Reading available collection" hint="Checking which assets can cover the cue area inside the window." />
          ) : options.length ? (
            <div className="intel-option-list">
              {options.map((option, index) => (
                <button
                  key={`${option.asset}-${option.mode}-${index}`}
                  type="button"
                  className="intel-option"
                  disabled={busy !== null}
                  onClick={() => doRequest(index)}
                >
                  <strong>{option.asset}</strong>
                  <span>
                    {option.mode} | {option.resolutionM} m | ETA {option.etaMinutes} min
                  </span>
                  <Tag label={`${option.priority} priority`} />
                  <span>{option.note}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Satellite}
              title="No asset reaches this area"
              hint="Nothing in the collection plan covers the cue inside the window. Confirm on the evidence held or dismiss the cue."
            />
          )}
        </Modal>
      ) : null}

      {approveTask ? (
        <Modal title="Approve collection" onClose={() => setApproveTaskId(null)}>
          <DetailGrid>
            <Detail label="Tasking" value={approveTask.taskingId} />
            <Detail label="Asset" value={approveTask.asset} />
            <Detail label="Mode" value={`${approveTask.mode}, ${approveTask.resolutionM} m`} />
            <Detail label="ETA" value={`${approveTask.etaMinutes} min`} />
          </DetailGrid>
          <Field label="Approver, recorded against the tasking">
            <input value={signer} onChange={(event) => setSigner(event.target.value)} placeholder="Rank and name" />
          </Field>
          <p className="intel-modal-note">
            SAGE cannot release collection. Your name goes on tasking {approveTask.taskingId} and stays in the hand-off record.
          </p>
          <ActionRow>
            <Button icon={ShieldCheck} onClick={doApprove} disabled={busy !== null}>
              {busy === "approve" ? "Releasing" : "Approve and release"}
            </Button>
            <Button variant="secondary" onClick={() => setApproveTaskId(null)}>
              Cancel
            </Button>
          </ActionRow>
        </Modal>
      ) : null}

      {signFor && cue ? (
        <Modal
          title={signFor === "confirm" ? "Confirm the target" : signFor === "identify" ? "Identify the contact" : "Generate the scenario"}
          onClose={() => setSignFor(null)}
        >
          <DetailGrid>
            <Detail label="Cue" value={cue.title} />
            <Detail label="Confidence" value={`${cue.confidence}%`} />
          </DetailGrid>
          <Field
            label={
              signFor === "confirm"
                ? "Name, recorded against the confirmation"
                : signFor === "identify"
                  ? "Name, recorded against the identification"
                  : "Name, recorded against the generated scenario"
            }
          >
            <input value={signer} onChange={(event) => setSigner(event.target.value)} placeholder="Rank and name" />
          </Field>
          <p className="intel-modal-note">
            {signFor === "confirm"
              ? "SAGE cannot confirm a target. Your name moves this cue from possible to confirmed and stays in the hand-off record."
              : signFor === "identify"
                ? "This platform is set to require a named human for identification. SAGE still does the work; your name is recorded as having authorised it."
                : "SAGE cannot open a scenario. Your name goes on the scenario and stays in the hand-off record."}
          </p>
          <ActionRow>
            {signFor === "identify" ? (
              <Button onClick={doIdentify} disabled={busy !== null}>
                {busy === "identify" ? "Identifying" : "Identify contact"}
              </Button>
            ) : signFor === "confirm" ? (
              <Button icon={Crosshair} onClick={doConfirm} disabled={busy !== null}>
                {busy === "confirm" ? "Confirming" : "Confirm target"}
              </Button>
            ) : (
              <Button onClick={doSpawn} disabled={busy !== null}>
                {busy === "spawn" ? "Generating" : "Generate scenario"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setSignFor(null)}>
              Cancel
            </Button>
          </ActionRow>
        </Modal>
      ) : null}

      {dismissOpen && cue ? (
        <Modal title="Dismiss this cue" onClose={() => setDismissOpen(false)}>
          <p className="intel-modal-note">
            The name and the reason are retained with the cue so the next watch can see who closed it and why.
          </p>
          <Field label="Name, recorded against the dismissal">
            <input value={signer} onChange={(event) => setSigner(event.target.value)} placeholder="Rank and name" />
          </Field>
          <Field label="Reason">
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="For example, track resolves to a civil survey vessel already declared"
            />
          </Field>
          <ActionRow>
            <Button icon={X} variant="danger" onClick={doDismiss} disabled={busy !== null}>
              {busy === "dismiss" ? "Dismissing" : "Dismiss cue"}
            </Button>
            <Button variant="secondary" onClick={() => setDismissOpen(false)}>
              Cancel
            </Button>
          </ActionRow>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({
  kind,
  kicker,
  time,
  records,
  children,
}: {
  kind: string;
  kicker: string;
  time?: string;
  records?: HandoffRecord[];
  children: ReactNode;
}) {
  return (
    <article className={`intel-card ${kind}`}>
      <header>
        <span className="intel-card-kicker">{kicker}</span>
        {time ? <span className="intel-card-time">{time}</span> : null}
      </header>
      {children}
      {records ? <HandoffInspector records={records} /> : null}
    </article>
  );
}

// The audit affordance: every AI output opens onto the record that produced it,
// including whether the step was allowed to run without a human. A step the
// backend logged no record for says so, it never borrows a neighbouring row.
function HandoffInspector({ records }: { records: HandoffRecord[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="intel-audit">
      <button type="button" className="intel-audit-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Hand-off inspector
        <em>{records.length ? plural(records.length, "record") : "no linked record"}</em>
      </button>
      {open ? (
        <div className="intel-audit-body">
          {records.length ? null : (
            <div className="intel-audit-rec">
              <p>
                No hand-off record is linked to this step. Records are addressed by id, so nothing here is inferred from the wording of
                another entry.
              </p>
            </div>
          )}
          {records.map((record, index) => (
            <div key={`${index}-${record.id}`} className="intel-audit-rec">
              <header>
                <strong>{record.action}</strong>
                <Tag label={record.kind === "human" ? "human" : "machine"} color={record.kind === "human" ? "var(--amber)" : "var(--blue)"} />
                <StatusPill
                  label={record.autonomy === "auto" ? "autonomous" : "human required"}
                  tone={record.autonomy === "auto" ? "info" : "warn"}
                />
              </header>
              <p>{record.detail}</p>
              <DetailGrid>
                <Detail label="Actor" value={record.actor} />
                {record.signedBy ? <Detail label="Signed by" value={record.signedBy} /> : null}
                <Detail label="Recorded" value={stamp(record.at)} />
                <Detail label="Model" value={modelLabel(record.source)} />
                <Detail label="Latency" value={record.latencyMs === null ? "not applicable" : `${record.latencyMs} ms`} />
              </DetailGrid>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

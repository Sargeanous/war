// ScenarioDesign · L3 application 1: build and validate exercise scenarios.
// Left: scenario library (select / create from template). Main: tabbed workspace
// (order of battle on the theater chart, weighted objectives, environment) with
// an explicit local dirty state; Save pushes the whole scenario via updateScenario.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Anchor,
  CloudSun,
  Compass,
  Crosshair,
  FileText,
  Map as MapIcon,
  Pencil,
  Plus,
  Radar,
  Save,
  Shield,
  ShieldCheck,
  Target,
  Trash2,
} from "lucide-react";
import type { PageProps } from "../shell";
import type {
  Domain,
  LatLng,
  Objective,
  OpordParse,
  OntologyClass,
  Scenario,
  ScenarioEnvironment,
  SensorSpec,
  SideId,
  TheaterFeature,
  Unit,
  ValidationReport,
  WeaponSpec,
} from "../types";
import {
  createScenario,
  createScenarioFromOpord,
  fetchBootstrap,
  fetchOntology,
  parseOpord,
  updateScenario,
  validateScenario,
} from "../api";
import {
  ActionRow,
  Button,
  CompactTable,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  FormGrid,
  Modal,
  PageBody,
  Panel,
  Segmented,
  StatusPill,
  Tag,
  timeAgo,
} from "../components";
import { domainLabels, sideColors, sideLabels, statusTone } from "../data";
import TheaterMap from "../map";
import "./scenariodesign.css";

// --- Local vocabulary ---------------------------------------------------------

type TabId = "orbat" | "objectives" | "environment";
type PlacementSide = "blue" | "red";

interface ObjectivePayload {
  title: string;
  description: string;
  kind: Objective["kind"];
  weight: number;
  area?: { center: LatLng; radiusKm: number };
}

const UNIT_COLUMNS = ["Unit", "Class", "Position", "Strength", "Status"];

const DOMAIN_ORDER: Domain[] = ["sea", "air", "land", "cyber", "space"];

const OBJECTIVE_KINDS: Array<{ id: Objective["kind"]; label: string }> = [
  { id: "control-area", label: "Control area" },
  { id: "destroy", label: "Destroy target set" },
  { id: "protect", label: "Protect force" },
  { id: "deliver", label: "Deliver force / lodgement" },
  { id: "deny", label: "Deny area or access" },
];

const SEA_STATE_LABELS = [
  "0 · Calm (glassy)",
  "1 · Calm (rippled)",
  "2 · Smooth",
  "3 · Slight",
  "4 · Moderate",
  "5 · Rough",
  "6 · Very rough",
  "7 · High",
  "8 · Very high",
  "9 · Phenomenal",
];

// --- Pure helpers ---------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error, check the backend on :5189";
}

function cloneScenario(scenario: Scenario): Scenario {
  return JSON.parse(JSON.stringify(scenario)) as Scenario;
}

function kindLabel(kind: Objective["kind"]): string {
  const entry = OBJECTIVE_KINDS.find((k) => k.id === kind);
  return entry ? entry.label : kind;
}

function initials(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "SC";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

function clampNum(raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// Date-free deterministic local id: counter derived from the existing id set.
function nextLocalId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = existing.length + 1;
  let candidate = `${prefix}-${String(n).padStart(3, "0")}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${prefix}-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

// Sensible per-domain defaults for a freshly placed unit.
function unitDefaults(domain: Domain): { speedKts: number; sensors: SensorSpec[]; weapons: WeaponSpec[] } {
  switch (domain) {
    case "sea":
      return {
        speedKts: 18,
        sensors: [{ type: "surface-radar", rangeKm: 90 }],
        weapons: [{ type: "ssm", rangeKm: 120, pk: 0.55, ammo: 8 }],
      };
    case "air":
      return {
        speedKts: 420,
        sensors: [{ type: "air-search-radar", rangeKm: 160 }],
        weapons: [{ type: "aam", rangeKm: 60, pk: 0.6, ammo: 6 }],
      };
    case "land":
      return {
        speedKts: 10,
        sensors: [{ type: "ground-surveillance-radar", rangeKm: 45 }],
        weapons: [{ type: "artillery", rangeKm: 32, pk: 0.4, ammo: 24 }],
      };
    case "cyber":
      return {
        speedKts: 0,
        sensors: [{ type: "signals-intercept", rangeKm: 320 }],
        weapons: [{ type: "cyber-effect", rangeKm: 300, pk: 0.3, ammo: 4 }],
      };
    case "space":
      return {
        speedKts: 0,
        sensors: [{ type: "orbital-surveillance", rangeKm: 400 }],
        weapons: [],
      };
  }
}

function buildUnit(cls: OntologyClass, side: PlacementSide, position: LatLng, id: string, existing: Unit[]): Unit {
  const domain: Domain = cls.domain ?? "land";
  // Custom piece types authored in the low-code designer carry their own
  // loadout; seed classes fall back to per-domain defaults.
  const defaults = cls.defaults ?? { ...unitDefaults(domain), strength: 100, supply: 100 };
  const ordinal = existing.filter((u) => u.side === side && u.classId === cls.id).length + 1;
  const prefix = side === "blue" ? "CTF" : "OPFOR";
  return {
    id,
    side,
    name: `${prefix} ${cls.label} ${ordinal}`,
    classId: cls.id,
    domain,
    position: { lat: Number(position.lat.toFixed(4)), lng: Number(position.lng.toFixed(4)) },
    headingDeg: side === "blue" ? 90 : 270,
    speedKts: defaults.speedKts,
    strength: defaults.strength,
    supply: defaults.supply,
    sensors: defaults.sensors.map((s) => ({ ...s })),
    weapons: defaults.weapons.map((w) => ({ ...w })),
    status: "active",
    taskForce: side === "blue" ? "CTF Meridian" : "Meridian Defense Group",
  };
}

// --- Modals ---------------------------------------------------------------------

function CreateScenarioModal({
  templates,
  busy,
  notify,
  onClose,
  onCreate,
}: {
  templates: Array<{ id: string; label: string }>;
  busy: boolean;
  notify: (message: string) => void;
  onClose: () => void;
  onCreate: (payload: { name: string; codename: string; description: string; template: string }) => void;
}) {
  const [name, setName] = useState("");
  const [codename, setCodename] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState(templates.length > 0 ? templates[0].id : "scn-blank-template");

  const submit = () => {
    if (!name.trim()) {
      notify("Scenario name is required");
      return;
    }
    onCreate({
      name: name.trim(),
      codename: codename.trim().toUpperCase(),
      description: description.trim(),
      template,
    });
  };

  return (
    <Modal title="New scenario" onClose={onClose}>
      <FormGrid columns={2}>
        <Field label="Scenario name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CORAL RAMPART rehearsal" />
        </Field>
        <Field label="Codename">
          <input value={codename} onChange={(e) => setCodename(e.target.value)} placeholder="e.g. CORAL RAMPART" />
        </Field>
        <div className="sd-span-full">
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Training audience, setting and exercise aim for the planning staff."
            />
          </Field>
        </div>
        <div className="sd-span-full">
          <Field label="Start from template">
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormGrid>
      <ActionRow>
        <Button icon={Plus} onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create scenario"}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

// Fictional sample order, written to parse cleanly offline (bullet + "at lat, lng" convention).
const SAMPLE_OPORD = `OPORD 26-04 · OPERATION AZURE TRIDENT
References: Exercise AZURE HORIZON series. Classification: EXERCISE / FICTIONAL.

1. SITUATION
RED occupation forces hold Kestrel Island and the eastern strait approaches with
coastal missile, naval and air-defense assets. Merchant traffic is suspended.

2. BLUE FORCES
- 1x Aircraft carrier "CVN 80 Meridian" at 24.55, 59.35 (TF Sword)
- 2x Guided-missile destroyer at 24.65, 59.70 (TF Sword)
- 1x Frigate at 24.40, 59.55 (TF Shield)
- 1x Submarine at 24.80, 60.10 (TF Undertow)
- 1x Amphibious assault ship at 24.30, 59.15 (TF Landing)
- 1x Marine battalion at 24.30, 59.05 (TF Landing)
- 2x Fighter squadron at 24.60, 59.25 (TF Sword)
- 1x Airborne early warning at 24.50, 59.05 (TF Sword)
- 1x Fleet auxiliary at 24.20, 58.85 (TF Shield)

3. RED FORCES
- 1x Coastal defense battery at 23.97, 62.15
- 2x Corvette at 23.85, 61.90
- 1x Fast missile boat at 23.70, 62.05
- 1x Submarine at 23.55, 61.40
- 1x Fighter squadron at 24.10, 62.30
- 1x SAM battalion at 24.03, 62.22
- 1x Cyber operations cell at 24.05, 62.40

4. MISSION / OBJECTIVES
- (BLUE) Seize control of the Meridian Strait transit lane
- (BLUE) Protect the amphibious landing group
- (RED) Deny BLUE passage east of Kestrel Island

5. CONSTRAINTS
- EMCON restricted until H+12
- No strikes on protected cultural sites (Meridian old town)
- Landing requires sea state 4 or below`;

function OpordWizardModal({
  notify,
  onClose,
  onCreated,
}: {
  notify: (message: string) => void;
  onClose: () => void;
  onCreated: (scenario: Scenario) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parse, setParse] = useState<OpordParse | null>(null);
  const [name, setName] = useState("");
  const [codename, setCodename] = useState("");
  const [creating, setCreating] = useState(false);

  const doParse = async () => {
    if (parsing) return;
    setParsing(true);
    try {
      const result = await parseOpord(text);
      setParse(result);
      const cleanTitle = result.title.replace(/^OPORD\s*[\d-]*\s*[—–-]?\s*/i, "").trim();
      setName(cleanTitle || result.title);
      setCodename((result.title.match(/operation\s+([a-z ]+)/i)?.[1] ?? cleanTitle).trim().toUpperCase().slice(0, 30));
      setStep(2);
      notify(
        result.source === "anthropic"
          ? "Document parsed by the reasoning service (anthropic)"
          : "Document parsed by the offline extraction rules"
      );
    } catch (err) {
      notify(errMsg(err));
    } finally {
      setParsing(false);
    }
  };

  const doCreate = async () => {
    if (!parse || creating) return;
    setCreating(true);
    try {
      const created = await createScenarioFromOpord({ parse, name: name.trim() || parse.title, codename: codename.trim() || undefined });
      onCreated(created);
    } catch (err) {
      notify(errMsg(err));
      setCreating(false);
    }
  };

  const sideBlock = (sideId: "blue" | "red") => {
    const entities = parse?.sides.find((s) => s.side === sideId)?.entities ?? [];
    return (
      <div key={sideId} className="sd-opord-sidecard">
        <p className={`sd-opord-sidehead ${sideId}`}>
          {sideId === "blue" ? "BLUE FORCES" : "RED FORCES"} · {entities.length} group(s)
        </p>
        {entities.length ? (
          <CompactTable
            columns={["Entity", "Class", "Qty", "Position", "Task force"]}
            rows={entities.map((e) => [
              e.name ?? e.classLabel,
              e.classLabel,
              String(e.count),
              `${e.position.lat.toFixed(2)}, ${e.position.lng.toFixed(2)}`,
              e.taskForce ?? "-",
            ])}
          />
        ) : (
          <p className="sd-opord-hint">No entities extracted for this side.</p>
        )}
      </div>
    );
  };

  return (
    <Modal title="Intelligent Documents, operational order to scenario" onClose={onClose}>
      {step === 1 ? (
        <>
          <p className="sd-opord-hint">
            Paste an operational order. The pipeline extracts force groups, positions, task organization and objectives -
            through the reasoning service when an API key is configured, or the built-in extraction rules offline.
          </p>
          <Field label="Operational document">
            <textarea
              className="sd-opord-text"
              rows={13}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="OPORD …&#10;2. BLUE FORCES&#10;- 1x Guided-missile destroyer at 24.65, 59.70 (TF Sword)&#10;…"
            />
          </Field>
          <ActionRow>
            <Button icon={FileText} onClick={doParse} disabled={parsing || text.trim().length < 40}>
              {parsing ? "Parsing document…" : "Parse document"}
            </Button>
            <Button variant="secondary" onClick={() => setText(SAMPLE_OPORD)}>
              Load sample OPORD
            </Button>
          </ActionRow>
        </>
      ) : null}
      {step === 2 && parse ? (
        <>
          <div className="sd-opord-src">
            <Tag
              label={parse.source === "anthropic" ? "reasoning service" : "offline rules"}
              color={parse.source === "anthropic" ? "var(--blue)" : undefined}
            />
            <small>{parse.summary}</small>
          </div>
          <div className="sd-opord-review">
            {sideBlock("blue")}
            {sideBlock("red")}
            {parse.objectives.length ? (
              <div className="sd-opord-sidecard">
                <p className="sd-opord-sidehead">OBJECTIVES</p>
                {parse.objectives.map((o, i) => (
                  <p key={i} className="sd-opord-obj">
                    <Tag label={o.side.toUpperCase()} color={sideColors[o.side]} /> <Tag label={o.kind} /> {o.title}
                  </p>
                ))}
              </div>
            ) : null}
            {parse.constraints.length ? (
              <div className="sd-opord-sidecard">
                <p className="sd-opord-sidehead">CONSTRAINTS</p>
                {parse.constraints.map((c, i) => (
                  <p key={i} className="sd-opord-hint">
                    · {c}
                  </p>
                ))}
              </div>
            ) : null}
            {parse.unparsed.length ? (
              <p className="sd-opord-warn">
                <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} /> {parse.unparsed.length} line(s) could not be
                matched to the ontology and were skipped.
              </p>
            ) : null}
          </div>
          <ActionRow>
            <Button icon={ShieldCheck} onClick={() => setStep(3)}>
              Looks right, continue
            </Button>
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back to document
            </Button>
          </ActionRow>
        </>
      ) : null}
      {step === 3 && parse ? (
        <>
          <FormGrid columns={2}>
            <Field label="Scenario name">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Codename">
              <input value={codename} onChange={(e) => setCodename(e.target.value.toUpperCase())} />
            </Field>
          </FormGrid>
          <p className="sd-opord-hint">
            Units are materialized with ontology-typed stats (cloned from doctrine templates), objectives are weighted per
            side, and the scenario lands in the library ready for COA generation.
          </p>
          <ActionRow>
            <Button icon={Plus} onClick={doCreate} disabled={creating}>
              {creating ? "Materializing scenario…" : "Create scenario"}
            </Button>
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back to review
            </Button>
          </ActionRow>
        </>
      ) : null}
    </Modal>
  );
}

function ObjectiveEditorModal({
  side,
  initial,
  mapCenter,
  notify,
  onClose,
  onCommit,
}: {
  side: SideId;
  initial: Objective | null;
  mapCenter: LatLng;
  notify: (message: string) => void;
  onClose: () => void;
  onCommit: (payload: ObjectivePayload) => void;
}) {
  const [title, setTitle] = useState(initial ? initial.title : "");
  const [description, setDescription] = useState(initial ? initial.description : "");
  const [kind, setKind] = useState<Objective["kind"]>(initial ? initial.kind : "control-area");
  const [weight, setWeight] = useState(initial ? String(initial.weight) : "0.25");
  const [lat, setLat] = useState(initial?.area ? String(initial.area.center.lat) : mapCenter.lat.toFixed(2));
  const [lng, setLng] = useState(initial?.area ? String(initial.area.center.lng) : mapCenter.lng.toFixed(2));
  const [radius, setRadius] = useState(initial?.area ? String(initial.area.radiusKm) : "25");

  const submit = () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      notify("Objective title is required");
      return;
    }
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0 || w > 1) {
      notify("Objective weight must be a value between 0 and 1");
      return;
    }
    let area: { center: LatLng; radiusKm: number } | undefined;
    if (kind === "control-area") {
      const la = Number(lat);
      const ln = Number(lng);
      const r = Number(radius);
      if (!Number.isFinite(la) || la < -90 || la > 90) {
        notify("Center latitude must be between -90 and 90");
        return;
      }
      if (!Number.isFinite(ln) || ln < -180 || ln > 180) {
        notify("Center longitude must be between -180 and 180");
        return;
      }
      if (!Number.isFinite(r) || r <= 0) {
        notify("Radius must be a positive number of kilometres");
        return;
      }
      area = { center: { lat: la, lng: ln }, radiusKm: r };
    }
    const payload: ObjectivePayload = {
      title: trimmedTitle,
      description: description.trim(),
      kind,
      weight: w,
    };
    if (area) payload.area = area;
    onCommit(payload);
  };

  return (
    <Modal title={initial ? `Edit objective, ${initial.title}` : `New objective, ${sideLabels[side]}`} onClose={onClose}>
      <FormGrid columns={2}>
        <div className="sd-span-full">
          <Field label="Objective title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Control Verdant Strait" />
          </Field>
        </div>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as Objective["kind"])}>
            {OBJECTIVE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Weight (0-1)">
          <input type="number" min={0.05} max={1} step={0.05} value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <div className="sd-span-full">
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="State the success criteria the adjudicator and assessment engine should score against."
            />
          </Field>
        </div>
      </FormGrid>
      {kind === "control-area" ? (
        <FormGrid columns={3}>
          <Field label="Center latitude">
            <input type="number" step={0.01} value={lat} onChange={(e) => setLat(e.target.value)} />
          </Field>
          <Field label="Center longitude">
            <input type="number" step={0.01} value={lng} onChange={(e) => setLng(e.target.value)} />
          </Field>
          <Field label="Radius (km)">
            <input type="number" min={1} max={400} value={radius} onChange={(e) => setRadius(e.target.value)} />
          </Field>
        </FormGrid>
      ) : null}
      <ActionRow>
        <Button icon={Save} onClick={submit}>
          {initial ? "Update objective" : "Add objective"}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

// --- Page -------------------------------------------------------------------------

export default function ScenarioDesign(props: PageProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [theater, setTheater] = useState<TheaterFeature[]>([]);
  const [classes, setClasses] = useState<OntologyClass[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [working, setWorking] = useState<Scenario | null>(null);
  const [dirty, setDirty] = useState(false);

  const [tab, setTab] = useState<TabId>("orbat");
  const [side, setSide] = useState<PlacementSide>("blue");
  const [placementClassId, setPlacementClassId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showOpord, setShowOpord] = useState(false);
  const [creating, setCreating] = useState(false);
  const [objModal, setObjModal] = useState<{ side: PlacementSide; objective: Objective | null } | null>(null);

  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchBootstrap(), fetchOntology()])
      .then(([boot, ontology]) => {
        if (cancelled) return;
        setScenarios(boot.scenarios);
        setTheater(boot.theater);
        setClasses(ontology.classes);
        const initial = boot.scenarios.find((s) => s.status === "ready") ?? boot.scenarios[0] ?? null;
        if (initial) {
          setSelectedId(initial.id);
          setWorking(cloneScenario(initial));
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = errMsg(err);
        setLoading(false);
        setLoadError(message);
        props.notify(message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const classById = useMemo(() => {
    const map = new Map<string, OntologyClass>();
    for (const cls of classes) map.set(cls.id, cls);
    return map;
  }, [classes]);

  const paletteGroups = useMemo(() => {
    const force = classes.filter((cls) => cls.category === "force");
    return DOMAIN_ORDER.map((domain) => ({
      domain,
      classes: force.filter((cls) => (cls.domain ?? "land") === domain),
    })).filter((group) => group.classes.length > 0);
  }, [classes]);

  const templates = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [
      { id: "scn-blank-template", label: "Blank scenario, empty ORBAT and objectives" },
    ];
    const azure = scenarios.find((s) => s.id === "scn-azure-horizon");
    if (azure) list.push({ id: azure.id, label: `Copy of ${azure.name}, full ${azure.units.length}-unit ORBAT` });
    return list;
  }, [scenarios]);

  const classLabel = (id: string) => classById.get(id)?.label ?? id;

  // --- Local mutation plumbing (explicit dirty state) -----------------------------

  const mutateWorking = (fn: (draft: Scenario) => void) => {
    setWorking((prev) => {
      if (!prev) return prev;
      const draft = cloneScenario(prev);
      fn(draft);
      return draft;
    });
    setDirty(true);
  };

  const updateUnit = (id: string, patch: Partial<Unit>) => {
    mutateWorking((draft) => {
      const unit = draft.units.find((u) => u.id === id);
      if (unit) Object.assign(unit, patch);
    });
  };

  const updateEnvironment = (patch: Partial<ScenarioEnvironment>) => {
    mutateWorking((draft) => {
      draft.environment = { ...draft.environment, ...patch };
    });
  };

  // --- User actions ----------------------------------------------------------------

  const handleSelectScenario = (scenario: Scenario) => {
    if (scenario.id === selectedId) return;
    const hadDirty = dirty;
    setSelectedId(scenario.id);
    setWorking(cloneScenario(scenario));
    setDirty(false);
    setValidation(null);
    setSelectedUnitId(null);
    setPlacementClassId(null);
    setTab("orbat");
    props.notify(
      hadDirty
        ? `Opened "${scenario.name}", unsaved changes on the previous scenario were discarded`
        : `Opened scenario "${scenario.name}"`
    );
  };

  const handleTab = (next: TabId) => {
    setTab(next);
    if (next !== "orbat") setPlacementClassId(null);
  };

  const togglePlacement = (cls: OntologyClass) => {
    if (placementClassId === cls.id) {
      setPlacementClassId(null);
      props.notify("Placement mode disarmed");
    } else {
      setPlacementClassId(cls.id);
      props.notify(`Placement armed, click the chart to add ${cls.label} for ${sideLabels[side]}`);
    }
  };

  const handleMapClick = (pos: LatLng) => {
    if (!working || !placementClassId) return;
    const cls = classById.get(placementClassId);
    if (!cls) return;
    const id = nextLocalId(working.units.map((u) => u.id), `${working.id}-local`);
    const unit = buildUnit(cls, side, pos, id, working.units);
    mutateWorking((draft) => {
      draft.units.push(unit);
    });
    setSelectedUnitId(id);
    props.notify(`${unit.name} placed at ${pos.lat.toFixed(2)}, ${pos.lng.toFixed(2)}, save to commit`);
  };

  const removeUnit = (id: string) => {
    const unit = working?.units.find((u) => u.id === id);
    mutateWorking((draft) => {
      draft.units = draft.units.filter((u) => u.id !== id);
      for (const objective of draft.objectives) {
        if (objective.targetUnitIds) {
          objective.targetUnitIds = objective.targetUnitIds.filter((t) => t !== id);
        }
      }
    });
    setSelectedUnitId(null);
    props.notify(unit ? `${unit.name} removed from the ORBAT, save to commit` : "Unit removed, save to commit");
  };

  const commitObjective = (payload: ObjectivePayload) => {
    if (!working || !objModal) return;
    const editing = objModal.objective;
    if (editing) {
      mutateWorking((draft) => {
        const objective = draft.objectives.find((o) => o.id === editing.id);
        if (objective) {
          objective.title = payload.title;
          objective.description = payload.description;
          objective.kind = payload.kind;
          objective.weight = payload.weight;
          if (payload.area) objective.area = payload.area;
          else delete objective.area;
        }
      });
      props.notify(`Objective "${payload.title}" updated, save to commit`);
    } else {
      const id = nextLocalId(working.objectives.map((o) => o.id), `${working.id}-obj`);
      const objective: Objective = {
        id,
        side: objModal.side,
        title: payload.title,
        description: payload.description,
        kind: payload.kind,
        weight: payload.weight,
      };
      if (payload.area) objective.area = payload.area;
      mutateWorking((draft) => {
        draft.objectives.push(objective);
      });
      props.notify(`Objective "${payload.title}" added for ${sideLabels[objModal.side]}, save to commit`);
    }
    setObjModal(null);
  };

  const removeObjective = (id: string) => {
    const objective = working?.objectives.find((o) => o.id === id);
    mutateWorking((draft) => {
      draft.objectives = draft.objectives.filter((o) => o.id !== id);
    });
    props.notify(objective ? `Objective "${objective.title}" removed, save to commit` : "Objective removed, save to commit");
  };

  const handleCreate = async (payload: { name: string; codename: string; description: string; template: string }) => {
    setCreating(true);
    try {
      const created = await createScenario({
        name: payload.name,
        codename: payload.codename || undefined,
        description: payload.description || undefined,
        template: payload.template,
      });
      if (!aliveRef.current) return;
      setScenarios((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setWorking(cloneScenario(created));
      setDirty(false);
      setValidation(null);
      setSelectedUnitId(null);
      setPlacementClassId(null);
      setShowCreate(false);
      setTab("orbat");
      props.notify(
        `Scenario "${created.name}" created from ${payload.template === "scn-blank-template" ? "the blank template" : "the AZURE HORIZON copy"}`
      );
    } catch (err) {
      if (aliveRef.current) props.notify(errMsg(err));
    } finally {
      if (aliveRef.current) setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!working || saving) return;
    setSaving(true);
    try {
      const saved = await updateScenario(working.id, working);
      if (!aliveRef.current) return;
      setScenarios((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
      setWorking(cloneScenario(saved));
      setDirty(false);
      setValidation(null);
      props.notify(`Scenario "${saved.name}" saved, ${saved.units.length} units and ${saved.objectives.length} objectives committed`);
    } catch (err) {
      if (aliveRef.current) props.notify(errMsg(err));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const handleValidate = async () => {
    if (!working || validating) return;
    setValidating(true);
    try {
      const report = await validateScenario(working.id);
      if (!aliveRef.current) return;
      setValidation(report);
      const errors = report.issues.filter((i) => i.level === "error").length;
      const warnings = report.issues.filter((i) => i.level === "warning").length;
      props.notify(
        report.ok
          ? "Validation passed, scenario is ready for COA generation"
          : `Validation flagged ${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}`
      );
    } catch (err) {
      if (aliveRef.current) props.notify(errMsg(err));
    } finally {
      if (aliveRef.current) setValidating(false);
    }
  };

  // --- Render helpers ---------------------------------------------------------------

  const unitRows = (units: Unit[]) =>
    units.map((unit) => [
      <button type="button" className="sd-unit-link" onClick={() => setSelectedUnitId(unit.id)}>
        {unit.name}
      </button>,
      classLabel(unit.classId),
      `${unit.position.lat.toFixed(2)}, ${unit.position.lng.toFixed(2)}`,
      `${Math.round(unit.strength)}%`,
      <StatusPill label={unit.status} tone={statusTone(unit.status)} />,
    ]);

  const renderOrbat = (scn: Scenario) => {
    const selectedUnit = selectedUnitId ? scn.units.find((u) => u.id === selectedUnitId) ?? null : null;
    const blueUnits = scn.units.filter((u) => u.side === "blue");
    const redUnits = scn.units.filter((u) => u.side === "red");
    const armedClass = placementClassId ? classById.get(placementClassId) ?? null : null;
    return (
      <div className="sd-tab-stack">
        <div className="sd-orbat-controls">
          <Segmented
            value={side}
            onChange={(next) => setSide(next)}
            items={[
              { id: "blue", label: "BLUE · Coalition" },
              { id: "red", label: "RED · OPFOR" },
            ]}
          />
          <p className="sd-controls-hint">
            Arm a unit class from the ontology palette, then click the chart to place it for the selected side. Click a
            placed unit to open the editor.
          </p>
        </div>
        <div className="sd-palette">
          {paletteGroups.map((group) => (
            <div key={group.domain} className="sd-palette-group">
              <span className="sd-palette-head">{domainLabels[group.domain]}</span>
              <div className="sd-palette-chips">
                {group.classes.map((cls) => (
                  <button
                    key={cls.id}
                    type="button"
                    className={`sd-chip${placementClassId === cls.id ? " sd-armed" : ""}`}
                    title={cls.description}
                    onClick={() => togglePlacement(cls)}
                  >
                    {cls.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {armedClass ? (
          <div className="sd-placement-note">
            <Crosshair size={15} />
            <span>
              Placement armed, click the chart to position <strong>{armedClass.label}</strong> for {sideLabels[side]}.
            </span>
            <button
              type="button"
              className="sd-note-cancel"
              onClick={() => {
                setPlacementClassId(null);
                props.notify("Placement mode disarmed");
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}
        <TheaterMap
          center={scn.mapCenter}
          zoom={scn.mapZoom}
          units={scn.units}
          theater={theater}
          objectives={scn.objectives}
          selectedUnitId={selectedUnitId}
          onSelectUnit={(id) => setSelectedUnitId(id)}
          onMapClick={handleMapClick}
          showHexGrid
          showLabels
          worldKey={`design:${scn.id}`}
          height={460}
        />
        {selectedUnit ? (
          <Panel
            icon={Crosshair}
            title={`Unit editor, ${selectedUnit.name}`}
            action={<Tag label={sideLabels[selectedUnit.side]} color={sideColors[selectedUnit.side]} />}
          >
            <div className="sd-stack">
              <DetailGrid>
                <Detail label="Class" value={classLabel(selectedUnit.classId)} />
                <Detail label="Domain" value={domainLabels[selectedUnit.domain]} />
                <Detail
                  label="Position"
                  value={`${selectedUnit.position.lat.toFixed(3)}, ${selectedUnit.position.lng.toFixed(3)}`}
                />
                <Detail
                  label="Weapons"
                  value={selectedUnit.weapons.length > 0 ? selectedUnit.weapons.map((w) => w.type).join(", ") : "none fitted"}
                />
              </DetailGrid>
              <FormGrid columns={4}>
                <div className="sd-span-full">
                  <Field label="Unit name">
                    <input value={selectedUnit.name} onChange={(e) => updateUnit(selectedUnit.id, { name: e.target.value })} />
                  </Field>
                </div>
                <Field label="Strength (%)">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={selectedUnit.strength}
                    onChange={(e) => updateUnit(selectedUnit.id, { strength: clampNum(e.target.value, 0, 100) })}
                  />
                </Field>
                <Field label="Heading (deg)">
                  <input
                    type="number"
                    min={0}
                    max={359}
                    value={selectedUnit.headingDeg}
                    onChange={(e) => updateUnit(selectedUnit.id, { headingDeg: clampNum(e.target.value, 0, 359) })}
                  />
                </Field>
                <Field label="Speed (kts)">
                  <input
                    type="number"
                    min={0}
                    max={900}
                    value={selectedUnit.speedKts}
                    onChange={(e) => updateUnit(selectedUnit.id, { speedKts: clampNum(e.target.value, 0, 900) })}
                  />
                </Field>
                <Field label="Supply (%)">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={selectedUnit.supply}
                    onChange={(e) => updateUnit(selectedUnit.id, { supply: clampNum(e.target.value, 0, 100) })}
                  />
                </Field>
              </FormGrid>
              <ActionRow>
                <Button className="button sd-danger" icon={Trash2} onClick={() => removeUnit(selectedUnit.id)}>
                  Remove unit
                </Button>
                <Button variant="secondary" onClick={() => setSelectedUnitId(null)}>
                  Close editor
                </Button>
              </ActionRow>
            </div>
          </Panel>
        ) : null}
        <div className="split-grid equal">
          <section>
            <header className="sd-force-head">
              <span className="sd-side-dot" style={{ background: sideColors.blue }} />
              <strong>{sideLabels.blue}</strong>
              <Tag label={`${blueUnits.length} units`} />
            </header>
            {blueUnits.length > 0 ? (
              <CompactTable columns={UNIT_COLUMNS} rows={unitRows(blueUnits)} />
            ) : (
              <EmptyState
                icon={Anchor}
                title="No BLUE units placed"
                hint="Arm a class from the palette and click the chart to build the coalition order of battle."
              />
            )}
          </section>
          <section>
            <header className="sd-force-head">
              <span className="sd-side-dot" style={{ background: sideColors.red }} />
              <strong>{sideLabels.red}</strong>
              <Tag label={`${redUnits.length} units`} />
            </header>
            {redUnits.length > 0 ? (
              <CompactTable columns={UNIT_COLUMNS} rows={unitRows(redUnits)} />
            ) : (
              <EmptyState
                icon={Shield}
                title="No RED units placed"
                hint="Switch the side picker to RED · OPFOR and lay down the opposing force on the archipelago."
              />
            )}
          </section>
        </div>
      </div>
    );
  };

  const renderObjectiveColumn = (scn: Scenario, columnSide: PlacementSide) => {
    const objectives = scn.objectives.filter((o) => o.side === columnSide);
    const totalWeight = objectives.reduce((acc, o) => acc + o.weight, 0);
    return (
      <section className="sd-obj-column">
        <header className="sd-obj-head">
          <div>
            <strong style={{ color: sideColors[columnSide] }}>{sideLabels[columnSide]}</strong>
            <small>
              {objectives.length} objective{objectives.length === 1 ? "" : "s"} · weight total {totalWeight.toFixed(2)}
            </small>
          </div>
          <Button variant="secondary" icon={Plus} onClick={() => setObjModal({ side: columnSide, objective: null })}>
            Add objective
          </Button>
        </header>
        {objectives.length === 0 ? (
          <EmptyState
            icon={Target}
            title={`No ${columnSide.toUpperCase()} objectives`}
            hint="Add at least one weighted objective so the engine can score this side during deduction."
          />
        ) : (
          objectives.map((objective) => (
            <article key={objective.id} className="sd-obj-row">
              <div>
                <strong>{objective.title}</strong>
                <p>{objective.description}</p>
                <div className="sd-obj-tags">
                  <Tag label={kindLabel(objective.kind)} color={sideColors[columnSide]} />
                  <Tag label={`weight ${Math.round(objective.weight * 100)}%`} />
                  {objective.area ? (
                    <Tag
                      label={`${objective.area.center.lat.toFixed(2)}, ${objective.area.center.lng.toFixed(2)} · r ${objective.area.radiusKm} km`}
                    />
                  ) : null}
                  {objective.targetUnitIds && objective.targetUnitIds.length > 0 ? (
                    <Tag label={`${objective.targetUnitIds.length} linked unit${objective.targetUnitIds.length === 1 ? "" : "s"}`} />
                  ) : null}
                </div>
              </div>
              <div className="sd-obj-actions">
                <button
                  type="button"
                  className="sd-icon-btn"
                  onClick={() => setObjModal({ side: columnSide, objective })}
                >
                  <Pencil size={13} /> Edit
                </button>
                <button type="button" className="sd-icon-btn sd-danger-link" onClick={() => removeObjective(objective.id)}>
                  <Trash2 size={13} /> Remove
                </button>
              </div>
            </article>
          ))
        )}
        {objectives.length > 0 && Math.abs(totalWeight - 1) > 0.05 ? (
          <p className="sd-weight-warn">
            Objective weights for this side should sum to roughly 1.00, currently {totalWeight.toFixed(2)}. Validation
            will flag unbalanced weighting.
          </p>
        ) : null}
      </section>
    );
  };

  const renderEnvironment = (scn: Scenario) => (
    <div className="sd-tab-stack">
      <FormGrid columns={3}>
        <Field label="Weather">
          <select
            value={scn.environment.weather}
            onChange={(e) => updateEnvironment({ weather: e.target.value as ScenarioEnvironment["weather"] })}
          >
            <option value="clear">Clear</option>
            <option value="overcast">Overcast</option>
            <option value="storm">Storm</option>
          </select>
        </Field>
        <Field label="Sea state (Douglas scale)">
          <select value={String(scn.environment.seaState)} onChange={(e) => updateEnvironment({ seaState: Number(e.target.value) })}>
            {SEA_STATE_LABELS.map((label, index) => (
              <option key={label} value={String(index)}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Visibility (km)">
          <input
            type="number"
            min={0}
            max={80}
            value={scn.environment.visibilityKm}
            onChange={(e) => updateEnvironment({ visibilityKm: clampNum(e.target.value, 0, 80) })}
          />
        </Field>
        <Field label="EMCON posture">
          <select
            value={scn.environment.emcon}
            onChange={(e) => updateEnvironment({ emcon: e.target.value as ScenarioEnvironment["emcon"] })}
          >
            <option value="free">Free, unrestricted emissions</option>
            <option value="restricted">Restricted, mission-essential only</option>
            <option value="silent">Silent, passive sensors only</option>
          </select>
        </Field>
        <Field label="Cyber threat condition">
          <select
            value={scn.environment.cyberThreat}
            onChange={(e) => updateEnvironment({ cyberThreat: e.target.value as ScenarioEnvironment["cyberThreat"] })}
          >
            <option value="low">Low</option>
            <option value="elevated">Elevated</option>
            <option value="severe">Severe</option>
          </select>
        </Field>
        <Field label="Exercise duration (hours)">
          <input
            type="number"
            min={6}
            max={240}
            step={6}
            value={scn.durationHours}
            onChange={(e) =>
              mutateWorking((draft) => {
                draft.durationHours = clampNum(e.target.value, 6, 240);
              })
            }
          />
        </Field>
      </FormGrid>
      <p className="sd-env-note">
        <CloudSun size={16} />
        <span>
          Environment settings drive adjudication modifiers during deduction: storm conditions and sea state 6 or above
          degrade detection ranges and small-craft speed, EMCON silent lowers own-force detectability at the cost of
          sensor coverage, and a severe cyber threat raises the likelihood of C2 disruption events. Duration bounds the
          simulation clock for every run started from this scenario.
        </span>
      </p>
    </div>
  );

  const renderValidation = (report: ValidationReport) => (
    <Panel
      icon={ShieldCheck}
      title="Validation report"
      action={<StatusPill label={report.ok ? "pass" : "issues found"} tone={report.ok ? "good" : "warn"} />}
    >
      {dirty ? (
        <p className="sd-validate-note">
          This report reflects the last saved revision, save your local changes and re-run validation to check them.
        </p>
      ) : null}
      {report.issues.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No issues found"
          hint="Scenario passes all readiness checks and can be promoted for mission decomposition and COA generation."
        />
      ) : (
        <div className="sd-issue-list">
          {report.issues.map((issue, index) => (
            <article key={`${issue.code}-${index}`} className="sd-issue-row">
              <StatusPill
                label={issue.level}
                tone={issue.level === "error" ? "danger" : issue.level === "warning" ? "warn" : "info"}
              />
              <div>
                <strong>{issue.message}</strong>
                <small>{issue.code}</small>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="sd-checked-at">Checked {timeAgo(report.checkedAt)}</p>
    </Panel>
  );

  const renderWorkspace = (scn: Scenario) => {
    const blueCount = scn.units.filter((u) => u.side === "blue").length;
    const redCount = scn.units.filter((u) => u.side === "red").length;
    const blueObjectives = scn.objectives.filter((o) => o.side === "blue").length;
    const redObjectives = scn.objectives.filter((o) => o.side === "red").length;
    return (
      <>
        <Panel
          icon={Compass}
          title={scn.name}
          action={
            <ActionRow>
              <StatusPill label={scn.status} tone={statusTone(scn.status)} />
              {dirty ? <Tag label="Unsaved changes" color="var(--amber)" /> : null}
              <Button variant="secondary" icon={ShieldCheck} onClick={handleValidate} disabled={validating}>
                {validating ? "Validating…" : "Validate"}
              </Button>
              <Button icon={Save} onClick={handleSave} disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save scenario"}
              </Button>
            </ActionRow>
          }
        >
          <p className="sd-desc">{scn.description}</p>
          <div className="sd-meta-grid">
            <DetailGrid>
              <Detail label="Theater" value={scn.theater} />
              <Detail label="Codename" value={scn.codename} />
              <Detail label="Duration" value={`${scn.durationHours} h planned`} />
              <Detail label="Force mix" value={`${blueCount} BLUE · ${redCount} RED`} />
              <Detail label="Objectives" value={`${blueObjectives} BLUE · ${redObjectives} RED`} />
              <Detail label="Last updated" value={timeAgo(scn.updatedAt)} />
            </DetailGrid>
          </div>
          <Segmented
            value={tab}
            onChange={handleTab}
            items={[
              { id: "orbat", label: `Order of battle (${scn.units.length})` },
              { id: "objectives", label: `Objectives (${scn.objectives.length})` },
              { id: "environment", label: "Environment" },
            ]}
          />
          {tab === "orbat" ? renderOrbat(scn) : null}
          {tab === "objectives" ? (
            <div className="sd-tab-stack">
              <div className="split-grid equal">
                {renderObjectiveColumn(scn, "blue")}
                {renderObjectiveColumn(scn, "red")}
              </div>
            </div>
          ) : null}
          {tab === "environment" ? renderEnvironment(scn) : null}
        </Panel>
        {validation ? renderValidation(validation) : null}
      </>
    );
  };

  // --- Top-level states ---------------------------------------------------------------

  if (loading) {
    return (
      <PageBody>
        <EmptyState
          icon={Radar}
          title="Loading scenario workspace"
          hint="Fetching theater geography, scenario library and the force ontology from the platform foundation."
        />
      </PageBody>
    );
  }

  if (loadError) {
    return (
      <PageBody>
        <EmptyState icon={AlertTriangle} title="Scenario workspace unavailable" hint={loadError} />
        <ActionRow>
          <Button
            variant="secondary"
            onClick={() => {
              setReloadKey((key) => key + 1);
              props.notify("Retrying platform data load");
            }}
          >
            Retry
          </Button>
        </ActionRow>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <div className="split-grid cms-grid">
        <Panel
          icon={MapIcon}
          title="Scenario library"
          action={
            <span className="sd-lib-actions">
              <Button icon={FileText} variant="secondary" onClick={() => setShowOpord(true)}>
                Import OPORD
              </Button>
              <Button icon={Plus} onClick={() => setShowCreate(true)}>
                New scenario
              </Button>
            </span>
          }
        >
          {scenarios.length === 0 ? (
            <EmptyState
              icon={MapIcon}
              title="No scenarios on file"
              hint="Create your first scenario from the blank template to start building an exercise."
            />
          ) : (
            <div className="zone-list">
              {scenarios.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  className={scenario.id === selectedId ? "sd-scn-selected" : ""}
                  onClick={() => handleSelectScenario(scenario)}
                >
                  <em>{initials(scenario.codename || scenario.name)}</em>
                  <span>
                    <strong>{scenario.name}</strong>
                    <small>
                      {scenario.codename} · {scenario.units.length} units · {scenario.objectives.length} objectives ·
                      updated {timeAgo(scenario.updatedAt)}
                    </small>
                  </span>
                  <StatusPill label={scenario.status} tone={statusTone(scenario.status)} />
                </button>
              ))}
            </div>
          )}
        </Panel>
        <div className="sd-stack">
          {working ? (
            renderWorkspace(working)
          ) : (
            <Panel icon={Compass} title="No scenario selected">
              <EmptyState
                icon={Compass}
                title="Select or create a scenario"
                hint="Pick a scenario from the library or create a new one to open the design workspace."
              />
            </Panel>
          )}
        </div>
      </div>
      {showOpord ? (
        <OpordWizardModal
          notify={props.notify}
          onClose={() => setShowOpord(false)}
          onCreated={(created) => {
            setScenarios((prev) => [created, ...prev]);
            setSelectedId(created.id);
            setWorking(cloneScenario(created));
            setDirty(false);
            setValidation(null);
            setSelectedUnitId(null);
            setPlacementClassId(null);
            setShowOpord(false);
            setTab("orbat");
            props.notify(`Scenario "${created.name}" materialized from the document, ${created.units.length} pieces deployed`);
          }}
        />
      ) : null}
      {showCreate ? (
        <CreateScenarioModal
          templates={templates}
          busy={creating}
          notify={props.notify}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      ) : null}
      {objModal && working ? (
        <ObjectiveEditorModal
          side={objModal.side}
          initial={objModal.objective}
          mapCenter={working.mapCenter}
          notify={props.notify}
          onClose={() => setObjModal(null)}
          onCommit={commitObjective}
        />
      ) : null}
    </PageBody>
  );
}

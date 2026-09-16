import { Database, Layers3, Plus, Puzzle, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "./foundation.css";
import { ApiError, createPieceType, fetchBootstrap, fetchOntology, fetchPlatform } from "../api";
import {
  ActionRow,
  Button,
  CompactTable,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  FormGrid,
  Metric,
  MetricGrid,
  Modal,
  Panel,
  ProgressBar,
  StatusPill,
  Tag,
} from "../components";
import { domainLabels, statusTone } from "../data";
import type { PageProps } from "../shell";
import type { Bootstrap, Domain, Ontology, OntologyClass, OntologyRelation, PlatformInfo } from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

const DOMAIN_ORDER = ["Base data", "Runtime data", "Scenario data", "Deduction process", "Assessment data"];

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function Foundation({ notify, goTo, profile }: PageProps) {
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [ontology, setOntology] = useState<Ontology | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [classId, setClassId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showDesigner, setShowDesigner] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchPlatform(), fetchOntology(), fetchBootstrap()])
      .then(([p, o, b]) => {
        if (!alive) return;
        setPlatform(p);
        setOntology(o);
        setBoot(b);
        setClassId(o.classes[0]?.id ?? "");
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

  // Flatten the class tree parent-first with depth for indentation.
  const tree = useMemo(() => {
    if (!ontology) return [] as Array<{ cls: OntologyClass; depth: number }>;
    const byParent = new Map<string | null, OntologyClass[]>();
    for (const cls of ontology.classes) {
      const list = byParent.get(cls.parent) ?? [];
      list.push(cls);
      byParent.set(cls.parent, list);
    }
    const out: Array<{ cls: OntologyClass; depth: number }> = [];
    const visit = (parent: string | null, depth: number) => {
      for (const cls of byParent.get(parent) ?? []) {
        out.push({ cls, depth });
        visit(cls.id, depth + 1);
      }
    };
    visit(null, 0);
    // Orphans whose parent id is not itself a class (defensive):
    const seen = new Set(out.map((r) => r.cls.id));
    for (const cls of ontology.classes) if (!seen.has(cls.id)) out.push({ cls, depth: 0 });
    return out;
  }, [ontology]);

  const selected = ontology?.classes.find((c) => c.id === classId);
  const relations = useMemo(() => {
    if (!ontology || !selected) return { out: [] as OntologyRelation[], into: [] as OntologyRelation[] };
    return {
      out: ontology.relations.filter((r) => r.from === selected.id),
      into: ontology.relations.filter((r) => r.to === selected.id),
    };
  }, [ontology, selected]);

  const label = (id: string) => ontology?.classes.find((c) => c.id === id)?.label ?? id;

  if (loading || !platform) {
    return (
      <div className="page-body">
        <EmptyState icon={Database} title="Loading platform foundation" hint="Fetching engines, data domains and the ontology." />
      </div>
    );
  }

  const enginesOnline = platform.engines.filter((e) => e.status === "online").length;
  const totalRecords = platform.dataDomains.reduce((s, d) => s + d.records, 0);
  const domains = [...platform.dataDomains].sort((a, b) => DOMAIN_ORDER.indexOf(a.name) - DOMAIN_ORDER.indexOf(b.name));

  return (
    <div className="page-body">
      <MetricGrid>
        <Metric label="Engines online" value={`${enginesOnline}/${platform.engines.length}`} helper="Simulation engine pool" tone={enginesOnline === platform.engines.length ? "good" : "warn"} />
        <Metric label="Data records" value={formatCount(totalRecords)} helper="Across five data domains" tone="info" />
        <Metric label="Active runs" value={String(platform.engines.reduce((s, e) => s + e.activeRuns, 0))} helper="Engine workload now" tone="neutral" />
        <Metric label="Ontology classes" value={String(ontology?.classes.length ?? 0)} helper={`${ontology?.relations.length ?? 0} relations | v${ontology?.version ?? "-"}`} tone="info" />
      </MetricGrid>

      <Panel title="Multiple simulation engines">
        <div className="fnd-engine-grid">
          {platform.engines.map((engine) => (
            <article key={engine.id} className="fnd-card">
              <header>
                <strong>{engine.name}</strong>
                <StatusPill label={engine.status} tone={statusTone(engine.status)} />
              </header>
              <span className="fnd-meta">
                {engine.kind} | v{engine.version} | {engine.activeRuns} active run(s)
              </span>
              <ProgressBar label="Load" value={engine.loadPct} tone={engine.loadPct > 75 ? "danger" : engine.loadPct > 45 ? "warn" : "good"} />
              <div className="fnd-caps">
                {engine.capabilities.map((cap) => (
                  <Tag key={cap} label={cap} />
                ))}
              </div>
            </article>
          ))}
        </div>
        <p className="fnd-caption">Unified real-time and turn-based engines | multi-resolution space-time | multi-branch COA in parallel | CGF and AI-agent runtime.</p>
      </Panel>

      <Panel title="Unified data foundation">
        <div className="fnd-domain-grid">
          {domains.map((domain) => (
            <article key={domain.id} className="fnd-card">
              <header>
                <strong>{domain.name}</strong>
                <StatusPill label={domain.health} tone={statusTone(domain.health)} />
              </header>
              <span className="fnd-meta">
                <Tag label={domain.store} /> | {formatCount(domain.records)} records | {domain.sizeGB} GB
              </span>
              <span className="fnd-desc">{domain.description}</span>
            </article>
          ))}
        </div>
        <p className="fnd-caption">One data engine across base, runtime, scenario, deduction-process and assessment data, polymorphic hybrid storage, distributed, secure and governed.</p>
      </Panel>

      <div className="split-grid equal">
        <Panel title="One platform - low-code inventory">
          <div className="detail-stack">
            <DetailGrid>
              <Detail label="Maps" value={String(platform.lowCode.maps)} />
              <Detail label="Pieces" value={String(platform.lowCode.pieces)} />
              <Detail label="Rules" value={String(platform.lowCode.rules)} />
              <Detail label="Scenarios" value={String(platform.lowCode.scenarios)} />
            </DetailGrid>
            <p className="fnd-desc" style={{ fontSize: 12.5 }}>
              Low-code / no-code design of maps, pieces, rules and scenarios, design, run and review closed in a single
              environment with unified user, permission and log management.
            </p>
            <Button icon={Puzzle} variant="secondary" onClick={() => setShowDesigner(true)}>
              New piece type
            </Button>
            {profile.pages.includes("admin") ? (
              <Button icon={ShieldCheck} variant="secondary" onClick={() => goTo("admin")}>
                Open user &amp; permission management
              </Button>
            ) : (
              <p className="ail-note">User, permission and log management requires the Platform Admin profile.</p>
            )}
          </div>
        </Panel>
        <Panel title="Runtime wiring">
          <div className="detail-stack">
            <DetailGrid>
              <Detail label="Observation API" value={`${formatCount(platform.apiStats.observationCalls)} calls`} />
              <Detail label="Piece-drive API" value={`${formatCount(platform.apiStats.pieceDriveCalls)} calls`} />
              <Detail label="Avg latency" value={`${platform.apiStats.avgLatencyMs} ms`} />
              <Detail label="Scenarios loaded" value={String(boot?.scenarios.length ?? 0)} />
            </DetailGrid>
            <p className="fnd-desc" style={{ fontSize: 12.5 }}>
              Tactical agents sense the world through the Observation API and act through the Piece-drive API; every call is
              logged to the deduction-process domain and replayable in assessment.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Ontology explorer" action={<Tag label={`updated ${ontology ? new Date(ontology.updatedAt).toLocaleDateString() : "-"}`} />}>
        <div className="fnd-onto">
          <div className="fnd-tree">
            {tree.map(({ cls, depth }) => (
              <button
                key={cls.id}
                type="button"
                className={`fnd-tree-row${cls.id === classId ? " active" : ""}`}
                style={{ marginInlineStart: depth * 18 }}
                onClick={() => setClassId(cls.id)}
              >
                <strong>{cls.label}</strong>
                <Tag label={cls.category} />
                {cls.domain ? <small>{domainLabels[cls.domain]}</small> : null}
                <small>{cls.attributes.length} attr</small>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="fnd-class-detail">
              <DetailGrid>
                <Detail label="Class" value={selected.label} />
                <Detail label="Identifier" value={selected.id} />
                <Detail label="Category" value={selected.category} />
                <Detail label="Domain" value={selected.domain ? domainLabels[selected.domain] : "-"} />
              </DetailGrid>
              <p>{selected.description}</p>
              <CompactTable
                columns={["Attribute", "Type", "Unit", "Description"]}
                rows={selected.attributes.map((attr) => [
                  attr.name,
                  attr.type + (attr.enumValues ? ` (${attr.enumValues.join(" | ")})` : ""),
                  attr.unit ?? "-",
                  attr.description ?? "-",
                ])}
              />
              <div className="fnd-rel-list">
                {relations.out.map((rel) => (
                  <span key={rel.id} className="fnd-rel">
                    <strong>{selected.label}</strong> <em>{rel.label}</em> <strong>{label(rel.to)}</strong>
                    <small style={{ color: "var(--muted)" }}>, {rel.description}</small>
                  </span>
                ))}
                {relations.into.map((rel) => (
                  <span key={rel.id} className="fnd-rel">
                    <strong>{label(rel.from)}</strong> <em>{rel.label}</em> <strong>{selected.label}</strong>
                    <small style={{ color: "var(--muted)" }}>, {rel.description}</small>
                  </span>
                ))}
                {!relations.out.length && !relations.into.length ? (
                  <span className="fnd-rel">No relations declared for this class.</span>
                ) : null}
              </div>
            </div>
          ) : (
            <EmptyState icon={Layers3} title="Pick a class" hint="Select an ontology class to inspect its attributes and relations." />
          )}
        </div>
      </Panel>

      {showDesigner ? (
        <PieceDesignerModal
          onClose={() => setShowDesigner(false)}
          onCreate={async (payload) => {
            try {
              const created = await createPieceType(payload);
              setOntology((o) => (o ? { ...o, classes: [...o.classes, created] } : o));
              setPlatform((p) => (p ? { ...p, lowCode: { ...p.lowCode, pieces: p.lowCode.pieces + 1 } } : p));
              setClassId(created.id);
              setShowDesigner(false);
              notify(`Piece type "${created.label}" added, it is now in the Scenario Design palette`);
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

interface DesignerSensor {
  type: string;
  rangeKm: string;
}

interface DesignerWeapon {
  type: string;
  rangeKm: string;
  pk: string;
  ammo: string;
}

function PieceDesignerModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (payload: {
    label: string;
    domain: string;
    description?: string;
    speedKts?: number;
    supply?: number;
    sensors?: Array<{ type: string; rangeKm: number }>;
    weapons?: Array<{ type: string; rangeKm: number; pk: number; ammo: number }>;
  }) => void;
}) {
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState<Domain>("sea");
  const [description, setDescription] = useState("");
  const [speedKts, setSpeedKts] = useState("14");
  const [supply, setSupply] = useState("100");
  const [sensors, setSensors] = useState<DesignerSensor[]>([{ type: "surface-search-radar", rangeKm: "80" }]);
  const [weapons, setWeapons] = useState<DesignerWeapon[]>([{ type: "ssm", rangeKm: "120", pk: "0.5", ammo: "8" }]);

  function submit() {
    if (!label.trim()) return;
    onCreate({
      label: label.trim(),
      domain,
      description: description.trim() || undefined,
      speedKts: Number(speedKts) || 0,
      supply: Number(supply) || 100,
      sensors: sensors
        .filter((s) => s.type.trim())
        .map((s) => ({ type: s.type.trim(), rangeKm: Number(s.rangeKm) || 10 })),
      weapons: weapons
        .filter((w) => w.type.trim())
        .map((w) => ({
          type: w.type.trim(),
          rangeKm: Number(w.rangeKm) || 10,
          pk: Number(w.pk) || 0.4,
          ammo: Number(w.ammo) || 8,
        })),
    });
  }

  return (
    <Modal title="Piece designer, new unit type" onClose={onClose} wide>
      <FormGrid columns={2}>
        <Field label="Piece name">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Fast attack craft" />
        </Field>
        <Field label="Domain">
          <select value={domain} onChange={(e) => setDomain(e.target.value as Domain)}>
            {(Object.keys(domainLabels) as Domain[]).map((d) => (
              <option key={d} value={d}>
                {domainLabels[d]}
              </option>
            ))}
          </select>
        </Field>
      </FormGrid>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this piece models and how it should be employed…"
        />
      </Field>
      <FormGrid columns={2}>
        <Field label="Speed (kts)">
          <input type="number" value={speedKts} onChange={(e) => setSpeedKts(e.target.value)} min={0} max={600} />
        </Field>
        <Field label="Initial supply (%)">
          <input type="number" value={supply} onChange={(e) => setSupply(e.target.value)} min={10} max={100} />
        </Field>
      </FormGrid>

      <div className="fnd-designer-section">
        <div className="fnd-designer-head">
          <span className="rc-subhead">Sensors</span>
          <Button icon={Plus} variant="secondary" onClick={() => setSensors((l) => [...l, { type: "", rangeKm: "50" }])}>
            Sensor
          </Button>
        </div>
        {sensors.map((sensor, index) => (
          <div key={index} className="fnd-designer-row">
            <input
              value={sensor.type}
              placeholder="type, e.g. sonar"
              onChange={(e) => setSensors((l) => l.map((s, i) => (i === index ? { ...s, type: e.target.value } : s)))}
            />
            <input
              type="number"
              value={sensor.rangeKm}
              placeholder="range km"
              onChange={(e) => setSensors((l) => l.map((s, i) => (i === index ? { ...s, rangeKm: e.target.value } : s)))}
            />
            <button className="rc-icon-btn" type="button" onClick={() => setSensors((l) => l.filter((_, i) => i !== index))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="fnd-designer-section">
        <div className="fnd-designer-head">
          <span className="rc-subhead">Weapons</span>
          <Button
            icon={Plus}
            variant="secondary"
            onClick={() => setWeapons((l) => [...l, { type: "", rangeKm: "60", pk: "0.4", ammo: "8" }])}
          >
            Weapon
          </Button>
        </div>
        {weapons.map((weapon, index) => (
          <div key={index} className="fnd-designer-row weapons">
            <input
              value={weapon.type}
              placeholder="type, e.g. sam"
              onChange={(e) => setWeapons((l) => l.map((w, i) => (i === index ? { ...w, type: e.target.value } : w)))}
            />
            <input
              type="number"
              value={weapon.rangeKm}
              placeholder="range km"
              onChange={(e) => setWeapons((l) => l.map((w, i) => (i === index ? { ...w, rangeKm: e.target.value } : w)))}
            />
            <input
              type="number"
              step="0.05"
              value={weapon.pk}
              placeholder="pk 0-1"
              onChange={(e) => setWeapons((l) => l.map((w, i) => (i === index ? { ...w, pk: e.target.value } : w)))}
            />
            <input
              type="number"
              value={weapon.ammo}
              placeholder="ammo"
              onChange={(e) => setWeapons((l) => l.map((w, i) => (i === index ? { ...w, ammo: e.target.value } : w)))}
            />
            <button className="rc-icon-btn" type="button" onClick={() => setWeapons((l) => l.filter((_, i) => i !== index))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <ActionRow>
        <Button icon={Puzzle} onClick={submit} disabled={!label.trim()}>
          Create piece type
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

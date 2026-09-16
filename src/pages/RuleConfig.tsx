import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  Gavel,
  Pencil,
  Plus,
  Scale,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "./ruleconfig.css";
import { ApiError, createRuleSet, fetchRuleSets, testRuleSet, updateRuleSet } from "../api";
import {
  ActionRow,
  Button,
  Detail,
  DetailGrid,
  EmptyState,
  Field,
  FormGrid,
  Modal,
  Panel,
  Segmented,
  StatusPill,
  Tag,
  timeAgo,
  plural,
} from "../components";
import { statusTone } from "../data";
import type { PageProps } from "../shell";
import type {
  ConditionOp,
  Rule,
  RuleCategory,
  RuleCondition,
  RuleEffect,
  RuleEffectType,
  RuleSet,
  RuleTestResult,
} from "../types";

const errMsg = (error: unknown) => (error instanceof ApiError ? error.message : "Backend unreachable");

const FACTS = [
  "range",
  "actor.domain",
  "actor.side",
  "actor.strength",
  "actor.supply",
  "actor.status",
  "target.domain",
  "target.side",
  "target.strength",
  "target.status",
  "weather",
  "seaState",
  "emcon",
  "simTimeH",
  "phase.name",
] as const;

const OPS: ConditionOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "within-km", "has"];

const EFFECT_TYPES: RuleEffectType[] = [
  "modify-pk",
  "modify-detection",
  "modify-speed",
  "apply-damage",
  "consume-supply",
  "reveal-unit",
  "score-points",
  "spawn-event",
  "request-decision",
];

const CATEGORIES: Array<{ id: RuleCategory; label: string; hint: string }> = [
  { id: "detection", label: "Detection", hint: "Who sees whom, and when tracks are revealed" },
  { id: "engagement", label: "Engagement", hint: "Hit probability modifiers and fire discipline" },
  { id: "movement", label: "Movement", hint: "Speed and maneuver modifiers" },
  { id: "logistics", label: "Logistics", hint: "Supply consumption and sustainment reports" },
  { id: "attrition", label: "Attrition", hint: "Progressive damage outside direct fire" },
  { id: "victory", label: "Victory", hint: "Scoring and end-state emphasis" },
];

const SITUATIONS = [
  { id: "surface-engagement", label: "Surface action - BLUE destroyer vs RED missile boat at 32 km, clear weather" },
  { id: "air-strike", label: "Air raid - BLUE strike package vs RED SAM battalion at 110 km, overcast" },
  { id: "submarine-ambush", label: "Subsurface ambush - RED submarine vs BLUE supply ship at 12 km, EMCON silent" },
  { id: "storm-transit", label: "Storm transit - BLUE task group at 18% supply moving through sea state 6" },
];

function conditionSentence(c: RuleCondition): string {
  const op = c.op === "within-km" ? "within" : c.op;
  return `${c.fact} ${op} ${c.value}${c.op === "within-km" ? " km" : ""}`;
}

function effectSentence(e: RuleEffect): string {
  const p = e.params;
  switch (e.type) {
    case "modify-pk":
      return `modify-pk ×${p.factor ?? 1}`;
    case "modify-detection":
      return `modify-detection ×${p.factor ?? 1}`;
    case "modify-speed":
      return `modify-speed ×${p.factor ?? 1}`;
    case "apply-damage":
      return `apply-damage ${p.amount ?? 0}`;
    case "consume-supply":
      return `consume-supply ${p.amount ?? 0}`;
    case "score-points":
      return `score ${p.points ?? 0} pts`;
    case "spawn-event":
      return `spawn-event "${p.title ?? "event"}"`;
    case "request-decision":
      return `request-decision "${p.title ?? "commander check"}"`;
    default:
      return e.type;
  }
}

export default function RuleConfig({ notify }: PageProps) {
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<Rule | "new" | null>(null);
  const [newRuleCategory, setNewRuleCategory] = useState<RuleCategory>("engagement");
  const [showNewSet, setShowNewSet] = useState(false);
  const [situation, setSituation] = useState(SITUATIONS[0].id);
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const selected = ruleSets.find((rs) => rs.id === selectedId) ?? ruleSets[0];
  const locked = selected?.status === "active";

  useEffect(() => {
    let alive = true;
    fetchRuleSets()
      .then((data) => {
        if (!alive) return;
        setRuleSets(data);
        setSelectedId(data.find((rs) => rs.status === "active")?.id ?? data[0]?.id ?? "");
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

  async function save(patch: Partial<RuleSet>, message: string) {
    if (!selected) return;
    if (selected.status === "active") {
      notify("Active rule snapshots are locked. Create a working copy before changing adjudication.");
      return;
    }
    try {
      const updated = await updateRuleSet(selected.id, patch);
      setRuleSets((list) => list.map((rs) => (rs.id === updated.id ? updated : rs)));
      notify(message);
    } catch (error) {
      notify(errMsg(error));
    }
  }

  async function forkRuleSet() {
    if (!selected) return;
    try {
      const draft = await createRuleSet({
        name: `${selected.name} - working copy`,
        description: `Working copy of ${selected.name}. Changes do not affect operational runs until approved and activated.`,
        domainFocus: selected.domainFocus,
        author: selected.author,
      });
      const cloned = await updateRuleSet(draft.id, {
        rules: selected.rules.map((rule) => ({
          ...rule,
          conditions: rule.conditions.map((condition) => ({ ...condition })),
          effects: rule.effects.map((effect) => ({ ...effect, params: { ...effect.params } })),
        })),
        adjudication: { ...selected.adjudication, phaseOrder: [...selected.adjudication.phaseOrder] },
        status: "draft",
      });
      setRuleSets((list) => [...list, cloned]);
      setSelectedId(cloned.id);
      notify(`Working copy created from ${selected.name}`);
    } catch (error) {
      notify(errMsg(error));
    }
  }

  function toggleRule(rule: Rule) {
    if (!selected) return;
    const rules = selected.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
    void save({ rules }, `Rule "${rule.name}" ${rule.enabled ? "disabled" : "enabled"}`);
  }

  function saveRule(rule: Rule) {
    if (!selected) return;
    const exists = selected.rules.some((r) => r.id === rule.id);
    const rules = exists ? selected.rules.map((r) => (r.id === rule.id ? rule : r)) : [...selected.rules, rule];
    void save({ rules }, exists ? `Rule "${rule.name}" updated` : `Rule "${rule.name}" added to ${selected.name}`);
    setEditingRule(null);
  }

  function deleteRule(rule: Rule) {
    if (!selected) return;
    if (!window.confirm(`Remove rule "${rule.name}" from ${selected.name}?`)) return;
    void save({ rules: selected.rules.filter((r) => r.id !== rule.id) }, `Rule "${rule.name}" removed`);
    setEditingRule(null);
  }

  function movePhase(index: number, dir: -1 | 1) {
    if (!selected) return;
    const order = [...selected.adjudication.phaseOrder];
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    void save({ adjudication: { ...selected.adjudication, phaseOrder: order } }, "Adjudication phase order updated");
  }

  async function runTest() {
    if (!selected) return;
    setTesting(true);
    try {
      const result = await testRuleSet(selected.id, situation);
      setTestResult(result);
      notify(`${plural(result.trace.filter((t) => t.fired).length, "rule")} fired`);
    } catch (error) {
      notify(errMsg(error));
    }
    setTesting(false);
  }

  if (loading) {
    return (
      <div className="page-body">
        <EmptyState icon={Scale} title="Loading rule sets" hint="Fetching adjudication configurations from the platform." />
      </div>
    );
  }

  return (
    <div className="page-body">
      <div className="split-grid wide-left">
        <div className="rc-stack">
          {selected ? (
            <>
              <Panel
                title={selected.name}
                action={
                  <div className="rc-lifecycle-actions">
                    <Tag label={selected.domainFocus} />
                    <StatusPill label={selected.status} tone={statusTone(selected.status)} />
                    {locked ? <Button variant="secondary" onClick={forkRuleSet}>Create working copy</Button> : null}
                  </div>
                }
              >
                <div className={`rc-lifecycle-strip${locked ? " is-locked" : ""}`}>
                  <span>ARTIFACT STATE</span>
                  <strong>{locked ? "Published snapshot · locked for active runs" : "Draft workspace · changes are not operational"}</strong>
                  <small>Owner {selected.author} · updated {new Date(selected.updatedAt).toISOString().replace("T", " ").slice(0, 16)}Z</small>
                </div>
                <p className="rc-set-desc">
                  {selected.description} <em>- {selected.author}, updated {timeAgo(selected.updatedAt)}</em>
                </p>
                <DetailGrid>
                  <Detail label="Rules" value={`${selected.rules.filter((r) => r.enabled).length}/${selected.rules.length} enabled`} />
                  <Detail label="Mode" value={selected.adjudication.mode} />
                  <Detail label="Die model" value={selected.adjudication.dieModel} />
                  <Detail label="Seed" value={String(selected.adjudication.seed)} />
                </DetailGrid>
              </Panel>

              <Panel title="Adjudication flow">
                <div className={`rc-adj-grid${locked ? " is-locked" : ""}`} aria-disabled={locked || undefined}>
                  <Field label="Mode">
                    <Segmented
                      value={selected.adjudication.mode}
                      onChange={(mode) => void save({ adjudication: { ...selected.adjudication, mode } }, `Adjudication mode set to ${mode}`)}
                      items={[
                        { id: "auto", label: "Auto" },
                        { id: "umpire", label: "Umpire" },
                        { id: "hybrid", label: "Hybrid" },
                      ]}
                    />
                  </Field>
                  <Field label="Die model">
                    <Segmented
                      value={selected.adjudication.dieModel}
                      onChange={(dieModel) =>
                        void save({ adjudication: { ...selected.adjudication, dieModel } }, `Die model set to ${dieModel}`)
                      }
                      items={[
                        { id: "deterministic", label: "Deterministic" },
                        { id: "stochastic", label: "Stochastic" },
                      ]}
                    />
                  </Field>
                  <Field label="Random seed">
                    <input
                      type="number"
                      disabled={locked}
                      defaultValue={selected.adjudication.seed}
                      key={`${selected.id}-seed`}
                      onBlur={(e) => {
                        const seed = Number(e.target.value) || 0;
                        if (seed !== selected.adjudication.seed) {
                          void save({ adjudication: { ...selected.adjudication, seed } }, `Seed set to ${seed}`);
                        }
                      }}
                    />
                  </Field>
                  <Field label="Phase order (runs top to bottom each tick)">
                    <div className="rc-phase-list">
                      {selected.adjudication.phaseOrder.map((phase, index) => (
                        <span key={phase} className="rc-phase-chip">
                          <em>{index + 1}</em>
                          <strong>{phase}</strong>
                          <button className="rc-chip-btn" type="button" disabled={locked || index === 0} onClick={() => movePhase(index, -1)}>
                            <ArrowUp size={13} />
                          </button>
                          <button
                            className="rc-chip-btn"
                            type="button"
                            disabled={locked || index === selected.adjudication.phaseOrder.length - 1}
                            onClick={() => movePhase(index, 1)}
                          >
                            <ArrowDown size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </Field>
                </div>
              </Panel>

              <Panel title="Rules by category" action={<Tag label={`${selected.rules.length} rules`} />}>
                <div className="rc-groups">
                  {CATEGORIES.map((category) => {
                    const rules = selected.rules
                      .filter((r) => r.category === category.id)
                      .sort((a, b) => a.priority - b.priority);
                    return (
                      <section key={category.id} className="rc-group">
                        <header className="rc-group-head">
                          <strong>{category.label}</strong>
                          <small>{category.hint}</small>
                          <button
                            className="rc-add-btn"
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              setNewRuleCategory(category.id);
                              setEditingRule("new");
                            }}
                          >
                            <Plus size={13} />
                            Rule
                          </button>
                        </header>
                        {rules.length ? (
                          rules.map((rule) => (
                            <div key={rule.id} className={`rc-rule-row${rule.enabled ? "" : " disabled"}`}>
                              <input
                                className="rc-rule-check"
                                type="checkbox"
                                checked={rule.enabled}
                                disabled={locked}
                                onChange={() => toggleRule(rule)}
                                title={rule.enabled ? "Disable rule" : "Enable rule"}
                              />
                              <div className="rc-rule-main">
                                <strong>{rule.name}</strong>
                                <span className="rc-rule-desc">{rule.description}</span>
                                <span className="rc-sentence">
                                  <em>WHEN</em>
                                  {rule.conditions.map((c, i) => (
                                    <span key={i}>
                                      {i > 0 ? <em> AND </em> : null}
                                      {conditionSentence(c)}
                                    </span>
                                  ))}
                                  <em>THEN</em>
                                  {rule.effects.map((e, i) => (
                                    <span key={i}>
                                      {i > 0 ? <em> + </em> : null}
                                      {effectSentence(e)}
                                    </span>
                                  ))}
                                </span>
                              </div>
                              <div className="rc-rule-side">
                                <Tag label={`p${rule.priority}`} />
                                <button className="rc-row-btn" type="button" disabled={locked} onClick={() => setEditingRule(rule)}>
                                  <Pencil size={13} />
                                  Edit
                                </button>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="rc-empty-group">No {category.label.toLowerCase()} rules, add one to shape the adjudication.</p>
                        )}
                      </section>
                    );
                  })}
                </div>
              </Panel>
            </>
          ) : (
            <EmptyState icon={Scale} title="No rule sets" hint="Create a rule set to define how the engine adjudicates the simulation." />
          )}
        </div>

        <div className="rc-stack">
          <Panel title="Rule sets" action={<Button icon={Plus} variant="secondary" onClick={() => setShowNewSet(true)}>New</Button>}>
            <div className="zone-list">
              {ruleSets.map((rs) => (
                <button key={rs.id} type="button" onClick={() => { setSelectedId(rs.id); setTestResult(null); }}>
                  <span>
                    <strong>{rs.name}</strong>
                    <small>
                      {rs.rules.length} rules | {rs.domainFocus} | {rs.adjudication.mode}
                    </small>
                  </span>
                  <StatusPill label={rs.status} tone={statusTone(rs.status)} />
                </button>
              ))}
            </div>
          </Panel>

          {selected ? (
            <Panel title="Test the rule set">
              <div className="detail-stack">
                <Field label="Canned situation">
                  <select value={situation} onChange={(e) => setSituation(e.target.value)}>
                    {SITUATIONS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <ActionRow>
                  <Button icon={FlaskConical} onClick={runTest} disabled={testing}>
                    {testing ? "Adjudicating…" : "Dry-run adjudication"}
                  </Button>
                </ActionRow>
                {testResult ? (
                  <>
                    <div className="rc-outcome">
                      <strong>Outcome</strong>
                      <span>{testResult.outcome}</span>
                      <small className="rc-test-meta">
                        {testResult.situation} | tested {timeAgo(testResult.testedAt)}
                      </small>
                    </div>
                    <div className="rc-trace">
                      {testResult.trace.map((entry) => (
                        <div key={entry.ruleId} className="rc-trace-row">
                          <span className={`dot rc-trace-dot ${entry.fired ? "good" : "neutral"}`} />
                          <div className="rc-trace-main">
                            <strong>{entry.ruleName}</strong>
                            <small>{entry.detail}</small>
                          </div>
                          <span className={`rc-trace-flag${entry.fired ? " fired" : ""}`}>{entry.fired ? "fired" : "skipped"}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

      {editingRule && selected ? (
        <RuleBuilder
          key={editingRule === "new" ? "new" : editingRule.id}
          initial={editingRule === "new" ? null : editingRule}
          defaultCategory={newRuleCategory}
          nextId={`rule-${selected.id}-${selected.rules.length + 1}-${Math.floor(Math.random() * 1000)}`}
          onSave={saveRule}
          onDelete={editingRule !== "new" ? () => deleteRule(editingRule) : undefined}
          onClose={() => setEditingRule(null)}
        />
      ) : null}

      {showNewSet ? (
        <NewRuleSetModal
          onClose={() => setShowNewSet(false)}
          onCreate={async (payload) => {
            try {
              const created = await createRuleSet(payload);
              setRuleSets((list) => [...list, created]);
              setSelectedId(created.id);
              setShowNewSet(false);
              notify(`Rule set "${created.name}" created, add rules to it`);
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

function RuleBuilder({
  initial,
  defaultCategory,
  nextId,
  onSave,
  onDelete,
  onClose,
}: {
  initial: Rule | null;
  defaultCategory: RuleCategory;
  nextId: string;
  onSave: (rule: Rule) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<RuleCategory>(initial?.category ?? defaultCategory);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priority, setPriority] = useState(String(initial?.priority ?? 50));
  const [conditions, setConditions] = useState<RuleCondition[]>(
    initial?.conditions.length ? initial.conditions.map((c) => ({ ...c })) : [{ fact: "range", op: "within-km", value: 40 }]
  );
  const [effects, setEffects] = useState<RuleEffect[]>(
    initial?.effects.length ? initial.effects.map((e) => ({ ...e, params: { ...e.params } })) : [{ type: "modify-pk", params: { factor: 1.15 } }]
  );

  const preview = useMemo(() => {
    const when = conditions.map(conditionSentence).join(" AND ");
    const then = effects.map(effectSentence).join(" + ");
    return { when: when || "(always)", then: then || "(no effect)" };
  }, [conditions, effects]);

  function setCondition(index: number, patch: Partial<RuleCondition>) {
    setConditions((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function setEffect(index: number, patch: Partial<RuleEffect>) {
    setEffects((list) => list.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }

  function setEffectParam(index: number, key: string, value: string | number) {
    setEffects((list) => list.map((e, i) => (i === index ? { ...e, params: { ...e.params, [key]: value } } : e)));
  }

  function defaultParamsFor(type: RuleEffectType): Record<string, string | number> {
    switch (type) {
      case "modify-pk":
      case "modify-detection":
      case "modify-speed":
        return { factor: 1.1 };
      case "apply-damage":
      case "consume-supply":
        return { amount: 1 };
      case "score-points":
        return { points: 5 };
      case "spawn-event":
        return { title: "Situation report", severity: "warn" };
      case "request-decision":
        return { title: "Commander check required" };
      default:
        return {};
    }
  }

  function submit() {
    if (!name.trim()) return;
    onSave({
      id: initial?.id ?? nextId,
      name: name.trim(),
      category,
      description: description.trim() || "Custom rule authored in the low-code builder.",
      conditions: conditions.map((c) => ({
        ...c,
        value: ["gt", "gte", "lt", "lte", "within-km"].includes(c.op) ? Number(c.value) || 0 : c.value,
      })),
      effects,
      priority: Number(priority) || 50,
      enabled: initial?.enabled ?? true,
    });
  }

  return (
    <Modal title={initial ? `Edit rule, ${initial.name}` : "New adjudication rule"} onClose={onClose} wide>
      <FormGrid columns={3}>
        <Field label="Rule name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Night attack bonus" />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value as RuleCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority (lower runs first)">
          <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </FormGrid>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this rule models and why…" />
      </Field>

      <div className="rc-builder-section">
        <div className="rc-builder-head">
          <span className="rc-subhead">Conditions (all must hold)</span>
          <button className="rc-add-btn" type="button" onClick={() => setConditions((l) => [...l, { fact: "range", op: "within-km", value: 40 }])}>
            <Plus size={13} />
            Condition
          </button>
        </div>
        <div className="rc-builder-rows">
          {conditions.map((condition, index) => (
            <div key={index} className="rc-cond-row">
              <select value={condition.fact} onChange={(e) => setCondition(index, { fact: e.target.value })}>
                {FACTS.map((fact) => (
                  <option key={fact} value={fact}>
                    {fact}
                  </option>
                ))}
              </select>
              <select value={condition.op} onChange={(e) => setCondition(index, { op: e.target.value as ConditionOp })}>
                {OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                value={String(condition.value)}
                onChange={(e) => setCondition(index, { value: e.target.value })}
                placeholder="value"
              />
              <button className="rc-icon-btn" type="button" onClick={() => setConditions((l) => l.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="rc-builder-section">
        <div className="rc-builder-head">
          <span className="rc-subhead">Effects</span>
          <button className="rc-add-btn" type="button" onClick={() => setEffects((l) => [...l, { type: "modify-pk", params: { factor: 1.1 } }])}>
            <Plus size={13} />
            Effect
          </button>
        </div>
        <div className="rc-builder-rows">
          {effects.map((effect, index) => (
            <div key={index} className="rc-effect-row">
              <select
                value={effect.type}
                onChange={(e) => {
                  const type = e.target.value as RuleEffectType;
                  setEffect(index, { type, params: defaultParamsFor(type) });
                }}
              >
                {EFFECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <div className="rc-effect-params">
                {["modify-pk", "modify-detection", "modify-speed"].includes(effect.type) ? (
                  <input
                    type="number"
                    step="0.05"
                    value={String(effect.params.factor ?? 1)}
                    onChange={(e) => setEffectParam(index, "factor", Number(e.target.value) || 1)}
                    placeholder="factor"
                  />
                ) : null}
                {["apply-damage", "consume-supply"].includes(effect.type) ? (
                  <input
                    type="number"
                    step="0.1"
                    value={String(effect.params.amount ?? 1)}
                    onChange={(e) => setEffectParam(index, "amount", Number(e.target.value) || 0)}
                    placeholder="amount"
                  />
                ) : null}
                {effect.type === "score-points" ? (
                  <input
                    type="number"
                    value={String(effect.params.points ?? 5)}
                    onChange={(e) => setEffectParam(index, "points", Number(e.target.value) || 0)}
                    placeholder="points"
                  />
                ) : null}
                {["spawn-event", "request-decision"].includes(effect.type) ? (
                  <input
                    value={String(effect.params.title ?? "")}
                    onChange={(e) => setEffectParam(index, "title", e.target.value)}
                    placeholder="title"
                  />
                ) : null}
                {effect.type === "spawn-event" ? (
                  <select value={String(effect.params.severity ?? "warn")} onChange={(e) => setEffectParam(index, "severity", e.target.value)}>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="danger">danger</option>
                    <option value="good">good</option>
                  </select>
                ) : null}
                {effect.type === "reveal-unit" ? <span className="rc-param-note">Reveals the target track to the opposing side.</span> : null}
              </div>
              <button className="rc-icon-btn" type="button" onClick={() => setEffects((l) => l.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="rc-preview">
        <span className="rc-preview-label">Live preview</span>
        <span className="rc-sentence">
          <em>WHEN</em> {preview.when} <em>THEN</em> {preview.then}
        </span>
      </div>

      <ActionRow>
        <Button icon={Gavel} onClick={submit} disabled={!name.trim()}>
          {initial ? "Save rule" : "Add rule"}
        </Button>
        {onDelete ? (
          <Button icon={Trash2} variant="danger" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        <Button icon={X} variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function NewRuleSetModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (payload: { name: string; description: string; domainFocus: string; author: string }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domainFocus, setDomainFocus] = useState("joint");

  return (
    <Modal title="New rule set" onClose={onClose}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Littoral Night Operations" />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this configuration models…" />
      </Field>
      <Field label="Domain focus">
        <select value={domainFocus} onChange={(e) => setDomainFocus(e.target.value)}>
          <option value="joint">Joint</option>
          <option value="sea">Maritime</option>
          <option value="air">Air</option>
          <option value="land">Land</option>
          <option value="cyber">Cyber</option>
        </select>
      </Field>
      <ActionRow>
        <Button
          icon={Plus}
          disabled={!name.trim()}
          onClick={() =>
            onCreate({
              name: name.trim(),
              description: description.trim() || "Custom adjudication configuration.",
              domainFocus,
              author: "Plans Cell (J5)",
            })
          }
        >
          Create rule set
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </ActionRow>
    </Modal>
  );
}

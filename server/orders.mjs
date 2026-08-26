// Staff products: the documents a headquarters actually hands to people.
//
// SANDTABLE could read an operational order and could not write one. It also
// computed a phase-to-assignment-to-subtask join and rendered it nowhere. This
// module closes both: a synchronisation matrix, a decision support matrix, a
// five-paragraph operation order with annexes, and the fragmentary order that
// gets cut when a commander overrides the machine at a decision point.
//
// Everything here is derived from the scenario, the COA and the mission that
// already exist. No new authored content, so a document can never claim
// something the simulation does not hold.

import { markingLine, portionMark, highWater, normalizeClassification } from "./classification.mjs";

const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const nl = String.fromCharCode(10);

/** Zulu date-time group, e.g. "261430ZAUG26". */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function dtg(iso) {
  const at = iso ? new Date(iso) : new Date();
  if (Number.isNaN(at.getTime())) return "UNKNOWN DTG";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}Z${MONTHS[at.getUTCMonth()]}${String(at.getUTCFullYear()).slice(2)}`;
}

/** "T+6h" against the exercise clock, which is what a phase boundary really is. */
const clock = (h) => `T+${round1(h)}h`;

// ---------------------------------------------------------------------------
// Task organisation
// ---------------------------------------------------------------------------

/**
 * Group BLUE by task force, falling back to domain when the scenario author did
 * not organise the force. This is the row axis of the synchronisation matrix and
 * Annex A of the order.
 */
export function taskOrganisation(scenario, side = "blue") {
  const units = (scenario.units || []).filter((u) => u.side === side);
  const groups = new Map();
  for (const unit of units) {
    const key = unit.taskForce || `${unit.domain.toUpperCase()} ELEMENT`;
    if (!groups.has(key)) groups.set(key, { id: key, name: key, units: [] });
    groups.get(key).units.push({ id: unit.id, name: unit.name, classId: unit.classId, domain: unit.domain });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Synchronisation matrix
// ---------------------------------------------------------------------------

/**
 * Phases across the top, task organisation down the side, what each element is
 * doing in each phase in the cells. The join between a phase, its assignment and
 * the mission sub-task the assignment serves has always been computed; this is
 * the first thing that renders it.
 */
export function buildSyncMatrix(scenario, coa, mission) {
  const groups = taskOrganisation(scenario, "blue");
  const subTasks = new Map(((mission && mission.subTasks) || []).map((t) => [t.id, t]));
  const unitName = new Map((scenario.units || []).map((u) => [u.id, u.name]));

  const phases = (coa.phases || []).map((phase) => ({
    id: phase.id,
    name: phase.name,
    startH: phase.startH,
    endH: phase.endH,
    window: `${clock(phase.startH)} to ${clock(phase.endH)}`,
    intent: phase.intent,
  }));

  const rows = groups.map((group) => {
    const unitIds = new Set(group.units.map((u) => u.id));
    const cells = (coa.phases || []).map((phase) => {
      const assignments = (phase.assignments || []).filter((a) => (a.unitIds || []).some((id) => unitIds.has(id)));
      if (!assignments.length) {
        return { phaseId: phase.id, tasks: [], summary: "No tasking in this phase, element holds its last order." };
      }
      const tasks = assignments.map((assignment) => {
        const subTask = subTasks.get(assignment.subTaskId) || null;
        const involved = (assignment.unitIds || []).filter((id) => unitIds.has(id));
        return {
          action: assignment.action,
          subTaskId: assignment.subTaskId,
          subTaskTitle: subTask ? subTask.title : null,
          subTaskDomain: subTask ? subTask.domain : null,
          unitIds: involved,
          unitNames: involved.map((id) => unitName.get(id) || id),
          legs: (assignment.waypoints || []).length,
        };
      });
      return {
        phaseId: phase.id,
        tasks,
        summary: tasks.map((t) => t.action).join(", "),
      };
    });
    return { groupId: group.id, group: group.name, units: group.units, cells };
  });

  // The same join at unit granularity. A task force row answers "what is the
  // formation doing"; a unit row answers "what is this hull doing", which is the
  // question a watch officer actually has.
  const unitRows = (scenario.units || [])
    .filter((u) => u.side === "blue")
    .map((unit) => ({
      groupId: unit.id,
      group: unit.name,
      units: [{ id: unit.id, name: unit.name, classId: unit.classId, domain: unit.domain }],
      taskForce: unit.taskForce || null,
      cells: (coa.phases || []).map((phase) => {
        const assignments = (phase.assignments || []).filter((a) => (a.unitIds || []).includes(unit.id));
        const tasks = assignments.map((assignment) => {
          const subTask = subTasks.get(assignment.subTaskId) || null;
          return {
            action: assignment.action,
            subTaskId: assignment.subTaskId,
            subTaskTitle: subTask ? subTask.title : null,
            subTaskDomain: subTask ? subTask.domain : null,
            unitIds: [unit.id],
            unitNames: [unit.name],
            legs: (assignment.waypoints || []).length,
          };
        });
        return {
          phaseId: phase.id,
          tasks,
          summary: tasks.map((t) => t.action).join(", ") || "No tasking in this phase, holds its last order.",
        };
      }),
    }));

  // Rows nothing was tasked in are a planning gap worth naming rather than hiding.
  const idle = rows.filter((row) => row.cells.every((cell) => !cell.tasks.length)).map((row) => row.group);
  const idleUnits = unitRows.filter((row) => row.cells.every((cell) => !cell.tasks.length)).map((row) => row.group);
  return { phases, rows, unitRows, idle, idleUnits };
}

// ---------------------------------------------------------------------------
// Decision support matrix
// ---------------------------------------------------------------------------

/**
 * The decisions this plan will force, before it is run. These are the same four
 * families the engine raises at execution: a phase commitment, first contact, an
 * attrition threshold, and anything a rule asks the commander to rule on. Writing
 * them down in advance is the whole point of a decision support matrix: the
 * commander decides the criteria now, in the quiet, rather than at the moment.
 */
export function buildDecisionSupport(scenario, coa, ruleSet, mission) {
  const rows = [];
  const phases = coa.phases || [];
  const objectives = (scenario.objectives || []).filter((o) => o.side === "blue");

  phases.slice(1).forEach((phase, index) => {
    const previous = phases[index];
    rows.push({
      id: `dsm-phase-${phase.id}`,
      trigger: `Exercise clock reaches ${clock(phase.startH)}, the end of "${previous.name}".`,
      decision: `Commit the force to "${phase.name}" or hold in "${previous.name}".`,
      watch: `Progress of "${previous.name}": ${previous.intent}`,
      ltiov: clock(Math.max(previous.startH, phase.startH - 1)),
      criteria: [
        "The preceding phase has achieved its stated intent.",
        "Sustainment supports the next phase without an immediate rotation.",
        "The threat picture has not changed the assumptions the plan rests on.",
      ],
      options: ["Commit as planned", "Hold and consolidate", "Branch to the alternate axis"],
      decider: "Joint Force Commander",
      source: "phase boundary",
    });
  });

  rows.push({
    id: "dsm-first-contact",
    trigger: "First confirmed contact between BLUE and the opposing force.",
    decision: "Press the advance under contact, or develop the picture before committing.",
    watch: objectives.length ? `The objective picture, led by "${objectives[0].title}".` : "The objective picture.",
    ltiov: "On contact, no later than the next phase boundary.",
    criteria: [
      "The contact is identified well enough to be worth engaging.",
      "Committing does not expose the force before the supporting effort is in place.",
      "Breaking contact costs less than the tempo it buys.",
    ],
    options: ["Press the advance", "Develop the picture", "Break contact and reposition"],
    decider: "Joint Force Commander",
    source: "contact",
  });

  rows.push({
    id: "dsm-attrition",
    trigger: "Aggregate BLUE strength falls below 70 percent.",
    decision: "Continue the mission on the current attrition curve, or change the plan to preserve the force.",
    watch: "Aggregate strength and the loss exchange ratio against the objective picture.",
    ltiov: "Within one phase of the threshold being crossed.",
    criteria: [
      "The objective picture still justifies the losses being taken.",
      "The force can be reconstituted inside the exercise window.",
      "The end state is reachable with what remains.",
    ],
    options: ["Continue as planned", "Preserve the force", "Culminate and consolidate"],
    decider: "Joint Force Commander",
    source: "attrition",
  });

  for (const rule of (ruleSet && ruleSet.rules) || []) {
    if (!rule.enabled) continue;
    const asks = (rule.effects || []).some((e) => e.type === "request-decision");
    if (!asks) continue;
    rows.push({
      id: `dsm-rule-${rule.id}`,
      trigger: `Rule "${rule.name}" fires: ${rule.description}`,
      decision: (rule.effects.find((e) => e.type === "request-decision").params || {}).title || "Commander check directed by the rule set",
      watch: `The conditions the rule tests: ${(rule.conditions || []).map((c) => `${c.fact} ${c.op} ${c.value}`).join(", ") || "none recorded"}.`,
      ltiov: "Immediately, the branch pauses on this decision.",
      criteria: ["The rule fired on the situation it was written for.", "The recommended option still fits the commander's intent."],
      options: ["Accept the recommendation", "Override with a stated rationale"],
      decider: "Joint Force Commander",
      source: "rule set",
    });
  }

  const namedAreas = objectives
    .filter((o) => o.area)
    .map((o) => ({
      id: o.id,
      title: o.title,
      centre: o.area.center,
      radiusKm: o.area.radiusKm,
      why: o.description,
    }));

  return { rows, namedAreas, missionTitle: mission ? mission.title : null };
}

// ---------------------------------------------------------------------------
// Operation order
// ---------------------------------------------------------------------------

const ORDER_SEQ = { value: 0 };

/**
 * A five-paragraph operation order built from the scenario, the mission and the
 * selected COA, with the annexes a plan of this shape actually needs.
 */
export function buildOpord({ scenario, coa, mission, ruleSet, classification, issuedBy, orderNumber, nowIso }) {
  const marking = normalizeClassification(classification);
  const mark = portionMark(marking);
  const sync = buildSyncMatrix(scenario, coa, mission);
  const dsm = buildDecisionSupport(scenario, coa, ruleSet, mission);
  const blueOrg = taskOrganisation(scenario, "blue");
  const redUnits = (scenario.units || []).filter((u) => u.side === "red");
  const blueObjectives = (scenario.objectives || []).filter((o) => o.side === "blue");
  const env = scenario.environment || {};
  const issued = nowIso ? nowIso() : new Date().toISOString();
  const number = orderNumber || `${(ORDER_SEQ.value += 1) + 100}`;

  const enemyByDomain = redUnits.reduce((acc, u) => {
    acc[u.domain] = (acc[u.domain] || 0) + 1;
    return acc;
  }, {});
  const enemySummary = Object.entries(enemyByDomain)
    .map(([domain, count]) => `${count} ${domain}`)
    .join(", ");

  const paragraphs = [
    {
      id: "1",
      title: "Situation",
      mark,
      sub: [
        {
          id: "1.a",
          title: "Opposing forces",
          mark,
          text:
            `The opposing force in ${scenario.theater} is assessed at ${plural(redUnits.length, "element")} (${enemySummary || "composition not recorded"}). ` +
            `Its scheme of manoeuvre is held by exercise control and is not disclosed in this order. Assume it is playing a plan of its own and ` +
            `that its quiet is a decision rather than an absence.`,
        },
        {
          id: "1.b",
          title: "Friendly forces",
          mark,
          text:
            `${plural(blueOrg.length, "task element")} are organised for this operation: ${blueOrg.map((g) => g.name).join("; ")}. ` +
            `Full composition is at Annex A.`,
        },
        {
          id: "1.c",
          title: "Environment",
          mark,
          text:
            `Weather ${env.weather || "not recorded"}, sea state ${env.seaState ?? "not recorded"}, visibility ${env.visibilityKm ?? "not recorded"} km, ` +
            `emission control ${env.emcon || "not recorded"}, cyber threat ${env.cyberThreat || "not recorded"}. ` +
            `Adjudication is under rule set "${ruleSet ? ruleSet.name : "not recorded"}".`,
        },
      ],
    },
    {
      id: "2",
      title: "Mission",
      mark,
      text: mission
        ? `${mission.title}. ${mission.intent} End state: ${mission.endState}`
        : `${scenario.name}: ${scenario.description}`,
    },
    {
      id: "3",
      title: "Execution",
      mark,
      sub: [
        {
          id: "3.a",
          title: "Commander's intent",
          mark,
          text: `${coa.approach}. ${coa.summary}`,
        },
        {
          id: "3.b",
          title: "Concept of operations",
          mark,
          text:
            `The operation runs in ${plural((coa.phases || []).length, "phase")} across ${plural(scenario.durationHours, "hour")}. ` +
            (coa.phases || []).map((p) => `${p.name} (${clock(p.startH)} to ${clock(p.endH)}): ${p.intent}`).join(" "),
        },
        ...(coa.phases || []).map((phase, index) => ({
          id: `3.c.${index + 1}`,
          title: `Tasks to subordinate elements, ${phase.name}`,
          mark,
          text:
            sync.rows
              .map((row) => {
                const cell = row.cells.find((c) => c.phaseId === phase.id);
                if (!cell || !cell.tasks.length) return null;
                return `${row.group}: ${cell.tasks
                  .map((t) => `${t.action}${t.subTaskTitle ? ` in support of "${t.subTaskTitle}"` : ""}${t.legs ? ` over ${plural(t.legs, "leg")}` : ""}`)
                  .join("; ")}.`;
              })
              .filter(Boolean)
              .join(" ") || "No element is tasked in this phase.",
        })),
        {
          id: "3.d",
          title: "Coordinating instructions",
          mark,
          text:
            `Objectives, in weight order: ${blueObjectives
              .sort((a, b) => b.weight - a.weight)
              .map((o) => `${o.title} (${Math.round(o.weight * 100)} percent of the objective score)`)
              .join("; ")}. ` +
            `Decision points and their criteria are at Annex C. Every commander decision is recorded with its rationale, whether it follows the ` +
            `machine recommendation or overrides it.`,
        },
      ],
    },
    {
      id: "4",
      title: "Sustainment",
      mark,
      text:
        `Sustainment elements in the order of battle: ${
          (scenario.units || [])
            .filter((u) => u.side === "blue" && (u.classId.includes("auxiliary") || u.classId.includes("depot")))
            .map((u) => u.name)
            .join(", ") || "none organic to this force"
        }. Units below 20 percent supply move at half speed and below 5 percent cannot engage, so the rotation plan is a scheme of manoeuvre ` +
        `constraint and not an administrative matter.`,
    },
    {
      id: "5",
      title: "Command and signal",
      mark,
      text:
        `Command seats for this operation are crewed at launch, each either held by a person or locked to an agent from the tactical library, ` +
        `and the roster is recorded on the run. Emission control is ${env.emcon || "not recorded"}. ` +
        `Changes to this order are issued as numbered fragmentary orders and carry the name of the commander who directed them.`,
    },
  ];

  const annexes = [
    {
      id: "A",
      title: "Task organisation",
      mark,
      kind: "task-organisation",
      groups: blueOrg,
    },
    {
      id: "B",
      title: "Synchronisation matrix",
      mark,
      kind: "sync-matrix",
      sync,
    },
    {
      id: "C",
      title: "Decision support matrix",
      mark,
      kind: "decision-support",
      dsm,
    },
  ];

  return {
    kind: "opord",
    number,
    title: `OPERATION ORDER ${number}, ${scenario.codename}`,
    classification: marking,
    marking: markingLine(marking),
    portion: mark,
    issuedAt: issued,
    dtg: dtg(issued),
    issuedBy: issuedBy || "Joint Force Headquarters",
    references: [
      `Scenario ${scenario.codename}, ${scenario.name}`,
      coa ? `Course of action "${coa.name}", ${coa.approach}` : null,
      ruleSet ? `Rule set "${ruleSet.name}"` : null,
      mission ? `Mission "${mission.title}"` : null,
    ].filter(Boolean),
    scenarioId: scenario.id,
    coaId: coa.id,
    missionId: mission ? mission.id : null,
    paragraphs,
    annexes,
  };
}

// ---------------------------------------------------------------------------
// Fragmentary order
// ---------------------------------------------------------------------------

/**
 * The order that gets cut when a commander changes the plan mid-run. Written on
 * every decision, and marked as an override when the commander went against the
 * machine recommendation, because that is the one a staff has to read carefully.
 */
export function buildFrago({ run, branch, decision, option, decidedBy, rationale, sequence, classification, nowIso }) {
  const marking = normalizeClassification(classification);
  const mark = portionMark(marking);
  const issued = nowIso ? nowIso() : new Date().toISOString();
  const followedMachine = option.id === decision.aiRecommendationId;
  const recommended = decision.options.find((o) => o.id === decision.aiRecommendationId) || null;

  return {
    kind: "frago",
    id: `frago-${branch.id}-${sequence}`,
    number: String(sequence),
    title: `FRAGMENTARY ORDER ${sequence} TO ${run.scenarioName}`,
    classification: marking,
    marking: markingLine(marking),
    portion: mark,
    runId: run.id,
    runLabel: run.label,
    branchId: branch.id,
    branchName: branch.name,
    decisionId: decision.id,
    issuedAt: issued,
    dtg: dtg(issued),
    issuedBy: decidedBy,
    simTimeH: decision.simTimeH,
    followedMachine,
    // The three lines a fragmentary order actually carries: what changed, what
    // the force does now, and what has not changed.
    situation: `${mark} At ${clock(decision.simTimeH)} in "${branch.name}": ${decision.situation}`,
    change: `${mark} ${decidedBy} directs: ${option.label}. ${option.description || ""} Projected effect: ${option.projectedEffect || "not recorded"} Risk accepted: ${option.risk || "not recorded"}.`,
    unchanged: `${mark} All other tasks in the operation order stand. Phase "${branch.currentPhaseName || "free play"}" boundaries are unchanged.`,
    rationale: rationale && rationale.trim() ? `${mark} ${rationale.trim()}` : `${mark} No rationale was recorded with this decision.`,
    machineLine: recommended
      ? followedMachine
        ? `${mark} This follows the machine recommendation "${recommended.label}": ${decision.aiRationale}`
        : `${mark} This overrides the machine recommendation "${recommended.label}", which held that ${decision.aiRationale}`
      : `${mark} No machine recommendation was on file for this decision.`,
  };
}

// ---------------------------------------------------------------------------
// Plain text rendering
// ---------------------------------------------------------------------------

function wrapParagraph(paragraph, indent = "") {
  const lines = [];
  lines.push(`${indent}${paragraph.id}. ${paragraph.title.toUpperCase()}`);
  if (paragraph.text) lines.push(`${indent}   ${paragraph.mark} ${paragraph.text}`);
  for (const sub of paragraph.sub || []) {
    lines.push("");
    lines.push(`${indent}   ${sub.id}. ${sub.title}`);
    lines.push(`${indent}      ${sub.mark} ${sub.text}`);
  }
  return lines;
}

/** The order as a document a staff officer could read on paper. */
export function renderOpordText(doc) {
  const out = [doc.marking, "", doc.title, `${doc.issuedBy}`, `DTG ${doc.dtg}`, ""];
  if (doc.references.length) {
    out.push("REFERENCES");
    for (const ref of doc.references) out.push(`   ${ref}`);
    out.push("");
  }
  for (const paragraph of doc.paragraphs) {
    out.push(...wrapParagraph(paragraph));
    out.push("");
  }
  for (const annex of doc.annexes) {
    out.push(`ANNEX ${annex.id}, ${annex.title.toUpperCase()}`);
    if (annex.kind === "task-organisation") {
      for (const group of annex.groups) {
        out.push(`   ${annex.mark} ${group.name}`);
        for (const unit of group.units) out.push(`      ${unit.name} (${unit.classId})`);
      }
    }
    if (annex.kind === "sync-matrix") {
      for (const phase of annex.sync.phases) {
        out.push(`   ${annex.mark} ${phase.name}, ${phase.window}`);
        for (const row of annex.sync.rows) {
          const cell = row.cells.find((c) => c.phaseId === phase.id);
          if (!cell || !cell.tasks.length) continue;
          out.push(`      ${row.group}: ${cell.tasks.map((t) => t.action).join(", ")}`);
        }
      }
      if (annex.sync.idle.length) {
        out.push(`   ${annex.mark} Untasked across every phase: ${annex.sync.idle.join(", ")}`);
      }
    }
    if (annex.kind === "decision-support") {
      for (const row of annex.dsm.rows) {
        out.push(`   ${annex.mark} ${row.decision}`);
        out.push(`      Trigger: ${row.trigger}`);
        out.push(`      Latest time to decide: ${row.ltiov}`);
        out.push(`      Criteria: ${row.criteria.join(" ")}`);
        out.push(`      Options: ${row.options.join(" | ")}`);
      }
      for (const area of annex.dsm.namedAreas) {
        out.push(`      Named area "${area.title}": ${area.radiusKm} km around ${area.centre.lat.toFixed(2)}N ${area.centre.lng.toFixed(2)}E`);
      }
    }
    out.push("");
  }
  out.push(doc.marking);
  return out.join(nl);
}

export function renderFragoText(doc) {
  return [
    doc.marking,
    "",
    doc.title,
    `${doc.issuedBy}`,
    `DTG ${doc.dtg}`,
    "",
    "1. SITUATION",
    `   ${doc.situation}`,
    "",
    "2. CHANGE TO THE ORDER",
    `   ${doc.change}`,
    "",
    "3. WHAT IS UNCHANGED",
    `   ${doc.unchanged}`,
    "",
    "4. COMMANDER'S RATIONALE",
    `   ${doc.rationale}`,
    `   ${doc.machineLine}`,
    "",
    doc.marking,
  ].join(nl);
}

export { highWater };

// Headless engine check. Runs the deduction engine directly, with no server and
// no state.json, and asserts the things a demo would be embarrassed to get wrong:
// branches are seed-fair, RED executes an authored plan, the hold-fire gate
// actually holds, and the plan is masked from the players until it is revealed.
//
//   node scripts/engine-check.mjs

import { buildScenarios, buildRuleSets, buildCoas, buildMissions } from "../server/data.mjs";
import { createRun, tickRun, applyDecision, revealAdversary, adversaryTruth } from "../server/engine.mjs";
import { ADVERSARY_PLANS, DEFAULT_ADVERSARY_PLAN_ID } from "../server/adversary.mjs";

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const scenarios = buildScenarios();
const ruleSets = buildRuleSets();
const missions = buildMissions(scenarios);
const coas = buildCoas(scenarios, missions);
const scenario = scenarios.find((s) => s.id === "scn-azure-horizon") || scenarios[0];
const ruleSet = ruleSets.find((r) => r.status === "active") || ruleSets[0];
const scenarioCoas = coas.filter((c) => c.scenarioId === scenario.id).slice(0, 2);

/** Run a whole exercise to completion, auto-resolving every decision point. */
function runToCompletion(redPlanId, label) {
  const run = createRun({
    scenario,
    coas: scenarioCoas,
    ruleSet,
    engine: "realtime",
    speed: 8,
    label,
    id: `check-${redPlanId}`,
    redPlanId,
  });
  run.seats = [{ id: "seat-red-1", side: "red", name: "OPFOR Commander", rank: "Component", mode: "ai", participant: null, agentId: "ag-1", agentName: "WARGAMER" }];
  const ctx = { scenario, ruleSet };
  let ticks = 0;
  while (ticks < 4000 && run.status !== "completed" && run.status !== "aborted") {
    ticks += 1;
    for (const branch of run.branches) {
      for (const decision of branch.decisions) {
        if (decision.status !== "open") continue;
        applyDecision(run, branch.id, decision.id, decision.aiRecommendationId, "check umpire", "Auto-resolved.", ctx);
      }
    }
    tickRun(run, ctx);
  }
  return { run, ticks };
}

section("1. Scenario and plan fixtures");
check("scenario has RED units", scenario.units.some((u) => u.side === "red"));
check("two COAs available for the comparison", scenarioCoas.length === 2, `got ${scenarioCoas.length}`);
check("two authored adversary plans", ADVERSARY_PLANS.length === 2, `got ${ADVERSARY_PLANS.length}`);

section("2. Seed fairness and common random numbers");
const fair = createRun({ scenario, coas: scenarioCoas, ruleSet, engine: "realtime", speed: 1, label: "seed", id: "check-seed" });
const seeds = fair.branches.map((b) => b.seed);
check("every branch carries the same seed", new Set(seeds).size === 1, `seeds ${seeds.join(", ")}`);
check("the seed is published on the branch", fair.branches.every((b) => b.seed === ruleSet.adjudication.seed));
check("no sequential RNG state survives on a branch", fair.branches.every((b) => b._rngState === undefined));

// The claim on screen is that the difference between two branches is the plan and
// not the dice. That is only true if the same decision meets the same die in both,
// which a sequential stream cannot do: a different plan makes a different NUMBER of
// draws and the streams desynchronise on the first tick. So assert the property
// itself, on real adjudications that happened in both branches.
const crn = runToCompletion(DEFAULT_ADVERSARY_PLAN_ID, "check CRN");
const rollsByKey = crn.run.branches.map((branch) => {
  const map = new Map();
  for (const event of branch._full.events) {
    if (!event.adjudication) continue;
    map.set(`${event.tick}|${event.actorId}|${event.targetId}|${event.adjudication.weaponType}`, event.adjudication.roll);
  }
  return map;
});
const shared = [...rollsByKey[0].keys()].filter((k) => rollsByKey[1].has(k));
const disagreed = shared.filter((k) => rollsByKey[0].get(k) !== rollsByKey[1].get(k));
check(
  "the two branches share adjudications to compare",
  shared.length > 0,
  "no engagement occurred at the same tick between the same pair in both branches"
);
check(
  "a shared adjudication draws the same die in both branches",
  shared.length > 0 && disagreed.length === 0,
  `${disagreed.length} of ${shared.length} shared adjudications drew different dice`
);
console.log(`  (${shared.length} adjudications occurred identically in both branches)`);

section("3. Adversary plan is resolved and masked");
const plan = fair.branches[0]._red;
check("a plan was resolved onto the branch", Boolean(plan));
check("the default plan is TIDEWALL", plan && plan.planId === DEFAULT_ADVERSARY_PLAN_ID, plan && plan.planId);
check("every RED unit carries a role", plan && scenario.units.filter((u) => u.side === "red").every((u) => plan.roles[u.id]));
check("phases span the scenario duration", plan && plan.phases[plan.phases.length - 1].endH === scenario.durationHours, plan && String(plan.phases[plan.phases.length - 1].endH));
check("the public projection is masked at start", fair.branches[0].adversary && fair.branches[0].adversary.revealed === false);
check("the masked projection leaks no intent", fair.branches[0].adversary && fair.branches[0].adversary.intent === null);
check("the masked projection leaks no phases", fair.branches[0].adversary && fair.branches[0].adversary.phases.length === 0);
check("fires start held under TIDEWALL", plan && plan.fires.released === false);

section("4. Umpire reveal");
const revealed = revealAdversary(fair.branches[0]);
check("reveal exposes the codename", revealed && revealed.codename === "TIDEWALL", revealed && revealed.codename);
check("reveal exposes the phase tasking", revealed && revealed.phases.length === 3, revealed && String(revealed.phases.length));
check("reveal exposes the counter", Boolean(revealed && revealed.counter));
check("the white-cell truth is available regardless", Boolean(adversaryTruth(fair.branches[1])));
check("the other branch stays masked", fair.branches[1].adversary.revealed === false);

section("5. TIDEWALL: the hold-fire gate holds, then breaks");
const tidewall = runToCompletion("adv-tidewall", "check TIDEWALL");
for (const branch of tidewall.run.branches) {
  const events = branch._full.events;
  const redPlan = branch._red;
  const release = events.find((e) => e.title === "OPFOR released fires");
  const firstRedShot = events.find((e) => e.type === "engagement" && branch.units.some((u) => u.id === e.actorId && u.side === "red"));
  check(`[${branch.name}] fires were eventually released`, Boolean(release));
  check(`[${branch.name}] the release carries a stated reason`, Boolean(redPlan.fires.releaseReason));
  if (release && firstRedShot) {
    check(
      `[${branch.name}] no RED shot before the release`,
      firstRedShot.simTimeH >= release.simTimeH,
      `first shot T+${firstRedShot.simTimeH}h, release T+${release.simTimeH}h`
    );
  } else {
    check(`[${branch.name}] RED fired after the release`, Boolean(firstRedShot), "RED never fired");
  }
  check(`[${branch.name}] posture shifts were logged`, events.some((e) => e.type === "adversary" && e.title === "OPFOR shifted posture"));
  check(`[${branch.name}] the OPFOR seat is credited`, events.some((e) => e.type === "adversary" && String(e.detail).includes("OPFOR Commander")));
  check(`[${branch.name}] the plan is revealed once the branch completes`, branch.adversary.revealed === true);
  check(`[${branch.name}] indicators were recorded for the masked view`, redPlan.indicators.length > 0);
}

section("6. SEA LANCE: weapons free from the opening tick");
const sealance = runToCompletion("adv-sealance", "check SEA LANCE");
const firstRedShotAt = (run) => {
  let earliest = Infinity;
  for (const branch of run.branches) {
    const redIds = new Set(branch.units.filter((u) => u.side === "red").map((u) => u.id));
    for (const event of branch._full.events) {
      if (event.type === "engagement" && redIds.has(event.actorId)) earliest = Math.min(earliest, event.simTimeH);
    }
  }
  return earliest;
};
for (const branch of sealance.run.branches) {
  check(`[${branch.name}] plan is SEA LANCE`, branch._red.planId === "adv-sealance");
}
// Reading the flag back would only prove the template was copied. The claim worth
// asserting is that the fires policy has a consequence: a weapons-free RED shoots
// sooner than one holding an ambush.
const sealanceShot = firstRedShotAt(sealance.run);
const tidewallShot = firstRedShotAt(tidewall.run);
console.log(`  (first RED shot: SEA LANCE T+${sealanceShot}h, TIDEWALL T+${tidewallShot}h)`);
check(
  "a weapons-free RED opens fire no later than one holding an ambush",
  sealanceShot <= tidewallShot,
  `SEA LANCE fired at T+${sealanceShot}h, TIDEWALL at T+${tidewallShot}h`
);
check("RED fired at all under SEA LANCE", Number.isFinite(sealanceShot));

section("7. The two plans produce different exercises");
const tw = tidewall.run.branches[0].metrics;
const sl = sealance.run.branches[0].metrics;
console.log(`  TIDEWALL  branch 1: objectives ${tw.objectiveScore}%, BLUE ${tw.blueStrength}%, RED ${tw.redStrength}%, losses B${tw.blueLosses}/R${tw.redLosses}`);
console.log(`  SEA LANCE branch 1: objectives ${sl.objectiveScore}%, BLUE ${sl.blueStrength}%, RED ${sl.redStrength}%, losses B${sl.blueLosses}/R${sl.redLosses}`);
check(
  "the adversary plan changes the outcome",
  tw.objectiveScore !== sl.objectiveScore || tw.blueStrength !== sl.blueStrength || tw.redStrength !== sl.redStrength,
  "both plans produced identical metrics, so RED's plan is not being executed"
);

section("8. Determinism");
const repeat = runToCompletion("adv-tidewall", "check TIDEWALL repeat");
check(
  "the same plan and seed reproduce the same result",
  repeat.run.branches[0].metrics.objectiveScore === tw.objectiveScore && repeat.run.branches[0].metrics.blueStrength === tw.blueStrength,
  `${repeat.run.branches[0].metrics.objectiveScore}/${repeat.run.branches[0].metrics.blueStrength} vs ${tw.objectiveScore}/${tw.blueStrength}`
);

console.log(`\n${failures ? "FAILED" : "PASSED"}: ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);

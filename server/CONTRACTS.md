# SANDTABLE backend contracts

Plain Node ESM, **zero npm dependencies** (`node:http`, `node:fs`, `node:path`,
`node:url`, `node:crypto` only). Port 5189 (`WAR_API_PORT` override). All JSON responses
must match the TypeScript shapes in `../src/types.ts` exactly (server is plain JS —
mirror the shapes by hand). CORS not needed (Vite proxy). Persist mutable state to
`server/state.json` (throttled, ~2s debounce); on boot load it if present, else build
seeds and **synchronously pre-run one full historical deduction run to completion**
(so Assessment & Replay has real computed data on first launch).

Files and ownership:

- `server/ontology.mjs` — exports `buildOntology()` → `Ontology` (≥28 classes with a
  sensible hierarchy across force/facility/system/event/concept categories and
  land/sea/air/cyber/space domains, each with 3–6 typed attributes; ≥12 relations such
  as subordinateTo/hasSensor/hasWeapon/defends/threatens/suppliedBy/detects/engages/
  basedAt/assignedTo/reportsVia/targets).
- `server/data.mjs` — exports:
  - `buildTheater()` → `TheaterFeature[]` — fictional Meridian Archipelago: 4–6 island
    polygons (8–14 vertices each, lat 32.5–35.5, lng -42.5..-37.5), 1–2 shoals, 1–2 zones
    (e.g. exclusion zone). Center ~ {lat 34.0, lng -40.0}.
  - `buildScenarios()` → `Scenario[]` — three scenarios:
    1. `scn-azure-horizon` "AZURE HORIZON" status `ready`: full ORBAT, ~26–32 units
       total. BLUE (~16): carrier, 2 destroyers, 2 frigates, submarine, amphibious ship,
       supply ship, 2 fighter squadrons, strike squadron, AEW&C, maritime patrol, UAV
       recon, marine battalion (embarked), cyber ops cell. Positioned west of the
       archipelago. RED (~14): coastal defense batteries, SAM battalions, radar sites,
       missile boats, corvettes, submarine, fighter squadron, artillery, logistics
       depot, command post on the islands / east. Realistic-ish sensors/weapons per
       class (ranges 15–400 km, pk 0.1–0.75, ammo 2–40). 4 BLUE objectives
       (control-area strait, destroy IADS, protect carrier, deliver marines) +
       2–3 RED objectives. durationHours 72.
    2. `scn-strait-guardian` "STRAIT GUARDIAN" status `draft`: smaller convoy-escort
       scenario, ~12 units.
    3. `scn-blank-template` "Blank planning template" status `draft`, 0 units, used as
       creation template.
  - `buildRuleSets()` → `RuleSet[]` — `rs-standard` "Standard Engagement Rules v2.1"
    (active, joint, 10–14 enabled rules across all six categories, stochastic, seeded)
    and `rs-high-intensity` "High-Intensity Attrition Study" (draft, 6–8 rules,
    deterministic). Rules must use the documented fact vocabulary (below) so the engine
    can evaluate them.
  - `buildAgents()` → `AgentDef[]` — 12 agents covering all five drive modes
    (fire-strike, route-planning, logistics, situation-understanding, air-tasking,
    asw-screen, ew-planning, strike-package, sead, amphib-timing, cyber-effects,
    coa-synthesis), plausible metrics.
  - `buildMissions()` → `Mission[]` — one decomposed BLUE mission for AZURE HORIZON
    (8–10 sub-tasks with dependencies + agent assignments) and one draft mission for
    STRAIT GUARDIAN.
  - `buildCoas()` → `Coa[]` — three pre-generated COAs for the AZURE HORIZON mission
    ("Direct Thrust" selected, "Air-First Suppression" candidate, "Envelop & Blockade"
    candidate), phases spanning the 72h with waypoints through the theater, distinct
    score profiles, colors #1f5f99 / #7c3aed / #0d8a8a.
  - `buildPlatform()` → `PlatformInfo`; `buildUsers()` → `User[]` (5, matching the app
    profiles); `buildAuditSeed()` → `AuditLogEntry[]` (~12 entries).
- `server/agents.mjs` — AI-layer logic (deterministic, seeded randomness allowed):
  - `decomposeMission(mission, scenario)` → Mission with generated subTasks (domain mix,
    dependencies, agent assignment by specialty/drive mode).
  - `generateCoas(scenario, mission, count, existingCount)` → Coa[] with distinct
    doctrine approaches, phases + per-subtask assignments (unit ids from the scenario,
    waypoints moving BLUE eastward through the theater), scores derived from a simple
    utility model (document it in comments).
  - `recommendDecision(branch, decisionPoint, scenario)` → { optionId, rationale }.
  - `agentActivityFor(run)` → AgentActivity[] describing observation/piece-drive calls.
  - `commentaryFor(assessment, branch)` → string + `recommendationsFor(...)` → string[].
- `server/engine.mjs` — the deduction engine:
  - `createRun({ scenario, coas, ruleSet, engine, speed, label, id })` → SimRun with one
    Branch per COA (deep-cloned units).
  - `tickBranch(run, branch, scenario, ruleSet, rng)` — advance one tick
    (`hoursPerTick` 0.25): movement along active COA phase waypoints (speedKts →
    degrees), detection (sensor range + probability, EMCON modifier), engagement
    (in-range + detected + weapon pk + ammo, damage → strength, destroyed), logistics
    (supply drain, resupply near supply ship / depot; low supply halves speed), custom
    rule effects from the rule set (evaluate conditions on the documented facts),
    metrics + metricsHistory (every 4 ticks), snapshots (every 4 ticks, stored
    separately for replay), events (capped: keep full log per branch internally,
    `recentEvents` = last 30 newest-first, `eventCount` total).
  - Decision points: at each COA phase boundary AND on emergent triggers (first contact;
    blue strength < 70%; objective at risk) — max ~4 per branch per run. Create 3
    options via agents.mjs, set branch `awaiting-decision`, pause that branch.
    `applyDecision(run, branch, decisionId, optionId, ...)` applies option effects
    (posture/speed/pk modifiers or reroute) and resumes.
  - `applyIntervention(run, branch, request)` — inject-event / move-unit / set-weather /
    resupply / withdraw-unit.
  - Completion: sim time >= scenario.durationHours OR victory rule fires OR one side's
    aggregate strength < 25%. On completion compute `Assessment` per branch
    (dimensions: mission accomplishment 35%, force preservation 25%, tempo 15%,
    resource efficiency 15%, decision quality 10%).
  - Realtime engine: the HTTP layer owns a `setInterval` per running run
    (`1000 / speed` ms per tick); turn-based advances only via control action `step`.
  - Rule fact vocabulary (conditions): `range` (km between actor/target),
    `actor.domain|side|strength|supply|status`, `target.domain|side|strength|status`,
    `weather`, `seaState`, `emcon`, `simTimeH`, `phase.name`. Effect params:
    `modify-pk {factor}`, `modify-detection {factor}`, `modify-speed {factor}`,
    `apply-damage {amount}`, `consume-supply {amount}`, `reveal-unit {}`,
    `score-points {points}`, `spawn-event {title, severity}`, `request-decision {title}`.
- `server/index.mjs` — HTTP router + state + persistence + copilot:
  - Endpoints (all under `/api`, JSON; 404 `{error}` unknown, 400 `{error}` invalid):
    `GET /api/bootstrap` → Bootstrap; `GET/POST /api/scenarios`; `GET/PUT
    /api/scenarios/:id`; `POST /api/scenarios/:id/validate`; `GET/POST /api/missions`
    (`?scenarioId=`); `POST /api/missions/:id/decompose`; `PUT /api/missions/:id`;
    `GET /api/coas` (`?scenarioId=`); `POST /api/coas/generate`; `PUT /api/coas/:id`;
    `GET/POST /api/rulesets`; `PUT /api/rulesets/:id`; `POST /api/rulesets/:id/test`;
    `GET /api/runs` (summaries); `POST /api/runs` (start; body per api.ts);
    `GET /api/runs/:id`; `POST /api/runs/:id/control` `{action, value?}`;
    `POST /api/runs/:id/branches/:bid/decide`; `POST /api/runs/:id/branches/:bid/intervene`;
    `GET /api/assessments` (`?runId=`); `POST /api/runs/:id/assess`;
    `GET /api/runs/:id/replay/:branchId` → ReplayData;
    `GET /api/ontology`; `GET /api/agents`; `GET /api/agent-activity` (`?runId=`);
    `GET /api/platform` (live numbers: engine load reflects active runs; apiStats grow
    with ticks); `GET /api/users`; `PUT /api/users/:id`; `GET/POST /api/audit`;
    `POST /api/ask`; `GET /health` → `{ok:true}`.
  - Body size cap 1 MB. Every mutating endpoint appends an AuditLogEntry.
  - GET /api/runs/:id must strip internal full event logs / snapshots (serve the SimRun
    shape only: recentEvents tail + eventCount).
  - Copilot `/api/ask`: mirrors DOOH — if `OPENAI_API_KEY` present call OpenAI chat
    completions with a situation summary as system context; otherwise answer from an
    offline knowledge base (platform concepts, current run status, COA comparison,
    rule explanations — compose from live state so answers feel real). Response shape
    `AskResult`. Load `.env` from project root like DOOH does.
  - Boot: if no state.json → seeds + synchronously run one historical run
    (label "Historical: AZURE HORIZON rehearsal", 2 branches: Direct Thrust +
    Air-First Suppression, auto-deciding every decision point with the AI
    recommendation, marking `followedAi`) to completion including assessments; persist.

Determinism: use a small seeded PRNG (mulberry32) everywhere randomness is needed;
never `Math.random()` for engine outcomes.

## Addendum — war-room console fields (2026-08-19)

- `Branch.currentPhaseName: string | null` — set at branch creation and on every phase
  transition; drives the console's "R{n} - {phase}" banner. Optional in old state files.
- `Branch.score: { blue, red: {objective, force, combat, total}, net }` — recomputed by
  `computeScore(branch, scenario)` every tick and after interventions. Objective points
  = weighted objective completion ×2 (+ victory-rule points for BLUE); force = remaining
  strength sum; combat = enemy kills ×150; net = BLUE total − RED total.
- Engagement events carry `adjudication`: `{attacker, target, weapon, weaponType,
  rangeKm, basePk, modifiers[{rule, factor}], finalPk, roll, result: hit|miss, damage}`.
  The random roll is drawn once (`roll < finalPk` = hit); damage rolls only on hits so
  the RNG sequence stays deterministic.
- Run payloads (GET /api/runs/:id and control/decide/intervene responses) are built by
  `serializeRun(run)` = `stripInternal(run)` + `environment` (the scenario's live
  environment, so umpire weather changes reach the console without a bootstrap refetch).

## Addendum — Phase 3 AI endpoints (2026-08-19)

- `POST /api/opord/parse` {text} → OpordParse (source anthropic|offline; offline
  parser covers the bullet + "at lat, lng" convention; Claude output validated and
  class-ids salvaged via the alias matcher). `POST /api/scenarios/from-opord`
  {parse, name?, codename?} → Scenario (unit stats cloned from seed units of the same
  classId, else class defaults, else domain baselines; objectives weighted per side).
- `POST /api/coas/generate` now takes {strategy: results-first|loss-control|
  speed-first|balanced} and returns {coas, analysis, strategy}; COAs carry strategy +
  grade (recommended = top composite, steady = lowest-risk of the rest). Weights in
  agents.mjs COA_STRATEGIES.
- `POST /api/coas/:id/silent-eval` → runs a throwaway headless deduction (active rule
  set, AI recommendations auto-accepted), stamps coa.silentEval.projected and flips
  candidate → simulated. Nothing else is persisted.
- `POST /api/runs/:id/branches/:bid/explain` {topic: adjudication|risk|next-step|
  enemy} → {answer, source, latencyMs}; grounded context built by
  branchExplainContext(); deterministic offlineExplain() fallback.

## Addendum, Phase 4 and seats (2026-08-19)

- `POST /api/runs/:id/branches/:bid/resume` {tick, speed?} -> SimRun. Picks the
  nearest recorded snapshot at or before `tick`, creates a new single-branch run on
  the same scenario/COA/rule set, and calls `rewindBranchToSnapshot()` to restore
  unit positions, strengths, statuses, detection flags and the clock. The fork keeps
  the parent's seed on purpose: draws are keyed by tick and by the identity of the
  decision, so a fork that repeats the parent's choices meets the parent's dice, and
  one that decides differently diverges only where the decision changed the world.
  That is what isolates the decision, which is the reason to fork at all.
  The new run carries `resumedFrom {runId, runLabel, branchId, branchName, tick,
  simTimeH}` and inherits the parent's seat roster.
- `POST /api/runs/:id/report` -> RunReport. Requires the run to be assessed. Builds
  per-branch figures from assessments plus the decision record, then four narrative
  sections (Summary, Branch comparison, Command decisions, Observations and
  optimisation) written by Claude when a key is present, deterministically otherwise.
  Stored on `run.report`.
- `PUT /api/runs/:id/seats/:seatId` {mode?, agentId?, participant?} -> SimRun.
  `run.seats` is built at launch by `buildSeats()`: four BLUE and three RED command
  seats, each `mode: "human" | "ai"`. AI seats resolve an agent by specialty from the
  ready pool. BLUE's Joint Force Commander is human by default; everything else is
  machine-crewed.

## Addendum, the adversary plays a plan (2026-08-26)

- `server/adversary.mjs` authors the RED scheme of manoeuvre and resolves it against
  any scenario. `ADVERSARY_PLANS` holds two templates: `adv-tidewall` TIDEWALL
  (coastal denial, fires held until a BLUE capital ship crosses inside the battery
  envelope) and `adv-sealance` SEA LANCE (forward contest, weapons free from the
  opening tick). `resolveAdversaryPlan({scenario, planId, durationHours})` classifies
  every RED unit into a role, derives station geometry from the scenario's own
  objectives and laydown, and returns phases in sim hours plus a fires gate.
- The engine reads it. `branch._red` holds the resolved plan; RED movement comes from
  `taskForUnit()` and `stationFor()` rather than from a chase leash, the old reactive
  behaviour survives as the `sortie-intercept` task. While the gate holds, RED units
  cannot fire at all and are 55 percent harder to detect, so the ambush costs BLUE
  time as well as position. `firesReleaseCheck()` opens the gate on a capital ship
  inside the trigger range, on the loss of any RED unit, on damage to a unit in a
  firing role, or on the plan's own patience running out.
- The plan is white-cell property. `branch.adversary` is a masked projection: no
  codename, no intent, no phases, only the indicators RED's own behaviour gave away.
  `POST /api/runs/:id/adversary/reveal` {revealedBy} -> SimRun reveals it mid-run and
  refuses an unnamed caller; completion reveals it automatically with the counter that
  would have broken it. `GET /api/runs/:id/adversary/truth` is the white-cell view.
  `GET /api/adversary/plans` is the launch catalogue; `POST /api/runs` accepts
  `redPlanId` and stores it as `run._redPlanId`, which `stripInternal` drops from
  every player-facing payload. Serialized next to a branch reporting "Withheld",
  the plan id would be the mask's own answer key, since the catalogue turns an id
  into the full intent, risk and phases. For the same reason the run-started audit
  entry does not name it, and `GET /api/runs/:id/adversary/truth` is gated on
  `run.adversary.truth` (`?viewedBy=`), audited on every read: handing over the
  whole plan mid-run is the same act as revealing it.
- SAGE answers the "enemy" topic from the BLUE picture only. Before the reveal the
  grounded context tells the model the plan is withheld and must not be invented.
- Common random numbers, not just a common seed. A shared starting seed is not
  enough: drawing from a sequential stream desynchronises two branches on the first
  tick, because a different plan makes a different NUMBER of draws (measured: two
  branches seeded identically at 20260810 sat at -611574860 and 1851826623 after one
  tick). `die(branch, ruleSet, key)` therefore hashes `branch.seed`, `branch._tick`
  and a key naming the decision (`det|observer|target`, `eng|actor|target|weapon`,
  `dmg|...`). The same shot at the same moment meets the same die in every branch,
  so where the plans agree the dice are identical and the difference is the plan.
  `branch._rngState` no longer exists. `npm run check:engine` asserts the property
  on real adjudications that occurred in both branches, not just on the seed value.
- `node scripts/engine-check.mjs` (`npm run check:engine`) runs the engine headlessly
  with no server and no state.json and asserts all of the above in 38 checks.

## Addendum, autonomy is enforced (2026-08-26)

- `GOVERNED_ACTIONS` in `index.mjs` is the single catalogue of actions the platform
  gates: the eight intel-bridge steps, the adversary reveal, the white-cell plan
  read, umpire injects, and `run.decide`. A commander decision cuts a numbered order
  under a name, so it passes the gate like everything else rather than falling back
  to a literal "commander".
  `state.governance.policy` maps each action id to `auto` or `human-required`.
- `gateAction(actionId, rawActor)` is the gate. Under `human-required` it refuses an
  unnamed actor with 403 and a machine-readable body (`code`, `actionId`,
  `actorField`), counts the refusal in `state.governance.refusals` and audits it.
  Under `auto` the machine acts and the record says so. There are no invented
  fallback names anywhere in the bridge.
- `recordHandoff()` reads `autonomy` from the policy for `fields.actionId` instead of
  taking a literal, and `kind` comes from `gate.kind` rather than being hardcoded:
  under an auto policy nobody named the step, and a record claiming a human did it
  would be a lie in the one place that must not lie. Work the machine
  performs under a human-required policy keeps the machine as `actor` and records the
  person in `signedBy`.
- `GET /api/governance/policy` -> `{updatedAt, updatedBy, actions[]}` with the
  autonomy in force and the refusal count per action. `PUT /api/governance/policy`
  {actionId, autonomy, changedBy} -> the same shape; the change itself is signed and
  audited. Flipping an entry changes what the API executes.

## Addendum, classification and staff products (2026-08-26)

- `server/classification.mjs` owns the marking. `state.classification` is one level
  (`unclassified | restricted | confidential | secret`) plus caveats, with EXERCISE
  and FICTIONAL DATA locked on. `markingLine()` builds the banner, `portionMark()` the
  paragraph mark, `highWater()` the rule that a document assembled from several
  sources takes the highest of them. `GET/PUT /api/classification` (the PUT is signed).
- `server/orders.mjs` writes the documents. `buildSyncMatrix(scenario, coa, mission)`
  renders the phase to assignment to sub-task join at both task-organisation and unit
  granularity and names any element tasked in no phase at all.
  `buildDecisionSupport(scenario, coa, ruleSet, mission)` derives the decisions the
  plan will force from the same four families the engine raises at execution.
  `buildOpord(...)` is the five-paragraph order with Annexes A, B and C, every
  paragraph portion-marked; `renderOpordText()` renders it as paper.
- `GET /api/coas/:id/orders` -> `{opord, text, sync, dsm}`.
- `buildFrago(...)` cuts a fragmentary order on every commander decision, marked as an
  override when the commander went against the machine, carrying the rationale and
  what the machine had recommended. Stored in `state.fragos`, read by
  `GET /api/runs/:id/fragos` -> `{runId, runLabel, fragos, marking, text}`. Orders
  cut either side of a marking change carry different markings, so the compilation
  banner is `highWater()` across all of them.

## Addendum, commander's requirements (2026-08-26)

- `server/requirements.mjs` authors three priority intelligence requirements, each
  broken into indicators tied to one of five named areas of interest.
- `matchCue(cue, requirements, namedAreas)` anchors a cue to an indicator only when
  its centre falls inside the named area AND it carries an entity of the right kind
  AND its reporting mentions one of the indicator's terms. Geography alone is a
  coincidence. Every match returns its own reasoning so a J2 can disagree with it.
- `GET /api/intel/requirements` -> `{pirs, namedAreas, outstanding}`. An indicator is
  `answered` only by a confirmed or spawned cue; an unconfirmed one leaves it
  `indicated`. `outstanding` is the collection task list.
  `GET /api/intel/cues/:id/requirements` -> what one cue answers, with the evidence.
- Matching is derived on read, so every cue that has ever landed is anchored without
  a state migration.

## Addendum, corrections from adversarial review (2026-08-26)

A six-dimension review of the work above, with every finding handed to a skeptic
told to refute it, confirmed twelve defects. What changed:

- **The mask leaked.** `run.redPlanId` was a public key on every run payload, and
  the open plan catalogue turns an id into the full intent, risk and phases: the
  mask carried its own answer key. It is `run._redPlanId` now, dropped by
  `stripInternal`, absent from the run-started audit line, and absent from the
  `SimRun` contract. `GET /api/runs/:id/adversary/truth` was ungated, which made
  the human-required reveal it protects meaningless; it is gated on
  `run.adversary.truth` (`?viewedBy=`) and audited. The masked projection reports
  `firesReleased` from what BLUE OBSERVED (`redPlan.firesObserved`, set on the
  first RED shot) rather than from the gate, which was open at tick zero under a
  weapons-free plan and named the plan. The branch-init event no longer announces
  the opening fires posture, and the launcher shows the plan picker and its brief
  only to exercise control.
- **Common random numbers, not a common seed.** See the addendum above; the
  original claim was false and is now asserted on real adjudications.
- **Geometry.** `towards()` extrapolated past its target, so any scenario whose
  RED deny objective sat on top of BLUE (every intel-generated one) sent RED's
  forward stations through the BLUE formation and out the far side on a
  rounding-noise bearing. The fraction is capped and an objective centre within
  25 km of BLUE falls back to the battery centre.
- **Plan coherence.** A TIDEWALL phase marked `startsOnRelease` begins when fires
  are released rather than on the clock, so a sprung ambush is not still logged as
  silent watch.
- **Hand-off honesty.** `kind` comes from `gate.kind`; five call sites hardcoded
  `"human"` and signed machine acts as human ones under an auto policy.
- **Two ungated actions.** `run.decide` (a decision cuts an order under a name,
  and defaulted to the literal "commander") and `run.control` (aborting freezes
  every branch; ships on `auto`).
- **Classification.** `highWater()` was never called; the FRAGO compilation now
  banners at the high water mark and `GET /api/runs/:id/fragos` returns `marking`.
  A release statement survives a merge only when every source agrees on it, since
  sorting by string length picked the shorter phrase rather than the narrower
  audience. `releasableTo` is stripped of the separators that structure a marking,
  which could otherwise forge a caveat. `RunReport` carries `classification` and
  `marking`, which the Admin console already claimed it did.
- **The 403 body** documented above now actually reaches the client (`code`,
  `actionId`, `actorField`).
- **A fork inherits the adversary state that was true AT the snapshot** and
  nothing that happened after it.
- **`buildDecisionSupport` returns `objectiveAreas`**, not `namedAreas`: those are
  the friendly areas the plan is scored on, and named areas of interest belong to
  the intel bridge. PIR 2 indicator B moved to its own `nai-monte-airfield`, since
  anchored on the channel it missed the only air-surge cue in the corpus by 1.6 km
  and was unanswerable by construction.

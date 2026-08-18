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

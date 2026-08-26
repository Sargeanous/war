# SANDTABLE — Scenario Simulation & Strategic Planning Platform

Localhost demo platform mirroring the DOOH platform layout. Frontend Vite + React 18 + TS
on :5188, backend plain Node (`node:http`) on :5189 (Vite proxies `/api` and `/health`).
Run with `pnpm dev`. **All content is fictional**: the theater is the invented
"Meridian Archipelago" (island polygons drawn over the Gulf of Oman / NW Arabian Sea near the UAE, in verified open water)
lat 34.0, lng -40.0), sides are BLUE "Coalition Task Force" and RED "Opposing Force
(OPFOR)", exercise codename AZURE HORIZON. No real countries, forces or persons.

## Three-layer architecture (from the product slide)

- **L3 Applications** (from scenario to assessment): Scenario Design → Data & COA
  Generation → Simulation Rule Configuration → Full-Process Deduction → Assessment & Replay.
- **L2 AI Layer**: strategic task decomposition (operational mission → sub-tasks →
  assign to mission agents), tactical agent library by drive mode (knowledge reasoning,
  data learning, operations research, large model → hybrid-driven mission agents),
  human+AI collaborative decision (OODA: situation analysis → mission planning →
  human-AI decision → action; effectiveness feeds back; intent & decision retained by
  the commander). Wargame system APIs: Observation API (sense) / Piece-drive API (execute).
- **L1 Platform Foundation**: one platform (low-code design of maps, pieces, rules,
  scenarios; unified user/permission/log management), multiple simulation engines
  (real-time + turn-based, multi-branch COA in parallel, CGF and AI-agent runtime),
  unified data foundation (base / runtime / scenario / deduction-process / assessment
  data over polymorphic hybrid storage) + ontology.

## Fixed contracts — READ THESE FILES FIRST, never modify them

- `src/types.ts` — the whole domain model. The backend must produce JSON matching these shapes exactly.
- `src/api.ts` — the typed API client; pages call ONLY these functions for data.
- `src/shell.ts` — `PageProps { notify, goTo, profile }`; every page default-exports `(props: PageProps) => JSX.Element`.
- `src/components.tsx` — shared primitives: PageBody, MetricGrid, Metric, Panel, Button,
  ActionRow, StatusPill, Tag, Segmented, Detail, DetailGrid, CompactTable, ObjectList,
  EmptyState, ProgressBar, Modal, Field, FormGrid, Sparkline, BarRow, SvgRadar,
  TimelineBar, simClock, timeAgo.
- `src/map.tsx` — `TheaterMap` (default export) with `MapUnit`/`TheaterMapProps`. Leaflet dark tiles + SVG fallback.
- `src/data.ts` — sideColors, sideLabels, domainLabels, driveModeLabels, driveModeHints, eventTones, statusTone.
- `src/styles.css` — full design system (light theme, green primary, DOOH classes:
  `.page-body`, `.metric-grid`, `.split-grid.wide-left|.equal`, `.panel`, `.table-card`,
  `.object-list`, `.zone-list`, `.kanban`, `.stack-form`, `.segmented`, `.stage-tracker`,
  `.detail-cards`, `.agent-grid`, `.agent-card`, `.media-grid`, plus SANDTABLE additions:
  `.tag`, `.empty-state`, `.progress-bar`, `.modal-*`, `.field`, `.form-grid`, `.bar-row`,
  `.timeline-*`, `.theater-map`, `.sim-clock`, `.layer-badge`).

## Page conventions

- One file per page in `src/pages/<Name>.tsx`, default export, signature `(props: PageProps)`.
- Pages fetch their own data via `src/api.ts` in `useEffect`; show `EmptyState` while
  loading/failed; call `props.notify("...")` after every user action; use `ApiError.message` on failure.
- A page MAY add page-specific styles in `src/pages/<name>.css` (imported at top of the
  page file). Every class in that file MUST carry the page prefix to avoid collisions:
  dashboard `cmd-`, scenario `sd-`, coa `coa-`, rules `rc-`, deduction `ded-`,
  assessment `asm-`, ailayer `ail-`, foundation `fnd-`, admin `adm-`, intel `intel-`,
  orders `ord-`.
- English only. Dates via `timeAgo`, sim time via `simClock`.
- Keep everything demo-plausible: metrics, latencies, versions.

## Per-page briefs

### CommandDashboard (`dashboard`)
The commander's landing view. Metrics row (scenarios ready, active runs, agents ready,
open decisions). Wide-left split: TheaterMap of the most relevant run (latest running,
else latest completed replay start, else the ready scenario's units) + right column
"Live deduction" summary (sim clock, branch statuses, latest events). Below: three
layer cards (L3/L2/L1 with `.layer-badge` and key counts, each with a button that
`goTo`s the relevant page) and "Recent activity" (latest events / audit). Poll the
active run every 2s while it is running.

### ScenarioDesign (`scenario`)
Left: scenario list (select / create from template or blank via Modal). Main: tabs
(Segmented) — "Order of battle" (TheaterMap with `onMapClick` to place a new unit using
a palette of ontology force classes + side picker; click unit to edit strength/heading/
speed or remove), "Objectives" (list + add/edit form), "Environment" (weather, sea state,
visibility, EMCON, cyber threat selectors). Save via `updateScenario`, run
`validateScenario` and render the ValidationReport issues. Show unit tables per side.

### CoaGeneration (`coa`)
Scenario selector. Panel 1 "Mission & decomposition": mission intent/end-state; button
"Decompose mission" → `decomposeMission` → render sub-task TimelineBar + table with
assigned agents (Tag with drive mode) and dependencies. Panel 2 "COA candidates":
"Generate COAs" (count selector 2–4) → `generateCoas`; render each COA as a card
(approach, summary, phases TimelineBar, SvgRadar of scores) + comparison SvgRadar of all
candidates; select/reject buttons (`updateCoa` status) — selected COAs are what
Deduction can run. Panel 3 "Data readiness": static-ish panel from bootstrap platform
data (data domains feeding generation).

### RuleConfig (`rules`)
Rule set list (status pill, domain focus). Rule set detail: adjudication config editor
(mode, die model, seed, phase order chips) and rules table grouped by category with
enable/disable toggles and priority. "New rule" / "Edit rule" Modal — the low-code rule
builder: name, category, description, conditions rows (fact select / op select / value
input, add & remove) and effects rows (type select + params), preview sentence
("WHEN range within 40km AND target.domain = sea THEN modify-pk +15%"). Save via
`updateRuleSet` (replace rules array). "Create rule set" via `createRuleSet`. "Test"
panel: pick a canned situation (select) → `testRuleSet` → render trace entries
(fired/skipped with detail). This is the page where a user literally builds a config.

### Deduction (`deduction`)
Run launcher panel when no active run selected: scenario select, selected-COAs
multi-pick (only status selected/simulated), rule set select, engine select
(realtime/turn-based), speed, label → `startRun`. Active run view: `.sim-clock` +
controls (pause/resume/step for turn-based/speed segmented/abort), branch tabs
(Segmented, one per COA branch, colored), TheaterMap with live units + trails +
recent event pulses + objectives, event stream (ObjectList, newest first), branch
metrics strip (BLUE/RED strength ProgressBars, objective score, losses) + Sparkline of
strength history. DECISION QUEUE: when branch status is awaiting-decision render the
open DecisionPoint prominently: situation, options with risk, AI recommendation
highlighted (BrainCircuit icon + rationale) → commander picks one (+ optional rationale
text) → `decideBranch`. Intervention Modal (umpire): inject event / resupply / withdraw
unit / set weather → `intervene`. Poll `fetchRun` every 1.5s while running. When run
completes, offer `goTo("assessment")`.

### Assessment (`assessment`)
Run selector (completed runs; if a completed run has no assessments, button
"Generate assessment" → `assessRun`). Per branch (Segmented): verdict + overall score
metric row; dimension bars (BarRow); objective results table (achieved / completion %);
loss exchange + decision stats (followed AI vs overridden); AI commentary paragraph +
recommendations list. REPLAY: `fetchReplay` → timeline slider (input range over
snapshots) + play/pause button driving TheaterMap at the selected snapshot, metrics at
that tick, and the event list filtered up to that tick. Branch comparison table when
multiple branches exist (side-by-side scores).

### AiLayer (`ailayer`)
Three-column layout mirroring the slide. Column 1 "Strategic - task decomposition":
missions with sub-task counts and status stage trackers. Column 2 "Tactical - agent
library": agent cards grouped by drive mode (`.agent-grid`), each with status, win rate,
latency, episodes; click → Modal with details + recent AgentActivity for the latest run
(api calls used: observation/piece-drive). Column 3 "Human + AI decision": OODA chips
(O→O→D→A), decision history across runs (followed AI vs overridden with rationale),
"intent & decision retained by the commander" note, and Wargame System API stats
(observation calls, piece-drive calls, avg latency from platform info).

### Foundation (`foundation`)
Metrics: engines online, total records, active runs, ontology classes. Panel "Simulation
engines": engine cards (kind, version, load ProgressBar, active runs, capabilities tags).
Panel "Unified data foundation": data domain cards (store type Tag, records, size,
health) — base/runtime/scenario/deduction-process/assessment. Panel "One platform -
low-code inventory": counts (maps, pieces, rules, scenarios) + note on unified user/
permission/log management with `goTo("admin")` when permitted. Panel "Ontology explorer":
class tree (indent by parent, category Tag, domain), click class → attributes table +
relations (from/to) list; relations rendered as readable sentences.

### Admin (`admin`)
Users table (role, org, last active, status, permissions as Tags; suspend/activate via
`updateUser`). Permission matrix (users × pages, read-only checkmarks). Audit log table
(`fetchAudit`, newest first). System parameters panel (static demo values: session
policy, data retention, engine limits).

### Orders (`orders`)
Where a plan leaves the machine as paper. Scenario and COA pickers, then four tabs.
"Operation order": the five-paragraph order rendered as a document, every paragraph
carrying its portion mark, with copy, download and print. "Synchronisation matrix":
phases across the top, the force down the side, each cell naming the tasking and the
mission sub-task it serves, toggled between task-organisation and unit granularity;
any element tasked in no phase is called out as a planning gap rather than hidden.
"Decision support": the decisions this plan will force before it is run, each with its
trigger, latest time to decide, criteria and options, plus the named areas of interest.
"Fragmentary orders": the orders cut when a commander ruled on a decision point, an
override marked as one and carrying both the commander's rationale and what the machine
had recommended. The platform marking sits at the head and the foot of the page.

## Cross-cutting layers added after the first release

- **The adversary plays a plan.** RED executes an authored scheme of manoeuvre chosen by
  the white cell at launch, not a chase leash. Its content is masked from the players
  until the run completes or an umpire reveals it by name. Never describe the RED plan
  in copy that a player can read before the reveal, and never let SAGE paraphrase it:
  the grounded context tells the model it is withheld.
- **Branches share one seed.** Two COAs run against the same dice, so the difference
  between them is the plan. Any UI that compares branches may say so.
- **Autonomy is enforced, not labelled.** Every governed action passes through the
  policy in `state.governance`. A page must read `GET /api/governance/policy` rather
  than hard-coding which buttons demand a name, because an administrator can change it.
- **One classification marking.** It sits at the head and the foot of every workspace
  and is inherited by every document the platform emits. EXERCISE and FICTIONAL DATA are
  locked on.
- **Cues answer requirements.** The intel console shows the commander's priority
  intelligence requirements above the feed, and every cue is anchored to the indicator
  and named area it answers, with the reasoning shown.

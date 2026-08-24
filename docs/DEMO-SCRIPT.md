# SANDTABLE · 5-minute demo script

A repeatable walkthrough for client demos. Total time ≈ 5-7 minutes. All content is
fictional (Meridian Archipelago, Exercise AZURE HORIZON), say so up front.

## Before the demo (2 minutes, once)

1. `pnpm dev`, frontend on `http://localhost:5188`, backend on `:5189`.
2. Optional: put `ANTHROPIC_API_KEY=...` (or `OPENAI_API_KEY`) in `.env` and restart -
   the SAGE copilot answers with a live model instead of offline heuristics.
3. **Administration → System parameters → Reset demo data.** This wipes any previous
   demo's runs/edits and rebuilds the seed state, including a pre-computed "Historical:
   AZURE HORIZON rehearsal" run so Assessment has data from the first click.
4. Pick the theme (Dark = the Origen Figma look) with the toggle on the login screen.

## The story: "mission decomposition to assessment, run by AI agents, decided by commanders"

### Beat 1 · The platform (30s) · login screen

- Point at the five role profiles: the platform is permissioned by duty position -
  Commander, Plans (J5), Simulation Control, Analysis (J8), Admin.
- Log in as **Plans Cell (J5)**.

### Beat 2 · Scenario Design (60s) · L3 app 1

- Open **Scenario Design**: AZURE HORIZON with a 31-unit joint ORBAT placed on the
  **hex wargame board** (terrain-classified hexes over the chart, zoom in for grid
  coordinates).
- Click a unit (e.g. the carrier), every piece is an ontology-typed object with
  sensors, weapons, strength, supply, drawn as a NATO-style counter.
- Switch tabs: **Objectives** (weighted, per side) and **Environment** (weather, sea
  state, EMCON).
- Click **Validate**, structural checks pass; "ready for COA generation".
- **The wow moment · Import OPORD**: click Import OPORD → Load sample → Parse. The
  Intelligent Documents pipeline (Claude when a key is set, offline rules otherwise)
  extracts 9 BLUE + 7 RED force groups, task organization and objectives from the
  order text, then materializes a ready scenario with ontology-typed pieces on the
  hex board. "From order to playable scenario in under a minute."

### Beat 3 · Data & COA Generation (75s) · L2 strategic + L3 app 2

- Open **Data & COA Generation**. Show the mission: commander's intent + end state.
- The mission is already **decomposed into 10 sub-tasks** on a timeline, each assigned
  to a *hybrid-driven mission agent* (ISR → cyber → SEAD → strike → maneuver →
  amphibious → sustainment). This is the L2 strategic layer from the architecture.
- Pick a **commander weighting strategy** (Results / Loss control / Speed / Balanced)
  and click **Generate COAs**, the SAGE planning analysis panel walks through its six
  reasoning steps live, then 3 doctrinally distinct candidates land graded
  **recommended / steady / alternate**. Change the strategy and regenerate, the
  grades move. Each card carries a phase Gantt and the five-axis radar.
- Click **Silent deduction** on the recommended COA, a full headless 72-hour
  engine run projects objectives, strengths and net score onto the card. Select one.

### Beat 4 · Simulation Rules (45s) · L3 app 3

- Open **Simulation Rules**: the active "Standard Engagement Rules v2.1" set -
  adjudication mode, die model, phase order, 14 rules by category.
- **Build a rule live** (the low-code moment): New rule → e.g. *WHEN simTimeH gte 48
  THEN modify-pk ×1.15*, show the live preview sentence, save.
- Run **Dry-run adjudication** on a canned situation, show which rules fired and the
  net result. These same rules drive the engine in the next beat.

### Beat 5 · Full-Process Deduction (90s) · the centerpiece

- Switch profile to **Joint Force Commander** → **Full-Process Deduction**.
- Launch: scenario + two selected COAs (two **parallel branches**) + rule set +
  real-time engine at 2x. The screen becomes a **war-room console**: phase banner
  ("R1 · Advance to contact" + sim clock), environment pills (weather / sea state /
  EMCON / day-night), left ORBAT drawer, right drawers (Score · Orders · Adjudication
  · Decisions).
- Watch the board: NATO counters move on COA waypoints, engagements pulse, the live
  **mirrored scoreboard** (objective / force / combat points, BLUE vs RED) ticks.
- Open the **Adjudication drawer**, every salvo shows its math: weapon, range, base
  pk, which rules modified it, the random roll and the raw damage. "Nothing is a
  black box, the engine shows its dice."
- Click **RED view / BLUE view**, **fog of war**: each side sees only its own picture
  plus detected contacts (the ORBAT roster filters too). Umpire view sees everything.
- Open the **Seats drawer**: seven command seats, each held by a person or locked to
  an agent from the library. Flip one live. This is the human-machine team, configured.
- Within ~30s the first **commander decision point** fires: situation, three options,
  and the **SAGE recommendation with rationale**. Override it once, point out the
  "Commander override" tag. *Intent and decision are retained by the commander;
  the AI executes.*
- (If Simulation Control) show an umpire **intervention**: set weather to storm, the
  environment pill flips, the inject is logged in the Orders drawer with its explicit
  rule effect, and movement/detection adjudication reacts immediately.

### Beat 6 · Assessment & Replay (60s) · L3 app 5

- Speed to 4x, or switch to the pre-computed historical run in **Assessment & Replay**.
- Show the branch verdicts: e.g. Direct Thrust = objectives faster but heavy losses;
  Air-First = force preserved, slower. Five weighted dimensions, loss-exchange ratio,
  decisions followed-vs-overridden.
- Drag the **replay scrubber**, the whole battle replays frame by frame.
- **Resume from here**: scrub to the moment before a decision and fork a live run
  from that exact world state. The war room opens on the fork.
- **Generate report**: a director-ready after-action document written from the run figures.
- Read one SAGE recommendation aloud, the feedback loop back into planning.
- Open the **SAGE drawer** in the war-room console: "Why this adjudication?",
  "Biggest risk?", "Suggest next step", "Explain RED", every answer is grounded in
  the branch's live state (with the exact rule modifiers and rolls), via the
  reasoning service or offline knowledge.

### Beat 7 · The layers beneath (30s) · L2 + L1

- **AI Command Layer**: the agent library by drive mode (knowledge reasoning, data
  learning, operations research, large model → hybrid), decision history, and the
  Observation / Piece-drive API counters, the wargame system contract from the slide.
- **Platform Foundation**: engines, five data domains, the browsable ontology, and
  the **Piece designer** (create a unit type live; it appears in the Scenario Design
  palette immediately).

### Close

"One platform: design, run and review closed in a single environment, scenario to
assessment, executed by AI agents, decided by commanders."

## Recovery notes

- Anything odd mid-demo → **Administration → Reset demo data** (≈5s) and restart the beat.
- No network? Everything works offline: the map falls back to an SVG chart and SAGE
  answers from the built-in knowledge base.
- The deduction runs server-side, you can navigate to other pages mid-run and come back.

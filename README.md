# SANDTABLE

Standalone localhost demo of a **Scenario Simulation & Strategic Planning** wargame
platform — scenario simulation from mission decomposition to assessment, run by AI
agents, decided by commanders. Mirrors the DOOH platform layout (Vite + React frontend,
plain Node backend, JSON state persistence).

All scenario content is fictional (Meridian Archipelago, Exercise AZURE HORIZON).

## Run

```bash
pnpm install
pnpm dev
```

Frontend: `http://localhost:5188` | Backend API: `http://localhost:5189`.

Optional: put `OPENAI_API_KEY=...` in `.env` to power the SAGE copilot with a live
model; without it every AI endpoint degrades to offline heuristics.

## Layers

- **L3 Applications**: Scenario Design, Data & COA Generation, Simulation Rule
  Configuration, Full-Process Deduction, Assessment & Replay.
- **L2 AI Layer**: strategic task decomposition, tactical agent library by drive mode,
  human + AI collaborative decision (OODA) over Observation / Piece-drive APIs.
- **L1 Platform Foundation**: multiple simulation engines, unified data foundation
  (base / runtime / scenario / deduction / assessment) with an explorable ontology,
  users, permissions and audit logs.

## What makes it a wargame rather than a movement model

- **The adversary plays a plan.** RED executes one of two authored schemes of manoeuvre
  chosen by the white cell at launch. Under TIDEWALL every launcher stays silent, and
  harder to detect, until a BLUE capital ship crosses inside the coastal battery
  envelope. The plan is masked from the players until the run completes or an umpire
  reveals it, and the reveal includes what BLUE would have had to do to break it.
- **The comparison is fair.** Branches do not merely share a seed, which would
  desynchronise on the first tick because a different plan makes a different number of
  dice rolls. Each roll is drawn from a hash of the seed, the clock and the identity of
  the shot, so the same engagement at the same moment meets the same die in every
  branch. Where two plans agree, the dice are identical and the difference is the plan.
- **Autonomy is a control.** Each governed action carries a policy of `auto` or
  `human-required`. A human-required action refuses to execute without a named person,
  counts the refusal and audits it. Changing the policy in the Administration console
  changes what the API will do.
- **Orders come out, not just in.** The platform writes the five-paragraph order, the
  synchronisation matrix and the decision support matrix, and cuts a numbered
  fragmentary order under the commander's name every time they rule on a decision.
- **Cues answer requirements.** Every intelligence cue is anchored to the priority
  requirement, indicator and named area it speaks to, with the reasoning shown.
- **Everything is marked.** One classification banner at the head and foot of every
  workspace, inherited by every document, with EXERCISE and FICTIONAL DATA locked on.

## Checks

```bash
pnpm typecheck        # tsc --noEmit
pnpm check:engine     # headless engine assertions, no server, no state.json
pnpm e2e              # full chain over the live API (needs pnpm dev running)
pnpm e2e:intel        # the intel bridge from BASEER cue to after-action report
```

See `SPEC.md` (product spec) and `server/CONTRACTS.md` (backend contracts).

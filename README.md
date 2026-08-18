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

Frontend: `http://localhost:5188` · Backend API: `http://localhost:5189`.

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

See `SPEC.md` (product spec) and `server/CONTRACTS.md` (backend contracts).

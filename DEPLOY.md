# Deploying SANDTABLE

SANDTABLE is a wargame simulation platform. It runs as **one process on one port**.
The Node server serves both the JSON API and the built front end, so there is no
separate web server and no proxy to configure.

All data in it is fictional exercise material. The opposing force is RED or OPFOR and
is not any real country.

---

## Read this first

**There is no authentication.** The screen that asks you to pick a duty position is a
role selector in the browser, not a login. Anyone who can reach the port has every
role available to them, including the administration page and the button that wipes
the exercise and reseeds it.

The role model itself is real and enforced on the server. Simulation Control cannot
take a commander's decision and the commander cannot launch a run, and the server
returns 403 rather than the interface merely hiding a button. But the platform does
not know *who you are*, only which seat you claimed.

So deploy it somewhere that already controls who reaches it: an internal network,
behind your VPN, or behind an authenticating reverse proxy. Do not put it on a public
address. Adding real authentication and directory integration is declared pilot scope.

---

## Quick start

```bash
git clone https://github.com/Sargeanous/war.git
cd war
docker compose up -d --build
```

Then open `http://<host>:5189`.

To use a different published port, change the left-hand side of the port mapping in
`docker-compose.yml`. The container always listens on 5189 internally.

Without Compose:

```bash
docker build -t sandtable:latest .
docker run -d --name sandtable -p 5189:5189 -v sandtable-state:/data sandtable:latest
```

---

## Configuration

Everything is optional. With no environment set at all the platform runs fully.

| Variable | Default | What it does |
|---|---|---|
| `WAR_API_PORT` | `5189` | Port the server listens on inside the container. |
| `WAR_STATE_PATH` | `/data/state.json` in the image | Where the exercise is persisted. |
| `ANTHROPIC_API_KEY` | unset | Enables the live model for the in-product assistant. |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model used when a key is present. |

**About the API key.** The assistant is advisory throughout. It never holds authority
and it cannot take a governed action. With a key it answers using the model, grounded
in the run being asked about. With no key it still answers, composed deterministically
from the same run state: the event ledger, the objectives, the force state and the
decision record. Every answer carries its source, so you can always tell which path
produced it.

Do not put a key in the repository, in `docker-compose.yml`, or in the image. Pass it
from the host environment or your secret store at run time. There is no key in this
repository and there never has been.

---

## State and persistence

The platform keeps the whole exercise in a single JSON document, written to
`WAR_STATE_PATH`. The Compose file mounts a named volume at `/data` so the exercise
survives a restart. Remove that volume line and every restart begins again from the
seed, which is fine for a demo and surprising in a pilot.

On first start the server builds the seed data and runs a historical rehearsal
deduction so the platform has something to show immediately. That takes a few seconds
and is why the health check allows a start period.

To return to a clean state, use **Administration**, then **Reset demo data**, or delete
the volume and restart.

---

## Health and logs

`GET /health` returns `{"ok":true}` and is what the container health check uses.

```bash
docker compose logs -f sandtable
docker inspect --format '{{.State.Health.Status}}' sandtable
```

On a healthy start the log reads something like:

```
[sandtable] seed data built; running historical rehearsal deduction...
[sandtable] historical rehearsal complete; state persisted.
[sandtable] backend listening on http://localhost:5189
[sandtable] 3 scenarios, 3 COAs, 12 agents, 1 run, 2 assessments; copilot: offline
```

`copilot: offline` means no API key is set, which is expected unless you supplied one.

---

## How it is built

Two stages. The build stage installs dependencies, type checks with `tsc --noEmit`
and bundles with Vite, so a type error fails the image rather than shipping. The
runtime stage copies only `server/`, `dist/` and `package.json`. It installs nothing,
because the server has no runtime npm dependencies: it imports Node builtins and its
own modules and nothing else. The container runs as the unprivileged `node` user and
writes only to `/data`.

Rough sizes: the build context is small because `.dockerignore` excludes
`node_modules`, `dist`, `.env`, local state and the client deck.

---

## Running without Docker

```bash
npm ci
npm run build
node server/index.mjs
```

Serves on 5189. Requires Node 22 or newer.

For development with hot reload, `npm run dev` instead runs the API on 5189 and Vite
on 5188 with a proxy between them. In that mode you open 5188, not 5189.

---

## What is not built yet

Declared scope rather than omissions found late:

- Authentication, single sign-on and directory integration
- Accreditation and hardened hosting
- Terrain affecting adjudication. The relief on the map is genuine generated geometry
  and the engine does not read it. Movement and detection are straight-line.
- Live data feeds in place of exercise data
- Autonomous agent behaviours under the autonomy policy
- Distributed play across multiple cells
- Customer doctrine templates and rule sets

---

## Questions

Mehdi Sargeane, mehdi.sargeane@origen.ae

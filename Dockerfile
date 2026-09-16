# SANDTABLE, packaged as one image.
#
# The front end is built with Vite and the result is served by the same Node process
# that serves the API, so the container is one process listening on one port. There
# is no nginx and no second service to keep in step.
#
# The backend has no runtime npm dependencies. It imports node: builtins and its own
# modules and nothing else, which is why the runtime stage installs nothing.

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall the world.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
# Type check and bundle. `npm run build` runs tsc --noEmit and then vite build, so a
# type error fails the image rather than shipping.
RUN npm run build

# ---------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only what the server actually needs at runtime: its own code and the built assets.
# No node_modules, no source, no toolchain.
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The exercise is persisted here rather than beside the code, so a mounted volume
# keeps it across restarts. Without a volume the container still runs, it just starts
# from the seed every time. See DEPLOY.md.
ENV WAR_STATE_PATH=/data/state.json
VOLUME ["/data"]

# Run unprivileged. The node image ships a `node` user; it needs to own the data
# directory, which is the only thing the process writes to.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV WAR_API_PORT=5189
EXPOSE 5189

# No shell wrapper, so signals reach node directly and the container stops cleanly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WAR_API_PORT||5189)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]

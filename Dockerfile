# Maestro: engine (Node + TypeScript via tsx) serving the built Angular dashboard on one port.

# The base image, pinned by digest so every build starts from the same bits.
# To update: docker buildx imagetools inspect node:24-bookworm-slim, then paste the new digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# Build the dashboard.
FROM ${NODE_IMAGE} AS dashboard
WORKDIR /app/apps/dashboard
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/dashboard ./
RUN npx ng analytics disable --global >/dev/null 2>&1 || true; npm run build

# Install the engine's runtime dependencies (including the Claude Agent SDK and its native CLI for this platform).
FROM ${NODE_IMAGE} AS engine
WORKDIR /app/apps/engine
COPY apps/engine/package.json apps/engine/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
# git for clones, worktrees and commits; the docker CLI only when the gate sandbox is wanted.
ARG WITH_DOCKER_CLI=false
# Coding CLIs to use as AI providers, as npm packages, e.g. "@github/copilot @openai/codex @google/gemini-cli".
ARG EXTRA_NPM_CLIS=
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && if [ "$WITH_DOCKER_CLI" = "true" ]; then apt-get install -y --no-install-recommends docker.io; fi \
  && rm -rf /var/lib/apt/lists/*
RUN if [ -n "$EXTRA_NPM_CLIS" ]; then npm install -g --no-audit --no-fund $EXTRA_NPM_CLIS && npm cache clean --force; fi
WORKDIR /app
COPY --from=engine /app/apps/engine/node_modules apps/engine/node_modules
COPY apps/engine/package.json apps/engine/tsconfig.json apps/engine/
COPY apps/engine/src apps/engine/src
COPY docker-entrypoint.sh /usr/local/bin/maestro-start
COPY --from=dashboard /app/apps/dashboard/dist apps/dashboard/dist

# The engine binds all interfaces inside the container; publish the port on 127.0.0.1 only (see docker-compose.yml).
# Its Host and Origin checks still refuse anything but localhost.
ENV NODE_ENV=production \
    MAESTRO_HOST=0.0.0.0 \
    MAESTRO_PORT=4800 \
    MAESTRO_HOME=/data \
    MAESTRO_SECRETS=file \
    HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/claude
# Runs as the image's node user (uid 1000) unless docker-compose.yml maps it to yours.
USER node
EXPOSE 4800
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAESTRO_PORT||4800)+'/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/apps/engine
# tini as PID 1 reaps the agent and gate processes the engine spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["maestro-start"]

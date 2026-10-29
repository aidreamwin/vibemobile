# Multi-stage build for VibeMobile monorepo
# Stage 1: Builder
# Full bookworm (buildpack-deps), not alpine or slim: node-pty publishes no
# linux prebuilds, so `npm ci` below runs node-gyp, and this variant already
# carries python3, make and g++. The slim/alpine variants do not, which is what
# killed the image job with `gyp ERR! not ok`.
FROM node:22-bookworm AS builder

WORKDIR /app

# Copy package manifests for layer caching
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Install all dependencies (including devDependencies required for typescript build)
RUN npm ci

# Put the Codex CLI somewhere `npm prune --omit=dev` cannot reach it.
#
# It is a root *devDependency*, so the prune below deletes it -- which is why
# this image used to come up with a working Claude provider and a Codex provider
# that could never start: the supervisor spawns `codex` off PATH (see
# apps/server/src/codex/supervisor.ts) and there was nothing there.
#
# No base-image change is needed for this: the linux x64 payload of the package
# is a *static musl* binary (`vendor/x86_64-unknown-linux-musl/bin/codex`, no
# ld-linux reference), which is exactly what the launcher picks on linux, so it
# runs on glibc and musl alike. Verified by unpacking the platform tarball.
#
# The version is read out of package.json rather than repeated here: the
# app-server protocol has no version negotiation, so a second pin that drifts
# from the first would be a silent field-shape mismatch at runtime.
RUN CODEX_CLI_VERSION="$(node -p "require('./package.json').devDependencies['@openai/codex']")" \
 && npm install --prefix /opt/codex-cli --no-save "@openai/codex@$CODEX_CLI_VERSION" \
 && /opt/codex-cli/node_modules/.bin/codex --version

# Copy source files. There is no root tsconfig.json — each workspace carries its
# own and `COPY apps/server ./apps/server` brings it along — so the line that
# tried to copy one is gone. Docker fails the build outright when a COPY source
# is missing, so that line could only ever have been a broken build.
COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server
COPY apps/web ./apps/web

# The server's `postbuild` writes dist/version.json through this file, and the
# web build reads it too. The `.d.mts` next to it is required: the web build
# runs `tsc -b` over vite.config.ts, which imports the `.mjs` directly, so
# without the declaration a clean build dies with TS7016 (a local incremental
# tsbuildinfo hides that). Copy just this pair rather than the whole scripts/
# directory — the rest is dev tooling and Windows binaries.
COPY scripts/build-info.mjs scripts/build-info.d.mts ./scripts/

# Build web frontend and server backend
RUN npm run build --workspace=@vibemobile/web && npm run build --workspace=@vibemobile/server

# Prune devDependencies for production runtime
RUN npm prune --omit=dev

# Stage 2: Runtime
# Same base as the builder, so the node-pty binary compiled there matches the
# runtime libc. bookworm (buildpack-deps) already ships git and bash, which
# Codex's git operations and VIBEMOBILE_SHELL=/bin/bash need.
FROM node:22-bookworm AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV VIBEMOBILE_HOST=0.0.0.0
ENV VIBEMOBILE_STATE_DIR=/app/data

# Copy workspace package definitions & node_modules
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol ./packages/protocol
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# The Codex CLI, out of prune's reach (see the builder stage). Putting it on
# PATH is the whole mechanism: that is where the supervisor looks for it.
COPY --from=builder /opt/codex-cli /opt/codex-cli
ENV PATH="/opt/codex-cli/node_modules/.bin:${PATH}"

# Expose port
EXPOSE 3000

# Persistent state volume
VOLUME ["/app/data"]

CMD ["npm", "start"]

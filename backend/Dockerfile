# zkvote-backend — hardened multi-stage build.
# Built ON the box from /opt/apps/zkvote/backend. Frontend is on Pages.

# ---- builder ----
# Pinned to Node 22 to match package.json engines + local dev (#599). Mixing
# Node 20 build layers with a Node 22 runtime breaks the better-sqlite3 /
# sharp native ABI (better_sqlite3.node compiled for the wrong NODE_MODULE_VERSION).
FROM node:22-bookworm-slim AS builder
# python3 + build-essential: required to rebuild better-sqlite3/sharp from
# source for the exact Node 22 ABI. Discarded with the builder stage either way.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Rebuild native modules for the Node 22 ABI even when the layer cache holds
# Node 20-compiled artifacts.
RUN npm rebuild better-sqlite3 --build-from-source && npm rebuild sharp --build-from-source || true
COPY . .
RUN npm run build
# prune dev dependencies (native modules already compiled in npm ci above)
RUN npm prune --omit=dev
# Smoke test the native ABI before shipping the layer: fails the build instead
# of degrading /health at runtime on Fly.
RUN node -e "require('better-sqlite3'); console.log('better-sqlite3 ABI ok:', process.versions.modules)"

# ---- runner ----
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=builder --chown=node:node /app /app
# SQLite data dir — owned by the non-root runtime user; mounted as a volume
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

# zkvote-backend — hardened multi-stage build.
# Built ON the box from /opt/apps/zkvote/backend. Frontend is on Pages.

# ---- builder ----
FROM node:20-bookworm-slim AS builder
# python3 + build-essential: only used if better-sqlite3 has no prebuilt for
# this platform. Discarded with the builder stage either way.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# prune dev dependencies (native modules already compiled in npm ci above)
RUN npm prune --omit=dev

# ---- runner ----
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=builder --chown=node:node /app /app
# SQLite data dir — owned by the non-root runtime user; mounted as a volume
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

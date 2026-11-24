# Build stage (pinned to Node 22 to match the backend runtime ABI, #599)
FROM node:22-alpine AS builder

# Install build dependencies for native modules (usb package needs Python/gcc)
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev

WORKDIR /app

# Copy package files
COPY frontend/package*.json ./

# Install all dependencies with frozen lockfile for hermetic build
RUN npm ci --legacy-peer-deps

# Copy frontend source
COPY frontend/ .

# Stage precompiled circuit artifacts for sync:circuits (#645).
# CIRCUITS_BUILD points sync at this staged tree (not ../circuits outside the image).
COPY circuits/build/ /circuits-build/
ENV CIRCUITS_BUILD=/circuits-build

# Public build-time config only. Never bake VITE_RELAYER_AUTH_TOKEN (or any
# shared write secret) into the bundle — Vite would inline it into public JS (#647).
ARG VITE_RELAYER_URL
RUN echo "VITE_RELAYER_URL=${VITE_RELAYER_URL}" > .env

# Build contracts first (they need to be built before main app)
RUN cd src/contracts/dao-registry && npm install --silent && npm run build || true
RUN cd src/contracts/membership-sbt && npm install --silent && npm run build || true
RUN cd src/contracts/membership-tree && npm install --silent && npm run build || true
RUN cd src/contracts/voting && npm install --silent && npm run build || true
RUN cd src/contracts/comments && npm install --silent && npm run build || true

# Use npm run build so prebuild → sync:circuits runs and FAILS if vote.wasm
# is missing (npx vite build previously skipped the hook).
RUN npm run build

# Production stage - serve with nginx
FROM nginx:alpine AS production

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/nginx.conf

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Run nginx
CMD ["nginx", "-g", "daemon off;"]

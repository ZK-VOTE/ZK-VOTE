# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for native modules (usb package needs Python/gcc)
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm install --legacy-peer-deps

# Copy source code (excluding contracts which are separate packages)
COPY . .

# Build contracts first (they need to be built before main app)
RUN cd src/contracts/dao-registry && npm install --silent && npm run build || true
RUN cd src/contracts/membership-sbt && npm install --silent && npm run build || true
RUN cd src/contracts/membership-tree && npm install --silent && npm run build || true
RUN cd src/contracts/voting && npm install --silent && npm run build || true
RUN cd src/contracts/comments && npm install --silent && npm run build || true

# Set environment variables for build
ARG VITE_RELAYER_URL

# Create .env file for Vite to pick up during build
# VITE_RELAYER_AUTH_TOKEN is passed as a build secret for security
RUN echo "VITE_RELAYER_URL=${VITE_RELAYER_URL}" > .env

# Build the frontend with auth token from build secret
# The --mount=type=secret makes the secret available only during this RUN command
RUN --mount=type=secret,id=VITE_RELAYER_AUTH_TOKEN \
    if [ -f /run/secrets/VITE_RELAYER_AUTH_TOKEN ]; then \
      echo "VITE_RELAYER_AUTH_TOKEN=$(cat /run/secrets/VITE_RELAYER_AUTH_TOKEN)" >> .env; \
    fi && \
    npx vite build

# Production stage - serve with nginx
FROM nginx:alpine AS production

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Run nginx
CMD ["nginx", "-g", "daemon off;"]

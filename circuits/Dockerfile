# Reproducible Docker Build for ZK-VOTE Circom Circuits
# Circom Version: 2.1.8

FROM node:20-slim AS builder

ARG CIRCOM_VERSION=2.1.8

# Install build dependencies & wget/curl/ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    git \
    python3 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Download pinned Circom binary
RUN curl -L "https://github.com/iden3/circom/releases/download/v${CIRCOM_VERSION}/circom-linux-amd64" -o /usr/local/bin/circom && \
    chmod +x /usr/local/bin/circom

# Verify circom version
RUN circom --version

WORKDIR /app/circuits

# Copy package metadata & install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy circuit sources & scripts
COPY vote.circom merkle_tree.circom ./
COPY convert_vkey_to_soroban_be.js conversion-utils.js ./
COPY .circomversion ./

# Compile circuit
RUN mkdir -p build && \
    circom vote.circom --r1cs --wasm --sym -o build -l node_modules

# Default entrypoint copies artifacts out or verifies build
CMD ["sh", "-c", "echo 'Circuit compilation complete. Artifacts located in /app/circuits/build'"]

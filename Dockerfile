# ── Build stage ──────────────────────────────────────────────────────────────
# node-pty compiles a native addon, so we need build tools at install time.
# We use a separate build stage so the final image stays lean.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install build tools required by node-pty (node-gyp + Python)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

WORKDIR /app

# Runtime dependencies: git (for repos), bash (PTY shell), ca-certs (HTTPS clones)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      bash \
      ca-certificates \
      openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    # Sensible git defaults so commits work inside the container
    && git config --system core.autocrlf false \
    && git config --system init.defaultBranch main

# Copy compiled node_modules from build stage
COPY --from=build /app/node_modules ./node_modules

# Copy application source
COPY server.js index.html package.json ./

# Repos are stored here — mount a volume to persist them across restarts
RUN mkdir -p /repos
ENV REPOS_DIR=/repos

# Shell for the PTY terminal
ENV SHELL=/bin/bash

# Expose the application port
EXPOSE 3057

# Run as a non-root user for better security
RUN useradd --create-home --shell /bin/bash webgit \
    && chown -R webgit:webgit /app /repos
USER webgit

CMD ["node", "server.js"]

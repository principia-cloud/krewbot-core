# ---- Stage 1: Build Chat SDK server (TypeScript → JS) ----
FROM public.ecr.aws/docker/library/node:22-alpine AS server-builder
WORKDIR /build
COPY chat-server/package.json chat-server/package-lock.json* ./
RUN npm install
RUN npm install typescript @types/node
COPY chat-server/src/ ./src/
COPY chat-server/tsconfig.json ./
RUN npx tsc --outDir /build/dist

# ---- Stage 3: Build libsandbox (unchanged) ----
FROM public.ecr.aws/docker/library/python:3.12-slim AS sandbox-builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY libsandbox.c .
RUN gcc -shared -fPIC -O2 -o libsandbox.so libsandbox.c -ldl \
    && strip libsandbox.so

# ---- Stage 4: Final runtime ----
FROM public.ecr.aws/docker/library/python:3.12-slim

# Node.js (required by Claude Agent SDK CLI) + git (used by context_mcp)
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# MCP servers for optional integrations (Google Workspace, Microsoft 365,
# Notion, Browser)
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: we connect to AgentCore's managed
# Chromium via CDP — no local browser binaries needed.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Pin exact versions — these are global installs with no lockfile, so an
# unpinned `latest` once silently shipped a breaking MCP server and broke
# Gmail until caught. Bump deliberately. (Google Workspace moved to the
# Python `workspace-mcp` package — see requirements.txt — for its native
# --tools/--tool-tier catalog filtering.)
RUN npm install -g \
      @notionhq/notion-mcp-server@2.2.1 \
      @playwright/mcp@0.0.75 \
      @softeria/ms-365-mcp-server@0.114.4

WORKDIR /app

# Python deps (MCP servers only — no claude-agent-sdk Python package)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Python MCP servers + system context template.
COPY mcp/ ./mcp/
COPY system_context/ ./system_context/
# Canonical JSON-line logger. Staged into this build context by
# scripts/inject-shared-log.sh before `docker build`; placed in mcp/
# so the MCP scripts (running with /app/mcp/ on sys.path) can import
# it via `from platform_log import init_logger`.
COPY platform_log.py ./mcp/platform_log.py

# Chat SDK server (compiled JS + production deps)
COPY --from=server-builder /build/dist/ ./chat-server/
COPY chat-server/package.json ./chat-server/
WORKDIR /app/chat-server
RUN npm install --production
WORKDIR /app

# Sandbox: LD_PRELOAD library + confined bash wrapper
COPY --from=sandbox-builder /build/libsandbox.so /app/libsandbox.so
COPY confined-bash /app/confined-bash
RUN mv /usr/bin/bash /usr/bin/bash.real \
    && cp /app/confined-bash /usr/bin/bash \
    && chmod 755 /usr/bin/bash

# Non-root uid 1000 matches EFS access point PosixUser enforcement
RUN useradd -u 1000 -m agent
USER agent

EXPOSE 8080
CMD ["node", "chat-server/index.js"]

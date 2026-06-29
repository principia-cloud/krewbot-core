#!/bin/bash
# Stages shared/python/platform_log.py into a Docker build context.
#
# The canonical log file lives at the package root in
# shared/python/platform_log.py. Docker builds need it inside their
# build context to COPY it into the image. Rather than rewriting every
# Dockerfile to use a wider build context (which would force rewriting
# every existing COPY directive), this script copies the file into
# place just before `docker build` runs.
#
# Usage:
#   ./scripts/inject-shared-log.sh <docker-context-dir>
#
# Examples:
#   # Inside core:
#   ./scripts/inject-shared-log.sh docker/agent
#   ./scripts/inject-shared-log.sh docker/sidecar
#
#   # From a downstream consumer (e.g. an overlay) after npm install:
#   bash node_modules/@krewbot/platform-core/scripts/inject-shared-log.sh \
#        node_modules/@krewbot/platform-core/docker/agent
set -euo pipefail

TARGET="${1:?usage: $0 <docker-context-dir>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$PKG_ROOT/shared/python/platform_log.py"

if [ ! -f "$SRC" ]; then
  echo "::error::Canonical log file not found at $SRC" >&2
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  echo "::error::Target directory does not exist: $TARGET" >&2
  exit 1
fi

cp "$SRC" "$TARGET/platform_log.py"
echo "[inject-shared-log] $TARGET/platform_log.py ← $SRC"

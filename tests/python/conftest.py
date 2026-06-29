"""Shared pytest setup for core's Python tests.

Keeps test imports isolated from any stale state left over by another
test file (sys.path / sys.modules pollution between hook tests and
workspace-api tests)."""

import sys
from pathlib import Path


# Make `lambda/workspace-api/` importable for hook tests; the neutral
# workspace-api test prepends it again inside its loader fixture.
LAMBDA_DIR = Path(__file__).resolve().parents[2] / "lambda" / "workspace-api"
if str(LAMBDA_DIR) not in sys.path:
    sys.path.insert(0, str(LAMBDA_DIR))

# Make `shared/python/platform_log.py` importable for sidecar tests.
# In production the file is staged into the sidecar image by
# scripts/inject-shared-log.sh; in tests we just point sys.path at it.
SHARED_PY = Path(__file__).resolve().parents[2] / "shared" / "python"
if str(SHARED_PY) not in sys.path:
    sys.path.insert(0, str(SHARED_PY))

# Make `docker/sidecar/` importable so `from jobs import sync` works.
SIDECAR_DIR = Path(__file__).resolve().parents[2] / "docker" / "sidecar"
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

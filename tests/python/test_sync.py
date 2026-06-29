"""Tests for the sidecar secrets-sync loop.

These tests pin the load-bearing invariants of how rotated secrets reach
the sandbox:

  - SYNC_INTERVAL defaults to 5 seconds (was 15; lowering it is half of
    the customer-visible "token refresh feels broken" fix). A revert
    will silently regress propagation latency.
  - A bumped `secrets-revision` SSM parameter triggers a full
    Secrets Manager sync on the very next tick (the fast path).
  - An unchanged revision does NOT trigger the expensive list+get pass
    (the cheap-probe optimization the design depends on).
  - The first tick always runs a full sync even when the workspace has
    no revision parameter yet (otherwise a freshly started sidecar
    leaves /config/secrets/ empty until the 15-min backstop fires).

We patch the cheap functions (jwks/platform-config/ssm/secrets) into
no-ops or counters and drive the loop via a sleep that raises after a
configurable number of iterations. This exercises the real sync_loop
decision logic, not a reimplementation.
"""

from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path

import pytest


SIDECAR_DIR = Path(__file__).resolve().parents[2] / "docker" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIR))


def _fresh_sync_module(monkeypatch, *, env: dict[str, str] | None = None):
    """Reload jobs.sync with a clean env so module-level constants
    (SYNC_INTERVAL, prefixes) reflect the test's setup."""
    for key in (
        "SYNC_INTERVAL",
        "JWKS_URL",
        "WORKSPACE_ID",
        "WORKSPACE_SECRETS_PREFIX",
        "WORKSPACE_SSM_PREFIX",
        "PLATFORM_CONFIG_SSM_NAME",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)

    sys.modules.pop("jobs.sync", None)
    sys.modules.pop("jobs", None)
    import jobs.sync as sync  # noqa: E402  — must follow env setup
    importlib.reload(sync)
    return sync


class _StopLoop(Exception):
    """Sentinel raised inside the patched sleep to exit sync_loop cleanly."""


def _driver(sync_mod, *, revisions, max_iters: int):
    """Run sync_loop for `max_iters` ticks, recording per-tick decisions.

    `revisions` is a list returned one-per-tick by the patched
    read_secrets_revision; if shorter than max_iters the last value
    repeats. Returns the count of full secrets-syncs that ran.
    """
    call_count = {"secrets": 0, "jwks": 0, "ssm": 0, "platform": 0}
    iter_idx = {"i": 0}

    def fake_read_secrets_revision():
        i = min(iter_idx["i"], len(revisions) - 1)
        return revisions[i]

    def fake_sync_workspace_secrets():
        call_count["secrets"] += 1

    def fake_sync_workspace_ssm():
        call_count["ssm"] += 1

    def fake_sync_jwks():
        call_count["jwks"] += 1

    def fake_sync_platform_config():
        call_count["platform"] += 1

    async def fake_sleep(_seconds):
        iter_idx["i"] += 1
        if iter_idx["i"] >= max_iters:
            raise _StopLoop()

    sync_mod.read_secrets_revision = fake_read_secrets_revision
    sync_mod.sync_workspace_secrets = fake_sync_workspace_secrets
    sync_mod.sync_workspace_ssm = fake_sync_workspace_ssm
    sync_mod.sync_jwks = fake_sync_jwks
    sync_mod.sync_platform_config = fake_sync_platform_config

    # Patch asyncio.sleep inside the sync module's namespace so its
    # `await asyncio.sleep(...)` call hits us, not the real timer.
    original_sleep = asyncio.sleep

    async def patched_sleep(seconds):
        await fake_sleep(seconds)

    asyncio.sleep = patched_sleep  # type: ignore[assignment]
    try:
        with pytest.raises(_StopLoop):
            asyncio.run(sync_mod.sync_loop())
    finally:
        asyncio.sleep = original_sleep  # type: ignore[assignment]

    return call_count


def test_sync_interval_default_is_5_seconds(monkeypatch):
    """The sidecar's SSM probe cadence is the consumer-facing latency
    budget. 5s was chosen to stay well below the SSM 40 TPS account-wide
    GetParameter quota for realistic workspace counts while giving
    near-real-time propagation. If this drifts back to 15+, the chat
    server's fs.watch can't compensate — the file simply doesn't change
    until the sidecar tick fires."""
    sync = _fresh_sync_module(monkeypatch)
    assert sync.SYNC_INTERVAL == 5


def test_revision_change_triggers_secrets_sync_within_one_tick(monkeypatch, tmp_path):
    tmp_config_dir = tmp_path / "config"
    """When workspace-api bumps `secrets-revision`, the very next tick
    must run a full Secrets Manager sync. This is the fast path; if it
    breaks, customers wait up to FULL_SECRETS_SYNC_BACKSTOP_SEC (15 min)
    for a rotated bot token to take effect."""
    sync = _fresh_sync_module(
        monkeypatch,
        env={
            "WORKSPACE_SSM_PREFIX": "/test",
            "WORKSPACE_SECRETS_PREFIX": "test",
            "CONFIG_DIR": str(tmp_config_dir),
        },
    )
    # First tick sees revision=A (always runs because last_full is None).
    # Second tick sees revision=B → revision_changed should fire.
    # Third tick sees revision=B again → no extra sync.
    counts = _driver(
        sync,
        revisions=["100", "200", "200"],
        max_iters=3,
    )
    assert counts["secrets"] == 2, (
        f"expected full sync on tick 1 (first run) and tick 2 (revision changed); "
        f"got {counts['secrets']}"
    )


def test_unchanged_revision_skips_secrets_sync(monkeypatch, tmp_path):
    tmp_config_dir = tmp_path / "config"
    """The cheap-probe optimization: when the revision counter hasn't
    moved (and we're well inside the backstop window), the loop must
    NOT pull from Secrets Manager. Otherwise the SSM-quota-friendly
    design collapses into "list_secrets every tick"."""
    sync = _fresh_sync_module(
        monkeypatch,
        env={
            "WORKSPACE_SSM_PREFIX": "/test",
            "WORKSPACE_SECRETS_PREFIX": "test",
            "CONFIG_DIR": str(tmp_config_dir),
        },
    )
    # Five ticks, revision pinned at the same value the whole time.
    # First tick fires (last_full is None backstop), the next four must not.
    counts = _driver(
        sync,
        revisions=["100", "100", "100", "100", "100"],
        max_iters=5,
    )
    assert counts["secrets"] == 1, (
        f"only the first tick should run a full sync when revision is steady; "
        f"got {counts['secrets']}"
    )


def test_first_tick_runs_full_sync_when_revision_param_missing(monkeypatch, tmp_path):
    tmp_config_dir = tmp_path / "config"
    """Pre-existing workspaces and freshly provisioned ones don't have a
    `secrets-revision` parameter until their first integration write.
    Without the `last_full_secrets_sync_at is None` clause in sync_loop,
    /config/secrets would stay empty for up to 15 minutes after boot.
    This test pins the boot-time invariant."""
    sync = _fresh_sync_module(
        monkeypatch,
        env={
            "WORKSPACE_SSM_PREFIX": "/test",
            "WORKSPACE_SECRETS_PREFIX": "test",
            "CONFIG_DIR": str(tmp_config_dir),
        },
    )
    # read_secrets_revision returns None throughout — workspace pre-dates
    # the counter, or its parameter hasn't been seeded yet.
    counts = _driver(
        sync,
        revisions=[None, None, None],
        max_iters=3,
    )
    assert counts["secrets"] == 1, (
        f"the first tick must run a full secrets sync even with no revision; "
        f"got {counts['secrets']}"
    )

"""End-to-end propagation test: producer → sidecar → chat-server.

This test exists because token rotation latency is a customer-visible
behavior built out of three independently-correct pieces (workspace-api
writes, sidecar pulls, chat-server reloads) plus the Python ↔ Node
boundary in the middle. The unit tests on either side don't catch a
regression that breaks the seam: e.g., sidecar writing files but
chat-server never being notified, or chat-server watching the wrong
directory, or the sidecar reading the secret name wrong relative to the
prefix the producer uses.

Chain under test:

  1. Producer (replicating workspace-api `_put_secret`) writes a secret
     to Secrets Manager and bumps the `secrets-revision` SSM parameter.
     moto stands in for AWS — same API surface, no real account needed.
  2. Sidecar's real `sync_workspace_secrets()` lists the prefix, fetches
     the value, and atomically writes it under tmp `/config/secrets/`.
  3. Chat-server's real `startSecretsWatcher` (run as a tsx subprocess
     pointed at the same tmp dir) sees the file change and emits its
     debounced onChange.

If any one step regresses, the customer pain ("I rotated my Telegram
bot token; the agent kept using the dead one for a long time") returns.
"""

from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from threading import Event, Thread

import pytest

boto3 = pytest.importorskip("boto3")
moto = pytest.importorskip("moto")
from moto import mock_aws  # type: ignore  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "docker" / "sidecar"
CHAT_SERVER_DIR = REPO_ROOT / "docker" / "agent" / "chat-server"
DRIVER_TS = Path(__file__).parent / "_watcher_driver.ts"


def _node_available() -> bool:
    return shutil.which("node") is not None


def _tsx_available() -> bool:
    """tsx is installed inside chat-server/node_modules; we invoke via
    `node --import tsx` (matching the package.json test script)."""
    return (CHAT_SERVER_DIR / "node_modules" / "tsx").exists()


pytestmark = [
    pytest.mark.skipif(not _node_available(), reason="node required"),
    pytest.mark.skipif(
        not _tsx_available(),
        reason="run `npm install` inside docker/agent/chat-server first",
    ),
]


def _fresh_sync_module(env: dict[str, str]):
    """Reload jobs.sync with the supplied env so module-level constants
    (CONFIG_DIR, prefixes, region) reflect the test's setup."""
    for key in (
        "SYNC_INTERVAL",
        "JWKS_URL",
        "WORKSPACE_ID",
        "WORKSPACE_SECRETS_PREFIX",
        "WORKSPACE_SSM_PREFIX",
        "PLATFORM_CONFIG_SSM_NAME",
        "CONFIG_DIR",
        "AWS_REGION",
    ):
        os.environ.pop(key, None)
    for key, value in env.items():
        os.environ[key] = value

    if str(SIDECAR_DIR) not in sys.path:
        sys.path.insert(0, str(SIDECAR_DIR))
    sys.modules.pop("jobs.sync", None)
    sys.modules.pop("jobs", None)
    import jobs.sync as sync  # noqa: E402

    importlib.reload(sync)
    # Force the lazy boto3 client cache to repopulate with the
    # moto-backed clients created in the test scope.
    sync._clients.clear()
    return sync


class _NodeWatcher:
    """Spawn the tsx driver and expose helpers to wait for stdout markers."""

    def __init__(self, watch_dir: Path):
        self._on_change_events: list[float] = []
        self._ready = Event()
        self._proc = subprocess.Popen(
            [
                "node",
                "--import",
                "tsx",
                str(DRIVER_TS),
                str(watch_dir),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(CHAT_SERVER_DIR),
            text=True,
            bufsize=1,
        )
        self._reader = Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if line == "READY":
                self._ready.set()
            elif line == "ONCHANGE":
                self._on_change_events.append(time.monotonic())

    def wait_ready(self, timeout: float = 10.0) -> None:
        if not self._ready.wait(timeout):
            self._dump_stderr()
            raise TimeoutError("watcher driver did not signal READY")

    def wait_for_change(self, since_count: int, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len(self._on_change_events) > since_count:
                return
            time.sleep(0.05)
        self._dump_stderr()
        raise TimeoutError(
            f"watcher driver did not emit ONCHANGE within {timeout}s "
            f"(have {len(self._on_change_events)}, wanted > {since_count})"
        )

    @property
    def change_count(self) -> int:
        return len(self._on_change_events)

    def _dump_stderr(self) -> None:
        if self._proc.stderr is not None:
            try:
                sys.stderr.write("--- watcher driver stderr ---\n")
                sys.stderr.write(self._proc.stderr.read() or "")
                sys.stderr.write("\n-----------------------------\n")
            except Exception:
                pass

    def stop(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.wait(timeout=5)
        except Exception:
            self._proc.kill()
            self._proc.wait(timeout=2)


@mock_aws
def test_full_rotation_propagation(tmp_path):
    """Producer writes a secret + bumps the revision → sidecar materializes
    it on disk → chat-server fs.watch fires. Then rotate the value and
    verify the same chain reflects the new value on the next sync."""
    config_dir = tmp_path / "config"
    secrets_dir = config_dir / "secrets"
    secrets_dir.mkdir(parents=True)

    region = "us-east-1"
    secrets_prefix = "test-self-host"
    ssm_prefix = "/test-self-host"
    workspace_id = "ws-integ-1"
    secret_basename = "telegram-bot-token"
    secret_name = f"{secrets_prefix}/{workspace_id}/{secret_basename}"
    revision_name = f"{ssm_prefix}/{workspace_id}/secrets-revision"

    sm = boto3.client("secretsmanager", region_name=region)
    ssm = boto3.client("ssm", region_name=region)

    # --- Producer side --------------------------------------------------
    # Replicates the two AWS writes workspace-api's _put_secret performs
    # (see lambda/workspace-api/index.py:_put_secret +
    # _bump_secrets_revision). Done with raw boto3 because importing the
    # Lambda module pulls in PEP 604 syntax that doesn't load on Python
    # 3.9; _put_secret's branching is covered by its own unit tests.
    sm.create_secret(Name=secret_name, SecretString="rotated-token-v1")
    ssm.put_parameter(
        Name=revision_name,
        Value=str(int(time.time())),
        Type="String",
        Overwrite=False,
    )

    # --- Chat-server watcher subprocess ---------------------------------
    watcher = _NodeWatcher(secrets_dir)
    try:
        watcher.wait_ready()

        # --- Sidecar pull (real production code path) -------------------
        sync = _fresh_sync_module(
            env={
                "CONFIG_DIR": str(config_dir),
                "AWS_REGION": region,
                "WORKSPACE_SECRETS_PREFIX": secrets_prefix,
                "WORKSPACE_SSM_PREFIX": ssm_prefix,
            }
        )
        sync.sync_workspace_secrets()

        # File materialized on the shared tmp dir.
        secret_path = secrets_dir / secret_basename
        assert secret_path.exists(), "sidecar didn't write the secret file"
        assert secret_path.read_text() == "rotated-token-v1"

        # Watcher debounced and fired (debounceMs=100 in the driver).
        watcher.wait_for_change(since_count=0)

        # --- Rotation -------------------------------------------------
        # Customer rotates the bot token. Producer overwrites the
        # secret and re-bumps the revision (production path).
        sm.put_secret_value(SecretId=secret_name, SecretString="rotated-token-v2")
        ssm.put_parameter(
            Name=revision_name,
            Value=str(int(time.time()) + 1),  # monotonic-ish
            Type="String",
            Overwrite=True,
        )

        first_count = watcher.change_count
        sync.sync_workspace_secrets()

        assert secret_path.read_text() == "rotated-token-v2"
        # write_if_changed should still cause an inode swap (content
        # differs), so the watcher fires again.
        watcher.wait_for_change(since_count=first_count)
    finally:
        watcher.stop()


@mock_aws
def test_unchanged_value_does_not_retrigger_watcher(tmp_path):
    """Steady-state ticks must NOT churn the chat-server. write_if_changed
    is the load-bearing primitive: it skips the atomic rename when the
    bytes haven't moved, so the watcher stays quiet between real
    rotations. If this regresses, every sidecar tick wakes the Chat SDK
    rebuild path, defeating the point of hash-gating maybeReloadChatSdk."""
    config_dir = tmp_path / "config"
    secrets_dir = config_dir / "secrets"
    secrets_dir.mkdir(parents=True)

    region = "us-east-1"
    secrets_prefix = "test-self-host"
    ssm_prefix = "/test-self-host"
    workspace_id = "ws-integ-2"
    secret_basename = "slack-bot-token"
    secret_name = f"{secrets_prefix}/{workspace_id}/{secret_basename}"

    sm = boto3.client("secretsmanager", region_name=region)
    sm.create_secret(Name=secret_name, SecretString="stable-value")

    watcher = _NodeWatcher(secrets_dir)
    try:
        watcher.wait_ready()

        sync = _fresh_sync_module(
            env={
                "CONFIG_DIR": str(config_dir),
                "AWS_REGION": region,
                "WORKSPACE_SECRETS_PREFIX": secrets_prefix,
                "WORKSPACE_SSM_PREFIX": ssm_prefix,
            }
        )
        # First sync writes the file → one change event.
        sync.sync_workspace_secrets()
        watcher.wait_for_change(since_count=0)
        first_count = watcher.change_count

        # Three more syncs with no AWS-side change. Each pulls the same
        # bytes from moto and hits write_if_changed's no-op branch.
        for _ in range(3):
            sync.sync_workspace_secrets()
            time.sleep(0.2)  # let any spurious debounce settle.

        assert watcher.change_count == first_count, (
            f"watcher fired again with no real change "
            f"(was {first_count}, now {watcher.change_count})"
        )
    finally:
        watcher.stop()

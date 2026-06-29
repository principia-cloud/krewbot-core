"""Sync job — vends per-workspace secrets, SSM params, and JWKS to /config/.

After the agent-platform API takeover the sidecar's job is intentionally
narrow: it materializes anything under the workspace secrets and SSM
prefixes (per WORKSPACE_SECRETS_PREFIX and WORKSPACE_SSM_PREFIX) into
/config/secrets/* and /config/ssm/*, plus the public Cognito JWKS into
/config/jwks.json. Members, workspace
metadata, cron job listings, and chat directory snapshots have all moved
to the Agent Platform API and are fetched on-demand by the chat-server.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from urllib.request import urlopen

import boto3

# /app is on sys.path (WORKDIR), so `import log` finds /app/log.py.
from platform_log import init_logger, log_catch

logger = init_logger("sidecar-sync")

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "5"))
JWKS_URL = os.environ.get("JWKS_URL", "")
WORKSPACE_ID = os.environ.get("WORKSPACE_ID", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
WORKSPACE_SECRETS_PREFIX = os.environ.get("WORKSPACE_SECRETS_PREFIX", "")
WORKSPACE_SSM_PREFIX = os.environ.get("WORKSPACE_SSM_PREFIX", "")

# Secrets-sync gating: avoid hammering Secrets Manager on every tick.
# `secrets-revision` is a monotonic counter (epoch seconds) that
# workspace-api stamps on every workspace-secret write. The sidecar
# reads it cheaply each tick and only does the full list_secrets +
# get_secret_value pass when:
#   - the counter has moved since the last successful full sync, OR
#   - 15 minutes have elapsed (backstop, catches missed bumps).
# Pre-existing workspaces with no revision parameter yet fall through
# to the 15-minute backstop until their first integration change.
SECRETS_REVISION_PARAM_BASENAME = "secrets-revision"
FULL_SECRETS_SYNC_BACKSTOP_SEC = 15 * 60

# boto3 clients — created lazily on first use so the module can be imported
# in tests without real AWS credentials.
_clients: dict = {}


def _client(service: str):
    if service not in _clients:
        _clients[service] = boto3.client(service, region_name=AWS_REGION)
    return _clients[service]


def atomic_write(target: Path, content: str) -> None:
    """Write to a .tmp file then rename — safe on NFSv4.1/EFS."""
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(content)
    os.replace(tmp, target)


def write_if_changed(target: Path, content: str) -> bool:
    """Atomic-write `content` to `target` only when it differs from the
    current file contents. Returns True if the file was written.

    Why this exists: in steady state the sidecar fetches the same value
    from AWS every cycle and rewrites the same bytes. Each rewrite is an
    `os.replace()` (rename(2)), which on NFSv4.1/EFS swaps the directory
    entry's inode. Reader containers cache directory-entry → inode lookups
    via the NFS attribute cache; after every rename their kernel can
    briefly resolve the path to a stale, now-unlinked inode and return
    ENOENT until the cache refreshes. Skipping the rename when content
    is unchanged eliminates that whole class of races for the common case
    while keeping atomic semantics for genuine rotations."""
    try:
        if target.read_text() == content:
            return False
    except FileNotFoundError:
        # Target doesn't exist yet — expected on first write.
        logger.debug(
            "target missing, will write fresh",
            extra={"event": "sync.compare.missing", "path": str(target), "expected": True},
        )
    except OSError as exc:
        # If the read fails for any other reason, fall through and let
        # atomic_write attempt the rename — it'll either succeed and
        # restore the file, or surface a real I/O error.
        log_catch(
            logger,
            "sync.compare.read_failed",
            exc,
            path=str(target),
        )
    atomic_write(target, content)
    return True


# ---------------------------------------------------------------------------
# Sync functions
# ---------------------------------------------------------------------------

def sync_jwks() -> None:
    if not JWKS_URL:
        logger.warning(
            "JWKS_URL not set, skipping JWKS sync",
            extra={"event": "sync.jwks.skipped"},
        )
        return
    try:
        with urlopen(JWKS_URL, timeout=10) as resp:
            jwks = resp.read().decode()
        if write_if_changed(CONFIG_DIR / "jwks.json", jwks):
            logger.info(
                "JWKS updated",
                extra={"event": "sync.jwks.updated"},
            )
    except Exception as exc:
        log_catch(logger, "sync.jwks.fetch_failed", exc, url=JWKS_URL)


# Single platform-wide SSM parameter holding cluster-wide TurnQueue +
# bg-pool tuning knobs as a JSON blob. Consumed by chat-server's
# turn-queue-config.ts at process start. Operators tune capacity by
# writing this one parameter (then force-redeploy sandbox services to
# pick it up); no CDK redeploy needed.
PLATFORM_CONFIG_SSM_NAME = os.environ.get(
    "PLATFORM_CONFIG_SSM_NAME",
    "",
)


def sync_platform_config() -> None:
    """Mirror the platform-wide turn-queue config SSM parameter (named by
    PLATFORM_CONFIG_SSM_NAME) into /config/turn-queue.json. Missing
    parameter is non-fatal: chat-server falls through to env-var /
    default fallbacks. Wire-format match is
    not enforced here; the chat-server's resolver tolerates extra fields
    and missing fields, so we just validate that the value parses as
    JSON before writing."""
    if not PLATFORM_CONFIG_SSM_NAME:
        # No platform config parameter configured — operator opted out
        # of cluster-wide tuning. chat-server uses its env-var/default
        # fallbacks.
        return
    try:
        ssm = _client("ssm")
        resp = ssm.get_parameter(Name=PLATFORM_CONFIG_SSM_NAME)
        value = resp["Parameter"]["Value"]
        try:
            json.loads(value)
        except json.JSONDecodeError as exc:
            log_catch(
                logger,
                "sync.platform_config.invalid_json",
                exc,
                paramName=PLATFORM_CONFIG_SSM_NAME,
            )
            return
        if write_if_changed(CONFIG_DIR / "turn-queue.json", value):
            logger.info(
                "platform turn-queue config updated",
                extra={"event": "sync.platform_config.updated"},
            )
    except _client("ssm").exceptions.ParameterNotFound:
        # Expected when the parameter hasn't been seeded yet — chat-server
        # uses env / defaults in that case.
        logger.debug(
            "platform turn-queue config parameter not present",
            extra={
                "event": "sync.platform_config.missing",
                "expected": True,
                "paramName": PLATFORM_CONFIG_SSM_NAME,
            },
        )
    except Exception as exc:
        log_catch(
            logger,
            "sync.platform_config.fetch_failed",
            exc,
            paramName=PLATFORM_CONFIG_SSM_NAME,
        )


def sync_workspace_secrets() -> None:
    if not WORKSPACE_SECRETS_PREFIX:
        return
    logger.info(
        "discovering workspace secrets",
        extra={"event": "sync.secrets.discover", "prefix": WORKSPACE_SECRETS_PREFIX},
    )
    try:
        sm = _client("secretsmanager")
        paginator = sm.get_paginator("list_secrets")
        expected_basenames: set[str] = set()
        count = 0
        for page in paginator.paginate(
            Filters=[{"Key": "name", "Values": [WORKSPACE_SECRETS_PREFIX]}],
            PaginationConfig={"PageSize": 100},
        ):
            for secret in page.get("SecretList", []):
                name = secret["Name"]
                if not name.startswith(WORKSPACE_SECRETS_PREFIX):
                    logger.warning(
                        "rejecting secret with unexpected name",
                        extra={"event": "sync.secrets.unexpected_name", "secretName": name},
                    )
                    continue
                basename = name.split("/")[-1]
                expected_basenames.add(basename)
                try:
                    val = sm.get_secret_value(SecretId=name)
                    if write_if_changed(CONFIG_DIR / "secrets" / basename, val["SecretString"]):
                        count += 1
                except Exception as exc:
                    log_catch(
                        logger,
                        "sync.secrets.fetch_one_failed",
                        exc,
                        secretName=name,
                    )

        # Remove stale files (runs once, after all pages have been processed)
        secrets_dir = CONFIG_DIR / "secrets"
        if secrets_dir.exists():
            for existing in secrets_dir.iterdir():
                if existing.suffix == ".tmp" or not existing.is_file():
                    continue
                if existing.name not in expected_basenames:
                    logger.info(
                        "removing stale secret file",
                        extra={"event": "sync.secrets.stale_removed", "secretName": existing.name},
                    )
                    existing.unlink(missing_ok=True)

        if count:
            logger.info(
                "workspace secrets updated",
                extra={
                    "event": "sync.secrets.updated",
                    "changed": count,
                    "total": len(expected_basenames),
                },
            )
    except Exception as exc:
        log_catch(
            logger,
            "sync.secrets.list_failed",
            exc,
            prefix=WORKSPACE_SECRETS_PREFIX,
        )


def read_secrets_revision() -> str | None:
    """Cheap probe for the workspace's secrets-revision counter.

    Returns the current value as a string, or None if the parameter
    doesn't exist (workspace pre-dates the feature or no integration
    write has happened yet) or the read fails. Callers MUST treat None
    as "no revision-driven sync this tick" and rely on the time-based
    backstop — never as "definitely no change", because we don't know.
    """
    if not WORKSPACE_SSM_PREFIX:
        return None
    name = f"{WORKSPACE_SSM_PREFIX.rstrip('/')}/{SECRETS_REVISION_PARAM_BASENAME}"
    try:
        resp = _client("ssm").get_parameter(Name=name)
        return resp["Parameter"]["Value"]
    except _client("ssm").exceptions.ParameterNotFound:
        return None
    except Exception as exc:
        log_catch(logger, "sync.secrets_revision.read_failed", exc, paramName=name)
        return None


def sync_workspace_ssm() -> None:
    if not WORKSPACE_SSM_PREFIX:
        return
    logger.info(
        "discovering workspace SSM params",
        extra={"event": "sync.ssm.discover", "prefix": WORKSPACE_SSM_PREFIX},
    )
    try:
        paginator = _client("ssm").get_paginator("get_parameters_by_path")
        expected_basenames: set[str] = set()
        aggregate: dict = {}
        changed = 0

        for page in paginator.paginate(
            Path=WORKSPACE_SSM_PREFIX,
            Recursive=True,
            WithDecryption=True,
        ):
            for param in page.get("Parameters", []):
                name = param["Name"]
                if not name.startswith(WORKSPACE_SSM_PREFIX):
                    continue
                basename = name.split("/")[-1]
                # The secrets-revision counter is sync-control metadata,
                # not configuration. Don't materialize it onto /config/ssm.
                if basename == SECRETS_REVISION_PARAM_BASENAME:
                    continue
                value = param["Value"]
                expected_basenames.add(basename)
                if write_if_changed(CONFIG_DIR / "ssm" / basename, value):
                    changed += 1
                aggregate[basename] = value

        # Stale cleanup (runs once, after all pages have been processed)
        ssm_dir = CONFIG_DIR / "ssm"
        if ssm_dir.exists():
            for existing in ssm_dir.iterdir():
                if existing.suffix == ".tmp" or not existing.is_file():
                    continue
                if existing.name not in expected_basenames:
                    logger.info(
                        "removing stale SSM file",
                        extra={"event": "sync.ssm.stale_removed", "paramName": existing.name},
                    )
                    existing.unlink(missing_ok=True)

        # Aggregate file for dispatcher convenience
        if write_if_changed(CONFIG_DIR / "workspace-config.json", json.dumps(aggregate)):
            changed += 1
        if changed:
            logger.info(
                "workspace SSM params updated",
                extra={
                    "event": "sync.ssm.updated",
                    "changed": changed,
                    "total": len(expected_basenames),
                },
            )
    except Exception as exc:
        log_catch(
            logger,
            "sync.ssm.fetch_failed",
            exc,
            prefix=WORKSPACE_SSM_PREFIX,
        )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def sync_loop() -> None:
    """Run all sync functions in sequence, sleep, repeat.

    The secrets sync is the only expensive call (1 list_secrets +
    N get_secret_value); we gate it on the revision counter so steady-
    state ticks pay only for the cheap get_parameter probe. JWKS and
    SSM-param syncs run every tick — both are cheap (single GET against
    the JWKS URL, single get_parameters_by_path against the SSM prefix).
    """
    (CONFIG_DIR / "secrets").mkdir(parents=True, exist_ok=True)
    (CONFIG_DIR / "ssm").mkdir(parents=True, exist_ok=True)

    logger.info(
        "sync loop started",
        extra={
            "event": "sync.loop.started",
            "intervalSec": SYNC_INTERVAL,
            "fullSyncBackstopSec": FULL_SECRETS_SYNC_BACKSTOP_SEC,
        },
    )
    last_seen_revision: str | None = None
    # `None` means "never synced yet" — distinct from any monotonic-time
    # value, so the first tick always runs the full sync regardless of
    # whether the revision parameter exists. Without this, a freshly
    # started sidecar with no revision parameter would have an empty
    # /config/secrets/ until the 15-min backstop elapsed. Subsequent
    # ticks compare to a real monotonic timestamp set after each sync.
    last_full_secrets_sync_at: float | None = None
    while True:
        sync_jwks()
        sync_platform_config()

        revision = read_secrets_revision()
        now = asyncio.get_event_loop().time()
        revision_changed = revision is not None and revision != last_seen_revision
        backstop_due = (
            last_full_secrets_sync_at is None
            or now - last_full_secrets_sync_at >= FULL_SECRETS_SYNC_BACKSTOP_SEC
        )
        if revision_changed or backstop_due:
            sync_workspace_secrets()
            # Only update last_seen on success; if sync_workspace_secrets()
            # raised we'd bail before this line and retry next tick. It
            # currently swallows exceptions internally, so this is set
            # unconditionally — matching the function's "best effort each
            # tick" semantics.
            last_seen_revision = revision
            last_full_secrets_sync_at = now
            logger.debug(
                "secrets sync triggered",
                extra={
                    "event": "sync.secrets.triggered",
                    "reason": "revision_changed" if revision_changed else "backstop",
                    "revision": revision,
                },
            )

        sync_workspace_ssm()
        await asyncio.sleep(SYNC_INTERVAL)

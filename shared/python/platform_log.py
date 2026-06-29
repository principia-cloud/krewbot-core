"""
platform_log.py — Canonical structured JSON logging for every Python
artifact in the platform (Lambdas, sidecar, agent MCPs).

This is the single source of truth. It is materialized into individual
artifacts at build time:
  • Lambdas: copied into each Lambda's asset bundle by
    `pythonLambdaAsset` (see `lib/python-lambda-asset.ts`).
  • Docker images: copied into each Dockerfile's build context by the
    `deploy-{agent,sidecar}.yml` workflows before `docker build`.

Stdlib-only — no third-party dependencies — so it works in any Python
env without forcing a pip install. Schema on the wire:
    { ts, level, service, env, workspaceId?, sessionKey?, source?,
      adapterName?, threadId?, userId?, turnId?, event, msg, err?, ...extra }

Surface:
    init_logger(service, *, context=None) -> LoggerAdapter
    log_catch(logger, event, err, *, level=WARNING, **extra) -> None

`event` is a short dotted identifier ("supervisor.job.failed",
"secret.sync.failed") so CloudWatch Logs Insights' `stats count() by event`
gives a clean dashboard. `log_catch` is the "log and continue" helper —
call it at every except block so no exception goes silent.

LOG_LEVEL env gates output (default INFO). PLATFORM_ENV and WORKSPACE_ID
env vars, when set, are auto-merged into every record.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, Mapping, MutableMapping


_STDLIB_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "asctime", "taskName",
})


def _base_env_fields() -> dict[str, Any]:
    """Fields read from the process environment at logger init time."""
    fields: dict[str, Any] = {
        "env": os.environ.get("PLATFORM_ENV", "unknown"),
        "pid": os.getpid(),
    }
    workspace_id = os.environ.get("WORKSPACE_ID")
    if workspace_id:
        fields["workspaceId"] = workspace_id
    return fields


class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per record on stdout matching the platform schema."""

    def format(self, record: logging.LogRecord) -> str:
        # `datetime.strftime` (not `time.strftime`) so `%f` (microseconds)
        # is honored. logging.Formatter.formatTime delegates to
        # time.strftime which doesn't support %f portably — on glibc it
        # leaves the literal "%f" in the string; on musl (sidecar's
        # Alpine container) it returns "" for the entire formatted
        # string. Using datetime.strftime works on both.
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname.lower(),
            "service": getattr(record, "service", "unknown"),
            "msg": record.getMessage(),
        }
        # Adapter-supplied extras (workspaceId, sessionKey, event, etc.).
        for k, v in record.__dict__.items():
            if k in _STDLIB_ATTRS or k in payload or k.startswith("_"):
                continue
            payload[k] = v
        # Process-env fields — only added if not already present from adapter
        # so per-call extras can override (e.g. cron handlers can stamp a
        # different workspaceId without touching the env).
        for k, v in _base_env_fields().items():
            payload.setdefault(k, v)
        if record.exc_info:
            exc_type, exc, _ = record.exc_info
            payload["err"] = {
                "type": exc_type.__name__ if exc_type else "",
                "message": str(exc) if exc else "",
            }
        return json.dumps(payload, default=str)


class _ContextAdapter(logging.LoggerAdapter):
    """Merges adapter-level `extra` into every call's `extra`."""

    def process(
        self,
        msg: str,
        kwargs: MutableMapping[str, Any],
    ) -> tuple[str, MutableMapping[str, Any]]:
        user_extra = kwargs.get("extra") or {}
        merged = {**(self.extra or {}), **user_extra}
        kwargs["extra"] = merged
        return msg, kwargs


def init_logger(
    service: str,
    *,
    context: Mapping[str, Any] | None = None,
) -> logging.LoggerAdapter:
    """
    Configure root logging with JSON output and return a context-bound adapter.

    `service` is stamped on every record under the `service` field.
    `context` is merged into every call's `extra` — use for fields that
    are constant for the lifetime of this logger (workspaceId for a
    per-workspace MCP, sessionKey for a session-scoped sidecar job).

    Repeated calls are idempotent (handler installed once).
    """
    root = logging.getLogger()
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    root.setLevel(getattr(logging, level_name, logging.INFO))

    if not getattr(root, "_json_configured", False):
        handler = logging.StreamHandler(stream=sys.stdout)
        handler.setFormatter(_JsonFormatter())
        # Replace any default handlers so we don't double-log.
        for h in list(root.handlers):
            root.removeHandler(h)
        root.addHandler(handler)
        root._json_configured = True  # type: ignore[attr-defined]

    return _ContextAdapter(
        logging.getLogger(service),
        {"service": service, **(context or {})},
    )


def log_catch(
    logger: logging.LoggerAdapter,
    event: str,
    err: BaseException,
    *,
    level: int = logging.WARNING,
    **extra: Any,
) -> None:
    """
    Log a caught exception with the standard shape. Does not re-raise.

    Default level is WARNING so every catch block surfaces in queries.
    Pass `level=logging.INFO` or `logging.DEBUG` for expected conditions
    (pair with `expected=True` in extra).
    """
    logger.log(
        level,
        f"{event}: {err!s}",
        exc_info=err,
        extra={"event": event, **extra},
    )

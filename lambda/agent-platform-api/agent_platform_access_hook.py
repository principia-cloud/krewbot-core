"""
Agent Platform API access hook — neutral stub.

Called by index.py's `with_workspace` decorator on every endpoint, after
the workspace row is loaded. Lets the operator gate workspace-level
access (subscription status, license validity, plan-tier enforcement,
etc.) at a single chokepoint — all adapters (web chat, Telegram, Slack,
cron, etc.) hit chat-server, which calls into this API on every turn,
which runs through this hook.

Contract:
  check_access(workspace: dict) -> None
    - Return None to allow the request.
    - Raise to reject. ServiceError(402, msg) is the suggested shape
      for subscription-expired; ServiceError(403, msg) for permission
      denial. Any raised exception propagates out of the Lambda as the
      response.

Core ships this neutral stub (always allow). Overlay deployments that
need gating supply their own implementation at the same path; the
build-agent-platform-api step (in the consumer's CI) overlays it on
top of core's bundle.
"""

from typing import Any


def check_access(workspace: dict[str, Any]) -> None:
    """No-op. Override in your overlay to enforce access policy."""
    return None

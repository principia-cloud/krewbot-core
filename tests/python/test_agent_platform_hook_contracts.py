"""Pin test for the agent-platform-api access hook.

The hook at `lambda/agent-platform-api/agent_platform_access_hook.py` is
the seam an overlay uses to gate workspace-level access (subscription
checks, license enforcement). Core's `index.py:with_workspace` calls
`check_access(workspace_dict)` on every request after loading the row;
the overlay can raise to reject.

This test pins:
  - Signature: `check_access(workspace: dict) -> None`
  - Neutral behavior: returns None for any workspace dict (no gate).

If the stub ever starts raising, every consumer's self-hosted deploy
breaks silently. If the signature changes, every overlay that supplied
its own impl breaks. This test is the alarm.
"""

from __future__ import annotations

import sys
from pathlib import Path


LAMBDA_DIR = Path(__file__).resolve().parents[2] / "lambda" / "agent-platform-api"
sys.path.insert(0, str(LAMBDA_DIR))


def test_access_hook_signature_and_neutral_return():
    import agent_platform_access_hook

    # Accepts a dict, returns None.
    result = agent_platform_access_hook.check_access({"workspaceId": "ws-test"})
    assert result is None

    # No-op for any shape — even an empty dict, even an "expired" sub.
    assert agent_platform_access_hook.check_access({}) is None
    assert (
        agent_platform_access_hook.check_access(
            {"subscriptionStatus": "canceled"}
        )
        is None
    )

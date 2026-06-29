"""Workspace-create hook — neutral core stub.

`index.py:create_workspace` calls `on_create_workspace(...)` before the
default provision flow. Returning None lets core's default flow run
(write PROVISIONING row, start Step Function inline).

Operators who want to intercept (paywall, approval queue, custom
routing) overlay a real implementation on top of this stub at bundle
time. A downstream overlay does this with a build step that overlays
`lambda/workspace-api/workspace_create_hook.py` from its repo into the
Lambda asset directory.
"""

from typing import Optional


def on_create_workspace(
    *,
    req,
    caller: str,
    existing_admin_workspace: Optional[dict],
    pending_config: dict,
    raw_body: dict,
):
    """Neutral default: do not intercept. Core runs its default flow."""
    return None

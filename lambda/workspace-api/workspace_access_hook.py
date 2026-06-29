"""Workspace-access hook — neutral core stub.

`index.py:_require_workspace` calls `check_access(workspace)` after
loading the row. The neutral default is "membership is enough" — no
additional gate. Operators who need a subscription/license/quota
check overlay a real implementation.
"""


def check_access(workspace: dict) -> None:
    """Neutral default: no additional gate beyond core's
    NotFoundError-on-missing check."""
    return

"""First-user-session side-effect hook — neutral core stub.

Core's `GET /me/workspaces` calls `on_first_user_session(...)` on every
request. The neutral default does nothing — no welcome email, no
analytics. Operators overlay a real implementation if they want to
send a welcome email or fire any kind of "user-just-arrived" side
effect.
"""

from typing import Optional


def on_first_user_session(
    *,
    user_id: str,
    email: Optional[str],
    name: Optional[str],
) -> None:
    """Neutral default: no side effect."""
    return

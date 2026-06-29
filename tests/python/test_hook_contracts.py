"""Pin tests for the five workspace-api composition hooks.

The hooks at `lambda/workspace-api/{workspace_create_hook,
workspace_access_hook, user_session_hook, billing_routes,
auth_routes}.py` are the load-bearing seams between core and a
downstream overlay. Core's `index.py` imports them by name and calls into them at
specific points; an overlay overlays a real implementation
on top at bundle time.

These tests pin the SIGNATURE + RETURN CONTRACT of each stub so that:

  1. A future signature change in core (e.g. adding a `caller_locale`
     kwarg to `on_create_workspace`) immediately surfaces here as a
     TypeError, forcing the overlay to be updated in lock-step.

  2. The neutral default behavior — "do nothing, let core's default
     flow run" — is captured. If someone accidentally makes the stub
     raise or return a fake response, the failure mode for self-hosted
     operators changes silently. These tests are the alarm.

No boto3, no powertools, no monkeypatching. Imported directly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


LAMBDA_DIR = Path(__file__).resolve().parents[2] / "lambda" / "workspace-api"
sys.path.insert(0, str(LAMBDA_DIR))


def test_workspace_create_hook_signature_and_neutral_return():
    """`index.py:create_workspace` calls this with five kwargs. The
    neutral stub must accept all five and return None (no intercept)."""
    import workspace_create_hook

    fn = workspace_create_hook.on_create_workspace
    # All-kwargs call mirroring core's call site exactly.
    result = fn(
        req=None,
        caller="user-1",
        existing_admin_workspace=None,
        pending_config={},
        raw_body={},
    )
    assert result is None, (
        "Neutral stub returned non-None — that would short-circuit core's "
        "default provisioning flow. Stub must return None."
    )


def test_workspace_create_hook_signature_is_kwargs_only():
    """Positional args would break the call site (which passes only
    keyword args). Enforce kwargs-only by attempting a positional call
    and expecting TypeError."""
    import workspace_create_hook

    with pytest.raises(TypeError):
        workspace_create_hook.on_create_workspace(None, "x", None, {}, {})


def test_workspace_access_hook_signature_and_neutral_noop():
    """`_require_workspace` calls `check_access(workspace_row)`. Neutral
    stub must accept any dict-shaped row and return without raising."""
    import workspace_access_hook

    # Minimal row shape that an overlay hook would inspect — neutral stub
    # must not care what fields are present.
    workspace_access_hook.check_access(
        {"workspaceId": "ws-1", "status": "ACTIVE"}
    )
    # And with an empty dict.
    workspace_access_hook.check_access({})


def test_user_session_hook_signature_and_neutral_noop():
    """`/me/workspaces` calls this with user_id + optional email/name.
    Neutral stub must accept all three and return None without raising
    (a raise would be swallowed by core, but the SAaS overlay should not
    depend on that behavior — it can rely on the stub being a true
    no-op)."""
    import user_session_hook

    assert (
        user_session_hook.on_first_user_session(
            user_id="cognito-sub-1",
            email="user@example.test",
            name="Test User",
        )
        is None
    )
    # Email + name are optional; None must be tolerated.
    assert (
        user_session_hook.on_first_user_session(
            user_id="cognito-sub-2",
            email=None,
            name=None,
        )
        is None
    )


def test_billing_routes_register_is_noop():
    """`index.py` calls `billing_routes.register(app)` once at module
    load. Neutral stub must accept any `app` value (we pass a sentinel
    object since the resolver type is internal) and register no routes —
    so it must return without inspecting `app`."""
    import billing_routes

    sentinel = object()
    assert billing_routes.register(sentinel) is None


def test_auth_routes_register_is_noop():
    """Same contract as billing_routes."""
    import auth_routes

    sentinel = object()
    assert auth_routes.register(sentinel) is None

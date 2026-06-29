"""Pin tests for the custom-secret revision-bump path.

Background: the Agent Platform API's `_put_custom_secret` /
`delete_workspace_custom_secret` handlers used to write to Secrets
Manager without bumping the workspace's `secrets-revision` SSM
parameter. The sidecar gates its expensive secrets sync on that
revision — without the bump, custom secrets only landed on disk when
the 15-min backstop fired, which was the customer-visible "token
refresh feels broken" symptom.

These tests pin the fix:
  - `_bump_secrets_revision` performs the exact ssm.put_parameter call
    the sidecar's revision-check loop reads.
  - The POST `/workspace/custom-secrets` handler bumps after a
    successful Secrets Manager write.
  - The DELETE handler bumps after a successful delete.
  - A bump failure does NOT fail the request (best-effort logging
    only — the 15-min backstop is still a safety net).

If any of these regress, the only signal is a customer ticket weeks
later complaining about delayed propagation. That's the alarm this
test set is here to fire instead.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest


LAMBDA_DIR = Path(__file__).resolve().parents[2] / "lambda" / "agent-platform-api"


def _load_agent_platform_api(monkeypatch):
    """Fresh import of core's agent-platform-api index.py with boto3
    and powertools stubbed. Returns the module."""
    monkeypatch.setenv("WORKSPACES_TABLE", "core-workspaces")
    monkeypatch.setenv("MEMBERS_TABLE", "core-workspace-members")
    monkeypatch.setenv("CHAT_DIRECTORY_TABLE", "core-chat-directory")
    monkeypatch.setenv("AGENTS_TABLE", "core-agents")
    monkeypatch.setenv("AWS_ACCOUNT_ID", "111111111111")
    monkeypatch.setenv("WORKSPACE_SECRETS_PREFIX", "selfhost")
    monkeypatch.setenv("WORKSPACE_SSM_PREFIX", "/selfhost")
    monkeypatch.setenv("CRON_DESTINATION_PREFIX", "selfhost-cron-dest")
    monkeypatch.setenv("CRON_INVOKE_ROLE_PREFIX", "selfhost-cron-role")
    monkeypatch.setenv("CRON_RULE_PREFIX", "selfhost-cron")
    monkeypatch.setenv("LANGFUSE_PLATFORM_SECRET", "selfhost/langfuse-platform")

    import boto3

    clients: dict = {}

    def fake_client(service, *a, **kw):
        if service not in clients:
            clients[service] = MagicMock(name=f"client:{service}")
        return clients[service]

    ddb_resource = MagicMock(name="ddb_resource")
    ddb_resource.Table.side_effect = lambda name: MagicMock(name=f"table:{name}")
    monkeypatch.setattr(boto3, "client", fake_client)
    monkeypatch.setattr(boto3, "resource", lambda *a, **kw: ddb_resource)

    # Powertools is not installed in the test env; stub the surface
    # this Lambda imports.
    powertools = types.ModuleType("aws_lambda_powertools")
    powertools.Logger = lambda *a, **k: MagicMock(name="logger")
    handler_mod = types.ModuleType("aws_lambda_powertools.event_handler")

    class FakeResolver:
        def __init__(self):
            self.current_event = MagicMock(name="current_event")

        def _register(self, *_a, **_k):
            return lambda fn: fn

        get = post = put = delete = patch = _register

    handler_mod.APIGatewayHttpResolver = FakeResolver
    exc_mod = types.ModuleType("aws_lambda_powertools.event_handler.exceptions")
    for cls in (
        "BadRequestError", "NotFoundError", "UnauthorizedError",
    ):
        setattr(exc_mod, cls, type(cls, (Exception,), {}))

    class FakeServiceError(Exception):
        def __init__(self, status_code=500, msg=""):
            super().__init__(msg)
            self.status_code = status_code

    exc_mod.ServiceError = FakeServiceError

    logging_mod = types.ModuleType("aws_lambda_powertools.logging")
    logging_mod.correlation_paths = types.SimpleNamespace(API_GATEWAY_HTTP="x")

    monkeypatch.setitem(sys.modules, "aws_lambda_powertools", powertools)
    monkeypatch.setitem(sys.modules, "aws_lambda_powertools.event_handler", handler_mod)
    monkeypatch.setitem(
        sys.modules, "aws_lambda_powertools.event_handler.exceptions", exc_mod
    )
    monkeypatch.setitem(sys.modules, "aws_lambda_powertools.logging", logging_mod)

    # Stub the local `browser` and `langfuse_proxy` siblings — they import
    # heavy deps we don't need for the secrets test.
    browser_mod = types.ModuleType("browser")
    browser_mod.register_browser_routes = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "browser", browser_mod)

    langfuse_mod = types.ModuleType("langfuse_proxy")
    langfuse_mod.register_langfuse_routes = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "langfuse_proxy", langfuse_mod)

    # Hook stub.
    hook_mod = types.ModuleType("agent_platform_access_hook")
    hook_mod.check_access = lambda *_a, **_k: None
    monkeypatch.setitem(sys.modules, "agent_platform_access_hook", hook_mod)

    # Path-based load to dodge collisions: test_hook_contracts.py
    # inserts lambda/workspace-api on sys.path at top level, so a plain
    # `import index` here would find the *workspace-api* index.py first
    # depending on collection order. spec_from_file_location pins us to
    # the file we actually want.
    sys.modules.pop("index", None)
    spec = importlib.util.spec_from_file_location(
        "index", LAMBDA_DIR / "index.py"
    )
    index = importlib.util.module_from_spec(spec)
    sys.modules["index"] = index
    spec.loader.exec_module(index)
    return index


def test_bump_writes_revision_parameter_with_monotonic_value(monkeypatch):
    """The sidecar reads `{ssmPrefix}/{workspaceId}/secrets-revision`
    cheaply each tick and triggers a full secrets sync when the value
    changes. Bump writes epoch-seconds (monotonic-ish) with
    Overwrite=True so concurrent bumps can't roll the value backwards."""
    index = _load_agent_platform_api(monkeypatch)
    index._bump_secrets_revision("ws-test")

    calls = index.ssm_client.put_parameter.call_args_list
    assert len(calls) == 1, f"expected exactly one put_parameter call, got {len(calls)}"
    kwargs = calls[0].kwargs
    assert kwargs["Name"] == "/selfhost/ws-test/secrets-revision"
    assert kwargs["Type"] == "String"
    assert kwargs["Overwrite"] is True
    assert kwargs["Value"].isdigit(), (
        f"Value should be a stringified epoch-seconds int, got {kwargs['Value']!r}"
    )
    assert int(kwargs["Value"]) > 1_700_000_000  # sanity: post-2023


def test_bump_skips_when_workspace_id_missing(monkeypatch):
    """Defense in depth: an empty workspace_id should never make a
    cross-tenant ssm:PutParameter call. The helper short-circuits."""
    index = _load_agent_platform_api(monkeypatch)
    index._bump_secrets_revision("")
    assert index.ssm_client.put_parameter.call_count == 0


def test_bump_failure_is_swallowed_so_request_succeeds(monkeypatch):
    """Best-effort: if SSM is throttling or permissions drifted, the
    customer's secret write still succeeds — the sidecar's 15-min
    backstop catches the change. This mirrors workspace-api's
    `_bump_secrets_revision` semantics."""
    index = _load_agent_platform_api(monkeypatch)
    index.ssm_client.put_parameter.side_effect = RuntimeError("throttle")

    # Should not raise.
    index._bump_secrets_revision("ws-test")
    assert index.ssm_client.put_parameter.call_count == 1


def test_put_custom_secret_handler_bumps_revision_after_write(monkeypatch):
    """End-to-end at the handler boundary: POST /workspace/custom-secrets
    must call _bump_secrets_revision after the Secrets Manager write,
    or the sidecar won't notice the new secret until the 15-min
    backstop. Pin this so a refactor can't quietly drop the bump."""
    index = _load_agent_platform_api(monkeypatch)

    # Replace _put_custom_secret with a recorder; we're testing the
    # handler's responsibility to bump *after* a successful write.
    bumps: list[str] = []
    writes: list[tuple[str, str, str, str]] = []

    def fake_put(ws, name, value, display_name):
        writes.append((ws, name, value, display_name))

    def fake_bump(ws):
        bumps.append(ws)

    monkeypatch.setattr(index, "_put_custom_secret", fake_put)
    monkeypatch.setattr(index, "_bump_secrets_revision", fake_bump)

    index.app.current_event.json_body = {"name": "github-token", "value": "ghp_abc123"}
    # _workspace_id() reads from the API GW authorizer context; bypass it.
    monkeypatch.setattr(index, "_workspace_id", lambda: "ws-test")
    monkeypatch.setattr(index, "_require_workspace_access", lambda *_a, **_k: {})

    result = index.create_workspace_custom_secret()

    assert writes == [("ws-test", "github-token", "ghp_abc123", "github-token")]
    assert bumps == ["ws-test"], (
        f"handler must bump after a successful write; bumps={bumps}"
    )
    assert result["status"] == "ok"


def test_delete_custom_secret_handler_bumps_revision_after_delete(monkeypatch):
    """Same invariant on the delete side: dropping a secret has to push
    the sidecar to re-sync so the file disappears from /config/secrets/
    promptly. Otherwise an agent could keep using a credential the
    admin just revoked."""
    index = _load_agent_platform_api(monkeypatch)

    bumps: list[str] = []
    monkeypatch.setattr(index, "_bump_secrets_revision", lambda ws: bumps.append(ws))
    monkeypatch.setattr(index, "_workspace_id", lambda: "ws-test")
    monkeypatch.setattr(index, "_require_workspace_access", lambda *_a, **_k: {})

    # delete_secret on the (mocked) Secrets Manager client just records
    # the call; no error.
    index.secrets_client.delete_secret.return_value = {}

    result = index.delete_workspace_custom_secret(name="github-token")

    assert bumps == ["ws-test"], (
        f"handler must bump after a successful delete; bumps={bumps}"
    )
    assert result["status"] == "deleted"

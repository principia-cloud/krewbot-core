"""End-to-end happy-path test for core's workspace-api WITHOUT a downstream overlay.

This is the self-hosted operator's reference path:
  POST /workspaces
    → workspace_create_hook returns None (neutral stub)
    → core's default flow runs
    → DDB row written (status=PROVISIONING)
    → admin member row written
    → Step Functions execution started

If any of those steps drift — e.g. someone adds an overlay-only assumption
into the default flow, or the hook signature changes — this test fails.

Uses the same `importlib`-based loader pattern overlay test suites use
for their `test_workspace_api_create.py` so an overlay's test suite and the core
suite exercise the same import shape.

No live AWS — boto3 is stubbed.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest


LAMBDA_DIR = Path(__file__).resolve().parents[2] / "lambda" / "workspace-api"


def _load_workspace_api(monkeypatch):
    """Fresh import of core's index.py + the five neutral stubs, with
    boto3 + powertools stubbed. Mirrors the overlay loader so any overlay-side
    drift shows up consistently."""
    import os

    monkeypatch.setenv("WORKSPACES_TABLE", "core-workspaces")
    monkeypatch.setenv("MEMBERS_TABLE", "core-workspace-members")
    monkeypatch.setenv("AGENTS_TABLE", "core-agents")
    monkeypatch.setenv("WORKSPACE_SECRETS_PREFIX", "selfhost")
    monkeypatch.setenv("WORKSPACE_SSM_PREFIX", "/selfhost")
    monkeypatch.setenv("CRON_RULE_PREFIX", "selfhost-cron")
    monkeypatch.setenv(
        "PROVISION_STATE_MACHINE_ARN",
        "arn:aws:states:us-east-1:0:stateMachine:Provision",
    )
    monkeypatch.setenv(
        "DEPROVISION_STATE_MACHINE_ARN",
        "arn:aws:states:us-east-1:0:stateMachine:Deprovision",
    )
    monkeypatch.setenv("GOOGLE_OAUTH_SECRET_NAME", "selfhost/google-oauth")
    monkeypatch.setenv("MICROSOFT_OAUTH_SECRET_NAME", "selfhost/microsoft-oauth")

    # Stub boto3 clients/resources.
    import boto3

    clients: dict = {}

    def fake_client(service, *a, **kw):
        if service not in clients:
            clients[service] = MagicMock(name=f"client:{service}")
        return clients[service]

    ddb_resource = MagicMock(name="ddb_resource")
    tables: dict[str, MagicMock] = {}

    def fake_table(name):
        if name not in tables:
            t = MagicMock(name=f"table:{name}")
            t.name = name
            tables[name] = t
        return tables[name]

    ddb_resource.Table.side_effect = fake_table
    monkeypatch.setattr(boto3, "client", fake_client)
    monkeypatch.setattr(boto3, "resource", lambda *a, **kw: ddb_resource)

    # Stub powertools (so we don't need it installed in test env).
    powertools = types.ModuleType("aws_lambda_powertools")
    powertools.Logger = lambda *a, **k: MagicMock(name="logger")
    handler_mod = types.ModuleType("aws_lambda_powertools.event_handler")

    class FakeResolver:
        def __init__(self):
            self._routes: dict[str, callable] = {}
            self.current_event = MagicMock(name="current_event")

        def _register(self, method, path):
            def deco(fn):
                self._routes[f"{method} {path}"] = fn
                return fn

            return deco

        def get(self, path):
            return self._register("GET", path)

        def post(self, path):
            return self._register("POST", path)

        def put(self, path):
            return self._register("PUT", path)

        def delete(self, path):
            return self._register("DELETE", path)

        def patch(self, path):
            return self._register("PATCH", path)

    handler_mod.APIGatewayHttpResolver = FakeResolver
    exc_mod = types.ModuleType("aws_lambda_powertools.event_handler.exceptions")

    class FakeServiceError(Exception):
        def __init__(self, status_code=500, msg=""):
            super().__init__(msg)
            self.status_code = status_code
            self.msg = msg

    exc_mod.BadRequestError = type("BadRequestError", (Exception,), {})
    exc_mod.NotFoundError = type("NotFoundError", (Exception,), {})
    exc_mod.ServiceError = FakeServiceError

    monkeypatch.setitem(sys.modules, "aws_lambda_powertools", powertools)
    monkeypatch.setitem(
        sys.modules, "aws_lambda_powertools.event_handler", handler_mod
    )
    monkeypatch.setitem(
        sys.modules,
        "aws_lambda_powertools.event_handler.exceptions",
        exc_mod,
    )

    # Drop any prior load — these names overlap with a downstream overlay's loader
    # in shared environments.
    for mod_name in (
        "index",
        "workspace_create_hook",
        "workspace_access_hook",
        "user_session_hook",
        "billing_routes",
        "auth_routes",
    ):
        sys.modules.pop(mod_name, None)

    if str(LAMBDA_DIR) not in sys.path:
        sys.path.insert(0, str(LAMBDA_DIR))

    spec = importlib.util.spec_from_file_location(
        "index", str(LAMBDA_DIR / "index.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["index"] = module
    spec.loader.exec_module(module)
    module._test_clients = clients
    module._test_tables = tables
    return module


@pytest.fixture
def wsapi(monkeypatch):
    return _load_workspace_api(monkeypatch)


def _invoke_create(wsapi, *, caller_sub: str, body: dict):
    """Drive the create_workspace handler. The neutral resolver doesn't
    route a real event for us — instead we set up `current_event` and
    call the registered handler directly."""
    # Configure caller identity on current_event.
    auth = MagicMock()
    auth.jwt_claim = {"sub": caller_sub, "email": "user@example.test"}
    wsapi.app.current_event.request_context.authorizer = auth
    wsapi.app.current_event.json_body = body

    handler = wsapi.app._routes["POST /workspaces"]
    return handler()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_neutral_create_workspace_writes_row_and_starts_sfn(wsapi):
    """The full default flow: hook returns None → core writes the
    PROVISIONING row, writes the admin membership, and starts the
    provision Step Function."""
    workspaces = wsapi._test_tables["core-workspaces"]
    members = wsapi._test_tables["core-workspace-members"]
    sfn = wsapi._test_clients["stepfunctions"]

    # No prior admin workspace.
    members.query.return_value = {"Items": []}
    workspaces.put_item.return_value = {}
    members.put_item.return_value = {}
    sfn.start_execution.return_value = {"executionArn": "arn:fake"}

    body = {"workspaceId": "operator-1", "name": "Operator Org"}
    body_resp, status = _invoke_create(
        wsapi, caller_sub="cognito-sub-operator", body=body
    )

    assert status == 202, f"expected 202, got {status}"
    assert body_resp["workspaceId"] == "operator-1"
    assert body_resp["status"] == "PROVISIONING"

    # Row written with caller as admin + PROVISIONING.
    workspaces.put_item.assert_called_once()
    put_call = workspaces.put_item.call_args.kwargs
    item = put_call["Item"]
    assert item["workspaceId"] == "operator-1"
    assert item["adminUserId"] == "cognito-sub-operator"
    assert item["status"] == "PROVISIONING"

    # Admin membership row written.
    members.put_item.assert_called_once()
    member_item = members.put_item.call_args.kwargs["Item"]
    assert member_item["workspaceId"] == "operator-1"
    assert member_item["userId"] == "cognito-sub-operator"
    assert member_item["role"] == "admin"

    # Step Function started with the input we expect.
    sfn.start_execution.assert_called_once()
    sfn_input = json.loads(sfn.start_execution.call_args.kwargs["input"])
    assert sfn_input["workspaceId"] == "operator-1"
    assert sfn_input["workspaceName"] == "Operator Org"
    assert sfn_input["adminUserId"] == "cognito-sub-operator"


def test_neutral_create_workspace_rejects_second_admin_workspace(wsapi):
    """Default flow enforces 1 admin-workspace per caller — a downstream
    overlay overrides this via the hook (it allows multiple by handling
    Stripe checkout per-workspace). Core's stub-mode behavior is the
    strict default."""
    workspaces = wsapi._test_tables["core-workspaces"]
    members = wsapi._test_tables["core-workspace-members"]

    # Caller already admins workspace "ws-existing".
    members.query.return_value = {
        "Items": [{"workspaceId": "ws-existing", "role": "admin"}]
    }
    workspaces.get_item.return_value = {
        "Item": {"workspaceId": "ws-existing", "status": "ACTIVE"}
    }

    BadRequestError = sys.modules[
        "aws_lambda_powertools.event_handler.exceptions"
    ].BadRequestError

    with pytest.raises(BadRequestError):
        _invoke_create(
            wsapi,
            caller_sub="cognito-sub-operator",
            body={"workspaceId": "ws-second"},
        )

    # No DDB write happened.
    workspaces.put_item.assert_not_called()


def test_neutral_create_workspace_passes_pending_config_to_sfn(wsapi):
    """Tokens supplied at create time flow into the Step Function input
    (the provision Lambda picks them up and writes them to Secrets
    Manager). The neutral path doesn't stash them on the row — that's
    an overlay's paywall behavior."""
    workspaces = wsapi._test_tables["core-workspaces"]
    members = wsapi._test_tables["core-workspace-members"]
    sfn = wsapi._test_clients["stepfunctions"]
    members.query.return_value = {"Items": []}

    # Tokens must match the Pydantic patterns enforced in
    # CreateWorkspaceRequest (production-shaped values).
    telegram_token = "1234567890:" + ("A" * 35)
    admin_telegram_id = "1234567890"
    _invoke_create(
        wsapi,
        caller_sub="cognito-sub-operator",
        body={
            "workspaceId": "with-creds",
            "claudeToken": "sk-ant-oat-fake",
            "telegramBotToken": telegram_token,
            "adminTelegramId": admin_telegram_id,
        },
    )

    sfn_input = json.loads(sfn.start_execution.call_args.kwargs["input"])
    assert sfn_input["claudeToken"] == "sk-ant-oat-fake"
    assert sfn_input["telegramBotToken"] == telegram_token
    assert sfn_input["adminTelegramId"] == admin_telegram_id


# ---------------------------------------------------------------------------
# Hook integration: the neutral stubs must NOT intercept / block / mutate
# ---------------------------------------------------------------------------


def test_create_workspace_hook_does_not_intercept_in_neutral_mode(wsapi):
    """`workspace_create_hook.on_create_workspace` returning None is the
    contract that lets core's default flow run. If a future stub change
    accidentally returned a dict, the route would short-circuit and
    nothing would be provisioned. This test pins that behavior end-to-end."""
    workspaces = wsapi._test_tables["core-workspaces"]
    members = wsapi._test_tables["core-workspace-members"]
    sfn = wsapi._test_clients["stepfunctions"]
    members.query.return_value = {"Items": []}

    _invoke_create(
        wsapi,
        caller_sub="cognito-sub-operator",
        body={"workspaceId": "neutral-ws"},
    )

    # The Step Function was started — proof the hook didn't intercept.
    sfn.start_execution.assert_called_once()
    workspaces.put_item.assert_called_once()

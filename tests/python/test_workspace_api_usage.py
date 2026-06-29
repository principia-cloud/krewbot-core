"""Tests for GET /workspaces/{id}/usage on the workspace-api (web UI read-back).

Covers: membership guard, USAGE#MONTH# rollup aggregation + gateway MONTH#
block merge, disabled-table response (enabled:false), month validation.

Run: .venv/bin/python -m pytest tests/python/test_workspace_api_usage.py -q
"""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from test_workspace_api_neutral import _load_workspace_api


@pytest.fixture
def wsapi(monkeypatch):
    # Must be set BEFORE import so the module creates llm_usage_table.
    monkeypatch.setenv("LLM_USAGE_TABLE", "core-llm-usage")
    api = _load_workspace_api(monkeypatch)
    _set_caller(api, "user-1")
    # Caller is a member by default; individual tests override.
    api._test_tables["core-workspace-members"].get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "userId": "user-1", "role": "member"}
    }
    api._test_tables["core-workspaces"].get_item.return_value = {
        "Item": {"workspaceId": "testws-01"}
    }
    return api


def _set_caller(api, sub: str) -> None:
    auth = MagicMock()
    auth.jwt_claim = {"sub": sub, "email": "user@example.test"}
    api.app.current_event.request_context.authorizer = auth


def _get_usage(api, month="2026-06"):
    api.app.current_event.get_query_string_value.return_value = month
    handler = api.app._routes["GET /workspaces/<workspaceId>/usage"]
    return handler("testws-01")


def test_usage_requires_membership(wsapi):
    wsapi._test_tables["core-workspace-members"].get_item.return_value = {}
    with pytest.raises(Exception):  # ForbiddenError
        _get_usage(wsapi)


def test_usage_aggregates_rollups_and_gateway_block(wsapi):
    wsapi._test_tables["core-workspaces"].get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "llmMonthlyBudgetUsd": Decimal("25")}
    }
    usage_table = wsapi._test_tables["core-llm-usage"]
    # DDB returns every number as Decimal — the fixture must mirror that
    # so the normalization (Decimal → int/float) is actually exercised.
    usage_table.query.return_value = {
        "Items": [
            {
                "sk": "USAGE#MONTH#2026-06",
                "inputTokens": Decimal("110"), "outputTokens": Decimal("55"),
                "cacheCreationInputTokens": Decimal("1000"),
                "cacheReadInputTokens": Decimal("5000"),
                "turns": Decimal("2"), "apiCalls": Decimal("5"),
            },
            {"sk": "USAGE#MONTH#2026-06#PATH#anthropic-direct", "inputTokens": Decimal("100")},
            {"sk": "USAGE#MONTH#2026-06#MODEL#weird%23model", "inputTokens": Decimal("10")},
            {"sk": "USAGE#MONTH#2026-06#SOURCE#cron", "inputTokens": Decimal("10")},
        ]
    }
    usage_table.get_item.return_value = {
        "Item": {"sk": "MONTH#2026-06", "costUsd": Decimal("4.5"), "requests": 7}
    }

    out = _get_usage(wsapi)
    assert out["enabled"] is True
    assert out["totals"]["inputTokens"] == 110
    assert out["totals"]["cacheReadInputTokens"] == 5000
    assert out["totals"]["turns"] == 2
    assert out["byPath"]["anthropic-direct"]["inputTokens"] == 100
    # Missing counters on a rollup row default to 0.
    assert out["byPath"]["anthropic-direct"]["outputTokens"] == 0
    assert set(out["byModel"]) == {"weird#model"}
    assert out["bySource"]["cron"]["inputTokens"] == 10
    assert out["gateway"]["costUsd"] == 4.5
    assert out["gateway"]["budgetUsd"] == 25
    assert out["gateway"]["requests"] == 7
    # Decimals must be normalized to plain numbers — Powertools' default
    # encoder serializes Decimal as a STRING, which the SPA renders as 0.
    assert type(out["totals"]["inputTokens"]) is int
    assert type(out["gateway"]["costUsd"]) is float
    assert type(out["gateway"]["budgetUsd"]) is int
    # Gateway rollup read at the gateway-owned key, not a USAGE# key.
    assert usage_table.get_item.call_args.kwargs["Key"] == {
        "workspaceId": "testws-01", "sk": "MONTH#2026-06",
    }


def test_usage_zeros_for_quiet_month(wsapi):
    usage_table = wsapi._test_tables["core-llm-usage"]
    usage_table.query.return_value = {"Items": []}
    usage_table.get_item.return_value = {}

    out = _get_usage(wsapi, month="2026-01")
    assert out["month"] == "2026-01"
    assert out["totals"]["inputTokens"] == 0
    assert out["byPath"] == {}
    assert out["gateway"] == {"costUsd": 0, "budgetUsd": 0, "requests": 0}


def test_usage_disabled_when_table_unset(monkeypatch):
    monkeypatch.delenv("LLM_USAGE_TABLE", raising=False)
    api = _load_workspace_api(monkeypatch)
    _set_caller(api, "user-1")
    api._test_tables["core-workspace-members"].get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "userId": "user-1", "role": "member"}
    }
    api._test_tables["core-workspaces"].get_item.return_value = {
        "Item": {"workspaceId": "testws-01"}
    }
    out = _get_usage(api)
    assert out["enabled"] is False
    assert out["totals"]["inputTokens"] == 0


def test_usage_rejects_bad_month(wsapi):
    with pytest.raises(Exception):  # BadRequestError
        _get_usage(wsapi, month="not-a-month")

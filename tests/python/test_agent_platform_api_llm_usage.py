"""Tests for GET /llm-gateway/usage on the Agent Platform API.

Reuses the local agent-platform-api loader. The route reads the gateway's
monthly rollup item plus the workspace's configured budget and returns a
normalized summary (Decimals coerced to plain numbers).

Run: .venv/bin/python -m pytest tests/python/test_agent_platform_api_llm_usage.py -q
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from test_agent_platform_custom_secrets import _load_agent_platform_api


@pytest.fixture
def api(monkeypatch):
    # Must be set BEFORE import so the module creates llm_usage_table.
    monkeypatch.setenv("LLM_USAGE_TABLE", "core-llm-usage")
    index = _load_agent_platform_api(monkeypatch)
    index.app.current_event.raw_event = {
        "requestContext": {"authorizer": {"lambda": {"workspaceId": "testws-01"}}}
    }
    return index


def _set_month(api, month):
    api.app.current_event.get_query_string_value.return_value = month


def test_usage_returns_rollup_and_budget(api):
    api.workspaces_table.get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "llmMonthlyBudgetUsd": Decimal("25")}
    }
    api.llm_usage_table.get_item.return_value = {
        "Item": {
            "workspaceId": "testws-01", "sk": "MONTH#2026-06",
            "costUsd": Decimal("4.50"), "inputTokens": 1500,
            "outputTokens": 300, "requests": 2,
        }
    }
    _set_month(api, "2026-06")

    out = api.get_llm_usage()
    assert out["month"] == "2026-06"
    assert out["costUsd"] == 4.5
    assert out["inputTokens"] == 1500
    assert out["outputTokens"] == 300
    assert out["requests"] == 2
    assert out["budgetUsd"] == 25
    # Read the rollup at the right key.
    assert api.llm_usage_table.get_item.call_args.kwargs["Key"] == {
        "workspaceId": "testws-01", "sk": "MONTH#2026-06",
    }


def test_usage_zeros_when_no_spend_this_month(api):
    api.workspaces_table.get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "llmMonthlyBudgetUsd": Decimal("10")}
    }
    api.llm_usage_table.get_item.return_value = {}  # no rollup yet
    _set_month(api, "2026-07")

    out = api.get_llm_usage()
    assert out == {
        "month": "2026-07", "costUsd": 0, "inputTokens": 0,
        "outputTokens": 0, "requests": 0, "budgetUsd": 10,
    }


def test_usage_budget_zero_when_unset(api):
    api.workspaces_table.get_item.return_value = {"Item": {"workspaceId": "testws-01"}}
    api.llm_usage_table.get_item.return_value = {}
    _set_month(api, "2026-06")
    out = api.get_llm_usage()
    assert out["budgetUsd"] == 0

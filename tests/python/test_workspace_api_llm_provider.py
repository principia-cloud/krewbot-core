"""Tests for the per-workspace `llmProvider` write path on PATCH /workspaces.

Reuses the neutral workspace-api loader (boto3 + powertools stubbed). Verifies:
  - gateway mode persists mode/model/budget to the DDB row AND dual-writes the
    non-secret routing bits to SSM `{ssmPrefix}/{workspaceId}/llm-provider`;
  - anthropic-direct mode writes the SSM doc without a model;
  - the fail-closed validation (gateway requires model + positive budget) is
    enforced before any write.

Run: .venv/bin/python -m pytest tests/python/test_workspace_api_llm_provider.py -q
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from test_workspace_api_neutral import _load_workspace_api


@pytest.fixture
def wsapi(monkeypatch):
    mod = _load_workspace_api(monkeypatch)
    # Admin check is exercised by other suites — stub it so these tests focus
    # on the llmProvider logic.
    monkeypatch.setattr(mod, "_require_admin", lambda workspace_id: {"role": "admin"})
    return mod


def _patch(wsapi, workspace_id: str, body: dict):
    wsapi.app.current_event.json_body = body
    workspaces = wsapi._test_tables["core-workspaces"]
    workspaces.get_item.return_value = {"Item": {"workspaceId": workspace_id}}
    handler = wsapi.app._routes["PATCH /workspaces/<workspaceId>"]
    return handler(workspace_id)


def test_gateway_mode_writes_ddb_row_and_ssm(wsapi):
    workspaces = wsapi._test_tables["core-workspaces"]
    ssm = wsapi._test_clients["ssm"]

    _patch(wsapi, "testws-01", {
        "llmProvider": {
            "mode": "gateway",
            "model": "bedrock/amazon.nova-pro-v1:0",
            "smallFastModel": "bedrock/amazon.nova-micro-v1:0",
            "monthlyBudgetUsd": 25,
        }
    })

    # DDB row carries mode + model + budget (budget as Decimal).
    update_kwargs = workspaces.update_item.call_args.kwargs
    vals = update_kwargs["ExpressionAttributeValues"]
    assert vals[":lpm"] == "gateway"
    assert vals[":lpmodel"] == "bedrock/amazon.nova-pro-v1:0"
    assert vals[":lpb"] == Decimal("25")

    # SSM dual-write: routing bits only (no budget), at the workspace path.
    ssm.put_parameter.assert_called_once()
    sk = ssm.put_parameter.call_args.kwargs
    assert sk["Name"] == "/selfhost/testws-01/llm-provider"
    doc = json.loads(sk["Value"])
    assert doc == {
        "mode": "gateway",
        "model": "bedrock/amazon.nova-pro-v1:0",
        "smallFastModel": "bedrock/amazon.nova-micro-v1:0",
    }


def test_anthropic_direct_writes_ssm_without_model(wsapi):
    ssm = wsapi._test_clients["ssm"]
    _patch(wsapi, "testws-01", {"llmProvider": {"mode": "anthropic-direct"}})
    sk = ssm.put_parameter.call_args.kwargs
    assert sk["Name"] == "/selfhost/testws-01/llm-provider"
    assert json.loads(sk["Value"]) == {"mode": "anthropic-direct"}


def test_gateway_without_budget_is_rejected_before_write(wsapi):
    workspaces = wsapi._test_tables["core-workspaces"]
    ssm = wsapi._test_clients["ssm"]
    with pytest.raises(Exception):
        _patch(wsapi, "testws-01", {
            "llmProvider": {"mode": "gateway", "model": "bedrock/x"}
        })
    # Fail-closed: nothing written when validation rejects.
    workspaces.update_item.assert_not_called()
    ssm.put_parameter.assert_not_called()


def test_gateway_without_model_is_rejected(wsapi):
    with pytest.raises(Exception):
        _patch(wsapi, "testws-01", {
            "llmProvider": {"mode": "gateway", "monthlyBudgetUsd": 10}
        })

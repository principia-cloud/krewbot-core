"""Tests for the unified token-usage routes on the Agent Platform API.

POST /usage/turns — the chat-server's fire-and-forget per-turn record:
  - TURN# detail row shape (key, TTL, token fields), conditional-put gate
  - rollup ADDs for total / PATH / SOURCE / per-MODEL rows
  - duplicate turnId → recorded:false, NO rollup ADDs (idempotency)
  - model names with `#` sanitized in the SK
  - CTX# snapshot upsert (firstSeenTs preserved via if_not_exists)
  - unset usage table → 200 {recorded:false, reason:disabled}

GET /usage — monthly aggregation:
  - USAGE#MONTH# rows folded into totals/byPath/byModel/bySource
  - gateway MONTH# block + workspace budget merged in

Run: .venv/bin/python -m pytest tests/python/test_agent_platform_api_usage_turns.py -q
"""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from test_agent_platform_custom_secrets import _load_agent_platform_api


@pytest.fixture
def api(monkeypatch):
    # Must be set BEFORE import so the module creates llm_usage_table.
    monkeypatch.setenv("LLM_USAGE_TABLE", "core-llm-usage")
    index = _load_agent_platform_api(monkeypatch)
    index.app.current_event.raw_event = {
        "requestContext": {"authorizer": {"lambda": {"workspaceId": "testws-01"}}}
    }
    index.workspaces_table.get_item.return_value = {
        "Item": {"workspaceId": "testws-01"}
    }
    return index


def _set_body(api, payload: dict) -> None:
    api.app.current_event.body = json.dumps(payload)


def _turn_payload(**overrides) -> dict:
    payload = {
        "ts": "2026-06-10T14:30:00.000Z",
        "turnId": "turn-abc-123",
        "sessionKey": "telegram/123",
        "source": "telegram",
        "adapterName": "telegram",
        "path": "anthropic-direct",
        "model": "claude-opus-4-7[1m]",
        "inputTokens": 100,
        "outputTokens": 50,
        "cacheCreationInputTokens": 1000,
        "cacheReadInputTokens": 2000,
        "apiCalls": 3,
        "models": {
            "claude-opus-4-7[1m]": {
                "inputTokens": 100,
                "outputTokens": 50,
                "cacheCreationInputTokens": 1000,
                "cacheReadInputTokens": 2000,
            }
        },
    }
    payload.update(overrides)
    return payload


def _rollup_calls(api) -> dict:
    """{sk: ExpressionAttributeValues} for every update_item rollup ADD."""
    out = {}
    for call in api.llm_usage_table.update_item.call_args_list:
        sk = call.kwargs["Key"]["sk"]
        if sk.startswith("USAGE#"):
            out[sk] = call.kwargs["ExpressionAttributeValues"]
    return out


def test_post_turn_writes_detail_row_and_rollups(api):
    _set_body(api, _turn_payload())

    out = api.post_usage_turn()
    assert out == {"recorded": True}

    # TURN# detail row: conditional put, full token shape, TTL set.
    put = api.llm_usage_table.put_item.call_args.kwargs
    assert put["ConditionExpression"] == "attribute_not_exists(sk)"
    item = put["Item"]
    assert item["workspaceId"] == "testws-01"
    assert item["sk"] == "TURN#2026-06-10T14:30:00.000Z#turn-abc-123"
    assert item["inputTokens"] == 100
    assert item["cacheReadInputTokens"] == 2000
    assert item["path"] == "anthropic-direct"
    assert item["apiCalls"] == 3
    assert isinstance(item["ttl"], int) and item["ttl"] > 1_700_000_000

    # Rollups: total + PATH + SOURCE (turn-counted), per-MODEL, and the
    # per-chat SESSION tally.
    rollups = _rollup_calls(api)
    assert set(rollups) == {
        "USAGE#MONTH#2026-06",
        "USAGE#MONTH#2026-06#PATH#anthropic-direct",
        "USAGE#MONTH#2026-06#SOURCE#telegram",
        "USAGE#MONTH#2026-06#MODEL#claude-opus-4-7[1m]",
        "USAGE#SESSION#telegram/123",
    }
    total = rollups["USAGE#MONTH#2026-06"]
    assert total[":inputTokens"] == 100
    assert total[":cacheCreationInputTokens"] == 1000
    assert total[":t"] == 1 and total[":a"] == 3
    # Per-model rows count tokens only, not turns/apiCalls (a turn spanning
    # N models must not inflate the turn count N times).
    model = rollups["USAGE#MONTH#2026-06#MODEL#claude-opus-4-7[1m]"]
    assert model[":t"] == 0 and model[":a"] == 0
    assert model[":inputTokens"] == 100
    # Session tally carries a sliding TTL + lastTs alongside the ADDs.
    session_call = next(
        c
        for c in api.llm_usage_table.update_item.call_args_list
        if c.kwargs["Key"]["sk"] == "USAGE#SESSION#telegram/123"
    )
    assert "SET lastTs = :ts, #ttl = :ttl" in session_call.kwargs["UpdateExpression"]
    assert session_call.kwargs["ExpressionAttributeValues"][":ts"] == "2026-06-10T14:30:00.000Z"


def test_post_turn_duplicate_skips_rollups(api):
    api.llm_usage_table.put_item.side_effect = ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem"
    )
    _set_body(api, _turn_payload())

    out = api.post_usage_turn()
    assert out == {"recorded": False, "reason": "duplicate"}
    assert api.llm_usage_table.update_item.call_count == 0


def test_post_turn_sanitizes_model_names_in_sk(api):
    _set_body(
        api,
        _turn_payload(
            models={"weird#model": {"inputTokens": 5, "outputTokens": 1}}
        ),
    )
    api.post_usage_turn()
    assert "USAGE#MONTH#2026-06#MODEL#weird%23model" in _rollup_calls(api)


def test_post_turn_upserts_context_snapshot(api):
    _set_body(
        api,
        _turn_payload(
            context={
                "hash": "aaaa-bbbb",
                "systemPromptBytes": 400,
                "totalToolBytes": 8000,
                "toolCount": 12,
            },
            contextSnapshot={"buckets": {"mcp__chat": {"count": 2, "bytes": 5000}}},
        ),
    )
    api.post_usage_turn()

    ctx_calls = [
        c
        for c in api.llm_usage_table.update_item.call_args_list
        if c.kwargs["Key"]["sk"].startswith("CTX#")
    ]
    assert len(ctx_calls) == 1
    kwargs = ctx_calls[0].kwargs
    assert kwargs["Key"] == {"workspaceId": "testws-01", "sk": "CTX#aaaa-bbbb"}
    assert "if_not_exists(firstSeenTs" in kwargs["UpdateExpression"]
    values = kwargs["ExpressionAttributeValues"]
    assert values[":spb"] == 400
    assert values[":b"] == {"mcp__chat": {"count": 2, "bytes": 5000}}


def test_post_turn_without_snapshot_skips_ctx_row(api):
    _set_body(api, _turn_payload(context={"hash": "aaaa-bbbb"}))
    api.post_usage_turn()
    assert not [
        c
        for c in api.llm_usage_table.update_item.call_args_list
        if c.kwargs["Key"]["sk"].startswith("CTX#")
    ]


def test_post_turn_disabled_table_returns_200(api, monkeypatch):
    monkeypatch.setattr(api, "llm_usage_table", None)
    _set_body(api, _turn_payload())
    assert api.post_usage_turn() == {"recorded": False, "reason": "disabled"}


@pytest.mark.parametrize(
    "overrides",
    [
        {"turnId": "bad turn id!"},
        {"ts": "junk"},
        {"path": "freeload"},
    ],
)
def test_post_turn_rejects_bad_input(api, overrides):
    _set_body(api, _turn_payload(**overrides))
    with pytest.raises(Exception):  # BadRequestError stub
        api.post_usage_turn()
    assert api.llm_usage_table.put_item.call_count == 0


def test_post_turn_clamps_models_fanout(api):
    models = {
        f"model-{i}": {"inputTokens": 1, "outputTokens": i} for i in range(30)
    }
    _set_body(api, _turn_payload(models=models))
    api.post_usage_turn()
    model_rollups = [sk for sk in _rollup_calls(api) if "#MODEL#" in sk]
    assert len(model_rollups) == 20
    # Biggest output-token consumers kept.
    assert "USAGE#MONTH#2026-06#MODEL#model-29" in model_rollups
    assert "USAGE#MONTH#2026-06#MODEL#model-0" not in model_rollups


def test_get_usage_aggregates_rollups_and_gateway_block(api):
    api.app.current_event.get_query_string_value.return_value = "2026-06"
    api.workspaces_table.get_item.return_value = {
        "Item": {"workspaceId": "testws-01", "llmMonthlyBudgetUsd": Decimal("25")}
    }

    def _block(**kw):
        base = {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheCreationInputTokens": 0,
            "cacheReadInputTokens": 0,
            "turns": 0,
            "apiCalls": 0,
        }
        base.update(kw)
        return base

    api.llm_usage_table.query.return_value = {
        "Items": [
            {"sk": "USAGE#MONTH#2026-06", **_block(inputTokens=110, outputTokens=55, turns=2, apiCalls=5)},
            {"sk": "USAGE#MONTH#2026-06#PATH#anthropic-direct", **_block(inputTokens=100)},
            {"sk": "USAGE#MONTH#2026-06#PATH#gateway", **_block(inputTokens=10)},
            {"sk": "USAGE#MONTH#2026-06#MODEL#weird%23model", **_block(inputTokens=10)},
            {"sk": "USAGE#MONTH#2026-06#SOURCE#telegram", **_block(inputTokens=110)},
        ]
    }
    api.llm_usage_table.get_item.return_value = {
        "Item": {"sk": "MONTH#2026-06", "costUsd": Decimal("4.5"), "requests": 7}
    }

    out = api.get_usage()
    assert out["month"] == "2026-06"
    assert out["enabled"] is True
    assert out["totals"]["inputTokens"] == 110
    assert out["totals"]["turns"] == 2
    assert set(out["byPath"]) == {"anthropic-direct", "gateway"}
    # `%23` unsanitized back to `#` for display.
    assert set(out["byModel"]) == {"weird#model"}
    assert out["bySource"]["telegram"]["inputTokens"] == 110
    assert out["gateway"] == {"costUsd": 4.5, "budgetUsd": 25, "requests": 7}


def test_get_session_usage_returns_tally(api):
    api.app.current_event.get_query_string_value.return_value = "http/user-1/sess-9"
    api.llm_usage_table.get_item.return_value = {
        "Item": {
            "sk": "USAGE#SESSION#http/user-1/sess-9",
            "inputTokens": 100, "outputTokens": 50,
            "cacheCreationInputTokens": 1000, "cacheReadInputTokens": 2000,
            "turns": 4, "apiCalls": 9, "lastTs": "2026-06-10T14:30:00.000Z",
        }
    }
    out = api.get_session_usage()
    assert out["enabled"] is True
    assert out["sessionKey"] == "http/user-1/sess-9"
    assert out["inputTokens"] == 100
    assert out["cacheReadInputTokens"] == 2000
    assert out["turns"] == 4
    assert out["lastTs"] == "2026-06-10T14:30:00.000Z"
    assert api.llm_usage_table.get_item.call_args.kwargs["Key"] == {
        "workspaceId": "testws-01", "sk": "USAGE#SESSION#http/user-1/sess-9",
    }


def test_get_session_usage_zeros_for_fresh_chat(api):
    api.app.current_event.get_query_string_value.return_value = "http/user-1/new"
    api.llm_usage_table.get_item.return_value = {}
    out = api.get_session_usage()
    assert out["inputTokens"] == 0
    assert out["turns"] == 0
    assert "lastTs" not in out


def test_get_session_usage_requires_session_key(api):
    api.app.current_event.get_query_string_value.return_value = ""
    with pytest.raises(Exception):
        api.get_session_usage()


def test_get_usage_disabled_table(api, monkeypatch):
    monkeypatch.setattr(api, "llm_usage_table", None)
    api.app.current_event.get_query_string_value.return_value = "2026-06"
    out = api.get_usage()
    assert out["enabled"] is False
    assert out["totals"]["inputTokens"] == 0


def test_get_usage_rejects_bad_month(api):
    api.app.current_event.get_query_string_value.return_value = "junk"
    with pytest.raises(Exception):
        api.get_usage()

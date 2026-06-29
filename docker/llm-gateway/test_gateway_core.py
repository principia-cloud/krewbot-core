"""
Unit tests for gateway_core: token validation, fail-closed budget enforcement,
and usage accounting. In-memory fakes stand in for Secrets Manager and the two
DynamoDB tables so no AWS access is needed.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

import gateway_core as gc


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------

class FakeSecrets:
    def __init__(self, store):
        self.store = store  # {secret_id: value}

    def get_secret_value(self, SecretId):
        from botocore.exceptions import ClientError
        if SecretId not in self.store:
            raise ClientError(
                {"Error": {"Code": "ResourceNotFoundException"}}, "GetSecretValue"
            )
        return {"SecretString": self.store[SecretId]}


class FakeTable:
    """Minimal DynamoDB resource-Table fake supporting get_item, put_item, and
    update_item with an `ADD` expression (the only one record_usage uses)."""

    def __init__(self):
        self.items = {}  # (pk, sk) -> dict

    @staticmethod
    def _key(key):
        return (key["workspaceId"], key.get("sk"))

    def get_item(self, Key):
        item = self.items.get(self._key(Key))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item):
        self.items[(Item["workspaceId"], Item.get("sk"))] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues):
        assert UpdateExpression.strip().startswith("ADD"), UpdateExpression
        k = self._key(Key)
        item = self.items.setdefault(k, {"workspaceId": Key["workspaceId"], "sk": Key.get("sk")})
        # Parse "ADD costUsd :c, inputTokens :i, ..."
        body = UpdateExpression.strip()[len("ADD"):]
        for clause in body.split(","):
            attr, placeholder = clause.split()
            inc = ExpressionAttributeValues[placeholder]
            item[attr] = (item.get(attr, 0) or 0) + inc


NOW = datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _prefix(monkeypatch):
    monkeypatch.setattr(gc, "WORKSPACE_SECRETS_PREFIX", "example-sandbox")


# --------------------------------------------------------------------------
# Token validation
# --------------------------------------------------------------------------

def test_parse_workspace_id():
    assert gc.parse_workspace_id("wsk_testws-01_" + "a" * 32) == "testws-01"
    assert gc.parse_workspace_id("garbage") is None
    assert gc.parse_workspace_id("") is None
    assert gc.parse_workspace_id("wsk_testws-01_NOThex") is None


def test_validate_token_accepts_matching_key():
    token = "wsk_testws-01_" + "a" * 32
    secrets = FakeSecrets({"example-sandbox/testws-01/agent-platform-key": token})
    assert gc.validate_token(token, secrets_client=secrets) == "testws-01"


def test_validate_token_rejects_wrong_key():
    token = "wsk_testws-01_" + "a" * 32
    other = "wsk_testws-01_" + "b" * 32
    secrets = FakeSecrets({"example-sandbox/testws-01/agent-platform-key": other})
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.validate_token(token, secrets_client=secrets)
    assert ei.value.status == 401


def test_validate_token_rejects_unknown_workspace():
    token = "wsk_ghost_" + "a" * 32
    secrets = FakeSecrets({})
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.validate_token(token, secrets_client=secrets)
    assert ei.value.status == 401


def test_validate_token_rejects_malformed():
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.validate_token("Bearerish-nonsense", secrets_client=FakeSecrets({}))
    assert ei.value.status == 401


# --------------------------------------------------------------------------
# Budget enforcement (fail-closed)
# --------------------------------------------------------------------------

def _ws_table(mode="gateway", budget=None):
    t = FakeTable()
    item = {"workspaceId": "testws-01", "sk": None, "llmProviderMode": mode}
    if budget is not None:
        item["llmMonthlyBudgetUsd"] = Decimal(str(budget))
    t.items[("testws-01", None)] = item
    return t


def test_enforce_allows_under_budget():
    ws = _ws_table(budget=10)
    usage = FakeTable()
    usage.items[("testws-01", gc.month_key(NOW))] = {
        "workspaceId": "testws-01", "sk": gc.month_key(NOW), "costUsd": Decimal("4.50"),
    }
    gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)  # no raise


def test_enforce_blocks_when_at_or_over_budget():
    ws = _ws_table(budget=10)
    usage = FakeTable()
    usage.items[("testws-01", gc.month_key(NOW))] = {
        "workspaceId": "testws-01", "sk": gc.month_key(NOW), "costUsd": Decimal("10.00"),
    }
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)
    assert ei.value.status == 402


def test_enforce_fail_closed_when_no_budget():
    ws = _ws_table(budget=None)  # gateway mode but no budget set
    usage = FakeTable()
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)
    assert ei.value.status == 402


def test_enforce_fail_closed_when_zero_budget():
    ws = _ws_table(budget=0)
    usage = FakeTable()
    with pytest.raises(gc.GatewayAuthError):
        gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)


def test_enforce_blocks_non_gateway_workspace():
    ws = _ws_table(mode="anthropic-direct", budget=10)
    usage = FakeTable()
    with pytest.raises(gc.GatewayAuthError) as ei:
        gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)
    assert ei.value.status == 402


def test_enforce_allows_fresh_month_with_no_rollup():
    ws = _ws_table(budget=10)
    usage = FakeTable()  # no rollup item yet → spent 0
    gc.enforce_budget("testws-01", NOW, workspaces_table=ws, usage_table=usage)  # no raise


# --------------------------------------------------------------------------
# Usage accounting
# --------------------------------------------------------------------------

def test_record_usage_increments_rollup_and_writes_detail():
    usage = FakeTable()
    gc.record_usage(
        "testws-01", model="bedrock/amazon.nova-pro-v1:0",
        input_tokens=1000, output_tokens=200, cost_usd="0.0123",
        now=NOW, request_id="req-1", usage_table=usage,
    )
    gc.record_usage(
        "testws-01", model="bedrock/amazon.nova-pro-v1:0",
        input_tokens=500, output_tokens=100, cost_usd=Decimal("0.0077"),
        now=NOW, request_id="req-2", usage_table=usage,
    )
    rollup = usage.items[("testws-01", gc.month_key(NOW))]
    assert rollup["costUsd"] == Decimal("0.0200")
    assert rollup["inputTokens"] == 1500
    assert rollup["outputTokens"] == 300
    assert rollup["requests"] == 2
    # Two detail rows present.
    detail_keys = [k for k in usage.items if k[1].startswith("REQ#")]
    assert len(detail_keys) == 2


def test_record_usage_captures_cache_tokens():
    usage = FakeTable()
    gc.record_usage(
        "testws-01", model="bedrock/amazon.nova-pro-v1:0",
        input_tokens=1000, output_tokens=200, cost_usd="0.0123",
        now=NOW, request_id="req-1",
        cache_creation_input_tokens=4000, cache_read_input_tokens=9000,
        usage_table=usage,
    )
    rollup = usage.items[("testws-01", gc.month_key(NOW))]
    assert rollup["cacheCreationInputTokens"] == 4000
    assert rollup["cacheReadInputTokens"] == 9000
    # Budget-relevant fields unchanged by the cache counters: cost still
    # derives from input/output only, requests still count 1 per call.
    assert rollup["costUsd"] == Decimal("0.0123")
    assert rollup["requests"] == 1
    detail = usage.items[("testws-01", f"REQ#{NOW.isoformat()}#req-1")]
    assert detail["cacheCreationInputTokens"] == 4000
    assert detail["cacheReadInputTokens"] == 9000


def test_record_usage_cache_tokens_default_to_zero():
    usage = FakeTable()
    gc.record_usage(
        "testws-01", model="bedrock/amazon.nova-pro-v1:0",
        input_tokens=10, output_tokens=2, cost_usd=0,
        now=NOW, request_id="req-1", usage_table=usage,
    )
    detail = usage.items[("testws-01", f"REQ#{NOW.isoformat()}#req-1")]
    assert detail["cacheCreationInputTokens"] == 0
    assert detail["cacheReadInputTokens"] == 0


def test_month_key_format():
    assert gc.month_key(NOW) == "MONTH#2026-06"


# --------------------------------------------------------------------------
# Streamed-usage extraction (Anthropic SSE wire format)
# --------------------------------------------------------------------------

# Trimmed-down capture of an Anthropic /v1/messages SSE stream: usage lands
# incrementally — input + cache counts in message_start, cumulative
# output_tokens in message_delta events.
SSE_SAMPLE = (
    'event: message_start\n'
    'data: {"type":"message_start","message":{"id":"msg_abc123","usage":'
    '{"input_tokens":25,"cache_creation_input_tokens":1500,'
    '"cache_read_input_tokens":60000,"output_tokens":1}}}\n\n'
    'event: message_delta\n'
    'data: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'
    'event: message_delta\n'
    'data: {"type":"message_delta","usage":{"output_tokens":118}}\n\n'
)


def test_extract_stream_usage_from_sse():
    out = gc.extract_stream_usage(SSE_SAMPLE)
    assert out["input_tokens"] == 25
    assert out["output_tokens"] == 118  # max of the cumulative deltas
    assert out["cache_creation_input_tokens"] == 1500
    assert out["cache_read_input_tokens"] == 60000
    assert out["request_id"] == "msg_abc123"


def test_extract_stream_usage_empty_text():
    out = gc.extract_stream_usage("")
    assert out == {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "request_id": None,
    }


# --------------------------------------------------------------------------
# max_tokens clamping
# --------------------------------------------------------------------------

def test_clamp_max_tokens_caps_oversized():
    data = {"max_tokens": 32000, "model": "bedrock/amazon.nova-lite-v1:0"}
    out = gc.clamp_max_tokens(data, cap=8192)
    assert out["max_tokens"] == 8192


def test_clamp_max_tokens_leaves_small_untouched():
    assert gc.clamp_max_tokens({"max_tokens": 256}, cap=8192)["max_tokens"] == 256


def test_clamp_max_tokens_ignores_missing():
    assert "max_tokens" not in gc.clamp_max_tokens({}, cap=8192)


# --------------------------------------------------------------------------
# cost estimation
# --------------------------------------------------------------------------

def test_compute_cost_nova_lite():
    # 1M in @ $0.06 + 1M out @ $0.24
    assert gc.compute_cost("bedrock/amazon.nova-lite-v1:0", 1_000_000, 1_000_000) == Decimal("0.30")


def test_compute_cost_deepseek_v32():
    # us-east-1 standard: $0.62/1M in + $1.85/1M out
    assert gc.compute_cost("bedrock/deepseek.v3.2", 1_000_000, 1_000_000) == Decimal("2.47")


def test_compute_cost_kimi_k25():
    # us-east-1 standard: $0.60/1M in + $3.00/1M out
    assert gc.compute_cost("bedrock/moonshotai.kimi-k2.5", 1_000_000, 1_000_000) == Decimal("3.60")


def test_price_for_known_model():
    assert gc.price_for("bedrock/amazon.nova-micro-v1:0") == (Decimal("0.035"), Decimal("0.14"))


def test_unpriced_model_fails_closed():
    # NEVER default a price — unknown/unmapped models must raise (fail closed).
    for m in ("bedrock/meta.llama3-3-70b-instruct-v1:0", "claude-haiku-4-5-20251001", "", "gpt-4o"):
        with pytest.raises(gc.PricingError):
            gc.price_for(m)
        with pytest.raises(gc.PricingError):
            gc.compute_cost(m, 1000, 1000)

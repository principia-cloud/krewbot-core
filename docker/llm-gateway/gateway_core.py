"""
gateway_core.py — credential-isolating auth, hard-cap enforcement, and usage
accounting for the LLM gateway. Pure logic, decoupled from LiteLLM's plumbing
so it can be unit-tested directly; the LiteLLM hooks in litellm_hooks.py are
thin adapters over these functions.

Trust model: the sandbox sends its own `wsk_<workspaceId>_<hex>` workspace token
(the same scheme as the Agent Platform API). The gateway validates it against
Secrets Manager, derives the workspaceId, and uses it as the key for both the
monthly spend cap and usage attribution. Real provider credentials (AWS Bedrock)
live only in this Lambda's execution role — never in the sandbox.

Hard cap: USD, monthly calendar reset, fail-closed. A workspace with no/zero
budget is rejected. The pre-request check reads the month's running total and
rejects when it has already reached the budget (bounded overshoot from
concurrent in-flight turns is accepted — no mid-stream cutoff).
"""

import hmac
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

import boto3
from botocore.exceptions import ClientError

WORKSPACE_SECRETS_PREFIX = os.environ.get("WORKSPACE_SECRETS_PREFIX", "").strip("/")
WORKSPACES_TABLE = os.environ.get("WORKSPACES_TABLE", "")
LLM_USAGE_TABLE = os.environ.get("LLM_USAGE_TABLE", "")

# Per-call output-token ceiling. Claude Code sizes max_tokens for a large Claude
# model (>10k), but smaller Bedrock models (e.g. Amazon Nova, output limit
# 10000) hard-400 on it. Clamp down so a foreign model doesn't reject the
# request. Overridable; 8192 sits safely under the Nova limit.
DEFAULT_MAX_OUTPUT_TOKENS = int(os.environ.get("GATEWAY_MAX_OUTPUT_TOKENS", "8192"))

# Same token shape the Agent Platform API authorizer accepts.
_KEY_PATTERN = re.compile(r"^wsk_([a-zA-Z0-9_-]{1,64})_([a-f0-9]{32,128})$")

# Lazily-created clients so importing the module (e.g. in tests) doesn't require
# AWS credentials. Tests can inject fakes via the *_client / *_table params.
_secrets_client = None
_ddb_resource = None


def _region():
    # Resolve the region explicitly: some botocore versions only honor
    # AWS_DEFAULT_REGION for default-session resolution, while Lambda sets
    # AWS_REGION. Accept either so the gateway works in both Lambda and a plain
    # container without a NoRegionError.
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")


def _secrets():
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager", region_name=_region())
    return _secrets_client


def _ddb():
    global _ddb_resource
    if _ddb_resource is None:
        _ddb_resource = boto3.resource("dynamodb", region_name=_region())
    return _ddb_resource


class GatewayAuthError(Exception):
    """Raised when a request must be rejected. `status` is the HTTP code the
    gateway should return (401 unauthorized, 402 over budget)."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# Token validation (mirrors lambda/agent-platform-api/authorizer.py)
# ---------------------------------------------------------------------------

def parse_workspace_id(token: str) -> Optional[str]:
    """Return the workspaceId encoded in a `wsk_` token, or None if malformed."""
    if not token:
        return None
    m = _KEY_PATTERN.match(token.strip())
    return m.group(1) if m else None


def _resolve_workspace_key(workspace_id: str, secrets_client=None) -> Optional[str]:
    name = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/agent-platform-key"
    client = secrets_client or _secrets()
    try:
        resp = client.get_secret_value(SecretId=name)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("ResourceNotFoundException", "InvalidRequestException"):
            return None
        raise
    return resp.get("SecretString") or None


def validate_token(token: str, secrets_client=None) -> str:
    """Validate a `wsk_` token and return its workspaceId. Raises
    GatewayAuthError(401) on any failure — constant-time compared."""
    workspace_id = parse_workspace_id(token)
    if not workspace_id:
        raise GatewayAuthError("invalid or malformed workspace token", 401)
    expected = _resolve_workspace_key(workspace_id, secrets_client)
    if not expected or not hmac.compare_digest(token.strip(), expected):
        raise GatewayAuthError("workspace token not recognized", 401)
    return workspace_id


# ---------------------------------------------------------------------------
# Budget / usage
# ---------------------------------------------------------------------------

def month_key(now) -> str:
    """Calendar-month partition for the rollup counter, e.g. 'MONTH#2026-06'.
    `now` is a datetime (passed in so it's deterministic in tests)."""
    return f"MONTH#{now.strftime('%Y-%m')}"


@dataclass
class WorkspaceBudget:
    mode: str
    budget_usd: Decimal


def _read_workspace_budget(workspace_id: str, workspaces_table=None) -> WorkspaceBudget:
    table = workspaces_table or _ddb().Table(WORKSPACES_TABLE)
    item = table.get_item(Key={"workspaceId": workspace_id}).get("Item") or {}
    mode = str(item.get("llmProviderMode", "anthropic-direct"))
    budget = item.get("llmMonthlyBudgetUsd")
    budget_usd = Decimal(str(budget)) if budget is not None else Decimal(0)
    return WorkspaceBudget(mode=mode, budget_usd=budget_usd)


def _read_month_spend(workspace_id: str, mkey: str, usage_table=None) -> Decimal:
    table = usage_table or _ddb().Table(LLM_USAGE_TABLE)
    item = table.get_item(Key={"workspaceId": workspace_id, "sk": mkey}).get("Item") or {}
    spent = item.get("costUsd")
    return Decimal(str(spent)) if spent is not None else Decimal(0)


def enforce_budget(
    workspace_id: str,
    now,
    workspaces_table=None,
    usage_table=None,
) -> None:
    """Fail-closed hard-cap check. Raises GatewayAuthError(402) when the
    workspace is not in gateway mode, has no positive budget, or has already
    reached this month's budget."""
    ws = _read_workspace_budget(workspace_id, workspaces_table)
    if ws.mode != "gateway":
        raise GatewayAuthError("workspace is not enabled for gateway access", 402)
    if ws.budget_usd <= 0:
        # Fail-closed: enabling the gateway requires a positive budget.
        raise GatewayAuthError("no LLM budget configured for this workspace", 402)
    spent = _read_month_spend(workspace_id, month_key(now), usage_table)
    if spent >= ws.budget_usd:
        raise GatewayAuthError("monthly LLM budget exhausted", 402)


# Authoritative Bedrock pricing (USD per 1M tokens: input, output) for the
# us-east-1 STANDARD on-demand tier — the tier the gateway's default Converse
# calls bill at (NOT flex/priority/batch, which differ). Sourced from the AWS
# Pricing API; region-specific. Keyed by a substring of the model id.
#
# There is deliberately NO default: a model absent here is UNPRICEABLE, and an
# unpriceable model must never be served or charged a guessed price (that would
# both mis-attribute spend and bypass the budget cap). It fails closed — the
# pre-call hook rejects the request, and compute_cost raises.
BEDROCK_PRICES_PER_1M = {
    "nova-micro": (Decimal("0.035"), Decimal("0.14")),
    "nova-lite": (Decimal("0.06"), Decimal("0.24")),
    "nova-pro": (Decimal("0.80"), Decimal("3.20")),
    "deepseek.v3.2": (Decimal("0.62"), Decimal("1.85")),
    # moonshotai.kimi-k2.5 — 256k window; standard tier us-east-1.
    "kimi-k2.5": (Decimal("0.60"), Decimal("3.00")),
}


class PricingError(Exception):
    """No authoritative price for a model — fail closed (don't serve/charge)."""


def price_for(model: str):
    """Return (input_per_1M, output_per_1M) Decimals for a model, or raise
    PricingError. NEVER returns a guessed/default price."""
    m = (model or "").lower()
    for key, price in BEDROCK_PRICES_PER_1M.items():
        if key in m:
            return price
    raise PricingError(f"no authoritative price configured for model {model!r}")


def compute_cost(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    """USD cost from token counts at the authoritative price. Raises
    PricingError if the model isn't priced (caller must fail closed)."""
    pin, pout = price_for(model)
    return (
        pin * Decimal(int(input_tokens or 0)) / 1_000_000
        + pout * Decimal(int(output_tokens or 0)) / 1_000_000
    )


def clamp_max_tokens(data: dict, cap: int = None) -> dict:
    """Clamp an over-large `max_tokens` down to the gateway's per-call ceiling so
    a client that sized it for a big Claude model doesn't 400 against a smaller
    Bedrock model's output limit. Mutates and returns `data`."""
    cap = DEFAULT_MAX_OUTPUT_TOKENS if cap is None else cap
    mt = data.get("max_tokens")
    if isinstance(mt, int) and mt > cap:
        data["max_tokens"] = cap
    return data


def record_usage(
    workspace_id: str,
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd,
    now,
    request_id: str,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    usage_table=None,
) -> None:
    """Atomically add this completion's cost/tokens to the monthly rollup and
    write a per-request detail row. Cost is stored as Decimal for DDB.

    Cache token counts are additive observability attributes — the budget
    check reads only costUsd, and the cost formula deliberately excludes
    them (Bedrock prices here are flat per input/output token)."""
    table = usage_table or _ddb().Table(LLM_USAGE_TABLE)
    cost = cost_usd if isinstance(cost_usd, Decimal) else Decimal(str(cost_usd or 0))
    mkey = month_key(now)
    ts = now.isoformat()

    table.update_item(
        Key={"workspaceId": workspace_id, "sk": mkey},
        UpdateExpression=(
            "ADD costUsd :c, inputTokens :i, outputTokens :o, "
            "cacheCreationInputTokens :cc, cacheReadInputTokens :cr, requests :one"
        ),
        ExpressionAttributeValues={
            ":c": cost,
            ":i": int(input_tokens or 0),
            ":o": int(output_tokens or 0),
            ":cc": int(cache_creation_input_tokens or 0),
            ":cr": int(cache_read_input_tokens or 0),
            ":one": 1,
        },
    )
    table.put_item(
        Item={
            "workspaceId": workspace_id,
            "sk": f"REQ#{ts}#{request_id}",
            "model": model,
            "inputTokens": int(input_tokens or 0),
            "outputTokens": int(output_tokens or 0),
            "cacheCreationInputTokens": int(cache_creation_input_tokens or 0),
            "cacheReadInputTokens": int(cache_read_input_tokens or 0),
            "costUsd": cost,
            "ts": ts,
        }
    )


_STREAM_USAGE_FIELDS = (
    ("input_tokens", r'"input_tokens":\s*(\d+)'),
    ("output_tokens", r'"output_tokens":\s*(\d+)'),
    ("cache_creation_input_tokens", r'"cache_creation_input_tokens":\s*(\d+)'),
    ("cache_read_input_tokens", r'"cache_read_input_tokens":\s*(\d+)'),
)


def extract_stream_usage(text: str) -> dict:
    """Pull token counts + message id out of buffered Anthropic SSE wire text.

    The stream reports usage incrementally (input/cache counts in
    message_start, cumulative output_tokens in message_delta), so `max` of
    each field's occurrences is the final value. Returns a dict with the
    four token counts (0 when absent) and `request_id` (None when absent)."""
    out = {}
    for field, pattern in _STREAM_USAGE_FIELDS:
        values = [int(x) for x in re.findall(pattern, text or "")]
        out[field] = max(values) if values else 0
    mid = re.search(r'"id":\s*"(msg_[^"]+)"', text or "")
    out["request_id"] = mid.group(1) if mid else None
    return out

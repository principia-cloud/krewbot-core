"""
Agent Platform API — workspace-scoped operations on behalf of the agent.

Replaces the file-based control plane the sidecar used to implement (cron
CRUD via /control, chat-directory observations via /control, members /
workspace / chats / people snapshots written to /config). The chat-server
calls these endpoints over HTTPS using a per-workspace API key vended by
Secrets Manager and synced to /config/secrets/agent-platform-key by the
sidecar.

Auth is handled by `authorizer.py` (a separate API Gateway Lambda
authorizer with response caching configured in CDK). When this handler
runs, the caller's workspaceId has already been validated and is
exposed in the request context at
`requestContext.authorizer.lambda.workspaceId`.

Routes (workspaceId implicit, comes from the authorizer context):
  GET    /workspace                         workspace metadata row
  GET    /members                           workspace members
  GET    /cron/jobs                         active EventBridge cron rules
  POST   /cron/jobs                         create cron rule (sync)
  DELETE /cron/jobs/{jobName}               delete cron rule (sync)
  GET    /chats                             chat directory snapshot
  GET    /people                            people directory snapshot
  POST   /chat-directory/observations       upsert chat + person observation
  GET    /workspace/agents                  list agents (deployed+draft)
  PUT    /agents/{agentId}/metadata         mirror requiredSecrets/description to DDB (creator)
  POST   /agents/{agentId}/status           flip DDB status (called by chat-server's /deploy)
  POST   /usage/turns                       record per-turn token usage (chat-server)
  GET    /usage                             unified monthly token usage + breakdowns
  GET    /usage/turns                       paginated per-turn usage detail
  GET    /usage/session?sessionKey=...      lifetime token tally for one chat
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
from decimal import Decimal
from functools import wraps

import boto3
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayHttpResolver
from aws_lambda_powertools.event_handler.exceptions import (
    BadRequestError,
    NotFoundError,
    ServiceError,
    UnauthorizedError,
)
from boto3.dynamodb.conditions import Key

import agent_platform_access_hook


class ForbiddenError(ServiceError):
    def __init__(self, msg: str) -> None:
        super().__init__(403, msg)


logger = Logger()
app = APIGatewayHttpResolver()

ddb = boto3.resource("dynamodb")
events_client = boto3.client("events")
secrets_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm")

WORKSPACES_TABLE = os.environ["WORKSPACES_TABLE"]
MEMBERS_TABLE = os.environ["MEMBERS_TABLE"]
CHAT_DIRECTORY_TABLE = os.environ["CHAT_DIRECTORY_TABLE"]
AGENTS_TABLE = os.environ["AGENTS_TABLE"]
ACCOUNT_ID = os.environ["AWS_ACCOUNT_ID"]
WORKSPACE_SECRETS_PREFIX = os.environ["WORKSPACE_SECRETS_PREFIX"].strip("/")
WORKSPACE_SSM_PREFIX = os.environ["WORKSPACE_SSM_PREFIX"].rstrip("/")
CRON_DESTINATION_PREFIX = os.environ["CRON_DESTINATION_PREFIX"]
CRON_INVOKE_ROLE_PREFIX = os.environ["CRON_INVOKE_ROLE_PREFIX"]
CRON_RULE_PREFIX = os.environ["CRON_RULE_PREFIX"]
LANGFUSE_PLATFORM_SECRET = os.environ["LANGFUSE_PLATFORM_SECRET"]

workspaces_table = ddb.Table(WORKSPACES_TABLE)
members_table = ddb.Table(MEMBERS_TABLE)
chat_directory_table = ddb.Table(CHAT_DIRECTORY_TABLE)
agents_table = ddb.Table(AGENTS_TABLE)

# Per-workspace LLM usage table (written by the gateway, read here for the
# usage read-back route). Optional so deployments without the gateway still boot.
LLM_USAGE_TABLE = os.environ.get("LLM_USAGE_TABLE", "")
llm_usage_table = ddb.Table(LLM_USAGE_TABLE) if LLM_USAGE_TABLE else None


# ============================================================================
# Authorizer context — workspaceId comes from the API GW Lambda authorizer
# ============================================================================

def _workspace_id() -> str:
    """Read workspaceId from the API GW authorizer context.

    The authorizer Lambda returns `{isAuthorized, context: {workspaceId}}`
    and API Gateway exposes that under `requestContext.authorizer.lambda`.
    Powertools' typed model surfaces this differently across versions, so
    we read from the raw event for portability.
    """
    raw = app.current_event.raw_event or {}
    ctx = (
        raw.get("requestContext", {})
        .get("authorizer", {})
        .get("lambda", {})
    )
    ws = ctx.get("workspaceId")
    if not ws:
        # Should never happen — API Gateway rejects unauthenticated calls
        # before they reach the integration. If it does, fail loud rather
        # than silently leak data.
        raise UnauthorizedError("Missing workspaceId in authorizer context")
    return ws


def _require_workspace_access(workspace_id: str) -> dict:
    """
    Load the workspace row and run the operator's access hook against it.

    Single chokepoint for "is this workspace allowed to do anything right
    now?" — every endpoint goes through `with_workspace`, which calls this.
    Core's neutral access hook always permits; overlay deployments can
    raise to block (e.g. ServiceError(402) when a subscription has
    lapsed).

    Raises:
        NotFoundError: workspace doesn't exist.
        ServiceError (or subclass): the hook rejected the request.
    """
    item = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item")
    if not item:
        raise NotFoundError("Workspace not found")
    agent_platform_access_hook.check_access(item)
    return item


def with_workspace(fn):
    """Decorator: load + access-check workspace, then prepend workspaceId to handler args."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        workspace_id = _workspace_id()
        _require_workspace_access(workspace_id)
        return fn(workspace_id, *args, **kwargs)
    return wrapper


# ============================================================================
# Helpers
# ============================================================================

def _decimal_default(o):
    """JSON encoder hook for DDB Decimals + Python sets."""
    if isinstance(o, Decimal):
        return int(o) if o % 1 == 0 else float(o)
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f"not JSON-serializable: {type(o).__name__}")


def _strip_keys(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in ("workspaceId", "entityKey")}


def _normalize(item: dict) -> dict:
    """Strip Decimals + sets so APIGatewayHttpResolver can serialize cleanly."""
    return json.loads(json.dumps(item, default=_decimal_default))


# ============================================================================
# Cron CRUD — per-workspace EventBridge rule management
# ============================================================================

_VALID_JOB_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_VALID_SCHEDULE = re.compile(r"^(cron|rate)\(")
_VALID_ADAPTERS = {"telegram", "slack", "discord", "whatsapp", "teams", "web"}

# Cache the API destination ARN per workspace — the name is
# deterministic (`{CRON_DESTINATION_PREFIX}-{workspaceId}`) but the
# trailing CFN-generated UUID is not, so we need one
# DescribeApiDestination per workspace per warm Lambda.
_API_DESTINATION_CACHE: dict[str, str] = {}


def _cron_api_destination_arn(workspace_id: str) -> str:
    cached = _API_DESTINATION_CACHE.get(workspace_id)
    if cached:
        return cached
    name = f"{CRON_DESTINATION_PREFIX}-{workspace_id}"
    resp = events_client.describe_api_destination(Name=name)
    arn = resp["ApiDestinationArn"]
    _API_DESTINATION_CACHE[workspace_id] = arn
    return arn


def _cron_invoke_role_arn(workspace_id: str) -> str:
    # Role name is set deterministically in workspace-stack.ts.
    return f"arn:aws:iam::{ACCOUNT_ID}:role/{CRON_INVOKE_ROLE_PREFIX}-{workspace_id}"


def _rule_name(workspace_id: str, job_name: str) -> str:
    return f"{CRON_RULE_PREFIX}--{workspace_id}--{job_name}"


def _validate_target(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise BadRequestError("target must be an object")
    adapter = raw.get("adapter")
    thread_id = raw.get("threadId")
    if not isinstance(adapter, str) or adapter not in _VALID_ADAPTERS:
        raise BadRequestError(f"target.adapter invalid: {adapter!r}")
    if not isinstance(thread_id, str) or not thread_id:
        raise BadRequestError("target.threadId must be a non-empty string")
    return {"adapter": adapter, "threadId": thread_id}


# ============================================================================
# Routes
# ============================================================================

@app.get("/workspace")
@with_workspace
def get_workspace(workspace_id: str):
    item = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item")
    if not item:
        raise NotFoundError("Workspace not found")
    return _normalize(item)


@app.get("/llm-gateway/usage")
@with_workspace
def get_llm_usage(workspace_id: str):
    """Per-workspace LLM spend + token usage for a calendar month (default: the
    current UTC month). Reads the gateway's monthly rollup item and the
    workspace's configured budget. Returns zeros when nothing has been spent."""
    from datetime import datetime, timezone as _tz

    month = (app.current_event.get_query_string_value(name="month") or
             datetime.now(_tz.utc).strftime("%Y-%m"))
    result = {
        "month": month,
        "costUsd": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "requests": 0,
        "budgetUsd": 0,
    }

    ws = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item") or {}
    if ws.get("llmMonthlyBudgetUsd") is not None:
        result["budgetUsd"] = ws["llmMonthlyBudgetUsd"]

    if llm_usage_table is not None:
        rollup = llm_usage_table.get_item(
            Key={"workspaceId": workspace_id, "sk": f"MONTH#{month}"}
        ).get("Item") or {}
        for k in ("costUsd", "inputTokens", "outputTokens", "requests"):
            if rollup.get(k) is not None:
                result[k] = rollup[k]

    return _normalize(result)


# ============================================================================
# Unified token usage — written per-turn by the chat-server, read by the
# chat-server / web UI. Lives in the same llm-usage table as the gateway's
# billing rows but in disjoint SK namespaces:
#   TURN#<ts>#<turnId>          per-turn detail (TTL-aged)
#   USAGE#MONTH#YYYY-MM[#DIM#x] monthly rollups (total + per-path/model/source)
#   CTX#<hash>                  context-composition snapshot (TTL-aged)
# Gateway-owned MONTH#/REQ# rows are never written here — budget enforcement
# stays untouched.
# ============================================================================

_VALID_MONTH = re.compile(r"^\d{4}-\d{2}$")
_VALID_TURN_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_VALID_TURN_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{8,32}$")
_USAGE_COUNTERS = (
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
)
_USAGE_TURN_TTL_DAYS = int(os.environ.get("USAGE_TURN_TTL_DAYS", "180"))
_USAGE_MAX_BODY_BYTES = 64 * 1024
_USAGE_MAX_MODELS = 20


def _sk_component(value: str) -> str:
    """Make an arbitrary string safe to embed in a `#`-delimited SK."""
    return str(value).replace("#", "%23")[:128]


def _usage_int(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, n)


def _usage_month(default_now=None) -> str:
    from datetime import datetime, timezone as _tz

    month = app.current_event.get_query_string_value(name="month") or (
        default_now or datetime.now(_tz.utc)
    ).strftime("%Y-%m")
    if not _VALID_MONTH.match(month):
        raise BadRequestError(f"invalid month: {month!r} (want YYYY-MM)")
    return month


def _zero_usage_block() -> dict:
    block = {k: 0 for k in _USAGE_COUNTERS}
    block["turns"] = 0
    block["apiCalls"] = 0
    return block


@app.post("/usage/turns")
@with_workspace
def post_usage_turn(workspace_id: str):
    """Persist one turn's token usage (chat-server fire-and-forget).

    Never errors the agent for benign conditions: an unset usage table or a
    duplicate turnId both answer 200 with `recorded: false`. The conditional
    put on the TURN row gates the rollup ADDs, so a chat-server retry after
    a timeout cannot double-count."""
    if llm_usage_table is None:
        return {"recorded": False, "reason": "disabled"}

    raw_body = app.current_event.body or ""
    if len(raw_body) > _USAGE_MAX_BODY_BYTES:
        raise BadRequestError("usage record too large")
    # parse_float=Decimal: boto3 rejects Python floats in DDB items.
    try:
        body = json.loads(raw_body, parse_float=Decimal)
    except (json.JSONDecodeError, TypeError):
        raise BadRequestError("invalid JSON body")
    if not isinstance(body, dict):
        raise BadRequestError("body must be an object")

    turn_id = body.get("turnId") or ""
    ts = body.get("ts") or ""
    if not isinstance(turn_id, str) or not _VALID_TURN_ID.match(turn_id):
        raise BadRequestError(f"invalid turnId: {turn_id!r}")
    if not isinstance(ts, str) or not _VALID_TURN_TS.match(ts):
        raise BadRequestError(f"invalid ts: {ts!r}")
    path = body.get("path")
    if path not in ("anthropic-direct", "gateway"):
        raise BadRequestError(f"invalid path: {path!r}")
    source = str(body.get("source") or "unknown")
    model = str(body.get("model") or "unknown")

    totals = {k: _usage_int(body.get(k)) for k in _USAGE_COUNTERS}
    api_calls = _usage_int(body.get("apiCalls"))

    models = body.get("models")
    if not isinstance(models, dict):
        models = {}
    # Clamp to the biggest consumers so a pathological payload can't fan out
    # into hundreds of MODEL# rollup rows.
    if len(models) > _USAGE_MAX_MODELS:
        models = dict(
            sorted(
                models.items(),
                key=lambda kv: _usage_int((kv[1] or {}).get("outputTokens")),
                reverse=True,
            )[:_USAGE_MAX_MODELS]
        )

    now = int(time.time())
    turn_item = {
        "workspaceId": workspace_id,
        "sk": f"TURN#{ts}#{turn_id}",
        "ts": ts,
        "turnId": turn_id,
        "path": path,
        "source": source,
        "model": model,
        "apiCalls": api_calls,
        "ttl": now + _USAGE_TURN_TTL_DAYS * 86400,
        **totals,
    }
    if models:
        turn_item["models"] = models
    for opt in (
        "sessionKey",
        "adapterName",
        "threadId",
        "userId",
        "subagentUsage",
        "estCostUsd",
        "error",
        "aborted",
        "context",
    ):
        if body.get(opt) is not None:
            turn_item[opt] = body[opt]

    try:
        llm_usage_table.put_item(
            Item=turn_item,
            ConditionExpression="attribute_not_exists(sk)",
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return {"recorded": False, "reason": "duplicate"}
        raise

    month = ts[:7]

    def _rollup(sk: str, counters: dict, turns: int, calls: int) -> None:
        values = {f":{k}": counters.get(k, 0) for k in _USAGE_COUNTERS}
        values[":t"] = turns
        values[":a"] = calls
        llm_usage_table.update_item(
            Key={"workspaceId": workspace_id, "sk": sk},
            UpdateExpression=(
                "ADD inputTokens :inputTokens, outputTokens :outputTokens, "
                "cacheCreationInputTokens :cacheCreationInputTokens, "
                "cacheReadInputTokens :cacheReadInputTokens, "
                "turns :t, apiCalls :a"
            ),
            ExpressionAttributeValues=values,
        )

    _rollup(f"USAGE#MONTH#{month}", totals, 1, api_calls)
    _rollup(f"USAGE#MONTH#{month}#PATH#{_sk_component(path)}", totals, 1, api_calls)
    _rollup(f"USAGE#MONTH#{month}#SOURCE#{_sk_component(source)}", totals, 1, api_calls)
    for model_name, usage in models.items():
        if not isinstance(usage, dict):
            continue
        _rollup(
            f"USAGE#MONTH#{month}#MODEL#{_sk_component(model_name)}",
            {k: _usage_int(usage.get(k)) for k in _USAGE_COUNTERS},
            0,
            0,
        )

    # Per-chat lifetime tally, keyed by sessionKey (e.g. "http/<sub>/<id>",
    # "telegram/<chat>"). Sliding TTL: an active chat keeps its tally, an
    # abandoned one ages out with the detail rows. Combined ADD+SET is one
    # atomic update.
    session_key = body.get("sessionKey")
    if isinstance(session_key, str) and session_key:
        values = {f":{k}": totals.get(k, 0) for k in _USAGE_COUNTERS}
        values[":t"] = 1
        values[":a"] = api_calls
        values[":ts"] = ts
        values[":ttl"] = now + _USAGE_TURN_TTL_DAYS * 86400
        llm_usage_table.update_item(
            Key={
                "workspaceId": workspace_id,
                "sk": f"USAGE#SESSION#{_sk_component(session_key)}",
            },
            UpdateExpression=(
                "ADD inputTokens :inputTokens, outputTokens :outputTokens, "
                "cacheCreationInputTokens :cacheCreationInputTokens, "
                "cacheReadInputTokens :cacheReadInputTokens, "
                "turns :t, apiCalls :a "
                "SET lastTs = :ts, #ttl = :ttl"
            ),
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues=values,
        )

    # Context-composition snapshot, keyed by (systemPromptHash-toolNamesHash).
    # The chat-server only sends contextSnapshot on first sighting per
    # process; the upsert keeps firstSeenTs stable across re-sightings.
    snapshot = body.get("contextSnapshot")
    context = body.get("context") or {}
    ctx_hash = context.get("hash") if isinstance(context, dict) else None
    if isinstance(snapshot, dict) and isinstance(ctx_hash, str) and ctx_hash:
        llm_usage_table.update_item(
            Key={"workspaceId": workspace_id, "sk": f"CTX#{_sk_component(ctx_hash)}"},
            UpdateExpression=(
                "SET buckets = :b, systemPromptBytes = :spb, totalToolBytes = :ttb, "
                "toolCount = :tc, lastSeenTs = :ts, #ttl = :ttl, "
                "firstSeenTs = if_not_exists(firstSeenTs, :ts)"
            ),
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={
                ":b": snapshot.get("buckets") or {},
                ":spb": _usage_int(context.get("systemPromptBytes")),
                ":ttb": _usage_int(context.get("totalToolBytes")),
                ":tc": _usage_int(context.get("toolCount")),
                ":ts": ts,
                ":ttl": now + _USAGE_TURN_TTL_DAYS * 86400,
            },
        )

    return {"recorded": True}


def _query_usage_month(workspace_id: str, month: str) -> dict:
    """Aggregate the USAGE#MONTH# rollup rows + gateway billing block for one
    month. Shared shape with workspace-api's GET /workspaces/{id}/usage."""
    result = {
        "month": month,
        "totals": _zero_usage_block(),
        "byPath": {},
        "byModel": {},
        "bySource": {},
        "gateway": {"costUsd": 0, "budgetUsd": 0, "requests": 0},
    }

    ws = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item") or {}
    if ws.get("llmMonthlyBudgetUsd") is not None:
        result["gateway"]["budgetUsd"] = ws["llmMonthlyBudgetUsd"]

    if llm_usage_table is None:
        result["enabled"] = False
        return result
    result["enabled"] = True

    prefix = f"USAGE#MONTH#{month}"
    resp = llm_usage_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id)
        & Key("sk").begins_with(prefix),
    )
    for item in resp.get("Items", []):
        sk = item["sk"]
        block = {k: item.get(k, 0) for k in _USAGE_COUNTERS}
        block["turns"] = item.get("turns", 0)
        block["apiCalls"] = item.get("apiCalls", 0)
        suffix = sk[len(prefix):]
        if suffix == "":
            result["totals"] = block
        elif suffix.startswith("#PATH#"):
            result["byPath"][suffix[len("#PATH#"):].replace("%23", "#")] = block
        elif suffix.startswith("#MODEL#"):
            result["byModel"][suffix[len("#MODEL#"):].replace("%23", "#")] = block
        elif suffix.startswith("#SOURCE#"):
            result["bySource"][suffix[len("#SOURCE#"):].replace("%23", "#")] = block

    gateway_rollup = llm_usage_table.get_item(
        Key={"workspaceId": workspace_id, "sk": f"MONTH#{month}"}
    ).get("Item") or {}
    for k in ("costUsd", "requests"):
        if gateway_rollup.get(k) is not None:
            result["gateway"][k] = gateway_rollup[k]

    return result


@app.get("/usage")
@with_workspace
def get_usage(workspace_id: str):
    """Unified monthly token usage: totals + per-path/model/source breakdowns
    (all LLM calls, both provider paths) plus the gateway billing block."""
    return _normalize(_query_usage_month(workspace_id, _usage_month()))


@app.get("/usage/session")
@with_workspace
def get_session_usage(workspace_id: str):
    """Lifetime token tally for one chat, by sessionKey (query param — keys
    contain slashes). Zeros when the chat has no recorded turns yet."""
    session_key = app.current_event.get_query_string_value(name="sessionKey") or ""
    if not session_key:
        raise BadRequestError("sessionKey query parameter is required")
    result = {"sessionKey": session_key, **_zero_usage_block()}
    if llm_usage_table is None:
        result["enabled"] = False
        return result
    result["enabled"] = True
    item = llm_usage_table.get_item(
        Key={
            "workspaceId": workspace_id,
            "sk": f"USAGE#SESSION#{_sk_component(session_key)}",
        }
    ).get("Item") or {}
    for k in (*_USAGE_COUNTERS, "turns", "apiCalls"):
        if item.get(k) is not None:
            result[k] = item[k]
    if item.get("lastTs"):
        result["lastTs"] = item["lastTs"]
    return _normalize(result)


@app.get("/usage/turns")
@with_workspace
def list_usage_turns(workspace_id: str):
    """Per-turn detail rows for a month, newest first. Cursor is the base64
    LastEvaluatedKey from the previous page."""
    if llm_usage_table is None:
        return {"turns": [], "enabled": False}
    month = _usage_month()
    limit = min(_usage_int(app.current_event.get_query_string_value(name="limit")) or 50, 200)
    kwargs = {
        "KeyConditionExpression": Key("workspaceId").eq(workspace_id)
        & Key("sk").begins_with(f"TURN#{month}"),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    cursor = app.current_event.get_query_string_value(name="cursor")
    if cursor:
        try:
            kwargs["ExclusiveStartKey"] = json.loads(
                base64.urlsafe_b64decode(cursor.encode()).decode()
            )
        except (ValueError, TypeError):
            raise BadRequestError("invalid cursor")
    resp = llm_usage_table.query(**kwargs)
    out = {
        "turns": [_normalize({k: v for k, v in it.items() if k != "workspaceId"})
                  for it in resp.get("Items", [])],
        "enabled": True,
    }
    lek = resp.get("LastEvaluatedKey")
    if lek:
        out["cursor"] = base64.urlsafe_b64encode(
            json.dumps(lek, default=_decimal_default).encode()
        ).decode()
    return out


@app.get("/members")
@with_workspace
def list_members(workspace_id: str):
    resp = members_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id),
    )
    members = []
    for item in resp.get("Items", []):
        row = {
            "userId": item.get("userId", ""),
            "role": item.get("role", "member"),
        }
        tg = item.get("telegramUserId")
        if tg:
            row["telegramUserId"] = str(tg)
        tg_name = item.get("telegramUsername")
        if tg_name:
            row["telegramUsername"] = tg_name
        members.append(row)
    return {"members": members}


def _read_rule_input(rule_name: str) -> dict:
    """Fetch the JSON `Input` from a rule's first target. Empty dict on
    miss / parse error — callers treat that as "no metadata"."""
    try:
        resp = events_client.list_targets_by_rule(Rule=rule_name)
    except events_client.exceptions.ResourceNotFoundException:
        return {}
    targets = resp.get("Targets", [])
    if not targets:
        return {}
    raw = targets[0].get("Input", "")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


@app.get("/cron/jobs")
@with_workspace
def list_cron_jobs(workspace_id: str):
    prefix = f"{CRON_RULE_PREFIX}--{workspace_id}--"
    resp = events_client.list_rules(NamePrefix=prefix)
    jobs = []
    for rule in resp.get("Rules", []):
        parts = rule["Name"].split("--", 2)
        job_name = parts[2] if len(parts) > 2 else rule["Name"]
        # agentId lives in the rule's target Input (we control the
        # JSON, so adding a field is free schema-wise). list_targets
        # is N+1 over rules — fine for the small N typical here. If
        # workspaces ever sprout hundreds of crons this becomes a
        # rate-limit candidate; mitigate with concurrent fetches then.
        meta = _read_rule_input(rule["Name"])
        agent_id = meta.get("agentId") if isinstance(meta.get("agentId"), str) else None
        jobs.append({
            "name": job_name,
            "schedule": rule.get("ScheduleExpression", ""),
            "message": rule.get("Description", ""),
            "enabled": rule.get("State") == "ENABLED",
            **({"agentId": agent_id} if agent_id else {}),
        })
    return {"jobs": jobs}


@app.post("/cron/jobs")
@with_workspace
def create_cron_job(workspace_id: str):
    body = app.current_event.json_body or {}
    name = body.get("name", "")
    schedule = body.get("schedule", "")
    message = body.get("message", "")
    target = _validate_target(body.get("target"))
    agent_id = body.get("agentId")
    if agent_id is not None and (not isinstance(agent_id, str) or not agent_id.strip()):
        raise BadRequestError("agentId must be a non-empty string when provided")

    if not _VALID_JOB_NAME.match(name):
        raise BadRequestError(f"Invalid job name: {name!r}")
    if not _VALID_SCHEDULE.match(schedule):
        raise BadRequestError(f"Invalid schedule: {schedule!r}")
    if not isinstance(message, str) or not message.strip():
        raise BadRequestError("message is required")

    # If an agent is named, validate it exists in this workspace so we
    # don't end up with crons pointing at deleted/unknown agents.
    if agent_id:
        existing = agents_table.get_item(
            Key={"workspaceId": workspace_id, "agentId": agent_id}
        ).get("Item")
        if not existing:
            raise BadRequestError(f"agentId {agent_id!r} not found in this workspace")

    rule_name = _rule_name(workspace_id, name)
    api_dest_arn = _cron_api_destination_arn(workspace_id)
    invoke_role_arn = _cron_invoke_role_arn(workspace_id)

    events_client.put_rule(
        Name=rule_name,
        ScheduleExpression=schedule,
        State="ENABLED",
        Description=message,
    )

    input_body: dict = {
        "jobName": name,
        "message": message,
        "workspaceId": workspace_id,
    }
    if target is not None:
        input_body["target"] = target
    if agent_id:
        input_body["agentId"] = agent_id

    events_client.put_targets(
        Rule=rule_name,
        Targets=[{
            "Id": "cron-trigger",
            "Arn": api_dest_arn,
            "RoleArn": invoke_role_arn,
            "Input": json.dumps(input_body),
            "RetryPolicy": {
                "MaximumRetryAttempts": 3,
                "MaximumEventAgeInSeconds": 3600,
            },
        }],
    )

    return {
        "status": "ok",
        "ruleName": rule_name,
        "name": name,
        **({"agentId": agent_id} if agent_id else {}),
    }


@app.delete("/cron/jobs/<jobName>")
@with_workspace
def delete_cron_job(workspace_id: str, jobName: str):
    if not _VALID_JOB_NAME.match(jobName):
        raise BadRequestError(f"Invalid job name: {jobName!r}")
    rule_name = _rule_name(workspace_id, jobName)

    try:
        events_client.remove_targets(Rule=rule_name, Ids=["cron-trigger"])
    except events_client.exceptions.ResourceNotFoundException:
        logger.info(
            "remove_targets on missing rule, continuing",
            extra={
                "event": "agent_platform.cron.remove_targets_not_found",
                "workspaceId": workspace_id,
                "ruleName": rule_name,
                "expected": True,
            },
        )
    try:
        events_client.delete_rule(Name=rule_name)
    except events_client.exceptions.ResourceNotFoundException:
        logger.info(
            "delete_rule on missing rule, returning ok",
            extra={
                "event": "agent_platform.cron.delete_rule_not_found",
                "workspaceId": workspace_id,
                "ruleName": rule_name,
                "expected": True,
            },
        )
        return {"status": "ok", "message": "rule did not exist"}

    return {"status": "ok", "name": jobName}


def _delete_rule_quiet(rule_name: str) -> bool:
    """Best-effort remove_targets + delete_rule. Returns True on real
    delete, False if the rule was already gone. Other failures
    propagate so callers can decide policy."""
    try:
        events_client.remove_targets(Rule=rule_name, Ids=["cron-trigger"])
    except events_client.exceptions.ResourceNotFoundException:
        return False
    try:
        events_client.delete_rule(Name=rule_name)
    except events_client.exceptions.ResourceNotFoundException:
        return False
    return True


@app.delete("/cron/jobs")
@with_workspace
def delete_cron_jobs_by_agent(workspace_id: str):
    """Bulk-delete every cron rule whose stored agentId matches.
    Called by the Management API agent-delete cascade so a deleted
    agent doesn't leave orphan EventBridge rules ticking forever.

    `agentId` arrives in the query string. We list rules under the
    workspace prefix, read each rule's target Input, and delete the
    matching ones."""
    agent_id = (app.current_event.get_query_string_value("agentId") or "").strip()
    if not agent_id:
        raise BadRequestError("agentId query param is required")

    prefix = f"{CRON_RULE_PREFIX}--{workspace_id}--"
    resp = events_client.list_rules(NamePrefix=prefix)
    deleted: list[str] = []
    skipped: list[str] = []
    for rule in resp.get("Rules", []):
        rule_name = rule["Name"]
        meta = _read_rule_input(rule_name)
        if meta.get("agentId") != agent_id:
            continue
        try:
            removed = _delete_rule_quiet(rule_name)
            if removed:
                parts = rule_name.split("--", 2)
                deleted.append(parts[2] if len(parts) > 2 else rule_name)
            else:
                skipped.append(rule_name)
        except Exception as err:  # noqa: BLE001
            logger.warning(
                "cron bulk-delete failed for one rule, continuing",
                extra={
                    "event": "agent_platform.cron.bulk_delete_failed",
                    "workspaceId": workspace_id,
                    "agentId": agent_id,
                    "ruleName": rule_name,
                    "err": str(err),
                },
            )
            skipped.append(rule_name)

    return {"status": "ok", "deleted": deleted, "skipped": skipped, "agentId": agent_id}


# ============================================================================
# Chat directory
# ============================================================================

def _query_directory(workspace_id: str) -> list[dict]:
    items: list[dict] = []
    response = chat_directory_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id),
    )
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = chat_directory_table.query(
            KeyConditionExpression=Key("workspaceId").eq(workspace_id),
            ExclusiveStartKey=response["LastEvaluatedKey"],
        )
        items.extend(response.get("Items", []))
    return items


@app.get("/chats")
@with_workspace
def list_chats(workspace_id: str):
    items = _query_directory(workspace_id)
    chats = [_strip_keys(i) for i in items if str(i.get("entityKey", "")).startswith("chat#")]
    return _normalize({"chats": chats})


@app.get("/people")
@with_workspace
def list_people(workspace_id: str):
    items = _query_directory(workspace_id)
    people = [_strip_keys(i) for i in items if str(i.get("entityKey", "")).startswith("person#")]
    return _normalize({"people": people})


@app.post("/chat-directory/observations")
@with_workspace
def post_observation(workspace_id: str):
    obs = app.current_event.json_body or {}
    adapter = obs.get("adapter") or ""
    thread = obs.get("thread") or {}
    author = obs.get("author") or {}
    ts = obs.get("ts") or ""

    thread_id = thread.get("threadId") or ""
    if not adapter:
        raise BadRequestError("adapter required")
    if not thread_id:
        raise BadRequestError("thread.threadId required")

    # Upsert chat — port of sidecar chat_directory.py:_upsert_chat. We
    # deliberately do NOT store any message text; the directory's purpose
    # is chat discovery (threadId/type/title/seen-times), not history.
    chat_directory_table.update_item(
        Key={"workspaceId": workspace_id, "entityKey": f"chat#{adapter}#{thread_id}"},
        UpdateExpression=(
            "SET adapter = :adapter, "
            "    threadId = :threadId, "
            "    chatId = :chatId, "
            "    #t = :type, "
            "    title = :title, "
            "    isDM = :isDM, "
            "    adapterData = :adapterData, "
            "    lastSeenAt = :ts, "
            "    firstSeenAt = if_not_exists(firstSeenAt, :ts) "
            "REMOVE lastMessage"
        ),
        ExpressionAttributeNames={"#t": "type"},
        ExpressionAttributeValues={
            ":adapter": adapter,
            ":threadId": thread_id,
            ":chatId": str(thread.get("chatId") or thread_id),
            ":type": thread.get("type") or "unknown",
            ":title": thread.get("title") or "",
            ":isDM": bool(thread.get("isDM", False)),
            ":adapterData": thread.get("adapterData") or {},
            ":ts": ts,
        },
    )

    # Upsert person — port of sidecar chat_directory.py:_upsert_person.
    user_id = author.get("userId") or ""
    if user_id:
        expr = (
            "SET adapter = :adapter, "
            "    userId = :userId, "
            "    userName = :userName, "
            "    fullName = :fullName, "
            "    isBot = :isBot, "
            "    lastSeenAt = :ts, "
            "    lastChatId = :lastChatId, "
            "    firstSeenAt = if_not_exists(firstSeenAt, :ts)"
        )
        values = {
            ":adapter": adapter,
            ":userId": user_id,
            ":userName": author.get("userName") or "",
            ":fullName": author.get("fullName") or "",
            ":isBot": bool(author.get("isBot", False)),
            ":ts": ts,
            ":lastChatId": thread_id,
        }
        # ADD requires a non-empty set; skip if we don't have a threadId.
        if thread_id:
            expr += " ADD chatsSeen :threadSet"
            values[":threadSet"] = {thread_id}
        chat_directory_table.update_item(
            Key={"workspaceId": workspace_id, "entityKey": f"person#{adapter}#{user_id}"},
            UpdateExpression=expr,
            ExpressionAttributeValues=values,
        )

    return {"status": "ok"}


# ============================================================================
# Agents
# ============================================================================
#
# Two routes, both workspace-scoped via the authorizer context:
#
#   PUT /agents/{agentId}/metadata
#     Called by the creator session after every save of
#     def/config.json, so the Management API's deploy-check endpoint
#     can read `requiredSecrets` from DDB without mounting EFS.
#
#   GET /workspace/agents
#     Called by the supervisor session at turn start to build its
#     SDK `agents` map (deployed-only).
#
# Agent secrets are NOT managed here. The spec's "agent-scoped custom
# secrets" tier was folded into the existing workspace-level custom
# secret storage ({WORKSPACE_SECRETS_PREFIX}/{ws}/custom-{name}) —
# managed by the Management API + Integrations UI, synced to
# /config/secrets/ by the sidecar. The creator reads /config/secrets/
# to discover what's available and asks the user to add anything
# missing via the UI.

_AGENT_ID_RE = re.compile(r"^agt_[0-9a-f]{10}$")

_AGENT_NAME_MAX = 128
_AGENT_DESC_MAX = 512
_AGENT_SECRET_NAME_MAX = 64
_AGENT_MAX_SECRETS = 64


def _require_agent(workspace_id: str, agent_id: str) -> dict:
    """Load an agents row scoped to this workspace. 404 if not present.

    The (workspaceId, agentId) DDB key is the workspace-scoping
    enforcement point — the handler never trusts a workspaceId from
    the request path/body."""
    if not _AGENT_ID_RE.match(agent_id):
        raise NotFoundError("Agent not found")
    item = agents_table.get_item(
        Key={"workspaceId": workspace_id, "agentId": agent_id}
    ).get("Item")
    if not item:
        raise NotFoundError("Agent not found")
    return item


@app.put("/agents/<agentId>/metadata")
@with_workspace
def put_agent_metadata(workspace_id: str, agentId: str):
    """Mirror the creator's view of `config.json.required_secrets` and
    `description` onto the DDB row. The deploy-check endpoint reads
    these without EFS access.

    Body: {"requiredSecrets": [str, ...], "description": "optional str"}
    """
    _require_agent(workspace_id, agentId)
    body = app.current_event.json_body or {}

    update_parts: list[str] = []
    values: dict = {}
    names: dict = {}

    if "requiredSecrets" in body:
        required = body.get("requiredSecrets")
        if not isinstance(required, list) or not all(isinstance(s, str) for s in required):
            raise BadRequestError("requiredSecrets must be a list of strings")
        if len(required) > _AGENT_MAX_SECRETS:
            raise BadRequestError(
                f"requiredSecrets exceeds cap of {_AGENT_MAX_SECRETS}"
            )
        for s in required:
            if not s or len(s) > _AGENT_SECRET_NAME_MAX:
                raise BadRequestError("requiredSecrets entries must be 1-64 chars")
        update_parts.append("requiredSecrets = :r")
        values[":r"] = required

    if "description" in body:
        description = body.get("description") or ""
        if not isinstance(description, str) or len(description) > _AGENT_DESC_MAX:
            raise BadRequestError(
                f"description must be a string <= {_AGENT_DESC_MAX} chars"
            )
        update_parts.append("description = :d")
        values[":d"] = description

    if not update_parts:
        raise BadRequestError("Nothing to update")

    update_parts.append("updatedAt = :u")
    # ISO-8601 UTC matches what workspace-api writes on create/update.
    from datetime import datetime, timezone as _tz
    values[":u"] = datetime.now(_tz.utc).isoformat()

    kwargs: dict = {
        "Key": {"workspaceId": workspace_id, "agentId": agentId},
        "UpdateExpression": "SET " + ", ".join(update_parts),
        "ExpressionAttributeValues": values,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    agents_table.update_item(**kwargs)

    logger.info(
        "agent metadata updated",
        extra={
            "event": "agent_platform.agent.metadata_updated",
            "workspaceId": workspace_id,
            "agentId": agentId,
            "fields": sorted(body.keys()),
        },
    )
    return {"agentId": agentId, "status": "ok"}


@app.post("/agents/<agentId>/status")
@with_workspace
def post_agent_status(workspace_id: str, agentId: str):
    """Flip the DDB status field. Called by the chat-server's /deploy
    orchestrator after it has already done the secret check + EFS
    promote — by the time this runs, the agent is "ready to be served"
    in every other dimension and we just need DDB to reflect that.

    Body: {"status": "deployed" | "draft"}

    Distinct from the Management API's `/deploy` (Cognito-authed,
    runs the secret check itself, intended for direct frontend use).
    The two coexist for now: the chat-server uses this one because it
    speaks workspace-key auth (no JWT forwarding plumbing needed),
    while the Management API path remains as the audited admin route.
    """
    _require_agent(workspace_id, agentId)
    body = app.current_event.json_body or {}
    new_status = body.get("status")
    if new_status not in ("deployed", "draft"):
        raise BadRequestError("status must be 'deployed' or 'draft'")
    from datetime import datetime, timezone as _tz
    agents_table.update_item(
        Key={"workspaceId": workspace_id, "agentId": agentId},
        UpdateExpression="SET #s = :s, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": new_status,
            ":u": datetime.now(_tz.utc).isoformat(),
        },
    )
    logger.info(
        "agent status flipped",
        extra={
            "event": "agent_platform.agent.status_flipped",
            "workspaceId": workspace_id,
            "agentId": agentId,
            "newStatus": new_status,
        },
    )
    return {"agentId": agentId, "status": new_status}


@app.get("/workspace/agents")
@with_workspace
def list_workspace_agents(workspace_id: str):
    """Return every agent in this workspace. The supervisor filters to
    status=deployed when building its SDK agents map; draft rows are
    still returned so debug tooling / future UIs can use the same
    endpoint. No tombstones — deletes are synchronous end-to-end
    (Management API → chat-server internal agent-delete → DDB delete),
    so there's no transient tombstone state to expose."""
    resp = agents_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id),
    )
    agents = [
        _strip_keys(item) | {"agentId": item.get("agentId")}
        for item in resp.get("Items", [])
    ]
    return _normalize({"agents": agents})


# ============================================================================
# Workspace custom secrets
# ============================================================================
#
# Sandbox-auth write path to the same
# {WORKSPACE_SECRETS_PREFIX}/{ws}/custom-{name} storage the Integrations
# UI manages. The creator session uses this
# when the user provides a credential mid-chat and consents to saving
# it. Values never leave via any API — the sidecar sync onto
# /config/secrets/ is the only egress path.
#
# Normalisation rules mirror the Management API's (commit 325f57f):
# lowercase ASCII letters and underscores → dashes, so human-typed names
# like "MY_GitHub_PAT" collapse to "my-github-pat". The pre-normalised
# string is preserved in the secret's Description for display.

_CUSTOM_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")
_CUSTOM_VALUE_MAX_BYTES = 8192


def _normalize_custom_name(name: str) -> str:
    return name.lower().replace("_", "-")


def _bump_secrets_revision(workspace_id: str) -> None:
    """Stamp the workspace's `secrets-revision` SSM parameter with the
    current epoch second so the sidecar's next 5s tick pulls the change
    from Secrets Manager instead of waiting for the 15-min backstop.
    Mirrors `lambda/workspace-api/index.py:_bump_secrets_revision` — the
    custom-secret path used to skip this, which manifested as
    "rotation took minutes" for any secret the creator agent set.

    Best-effort: a failed bump just delays propagation to the next
    backstop interval. Monotonic epoch-second value (Overwrite=True) so
    concurrent bumps can't race the sidecar into missing a change."""
    if not workspace_id:
        return
    name = f"{WORKSPACE_SSM_PREFIX}/{workspace_id}/secrets-revision"
    try:
        ssm_client.put_parameter(
            Name=name,
            Value=str(int(time.time())),
            Type="String",
            Overwrite=True,
        )
    except Exception:
        logger.warning(
            "failed to bump secrets-revision; sidecar will pick up at next backstop",
            extra={
                "event": "agent_platform.secrets_revision.bump_failed",
                "workspaceId": workspace_id,
            },
            exc_info=True,
        )


def _put_custom_secret(
    workspace_id: str, name: str, value: str, display_name: str
) -> None:
    """Create/overwrite/restore a Secrets Manager entry. Matches the
    shape written by the Management API's integrations endpoint — a
    JSON envelope with {value, displayName} so list_integrations can
    surface the original name without decrypting every secret.
    """
    secret_id = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/custom-{name}"
    envelope = json.dumps({"value": value, "displayName": display_name})
    from botocore.exceptions import ClientError as _ClientError
    try:
        secrets_client.create_secret(
            Name=secret_id,
            SecretString=envelope,
            Description=display_name,
        )
        return
    except _ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "ResourceExistsException":
            secrets_client.put_secret_value(SecretId=secret_id, SecretString=envelope)
            secrets_client.update_secret(SecretId=secret_id, Description=display_name)
        elif code == "InvalidRequestException" and "scheduled for deletion" in str(e):
            # Same recovery path the Management API uses — a user who
            # deletes then recreates within the 7-day window would
            # otherwise hit a dead state.
            secrets_client.restore_secret(SecretId=secret_id)
            secrets_client.put_secret_value(SecretId=secret_id, SecretString=envelope)
            secrets_client.update_secret(SecretId=secret_id, Description=display_name)
        else:
            raise


@app.post("/workspace/custom-secrets")
@with_workspace
def create_workspace_custom_secret(workspace_id: str):
    """Create or update a workspace custom secret on behalf of the user.

    Body: {"name": "human-friendly name", "value": "<string>"}

    The name is normalised to lowercase with dashes; the pre-normalised
    form is kept as the display name so the Integrations UI can show it
    back unchanged.
    """
    body = app.current_event.json_body or {}
    name = body.get("name")
    value = body.get("value")
    if not isinstance(name, str) or not _CUSTOM_NAME_RE.match(name):
        raise BadRequestError(
            "name must match [A-Za-z0-9][A-Za-z0-9_-]{0,62}"
        )
    if not isinstance(value, str) or not value:
        raise BadRequestError("value must be a non-empty string")
    if len(value.encode("utf-8")) > _CUSTOM_VALUE_MAX_BYTES:
        raise BadRequestError(
            f"value exceeds {_CUSTOM_VALUE_MAX_BYTES} bytes"
        )
    normalized = _normalize_custom_name(name)
    try:
        _put_custom_secret(workspace_id, normalized, value, name)
    except Exception:
        logger.exception(
            "failed to put custom secret",
            extra={
                "event": "agent_platform.custom_secret.put_failed",
                "workspaceId": workspace_id,
                "secretName": normalized,
            },
        )
        raise ServiceError(500, "Failed to store secret")
    _bump_secrets_revision(workspace_id)
    logger.info(
        "stored custom secret from creator",
        extra={
            "event": "agent_platform.custom_secret.stored",
            "workspaceId": workspace_id,
            "secretName": normalized,
            "displayName": name,
        },
    )
    return {"name": normalized, "displayName": name, "status": "ok"}


@app.delete("/workspace/custom-secrets/<name>")
@with_workspace
def delete_workspace_custom_secret(workspace_id: str, name: str):
    """Delete a workspace custom secret. Used rarely — most deletes
    happen through the Integrations UI. Exists so a creator can undo
    a secret it just created (typo correction)."""
    if not _CUSTOM_NAME_RE.match(name):
        raise BadRequestError("Invalid custom secret name")
    normalized = _normalize_custom_name(name)
    secret_id = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/custom-{normalized}"
    from botocore.exceptions import ClientError as _ClientError
    try:
        secrets_client.delete_secret(
            SecretId=secret_id, ForceDeleteWithoutRecovery=True
        )
    except _ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        # Treat missing-secret as success — idempotent delete matches the
        # behaviour of the Management API's DELETE /integrations/{name}.
        if code != "ResourceNotFoundException":
            logger.warning(
                "failed to delete custom secret",
                extra={
                    "event": "agent_platform.custom_secret.delete_failed",
                    "workspaceId": workspace_id,
                    "secretName": normalized,
                },
                exc_info=True,
            )
            raise ServiceError(500, "Failed to delete secret")
    _bump_secrets_revision(workspace_id)
    logger.info(
        "deleted custom secret from creator",
        extra={
            "event": "agent_platform.custom_secret.deleted",
            "workspaceId": workspace_id,
            "secretName": normalized,
        },
    )
    return {"name": normalized, "status": "deleted"}


# ============================================================================
# Browser routes (registered from browser.py to keep this file readable)
# ============================================================================

from browser import register_browser_routes
register_browser_routes(app, with_workspace, workspaces_table)


# ============================================================================
# Langfuse ingestion proxy
#
# Every agent turn sends its Langfuse spans through this route instead of
# talking to Langfuse Cloud directly. The chat-server never holds Langfuse
# credentials — it only holds its own per-workspace agent-platform-key,
# which we validate here. We then forward the batch with the real platform
# Langfuse key (read from the secret named by LANGFUSE_PLATFORM_SECRET)
# into the single shared platform-wide project.
#
# Security properties this enforces:
#   1. Agent container can't query other workspaces' traces — it has no
#      Langfuse credential at all.
#   2. Agent container can't spoof a different workspace's traces — the
#      workspaceId stamped on every event comes from the authenticated
#      agent-platform-key, not from the payload.
#   3. Read access is not exposed — this Lambda only accepts the ingest
#      path. The shared Langfuse project's UI is viewed by platform
#      admins only.
#
# Auth:
#   The Langfuse Node SDK only supports HTTP Basic auth, so we pass the
#   per-workspace agent-platform-key in the secret half of Basic auth:
#       Authorization: Basic base64("proxy:wsk_<workspaceId>_<hex>")
#   (The public half is a dummy string; only the secret is checked.) This
#   route is NOT behind the Bearer authorizer — auth happens inline below.
# ============================================================================

_KEY_PATTERN = re.compile(r"^wsk_([a-zA-Z0-9_-]{1,64})_([a-f0-9]{32,128})$")

# Module-level cache for the single shared platform Langfuse key.
# TTL is short (5 min) — plenty for our call volume while letting
# rotations propagate without a redeploy.
_LANGFUSE_PLATFORM_SECRET = LANGFUSE_PLATFORM_SECRET
_LANGFUSE_CACHE_TTL_SEC = 300
_langfuse_platform_cache: dict | None = None
_langfuse_platform_cache_at: float = 0.0

# Reject ingestion batches larger than this to cap Lambda-memory /
# egress exposure from a rogue workspace. Langfuse Cloud's own limit
# is ~3.5 MB, so 4 MB gives a little headroom for overhead.
_LANGFUSE_MAX_BODY_BYTES = 4 * 1024 * 1024

# Per-workspace cache for the `diagnosticsOptOut` boolean on the
# workspaces table. Sits in front of langfuse_ingest's DDB read so the
# hot path stays cheap; flag changes propagate within one TTL window.
_WORKSPACE_OPTOUT_CACHE_TTL_SEC = 300
_workspace_optout_cache: dict[str, tuple[bool, float]] = {}


def _extract_basic_secret() -> str | None:
    """Pull the secret half of an Authorization: Basic header."""
    headers = (app.current_event.raw_event or {}).get("headers") or {}
    raw = headers.get("authorization") or headers.get("Authorization") or ""
    if not raw.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(raw[len("basic "):].strip()).decode()
    except Exception:
        return None
    # base64 decoded form is "publicKey:secretKey"; we ignore the public half.
    _, _, secret = decoded.partition(":")
    return secret or None


# Short-TTL cache in front of the per-workspace agent-platform-key lookup
# for the (unauthenticated-until-validated) langfuse proxy. Caches both
# hits AND misses: without the negative entry, a flood of format-valid but
# nonexistent `wsk_<ws>_<hex>` keys drives one Secrets Manager
# GetSecretValue per request (cost/throttle amplification). TTL is short so
# a rotated key still takes effect quickly.  workspace_id -> (expected_key
# or None for known-absent, cached_at).
_LANGFUSE_KEY_CACHE_TTL_SEC = 60
_langfuse_key_cache: dict[str, tuple[str | None, float]] = {}


def _resolve_langfuse_workspace_key(workspace_id: str) -> str | None:
    now = time.time()
    cached = _langfuse_key_cache.get(workspace_id)
    if cached and now - cached[1] < _LANGFUSE_KEY_CACHE_TTL_SEC:
        return cached[0]
    name = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/agent-platform-key"
    try:
        value: str | None = secrets_client.get_secret_value(SecretId=name).get("SecretString") or ""
    except secrets_client.exceptions.ResourceNotFoundException:
        value = None
    _langfuse_key_cache[workspace_id] = (value, now)
    return value


def _authenticate_langfuse_proxy() -> str:
    """Return the caller's workspaceId or raise 401/403."""
    key = _extract_basic_secret()
    if not key:
        raise UnauthorizedError("Missing Basic auth credentials")
    m = _KEY_PATTERN.match(key)
    if not m:
        raise UnauthorizedError("Malformed agent-platform-key")
    workspace_id = m.group(1)
    expected = _resolve_langfuse_workspace_key(workspace_id)
    if expected is None:
        raise UnauthorizedError("Unknown workspace")
    if not hmac.compare_digest(key, expected):
        raise UnauthorizedError("Invalid agent-platform-key")
    return workspace_id


def _get_platform_langfuse_keys() -> dict:
    """Return {publicKey, secretKey, host} from the platform secret, cached."""
    global _langfuse_platform_cache, _langfuse_platform_cache_at
    now = time.time()
    if _langfuse_platform_cache is not None and now - _langfuse_platform_cache_at < _LANGFUSE_CACHE_TTL_SEC:
        return _langfuse_platform_cache
    try:
        resp = secrets_client.get_secret_value(SecretId=_LANGFUSE_PLATFORM_SECRET)
    except secrets_client.exceptions.ResourceNotFoundException:
        raise ServiceError(503, "Langfuse proxy not configured (platform secret missing)")
    try:
        data = json.loads(resp["SecretString"])
    except (KeyError, json.JSONDecodeError):
        raise ServiceError(503, "Langfuse platform secret is malformed")
    if not data.get("publicKey") or not data.get("secretKey"):
        raise ServiceError(503, "Langfuse platform secret is incomplete")
    data.setdefault("host", "https://cloud.langfuse.com")
    _langfuse_platform_cache = data
    _langfuse_platform_cache_at = now
    return data


def _get_workspace_optout(workspace_id: str) -> bool:
    """Return True iff the workspace has `diagnosticsOptOut=True` on its row.

    Fail-open: if the DDB read errors transiently, we fall back to the
    cached value (or False if none) rather than blocking telemetry. The
    cost of one window of stale-true is "telemetry briefly leaks for a
    workspace that opted out"; the cost of blocking on DDB errors is
    "all workspaces lose Langfuse traces during a DDB hiccup". The
    former is recoverable, the latter is not.
    """
    now = time.time()
    cached = _workspace_optout_cache.get(workspace_id)
    if cached and now - cached[1] < _WORKSPACE_OPTOUT_CACHE_TTL_SEC:
        return cached[0]
    try:
        item = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item")
    except Exception:
        logger.warning(
            "workspace row read failed during opt-out check",
            extra={
                "event": "langfuse_proxy.optout_lookup_failed",
                "workspaceId": workspace_id,
            },
        )
        return cached[0] if cached else False
    opt_out = bool(item.get("diagnosticsOptOut")) if item else False
    _workspace_optout_cache[workspace_id] = (opt_out, now)
    return opt_out


def _inject_workspace_id(batch: list, workspace_id: str) -> list:
    """Stamp workspaceId into every event's body.metadata before forwarding.

    We overwrite rather than fill-if-missing: the agent is untrusted for
    this field. Downstream Langfuse filters / UI groupings should always
    reflect the authenticated identity, not whatever the payload claims.
    """
    for evt in batch:
        if not isinstance(evt, dict):
            continue
        body = evt.get("body")
        if not isinstance(body, dict):
            continue
        meta = body.get("metadata")
        if not isinstance(meta, dict):
            meta = {}
            body["metadata"] = meta
        meta["workspaceId"] = workspace_id
    return batch


@app.post("/langfuse/api/public/ingestion")
def langfuse_ingest() -> dict:
    """Forward a Langfuse ingestion batch into the shared platform project.

    The Langfuse Node SDK calls this as if it were Langfuse Cloud. We
    validate the caller, stamp workspaceId, swap the credentials, and
    re-emit the request.

    Workspaces with `diagnosticsOptOut=True` on their workspaces-table
    row are short-circuited: we return an empty-success response so the
    SDK treats the batch as delivered, and nothing leaves the account.
    """
    workspace_id = _authenticate_langfuse_proxy()

    if _get_workspace_optout(workspace_id):
        logger.info(
            "langfuse ingest skipped — workspace opted out of diagnostics",
            extra={
                "event": "langfuse_proxy.opt_out_skipped",
                "workspaceId": workspace_id,
            },
        )
        # Shape mirrors Langfuse's "accepted, no per-event errors" body
        # so the SDK won't retry or surface a failure.
        return {"successes": [], "errors": []}

    # Raw body so we can enforce a byte limit before JSON parsing.
    raw = (app.current_event.body or "").encode()
    if len(raw) > _LANGFUSE_MAX_BODY_BYTES:
        logger.warning(
            "langfuse ingestion body exceeds limit",
            extra={
                "event": "langfuse_proxy.body_too_large",
                "workspaceId": workspace_id,
                "bytes": len(raw),
            },
        )
        raise BadRequestError("Payload too large")

    try:
        body = json.loads(raw.decode()) if raw else {}
    except json.JSONDecodeError:
        raise BadRequestError("Invalid JSON body")
    batch = body.get("batch")
    if not isinstance(batch, list):
        raise BadRequestError("Missing 'batch' array")

    body["batch"] = _inject_workspace_id(batch, workspace_id)

    platform = _get_platform_langfuse_keys()
    token = base64.b64encode(
        f"{platform['publicKey']}:{platform['secretKey']}".encode()
    ).decode()

    url = platform["host"].rstrip("/") + "/api/public/ingestion"
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode(),
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.status
            resp_body = resp.read().decode()
    except urllib.error.HTTPError as e:
        status = e.code
        resp_body = e.read().decode() if e.fp else ""
        logger.warning(
            "langfuse upstream returned non-2xx",
            extra={
                "event": "langfuse_proxy.upstream_non_2xx",
                "workspaceId": workspace_id,
                "status": status,
                "bodySnippet": resp_body[:300],
            },
        )
    except Exception as e:
        logger.exception(
            "langfuse upstream call failed",
            extra={
                "event": "langfuse_proxy.upstream_failed",
                "workspaceId": workspace_id,
            },
        )
        raise ServiceError(502, f"Langfuse upstream error: {e}")

    logger.info(
        "langfuse ingest forwarded",
        extra={
            "event": "langfuse_proxy.forwarded",
            "workspaceId": workspace_id,
            "batchSize": len(batch),
            "upstreamStatus": status,
        },
    )

    # Propagate upstream status + body verbatim so the Langfuse SDK can
    # parse per-event success/failure exactly as it would against cloud.
    try:
        return json.loads(resp_body) if resp_body else {}
    except json.JSONDecodeError:
        return {"raw": resp_body, "status": status}


# ============================================================================
# Lambda entry
# ============================================================================

@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    return app.resolve(event, context)

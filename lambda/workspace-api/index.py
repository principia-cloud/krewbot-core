"""
Workspace API — all HTTP endpoints served by a single Lambda via
aws-lambda-powertools APIGatewayHttpResolver with Pydantic validation.

Routes:
  POST   /workspaces                            — create workspace (caller becomes admin)
  GET    /workspaces/{workspaceId}              — read workspace (member)
  PATCH  /workspaces/{workspaceId}              — update workspace settings (admin)
  DELETE /workspaces/{workspaceId}              — deprovision (admin)
  GET    /me/workspaces                         — list caller's workspaces
  POST   /workspaces/{workspaceId}/members      — add member (admin)
  DELETE /workspaces/{workspaceId}/members/{userId} — remove member (admin)
  GET    /workspaces/{workspaceId}/members      — list members (member)
  PUT    /workspaces/{workspaceId}/integrations/{name} — set integration (admin)
  DELETE /workspaces/{workspaceId}/integrations/{name} — remove integration (admin)
  POST   /workspaces/{workspaceId}/agents                     — create draft agent (admin)
  GET    /workspaces/{workspaceId}/agents                     — list agents (member)
  GET    /workspaces/{workspaceId}/agents/{agentId}           — read agent (member)
  PATCH  /workspaces/{workspaceId}/agents/{agentId}           — rename/redescribe (admin)
  DELETE /workspaces/{workspaceId}/agents/{agentId}           — tombstone (admin)
  POST   /workspaces/{workspaceId}/agents/{agentId}/deploy    — soft-block deploy check + flip (admin)

Auth: API Gateway JWT authorizer has already verified the Cognito token
before this Lambda is invoked. The caller's Cognito sub is read from
`request_context.authorizer.jwt_claims.sub`.
"""

import json
import os
import re
import secrets
from datetime import datetime, timezone
from typing import List, Literal, Optional

import boto3
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayHttpResolver
from aws_lambda_powertools.event_handler.exceptions import (
    BadRequestError,
    NotFoundError,
    ServiceError,
)

# Why a custom ForbiddenError: powertools v3.3.0 ships BadRequest/Unauthorized/
# NotFound/InternalServer helpers but NOT a 403 helper. ServiceError lets us
# raise any status code with a message.
class ForbiddenError(ServiceError):
    def __init__(self, msg: str) -> None:
        super().__init__(403, msg)


class ConflictError(ServiceError):
    def __init__(self, msg: str) -> None:
        super().__init__(409, msg)
from boto3.dynamodb.conditions import Key
from decimal import Decimal
from pydantic import BaseModel, Field, ValidationError, model_validator

logger = Logger()
app = APIGatewayHttpResolver()


def _validation_error(e: ValidationError) -> BadRequestError:
    """Build a generic 400 for a Pydantic ValidationError WITHOUT echoing
    the submitted values. `e.json()` includes the offending `input`, which
    for token fields (claudeToken, telegramBotToken, …) means a malformed
    secret could be reflected back into the response/client logs. Surface
    only the field names; full detail is logged server-side."""
    fields = sorted({".".join(str(p) for p in err.get("loc", ())) for err in e.errors()})
    logger.info(
        "request validation failed",
        extra={"event": "workspace_api.validation_failed", "fields": fields},
    )
    msg = "Invalid request body"
    if fields:
        msg += f": check {', '.join(fields)}"
    return BadRequestError(msg)


ddb = boto3.resource("dynamodb")
sfn = boto3.client("stepfunctions")
secrets_client = boto3.client("secretsmanager")
events_client = boto3.client("events")
ssm_client = boto3.client("ssm")

workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])
members_table = ddb.Table(os.environ["MEMBERS_TABLE"])
# Unified per-workspace token usage (TURN#/USAGE#/CTX# rows written via the
# Agent Platform API; MONTH#/REQ# billing rows written by the LLM gateway).
# Optional — GET /workspaces/{id}/usage answers enabled:false when unset.
LLM_USAGE_TABLE = os.environ.get("LLM_USAGE_TABLE", "")
llm_usage_table = ddb.Table(LLM_USAGE_TABLE) if LLM_USAGE_TABLE else None
WORKSPACE_SECRETS_PREFIX = os.environ["WORKSPACE_SECRETS_PREFIX"].strip("/")
WORKSPACE_SSM_PREFIX = "/" + os.environ["WORKSPACE_SSM_PREFIX"].strip("/")
CRON_RULE_PREFIX = os.environ["CRON_RULE_PREFIX"]

PROVISION_STATE_MACHINE_ARN = os.environ["PROVISION_STATE_MACHINE_ARN"]
DEPROVISION_STATE_MACHINE_ARN = os.environ["DEPROVISION_STATE_MACHINE_ARN"]

# Platform-level Google OAuth client credentials live under a single
# secret. The platform (not each workspace) owns the OAuth app
# registration with Google Cloud Console — workspaces only hold the
# per-user refresh_token, which the platform must combine with these
# client credentials to refresh. Required env, supplied by the CDK
# side from config; no overlay-shaped fallback in this file so it stays
# copy-safe to a neutral-config core.
GOOGLE_OAUTH_SECRET_NAME = os.environ["GOOGLE_OAUTH_SECRET_NAME"]
MICROSOFT_OAUTH_SECRET_NAME = os.environ["MICROSOFT_OAUTH_SECRET_NAME"]

# Deployed app origin (e.g. https://app.example.com). Used to
# allowlist the Google OAuth redirect_uri so the platform never builds a
# consent URL — or exchanges an auth code — against an attacker-supplied
# callback (open-redirect / code interception). Optional: when unset, only
# localhost callbacks (dev web + CLI) are accepted.
APP_URL = os.environ.get("APP_URL", "").rstrip("/")

# Fields that travel into the provision Step Function. Either passed
# inline by the default core flow, or stashed on a workspace row as
# `pendingConfig` by a composition hook that defers provisioning until
# some out-of-band event fires.
PENDING_CONFIG_FIELDS = (
    "claudeToken",
    "telegramBotToken",
    "adminTelegramId",
    "notionToken",
    "googleAccountToken",
    "slackBotToken",
    "slackSigningSecret",
    "whatsappApiToken",
    "whatsappPhoneNumberId",
    "whatsappAppSecret",
    "teamsAppId",
    "teamsAppPassword",
)


# ============================================================
# Pydantic request models (validation + clean 422 on bad input)
# ============================================================

# Why this workspaceId pattern: it's interpolated into CFN stack names, EFS
# paths, ECS service names, and log group names. Restricting to
# [a-zA-Z0-9_-] prevents path traversal, name injection, and shell escaping.
WorkspaceIdStr = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$", examples=["my-workspace"])

# Why this userId pattern: Cognito subs are standard UUIDs. Enforcing the
# format prevents garbage rows in the members table from path param abuse.
UserIdStr = Field(
    pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    examples=["11111111-2222-3333-4444-555555555555"],
)


class CreateWorkspaceRequest(BaseModel):
    workspaceId: str = WorkspaceIdStr
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)

    # Agent integration fields. All optional so a workspace can be
    # provisioned without an agent and have these added later via the AWS
    # console / CLI — the sidecar's discovery loop picks up anything added
    # to the {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/ prefix on its next tick.
    #
    # Validation philosophy: reject clearly malformed values (wrong enum,
    # non-numeric Telegram id) but don't try to verify token validity here —
    # that's the agent's job at first turn, and Lambda has no network path
    # to Telegram / Anthropic to verify anyway.
    claudeToken: Optional[str] = Field(default=None, min_length=10, max_length=4096)
    telegramBotToken: Optional[str] = Field(
        default=None,
        # Telegram bot tokens are <numeric_id>:<35-char alnum/dash/underscore>.
        pattern=r"^[0-9]{6,16}:[A-Za-z0-9_-]{30,}$",
    )
    adminTelegramId: Optional[str] = Field(default=None, pattern=r"^[0-9]{4,20}$")

    # Optional integration tokens — can also be set later via
    # PUT /workspaces/{id}/integrations/{name}.
    notionToken: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    googleAccountToken: Optional[str] = Field(default=None, min_length=1, max_length=8192)

    # Messaging platform credentials (optional, can be set later via integrations page)
    slackBotToken: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    slackSigningSecret: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    whatsappApiToken: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    whatsappPhoneNumberId: Optional[str] = Field(default=None, min_length=1, max_length=256)
    # App Secret is required by Meta's X-Hub-Signature-256 webhook signature
    # verification. Without it the chat-server's WhatsApp adapter refuses to
    # initialize, so this must travel with the other two credentials.
    whatsappAppSecret: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    teamsAppId: Optional[str] = Field(default=None, min_length=1, max_length=256)
    teamsAppPassword: Optional[str] = Field(default=None, min_length=1, max_length=4096)

    # Pydantic v2's default for unknown fields is "ignore", so any
    # overlay-only attributes a composition hook needs (e.g. affiliate
    # referral ids) ride along on the request body unvalidated and
    # core's create_workspace passes the raw body into the hook for
    # the hook to read and validate itself.


class AddMemberRequest(BaseModel):
    userId: str = UserIdStr
    role: Literal["admin", "member"] = "member"
    # Optional Telegram user_id to link to this Cognito row. If set, the
    # sidecar surfaces it in /config/members.json and the agent treats an
    # inbound Telegram turn with this telegram_id as this member.
    telegramUserId: Optional[str] = Field(default=None, pattern=r"^[0-9]{4,20}$")


# ============================================================
# Helpers
# ============================================================

def _caller() -> str:
    """Extract the Cognito sub from the API Gateway JWT authorizer context."""
    return app.current_event.request_context.authorizer.jwt_claim.get("sub")


def _caller_email() -> Optional[str]:
    """Caller's email address from the JWT (Google federation + Cognito
    email/password both populate this). Returns None when missing —
    Cognito always sets it for our pool, so a missing value usually
    means the request bypassed the authorizer (shouldn't happen)."""
    claims = app.current_event.request_context.authorizer.jwt_claim or {}
    email = claims.get("email")
    return email if isinstance(email, str) and email else None


def _caller_name() -> Optional[str]:
    """Caller's display name from the JWT. Cognito populates `name`
    from federated providers like Google; users who signed up via
    email/password may not have it set. Falls back to the email's
    local-part so callers get something usable to greet the user by."""
    claims = app.current_event.request_context.authorizer.jwt_claim or {}
    for key in ("name", "given_name", "cognito:username"):
        v = claims.get(key)
        if isinstance(v, str) and v.strip() and "@" not in v:
            return v.strip()
    email = _caller_email()
    if email:
        return email.split("@", 1)[0]
    return None


def _get_membership(workspace_id: str, user_id: str) -> Optional[dict]:
    return members_table.get_item(
        Key={"workspaceId": workspace_id, "userId": user_id}
    ).get("Item")


def _require_member(workspace_id: str) -> dict:
    m = _get_membership(workspace_id, _caller())
    if not m:
        raise ForbiddenError("Not a member of this workspace")
    return m


def _require_admin(workspace_id: str) -> dict:
    m = _require_member(workspace_id)
    if m.get("role") != "admin":
        raise ForbiddenError("Must be a workspace admin")
    return m


# ============================================================
# Routes
# ============================================================

@app.post("/workspaces")
def create_workspace():
    """Create a workspace.

    Default flow (core): enforce 1-admin-workspace-per-account, then
    write a PROVISIONING row, add the admin member, and start the
    provision Step Function inline. Returns
    {workspaceId, status: "PROVISIONING"}.

    Composition hook: `workspace_create_hook.on_create_workspace` is
    called BEFORE the default flow runs. If it returns a response, that
    response short-circuits the route (the hook took ownership of any
    DDB writes and side effects). If it returns None, the default flow
    proceeds. This lets a downstream overlay plug in alternative semantics
    (paywall, approval queue, custom routing) without core needing to
    know about them.
    """
    caller = _caller()

    # Capture the raw body before validation. Pydantic strips unknown
    # fields, so the hook gets the original dict for any overlay-specific
    # attributes (e.g. affiliate referrals) it wants to read itself.
    raw_body = app.current_event.json_body or {}

    # Validate the request body so bad input returns 422 before we
    # touch persistent state.
    try:
        req = CreateWorkspaceRequest(**raw_body)
    except ValidationError as e:
        raise _validation_error(e)

    # Look up the caller's existing admin workspace (if any). Passed
    # into the hook so it can implement resume-style semantics, and
    # consulted afterwards to enforce the 1-per-account limit in the
    # default flow.
    existing_admin_workspace = _find_existing_admin_workspace(caller)

    # Pull pending-config fields off the request — tokens the caller
    # wants delivered to the workspace at provisioning time.
    pending_config: dict = {}
    for field in PENDING_CONFIG_FIELDS:
        v = getattr(req, field, None)
        if v is not None:
            pending_config[field] = v

    # Composition hook. Imported lazily so the hook module can re-use
    # this module's clients without an import cycle.
    from workspace_create_hook import on_create_workspace

    intercepted = on_create_workspace(
        req=req,
        caller=caller,
        existing_admin_workspace=existing_admin_workspace,
        pending_config=pending_config,
        raw_body=raw_body,
    )
    if intercepted is not None:
        return intercepted

    # Default flow.
    if existing_admin_workspace:
        raise BadRequestError(
            "You already own a workspace. Limit is 1 per account."
        )
    return _provision_workspace_now(req, caller, pending_config)


def _find_existing_admin_workspace(caller: str) -> Optional[dict]:
    """Return the caller's existing admin-membership workspace row, or
    None. Used to enforce the 1-per-account invariant and to inform the
    composition hook of resume-style scenarios."""
    existing = members_table.query(
        IndexName="by-user",
        KeyConditionExpression=Key("userId").eq(caller),
        FilterExpression="#r = :admin",
        ExpressionAttributeNames={"#r": "role"},
        ExpressionAttributeValues={":admin": "admin"},
    )
    items = existing.get("Items", [])
    if not items:
        return None
    ws_id = items[0]["workspaceId"]
    return workspaces_table.get_item(Key={"workspaceId": ws_id}).get("Item") or None


def _provision_workspace_now(
    req: CreateWorkspaceRequest, caller: str, pending_config: dict
):
    """Default core provisioning flow: write a PROVISIONING workspace
    row, add the admin member, and start the provision Step Function
    inline. Returns the response body + 202.

    Concurrency: a conditional put guards against two concurrent
    creates for the same workspaceId. If the Step Function start fails
    after the row is written, we delete the row so a client retry can
    recreate it cleanly — no half-provisioned state lingers."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        workspaces_table.put_item(
            Item={
                "workspaceId": req.workspaceId,
                "name": req.name or req.workspaceId,
                "adminUserId": caller,
                "status": "PROVISIONING",
                "createdAt": now,
            },
            ConditionExpression="attribute_not_exists(workspaceId)",
        )
    except ddb.meta.client.exceptions.ConditionalCheckFailedException:
        raise BadRequestError("Workspace ID is already taken")

    members_table.put_item(
        Item={
            "workspaceId": req.workspaceId,
            "userId": caller,
            "role": "admin",
            "addedAt": now,
            "addedBy": caller,
        }
    )

    sfn_input = {
        "workspaceId": req.workspaceId,
        "workspaceName": req.name or req.workspaceId,
        "adminUserId": caller,
        **{k: v for k, v in pending_config.items() if v is not None},
    }
    try:
        sfn.start_execution(
            stateMachineArn=PROVISION_STATE_MACHINE_ARN,
            input=json.dumps(sfn_input),
        )
    except Exception:
        # Clear the row so a client retry can recreate it cleanly. No
        # async webhook path to pick this up later in the default flow.
        workspaces_table.delete_item(Key={"workspaceId": req.workspaceId})
        raise

    return (
        {
            "workspaceId": req.workspaceId,
            "status": "PROVISIONING",
        },
        202,
    )


@app.get("/workspaces/<workspaceId>")
def get_workspace(workspaceId: str):
    _require_member(workspaceId)
    item = workspaces_table.get_item(Key={"workspaceId": workspaceId}).get("Item")
    if not item:
        raise NotFoundError("Workspace not found")
    return item


class LlmProviderSettings(BaseModel):
    """Per-workspace LLM routing.

    `anthropic-direct` (default) keeps the subscription model via the OAuth
    token. `gateway` routes the agent through the central LLM gateway to a
    Bedrock model and REQUIRES a positive monthly USD budget — the hard cap is
    fail-closed, so enabling the gateway without a budget is rejected here
    rather than silently allowing unbounded spend.
    """
    mode: Literal["anthropic-direct", "gateway"]
    model: Optional[str] = None
    smallFastModel: Optional[str] = None
    monthlyBudgetUsd: Optional[float] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _require_gateway_fields(self) -> "LlmProviderSettings":
        if self.mode == "gateway":
            if not self.model:
                raise ValueError("gateway mode requires a 'model'")
            if self.monthlyBudgetUsd is None or self.monthlyBudgetUsd <= 0:
                raise ValueError(
                    "gateway mode requires a positive 'monthlyBudgetUsd' "
                    "(the spend cap is fail-closed)"
                )
        return self


class UpdateWorkspaceRequest(BaseModel):
    """Admin-only workspace setting updates.

    Keep this strictly to overlay-neutral, operator-toggleable settings.
    Identity-shaped fields (name, adminUserId) and lifecycle status
    (status, subscriptionStatus, …) stay on their dedicated routes.
    """
    diagnosticsOptOut: Optional[bool] = Field(default=None)
    llmProvider: Optional[LlmProviderSettings] = Field(default=None)


@app.patch("/workspaces/<workspaceId>")
def update_workspace(workspaceId: str):
    """Patch admin-toggleable workspace settings.

    Currently exposes a single field — `diagnosticsOptOut` — which the
    agent-platform-api's Langfuse proxy reads to short-circuit tracing
    for the workspace. Additional operator-toggleable settings can be
    added to `UpdateWorkspaceRequest` without a separate route.
    """
    _require_admin(workspaceId)
    # Verify the workspace exists; same NotFound semantics as GET.
    if not workspaces_table.get_item(Key={"workspaceId": workspaceId}).get("Item"):
        raise NotFoundError("Workspace not found")
    try:
        req = UpdateWorkspaceRequest(**(app.current_event.json_body or {}))
    except ValidationError as e:
        raise _validation_error(e)

    update_parts: list[str] = []
    values: dict = {}
    if req.diagnosticsOptOut is not None:
        update_parts.append("diagnosticsOptOut = :d")
        values[":d"] = req.diagnosticsOptOut
    if req.llmProvider is not None:
        lp = req.llmProvider
        # DDB row is the source of truth the gateway reads for enforcement
        # (mode + monthly budget). Budgets are numeric → Decimal for DDB.
        update_parts.append("llmProviderMode = :lpm")
        values[":lpm"] = lp.mode
        update_parts.append("llmProviderModel = :lpmodel")
        values[":lpmodel"] = lp.model or ""
        update_parts.append("llmMonthlyBudgetUsd = :lpb")
        values[":lpb"] = Decimal(str(lp.monthlyBudgetUsd)) if lp.monthlyBudgetUsd else Decimal(0)
    if not update_parts:
        raise BadRequestError("Nothing to update")

    update_parts.append("updatedAt = :u")
    values[":u"] = datetime.now(timezone.utc).isoformat()

    workspaces_table.update_item(
        Key={"workspaceId": workspaceId},
        UpdateExpression="SET " + ", ".join(update_parts),
        ExpressionAttributeValues=values,
    )

    # Dual-write the non-secret routing bits to SSM so the sidecar vends them to
    # the sandbox (/config/ssm/llm-provider). Only mode/model/smallFastModel are
    # needed there — the budget stays in DDB and is read by the gateway, never
    # by the sandbox.
    if req.llmProvider is not None:
        lp = req.llmProvider
        ssm_doc: dict = {"mode": lp.mode}
        if lp.model:
            ssm_doc["model"] = lp.model
        if lp.smallFastModel:
            ssm_doc["smallFastModel"] = lp.smallFastModel
        _put_workspace_ssm_param(workspaceId, "llm-provider", json.dumps(ssm_doc))

    item = workspaces_table.get_item(Key={"workspaceId": workspaceId}).get("Item") or {}
    return item


@app.delete("/workspaces/<workspaceId>")
def delete_workspace(workspaceId: str):
    _require_admin(workspaceId)
    # Flip status=DELETING before kicking off the SFN so the workspace
    # immediately reads as inert in /me/workspaces and the UI can show
    # a "Deleting…" badge instead of looking like nothing happened
    # during the ~3-minute CFN tear-down.
    try:
        workspaces_table.update_item(
            Key={"workspaceId": workspaceId},
            UpdateExpression="SET #s = :d",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":d": "DELETING"},
        )
    except Exception:
        logger.exception(
            "failed to mark workspace DELETING",
            extra={"event": "workspace_api.delete.mark_failed", "workspaceId": workspaceId},
        )
    sfn.start_execution(
        stateMachineArn=DEPROVISION_STATE_MACHINE_ARN,
        input=json.dumps({"workspaceId": workspaceId}),
    )
    return {"workspaceId": workspaceId, "status": "DELETING"}, 202


@app.get("/me/workspaces")
def list_my_workspaces():
    user_id = _caller()
    # First /me/workspaces hit is the canonical "user just landed in
    # the app" signal — any side effect (e.g. an overlay welcome email) is
    # delegated to the user_session_hook. Wrapped so a failure can't
    # break the listing; the hook itself is expected to be idempotent
    # if it cares about firing only once per user.
    try:
        from user_session_hook import on_first_user_session

        on_first_user_session(
            user_id=user_id,
            email=_caller_email(),
            name=_caller_name(),
        )
    except Exception:
        logger.exception(
            "user_session_hook failed",
            extra={"event": "workspace_api.user_session_hook.unhandled", "userId": user_id},
        )
    result = members_table.query(
        IndexName="by-user",
        KeyConditionExpression=Key("userId").eq(user_id),
    )
    items = result.get("Items", [])

    # Enrich with workspace status + name so the UI can render a
    # "Deleting…" badge for in-flight tear-downs and skip them in the
    # post-delete redirect. BatchGetItem is fine at the typical N
    # (single-digit workspaces per user).
    if items:
        keys = [{"workspaceId": it["workspaceId"]} for it in items]
        try:
            batch = ddb.batch_get_item(
                RequestItems={workspaces_table.name: {"Keys": keys}}
            )
            by_id = {
                w["workspaceId"]: w
                for w in batch.get("Responses", {}).get(workspaces_table.name, [])
            }
            for it in items:
                ws = by_id.get(it["workspaceId"])
                if ws:
                    if "status" in ws:
                        it["status"] = ws["status"]
                    if "name" in ws:
                        it["name"] = ws["name"]
        except Exception:
            logger.exception(
                "failed to enrich /me/workspaces",
                extra={"event": "workspace_api.list.enrich_failed", "userId": user_id},
            )

    return {"workspaces": items}


def _telegram_id_owner(workspace_id: str, telegram_user_id: str) -> Optional[str]:
    """Return the userId of an EXISTING member in this workspace already
    linked to `telegram_user_id`, or None. The agent resolves an inbound
    Telegram turn to a member by telegramUserId (context-write authz is
    matched on it), so two members must never share one — otherwise a
    low-privilege member could bind an admin's Telegram ID and be
    attributed as that admin (identity spoofing). Scope is per-workspace,
    matching how the agent does the lookup."""
    resp = members_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id)
    )
    for m in resp.get("Items", []):
        if m.get("telegramUserId") == telegram_user_id:
            return m.get("userId")
    return None


@app.post("/workspaces/<workspaceId>/members")
def add_member(workspaceId: str):
    _require_admin(workspaceId)
    _require_workspace(workspaceId)
    try:
        req = AddMemberRequest(**(app.current_event.json_body or {}))
    except ValidationError as e:
        raise _validation_error(e)

    if req.telegramUserId:
        owner = _telegram_id_owner(workspaceId, req.telegramUserId)
        if owner is not None and owner != req.userId:
            raise ConflictError(
                "That Telegram user is already linked to another member."
            )

    row: dict = {
        "workspaceId": workspaceId,
        "userId": req.userId,
        "role": req.role,
        "addedAt": datetime.now(timezone.utc).isoformat(),
        "addedBy": _caller(),
    }
    if req.telegramUserId:
        row["telegramUserId"] = req.telegramUserId
    members_table.put_item(Item=row)
    return {
        "workspaceId": workspaceId,
        "userId": req.userId,
        "role": req.role,
        **({"telegramUserId": req.telegramUserId} if req.telegramUserId else {}),
    }


class LinkMyTelegramRequest(BaseModel):
    telegramUserId: str = Field(pattern=r"^[0-9]{4,20}$")


@app.patch("/workspaces/<workspaceId>/members/me/telegram")
def link_my_telegram(workspaceId: str):
    """Link the caller's own Telegram user ID to their membership row.

    Admin-only. The telegramUserId is a self-asserted numeric ID (the user
    copies it from a third-party bot like @userinfobot) with no proof of
    account ownership, and the agent resolves inbound Telegram turns to a
    member by matching it. Letting any member self-assert one is the
    identity-spoofing surface, so only workspace admins may set Telegram
    IDs (here for themselves; via add_member for other members). Combined
    with the per-workspace uniqueness check below, this keeps the
    telegramUserId->member map both 1:1 and admin-controlled.
    """
    _require_admin(workspaceId)
    try:
        req = LinkMyTelegramRequest(**(app.current_event.json_body or {}))
    except ValidationError as e:
        raise _validation_error(e)

    # Per-workspace uniqueness: a member cannot claim a Telegram ID already
    # linked to someone else (would let them be attributed as that member).
    owner = _telegram_id_owner(workspaceId, req.telegramUserId)
    if owner is not None and owner != _caller():
        raise ConflictError("That Telegram user is already linked to another member.")

    members_table.update_item(
        Key={"workspaceId": workspaceId, "userId": _caller()},
        UpdateExpression="SET telegramUserId = :t",
        ExpressionAttributeValues={":t": req.telegramUserId},
    )
    return {"workspaceId": workspaceId, "userId": _caller(), "telegramUserId": req.telegramUserId}


@app.delete("/workspaces/<workspaceId>/members/<userId>")
def remove_member(workspaceId: str, userId: str):
    _require_admin(workspaceId)

    # Why this guard: removing the last admin would orphan the workspace.
    # An admin removing themselves is allowed only if another admin exists.
    if userId == _caller():
        admins = members_table.query(
            KeyConditionExpression=Key("workspaceId").eq(workspaceId),
            FilterExpression="#r = :admin",
            ExpressionAttributeNames={"#r": "role"},
            ExpressionAttributeValues={":admin": "admin"},
        )
        if len(admins.get("Items", [])) <= 1:
            raise BadRequestError("Cannot remove the last admin")

    members_table.delete_item(Key={"workspaceId": workspaceId, "userId": userId})
    return {}, 204


@app.get("/workspaces/<workspaceId>/members")
def list_members(workspaceId: str):
    _require_member(workspaceId)
    members = members_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspaceId)
    )
    return {"members": members.get("Items", [])}


# ============================================================
# Token usage read-back (web UI)
# ============================================================

_VALID_USAGE_MONTH = re.compile(r"^\d{4}-\d{2}$")
_USAGE_COUNTERS = (
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
)


def _usage_plain(obj: dict) -> dict:
    """DDB Decimals → plain ints/floats. Powertools' default JSON encoder
    serializes Decimal as a *string*, which the SPA's number formatting
    treats as 0 — token counts must leave this API as real numbers."""
    def _default(o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        raise TypeError(f"not JSON-serializable: {type(o).__name__}")
    return json.loads(json.dumps(obj, default=_default))


@app.get("/workspaces/<workspaceId>/usage")
def get_workspace_usage(workspaceId: str):
    """Unified monthly token usage for the workspace UI: totals plus
    per-path/model/source breakdowns from the USAGE#MONTH# rollup rows the
    Agent Platform API maintains, and the gateway billing block (MONTH# row +
    configured budget). Same response shape as agent-platform-api GET /usage —
    deliberate small duplication, the two lambdas are separate codebases."""
    _require_member(workspaceId)

    from datetime import datetime, timezone as _tz

    month = app.current_event.get_query_string_value(name="month") or datetime.now(
        _tz.utc
    ).strftime("%Y-%m")
    if not _VALID_USAGE_MONTH.match(month):
        raise BadRequestError(f"invalid month: {month!r} (want YYYY-MM)")

    def _zero_block() -> dict:
        block = {k: 0 for k in _USAGE_COUNTERS}
        block["turns"] = 0
        block["apiCalls"] = 0
        return block

    result = {
        "month": month,
        "totals": _zero_block(),
        "byPath": {},
        "byModel": {},
        "bySource": {},
        "gateway": {"costUsd": 0, "budgetUsd": 0, "requests": 0},
    }

    ws = workspaces_table.get_item(Key={"workspaceId": workspaceId}).get("Item") or {}
    if ws.get("llmMonthlyBudgetUsd") is not None:
        result["gateway"]["budgetUsd"] = ws["llmMonthlyBudgetUsd"]

    if llm_usage_table is None:
        result["enabled"] = False
        return _usage_plain(result)
    result["enabled"] = True

    prefix = f"USAGE#MONTH#{month}"
    resp = llm_usage_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspaceId)
        & Key("sk").begins_with(prefix),
    )
    for item in resp.get("Items", []):
        block = {k: item.get(k, 0) for k in _USAGE_COUNTERS}
        block["turns"] = item.get("turns", 0)
        block["apiCalls"] = item.get("apiCalls", 0)
        suffix = item["sk"][len(prefix):]
        if suffix == "":
            result["totals"] = block
        elif suffix.startswith("#PATH#"):
            result["byPath"][suffix[len("#PATH#"):].replace("%23", "#")] = block
        elif suffix.startswith("#MODEL#"):
            result["byModel"][suffix[len("#MODEL#"):].replace("%23", "#")] = block
        elif suffix.startswith("#SOURCE#"):
            result["bySource"][suffix[len("#SOURCE#"):].replace("%23", "#")] = block

    gateway_rollup = llm_usage_table.get_item(
        Key={"workspaceId": workspaceId, "sk": f"MONTH#{month}"}
    ).get("Item") or {}
    for k in ("costUsd", "requests"):
        if gateway_rollup.get(k) is not None:
            result["gateway"][k] = gateway_rollup[k]

    return _usage_plain(result)


# ============================================================
# Integrations
# ============================================================

# Registry of per-workspace integrations. Each entry maps a URL name
# to the body key expected in the PUT request and the Secrets Manager
# secret suffix under {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/.
INTEGRATIONS = {
    "claude": {
        "body_key": "token",            # PUT body: {"token": "sk-ant-oat..."}
        "secret_name": "claude-token",
    },
    "telegram": {
        "body_key": "token",            # PUT body: {"token": "123456:ABC-DEF..."}
        "secret_name": "telegram-bot-token",
    },
    "slack": {
        "body_key": "credentials",      # PUT body: {"credentials": {"botToken": "xoxb-...", "signingSecret": "..."}}
        "secret_name": "slack-credentials",
        "secret_files": {               # Split into individual secret files for the chat server
            "slack-bot-token": "botToken",
            "slack-signing-secret": "signingSecret",
        },
    },
    "whatsapp": {
        "body_key": "credentials",      # PUT body: {"credentials": {"apiToken": "...", "phoneNumberId": "...", "appSecret": "..."}}
        "secret_name": "whatsapp-credentials",
        "secret_files": {
            "whatsapp-access-token": "apiToken",
            "whatsapp-phone-number-id": "phoneNumberId",
            "whatsapp-app-secret": "appSecret",
        },
    },
    "teams": {
        "body_key": "credentials",      # PUT body: {"credentials": {"appId": "...", "appPassword": "..."}}
        "secret_name": "teams-credentials",
        "secret_files": {
            "teams-app-id": "appId",
            "teams-app-password": "appPassword",
        },
    },
    "notion": {
        "body_key": "token",            # PUT body: {"token": "ntn_..."}
        "secret_name": "notion-token",
    },
    "google": {
        "body_key": "credentials",      # PUT body: {"credentials": {client_id, client_secret, refresh_token, account_name}}
        "secret_name": "google-account-token",
    },
    "microsoft": {
        "body_key": "credentials",      # PUT body: {"credentials": {client_id, client_secret, refresh_token, tenant_id, account_name}}
        "secret_name": "microsoft-account-token",
    },
}

# Reserved slots for the typed-path regression suite
# (tests/test_workspace_api_integrations.py): they exercise the single-
# and multi-field code paths without touching a real integration. They're
# attacker-writable secret basenames (admin-gated, inert downstream) with
# no production purpose, so register them in NON-PROD ONLY. The integration
# tests run against beta (testws-01), so beta keeps them; prod drops them.
# PLATFORM_ENV is supplied by the CDK side (management-api stack); defaults
# to beta when unset.
PLATFORM_ENV = os.environ.get("PLATFORM_ENV", "beta")
if PLATFORM_ENV != "prod":
    INTEGRATIONS.update({
        "test-integration": {
            "body_key": "value",
            "secret_name": "test-integration-token",
        },
        "test-multi-integration": {
            "body_key": "credentials",
            "secret_name": "test-multi-integration-credentials",
            "secret_files": {
                "test-multi-integration-a": "fieldA",
                "test-multi-integration-b": "fieldB",
            },
        },
    })

# Custom ("bring-your-own") integrations live under the `custom-` prefix,
# so they can't collide with typed-integration or platform-owned basenames
# (agent-platform-key, cron-trigger-key, etc.) that live beside them under
# {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/.
#
# Names accept the human-friendly character set (uppercase letters and
# underscores included) at the API boundary, but are normalised for
# storage: lowercased + underscores replaced with dashes. The pre-
# normalisation string is preserved as the secret's Description so the
# dashboard can display it back to the admin verbatim.
CUSTOM_SECRET_PREFIX = "custom-"
CUSTOM_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")
CUSTOM_VALUE_MAX_BYTES = 8192


def _normalize_custom_name(name: str) -> str:
    """Normalise a user-supplied custom-integration name to its storage key.

    Lowercases ASCII letters and converts underscores to dashes, so
    `My_GitHub_PAT`, `my_github_pat`, and `my-github-pat` all resolve to
    the same secret. The original string is kept in the Secrets Manager
    Description (see `_put_secret`'s `description` arg) for display.
    """
    return name.lower().replace("_", "-")


def _workspace_id_from_secret_name(name: str) -> str | None:
    """Parse `{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/...` and return workspaceId.

    Returns None for non-workspace secrets (`{WORKSPACE_SECRETS_PREFIX}/platform/...`
    or anything outside the workspace secrets prefix). Used by the bump
    helper to skip platform-shared secrets — those don't belong to any
    single workspace, so there's no sidecar to notify.
    """
    prefix = f"{WORKSPACE_SECRETS_PREFIX}/"
    if not name.startswith(prefix):
        return None
    parts = name[len(prefix):].split("/", 1)
    if len(parts) < 2:
        return None
    workspace_id = parts[0]
    if workspace_id == "platform":
        return None
    return workspace_id


def _bump_secrets_revision(workspace_id: str) -> None:
    """Stamp the workspace's secrets-revision SSM parameter with the
    current epoch second so the sidecar's next 15s tick triggers a full
    Secrets Manager sync (instead of waiting up to 15 minutes for the
    backstop). Best-effort: a failed bump just delays the new secret's
    materialization to the next backstop interval.

    The value is monotonic (epoch seconds, Overwrite=True) so concurrent
    bumps can't race the sidecar into missing a change — see
    `docker/sidecar/jobs/sync.py:sync_loop` for the comparison logic.
    """
    if not workspace_id:
        return
    name = f"{WORKSPACE_SSM_PREFIX}/{workspace_id}/secrets-revision"
    try:
        import time as _time
        ssm_client.put_parameter(
            Name=name,
            Value=str(int(_time.time())),
            Type="String",
            Overwrite=True,
        )
    except Exception:
        logger.warning(
            "failed to bump secrets-revision; sidecar will pick up at next backstop",
            extra={
                "event": "workspace_api.secrets_revision.bump_failed",
                "workspaceId": workspace_id,
            },
            exc_info=True,
        )


def _put_workspace_ssm_param(workspace_id: str, basename: str, value: str) -> None:
    """Write a non-secret per-workspace config parameter to SSM. The sidecar's
    `sync_workspace_ssm()` runs every tick (NOT gated on secrets-revision), so
    this propagates to /config/ssm/<basename> within one sync interval without
    forcing an expensive Secrets Manager re-sync.
    """
    name = f"{WORKSPACE_SSM_PREFIX}/{workspace_id}/{basename}"
    ssm_client.put_parameter(Name=name, Value=value, Type="String", Overwrite=True)


def _put_secret(name: str, value: str, description: str | None = None) -> None:
    """Create or overwrite a Secrets Manager secret (idempotent).

    Handles three cases:
    - Secret doesn't exist → create_secret (with Description if provided)
    - Secret exists → put_secret_value + update_secret for Description
    - Secret scheduled for deletion → restore, then put_secret_value + update_secret

    `description` is optional; when supplied it's stored on the secret and
    used by callers (e.g. `list_integrations`) to display the admin's
    original human-friendly name alongside the normalised storage key.
    """
    from botocore.exceptions import ClientError as BotoClientError
    create_kwargs: dict = {"Name": name, "SecretString": value}
    if description is not None:
        create_kwargs["Description"] = description
    try:
        secrets_client.create_secret(**create_kwargs)
    except BotoClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ResourceExistsException":
            logger.info(
                "secret already exists, updating",
                extra={
                    "event": "workspace_api.secret.exists_updating",
                    "secretName": name,
                    "expected": True,
                },
            )
            secrets_client.put_secret_value(SecretId=name, SecretString=value)
            if description is not None:
                secrets_client.update_secret(
                    SecretId=name, Description=description
                )
        elif code == "InvalidRequestException" and "scheduled for deletion" in str(e):
            logger.info(
                "secret in scheduled-deletion state, restoring and updating",
                extra={
                    "event": "workspace_api.secret.restored",
                    "secretName": name,
                    "expected": True,
                },
            )
            secrets_client.restore_secret(SecretId=name)
            secrets_client.put_secret_value(SecretId=name, SecretString=value)
            if description is not None:
                secrets_client.update_secret(
                    SecretId=name, Description=description
                )
        else:
            logger.exception(
                "unexpected secret create error",
                extra={
                    "event": "workspace_api.secret.create_failed",
                    "secretName": name,
                },
            )
            raise

    workspace_id = _workspace_id_from_secret_name(name)
    if workspace_id:
        _bump_secrets_revision(workspace_id)


def _qs_flag(key: str) -> bool:
    """Read a truthy query-string flag (accepts 1/true/yes, case-insensitive)."""
    qs = app.current_event.query_string_parameters or {}
    return str(qs.get(key, "")).lower() in ("1", "true", "yes")


def _delete_secret(name: str) -> bool:
    from botocore.exceptions import ClientError as BotoClientError
    try:
        secrets_client.delete_secret(SecretId=name, ForceDeleteWithoutRecovery=True)
    except BotoClientError:
        logger.warning(
            "secret delete failed",
            extra={
                "event": "workspace_api.secret.delete_failed",
                "secretName": name,
            },
            exc_info=True,
        )
        return False

    workspace_id = _workspace_id_from_secret_name(name)
    if workspace_id:
        _bump_secrets_revision(workspace_id)
    return True


def _is_allowed_oauth_redirect(redirect_uri: str, callback_path: str) -> bool:
    """Allowlist an OAuth redirect_uri against the deployed app origin.
    Without this the platform would build a consent URL (and exchange the
    returned code) against an arbitrary client-supplied callback, leaking
    the auth code to an attacker host (open-redirect / code interception).

    Permitted:
      - the deployed app origin's callback (`{APP_URL}{callback_path}`)
      - any localhost / 127.0.0.1 callback (dev web + the `localhost:8977`
        CLI flow) — an attacker can't receive a code on the victim's
        loopback.
    Everything else (arbitrary external hosts) is rejected.

    `callback_path` is per-provider (`/oauth/google/callback`,
    `/oauth/microsoft/callback`, …) so a code for one provider can't be
    redirected through another provider's callback.
    """
    import urllib.parse

    if not redirect_uri or not isinstance(redirect_uri, str):
        return False
    try:
        u = urllib.parse.urlparse(redirect_uri)
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    host = (u.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    if APP_URL:
        app = urllib.parse.urlparse(APP_URL)
        if (
            u.scheme == app.scheme
            and host == (app.hostname or "").lower()
            and u.port == app.port
            and u.path == callback_path
        ):
            return True
    return False


def _is_allowed_google_redirect(redirect_uri: str) -> bool:
    return _is_allowed_oauth_redirect(redirect_uri, "/oauth/google/callback")


def _is_allowed_microsoft_redirect(redirect_uri: str) -> bool:
    return _is_allowed_oauth_redirect(redirect_uri, "/oauth/microsoft/callback")


def _exchange_google_token(payload: dict) -> dict | None:
    """Exchange a Google OAuth auth code for a refresh token.

    Reads the shared Google OAuth client credentials from Secrets Manager,
    exchanges the auth code, fetches the user's email, and returns an
    assembled blob ready for the agent.
    """
    import urllib.request
    import urllib.parse

    auth_code = payload.get("auth_code")
    redirect_uri = payload.get("redirect_uri", "http://localhost:8977/callback")
    if not auth_code:
        return None
    if not _is_allowed_google_redirect(redirect_uri):
        logger.warning(
            "rejected google token exchange with disallowed redirect_uri",
            extra={
                "event": "workspace_api.google_oauth.bad_redirect_uri",
                "redirectUri": redirect_uri,
                "expectedOrigin": APP_URL or None,
            },
        )
        return None

    # Load shared Google OAuth client credentials
    try:
        raw = secrets_client.get_secret_value(SecretId=GOOGLE_OAUTH_SECRET_NAME)["SecretString"]
        google_creds = json.loads(raw)
    except Exception:
        logger.exception(
            "failed to load google-oauth secret",
            extra={"event": "workspace_api.google_oauth.secret_read_failed"},
        )
        return None

    client_id = google_creds["client_id"]
    client_secret = google_creds["client_secret"]

    # Exchange auth code for tokens
    token_data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except Exception:
        logger.exception(
            "failed to exchange google auth code",
            extra={"event": "workspace_api.google_oauth.exchange_failed"},
        )
        return None

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        logger.warning(
            "google token response missing refresh_token",
            extra={"event": "workspace_api.google_oauth.no_refresh_token"},
        )
        return None

    # Fetch user email for the account name
    account_name = "default"
    access_token = tokens.get("access_token")
    if access_token:
        try:
            user_req = urllib.request.Request(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            with urllib.request.urlopen(user_req) as resp:
                user_info = json.loads(resp.read())
                account_name = user_info.get("email", "default").split("@")[0]
        except Exception:
            # Userinfo fetch is optional — we just fall back to
            # account_name="default" on any failure. Log so a persistent
            # outage is visible.
            logger.warning(
                "google userinfo fetch failed, using default account name",
                extra={
                    "event": "workspace_api.google_oauth.userinfo_failed",
                    "expected": True,
                },
                exc_info=True,
            )

    from datetime import datetime, timezone
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "account_name": account_name,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/workspaces/<workspaceId>/integrations/google/auth-url")
def google_auth_url(workspaceId: str):
    """Build the Google OAuth consent URL for this workspace.
    The frontend opens this URL in a popup; Google redirects back to
    `redirectUri` with `?code=...` which the frontend then submits to
    PUT /integrations/google.
    """
    _require_admin(workspaceId)

    redirect_uri = app.current_event.get_query_string_value("redirectUri")
    if not redirect_uri:
        raise BadRequestError("redirectUri query parameter is required")
    if not _is_allowed_google_redirect(redirect_uri):
        raise BadRequestError("redirectUri is not an allowed callback")

    try:
        raw = secrets_client.get_secret_value(SecretId=GOOGLE_OAUTH_SECRET_NAME)["SecretString"]
        google_creds = json.loads(raw)
    except Exception:
        logger.exception(
            "failed to load google-oauth secret",
            extra={"event": "workspace_api.google_oauth.secret_read_failed"},
        )
        raise ServiceError(500, "Google OAuth not configured")

    client_id = google_creds.get("client_id")
    if not client_id:
        raise ServiceError(500, "Google OAuth client_id missing")

    # Scopes: broad Google Workspace access for the agent.
    scopes = [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/presentations",
    ]

    import urllib.parse
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        # access_type=offline + prompt=consent guarantees a refresh_token,
        # even on subsequent connects.
        "access_type": "offline",
        "prompt": "consent",
        # Round-trip the workspace ID so the callback knows where to land.
        "state": workspaceId,
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
    return {"url": url}


# Microsoft 365 / Azure AD endpoints are tenant-scoped, but a multitenant
# app uses /common to accept both work/school (any tenant) and personal
# MSA accounts. We store the per-user tenant_id at exchange time so the
# agent can route refreshes against the correct tenant authority.
MS_OAUTH_AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
MS_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MS_GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me"

# Delegated Graph scopes. `offline_access` is what surfaces a
# refresh_token in the response. Keep this list in sync with the Azure
# app's API permissions — scopes requested here must be a subset of what
# the app is registered for, or consent fails with AADSTS65001.
MS_GRAPH_SCOPES = [
    "openid",
    "profile",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Files.ReadWrite.All",
    "Sites.ReadWrite.All",
    "ChannelMessage.Send",
    "Chat.ReadWrite",
]


def _exchange_microsoft_token(payload: dict) -> dict | None:
    """Exchange a Microsoft auth code for a refresh token.

    Mirrors `_exchange_google_token`: reads the platform Azure AD app
    credentials, exchanges the code, looks up the user's UPN + tenant
    for the account_name, returns a blob ready for `microsoft-account-
    token`. The tenant_id captured here is what the agent's refresh shim
    uses to build the per-user authority URL.
    """
    import urllib.request
    import urllib.parse

    auth_code = payload.get("auth_code")
    redirect_uri = payload.get("redirect_uri")
    if not auth_code or not redirect_uri:
        return None
    if not _is_allowed_microsoft_redirect(redirect_uri):
        logger.warning(
            "rejected microsoft token exchange with disallowed redirect_uri",
            extra={
                "event": "workspace_api.microsoft_oauth.bad_redirect_uri",
                "redirectUri": redirect_uri,
                "expectedOrigin": APP_URL or None,
            },
        )
        return None

    try:
        raw = secrets_client.get_secret_value(SecretId=MICROSOFT_OAUTH_SECRET_NAME)["SecretString"]
        ms_creds = json.loads(raw)
    except Exception:
        logger.exception(
            "failed to load microsoft-oauth secret",
            extra={"event": "workspace_api.microsoft_oauth.secret_read_failed"},
        )
        return None

    client_id = ms_creds["client_id"]
    client_secret = ms_creds["client_secret"]

    token_data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "scope": " ".join(MS_GRAPH_SCOPES),
    }).encode()
    req = urllib.request.Request(
        MS_OAUTH_TOKEN_URL,
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except Exception:
        logger.exception(
            "failed to exchange microsoft auth code",
            extra={"event": "workspace_api.microsoft_oauth.exchange_failed"},
        )
        return None

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Without offline_access scope on the app, MS returns access only.
        # That's fatal for an unattended agent — bail loudly.
        logger.warning(
            "microsoft token response missing refresh_token",
            extra={"event": "workspace_api.microsoft_oauth.no_refresh_token"},
        )
        return None

    # Fetch the user's UPN + tenant from Graph /me. Fall back to a
    # generic account_name on failure (same pattern as Google).
    account_name = "default"
    tenant_id = "common"
    access_token = tokens.get("access_token")
    if access_token:
        try:
            user_req = urllib.request.Request(
                MS_GRAPH_ME_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            with urllib.request.urlopen(user_req) as resp:
                user_info = json.loads(resp.read())
                upn = user_info.get("userPrincipalName") or user_info.get("mail")
                if upn:
                    account_name = upn.split("@")[0]
            # The /me response doesn't include tenant ID directly; pull
            # it from the id_token if present, else leave as `common` and
            # let the agent figure it out at refresh time.
            id_token = tokens.get("id_token")
            if id_token:
                # JWT payload is the middle segment, base64url-encoded.
                import base64
                try:
                    payload_b64 = id_token.split(".")[1]
                    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
                    claims = json.loads(base64.urlsafe_b64decode(padded))
                    if claims.get("tid"):
                        tenant_id = claims["tid"]
                except Exception:
                    pass
        except Exception:
            logger.warning(
                "microsoft userinfo fetch failed, using default account name",
                extra={
                    "event": "workspace_api.microsoft_oauth.userinfo_failed",
                    "expected": True,
                },
                exc_info=True,
            )

    from datetime import datetime, timezone
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "tenant_id": tenant_id,
        "account_name": account_name,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/workspaces/<workspaceId>/integrations/microsoft/auth-url")
def microsoft_auth_url(workspaceId: str):
    """Build the Microsoft OAuth consent URL for this workspace.
    Frontend opens this in a popup; MS redirects back to `redirectUri`
    with `?code=...` which the frontend submits to PUT /integrations/microsoft.
    """
    _require_admin(workspaceId)

    redirect_uri = app.current_event.get_query_string_value("redirectUri")
    if not redirect_uri:
        raise BadRequestError("redirectUri query parameter is required")
    if not _is_allowed_microsoft_redirect(redirect_uri):
        logger.warning(
            "rejected microsoft auth-url build with disallowed redirect_uri",
            extra={
                "event": "workspace_api.microsoft_oauth.bad_redirect_uri",
                "redirectUri": redirect_uri,
                "expectedOrigin": APP_URL or None,
            },
        )
        raise BadRequestError("redirect_uri not allowed")

    try:
        raw = secrets_client.get_secret_value(SecretId=MICROSOFT_OAUTH_SECRET_NAME)["SecretString"]
        ms_creds = json.loads(raw)
    except Exception:
        logger.exception(
            "failed to load microsoft-oauth secret",
            extra={"event": "workspace_api.microsoft_oauth.secret_read_failed"},
        )
        raise ServiceError(500, "Microsoft OAuth not configured")

    client_id = ms_creds.get("client_id")
    if not client_id:
        raise ServiceError(500, "Microsoft OAuth client_id missing")

    import urllib.parse
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(MS_GRAPH_SCOPES),
        # response_mode=query keeps the code on the redirect URL (not fragment).
        "response_mode": "query",
        # prompt=consent forces the consent screen on every connect, which
        # guarantees a refresh_token even if the user has previously
        # consented (Azure's default is to skip consent on re-auth).
        "prompt": "consent",
        # Round-trip the workspace ID so the callback knows where to land.
        "state": workspaceId,
    }
    url = MS_OAUTH_AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)
    return {"url": url}


@app.get("/workspaces/<workspaceId>/integrations")
def list_integrations(workspaceId: str):
    """Return which integrations are configured for the workspace.
    Only checks for secret existence — never returns secret values.
    """
    _require_member(workspaceId)

    # Enumerate every secret under {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/
    # once, then check each integration's expected secret suffix(es)
    # against the set.
    prefix = f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/"
    found_suffixes: set[str] = set()
    # Map of custom basename (without prefix) → admin-supplied display
    # name (from the secret's Description). Empty string when the secret
    # predates the displayName feature.
    custom_descriptions: dict[str, str] = {}
    paginator = secrets_client.get_paginator("list_secrets")
    try:
        for page in paginator.paginate(
            Filters=[{"Key": "name", "Values": [prefix]}],
            MaxResults=100,
        ):
            for secret in page.get("SecretList", []):
                name = secret.get("Name", "")
                if not name.startswith(prefix):
                    continue
                suffix = name[len(prefix):]
                found_suffixes.add(suffix)
                if suffix.startswith(CUSTOM_SECRET_PREFIX):
                    key = suffix[len(CUSTOM_SECRET_PREFIX):]
                    custom_descriptions[key] = secret.get("Description", "") or ""
    except Exception:
        logger.exception(
            "failed to list secrets for workspace",
            extra={
                "event": "workspace_api.integrations.list_secrets_failed",
                "workspaceId": workspaceId,
            },
        )
        raise ServiceError(500, "Failed to list integrations")

    configured: list[str] = []
    for integration_name, spec in INTEGRATIONS.items():
        secret_files = spec.get("secret_files")
        if secret_files:
            # Multi-field integrations are configured if at least one of
            # their per-field secrets exists.
            if any(suffix in found_suffixes for suffix in secret_files):
                configured.append(integration_name)
        else:
            if spec["secret_name"] in found_suffixes:
                configured.append(integration_name)

    # `name` is the normalised storage key (used as the path segment on
    # PUT/DELETE and as the basename the agent reads). `displayName`
    # is the admin's original friendly name — falls back to `name` for
    # legacy secrets created before the Description was recorded.
    custom = sorted(
        (
            {"name": key, "displayName": desc or key}
            for key, desc in custom_descriptions.items()
        ),
        key=lambda e: e["name"],
    )
    return {"integrations": configured, "custom": custom}


@app.put("/workspaces/<workspaceId>/integrations/<name>")
def set_integration(workspaceId: str, name: str):
    _require_workspace(workspaceId)
    body = app.current_event.json_body or {}
    is_custom = bool(body.get("custom", False))

    if is_custom:
        _require_admin(workspaceId)
        if not CUSTOM_NAME_RE.match(name):
            raise BadRequestError(
                "Custom integration name must match "
                "[A-Za-z0-9][A-Za-z0-9_-]{0,62}"
            )
        value = body.get("value")
        if not isinstance(value, str) or not value:
            raise BadRequestError(
                'Custom integration requires {"custom": true, "value": "<string>"}'
            )
        if len(value.encode("utf-8")) > CUSTOM_VALUE_MAX_BYTES:
            raise BadRequestError(
                f"Custom integration value exceeds {CUSTOM_VALUE_MAX_BYTES} bytes"
            )
        normalized = _normalize_custom_name(name)
        secret_id = f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{CUSTOM_SECRET_PREFIX}{normalized}"
        # Store the secret as a JSON envelope so the sidecar-synced
        # on-disk file carries both the raw value and the display name —
        # that way the agent MCP can return the displayName without a
        # second sidecar sync file.
        # Also keep `Description` in sync so list_integrations can read
        # display names without decrypting every secret value.
        envelope = json.dumps({"value": value, "displayName": name})
        _put_secret(secret_id, envelope, description=name)
        logger.info(
            "stored custom integration",
            extra={
                "event": "workspace_api.integration.custom_stored",
                "workspaceId": workspaceId,
                "integrationName": normalized,
                "displayName": name,
            },
        )
        return {
            "integration": normalized,
            "displayName": name,
            "status": "configured",
            "type": "custom",
        }

    if name not in INTEGRATIONS:
        raise NotFoundError(f"Unknown integration: {name}")
    _require_admin(workspaceId)

    spec = INTEGRATIONS[name]
    payload = body.get(spec["body_key"])
    if not payload:
        raise BadRequestError(f"Missing required field: {spec['body_key']}")

    # Google requires an OAuth code exchange before storage.
    if name == "google" and isinstance(payload, dict) and "auth_code" in payload:
        payload = _exchange_google_token(payload)
        if not payload:
            raise BadRequestError("Google token exchange failed")

    # Microsoft mirrors the Google flow: code in → refresh_token blob out.
    if name == "microsoft" and isinstance(payload, dict) and "auth_code" in payload:
        payload = _exchange_microsoft_token(payload)
        if not payload:
            raise BadRequestError("Microsoft token exchange failed")

    # For multi-field integrations, write each field as a separate secret
    # so the chat server can read them individually from /config/secrets/.
    secret_files = spec.get("secret_files")
    if secret_files and isinstance(payload, dict):
        for secret_suffix, field_key in secret_files.items():
            field_value = payload.get(field_key, "")
            if field_value:
                _put_secret(f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{secret_suffix}", str(field_value))
        logger.info(
            "stored integration secret files",
            extra={
                "event": "workspace_api.integration.stored",
                "workspaceId": workspaceId,
                "integrationName": name,
                "fieldCount": len(secret_files),
            },
        )
    else:
        # Single-field: store as string. If the payload is a dict, serialize to JSON.
        value = json.dumps(payload) if isinstance(payload, dict) else str(payload)
        secret_id = f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{spec['secret_name']}"
        _put_secret(secret_id, value)
        logger.info(
            "stored integration",
            extra={
                "event": "workspace_api.integration.stored",
                "workspaceId": workspaceId,
                "integrationName": name,
            },
        )

    return {"integration": name, "status": "configured"}


@app.delete("/workspaces/<workspaceId>/integrations/<name>")
def remove_integration(workspaceId: str, name: str):
    is_custom = _qs_flag("custom")

    if is_custom:
        _require_admin(workspaceId)
        if not CUSTOM_NAME_RE.match(name):
            raise BadRequestError("Invalid custom integration name")
        normalized = _normalize_custom_name(name)
        _delete_secret(
            f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{CUSTOM_SECRET_PREFIX}{normalized}"
        )
        logger.info(
            "removed custom integration",
            extra={
                "event": "workspace_api.integration.custom_removed",
                "workspaceId": workspaceId,
                "integrationName": normalized,
            },
        )
        return {"integration": normalized, "status": "removed", "type": "custom"}

    if name not in INTEGRATIONS:
        raise NotFoundError(f"Unknown integration: {name}")
    _require_admin(workspaceId)

    spec = INTEGRATIONS[name]
    secret_files = spec.get("secret_files")
    if secret_files:
        for secret_suffix in secret_files:
            _delete_secret(f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{secret_suffix}")
    else:
        _delete_secret(f"{WORKSPACE_SECRETS_PREFIX}/{workspaceId}/{spec['secret_name']}")
    logger.info(
        "removed integration",
        extra={
            "event": "workspace_api.integration.removed",
            "workspaceId": workspaceId,
            "integrationName": name,
        },
    )

    return {"integration": name, "status": "removed"}


# ============================================================
# Browser cookies (admin-managed, injected into agent sessions)
# ============================================================


@app.get("/workspaces/<workspaceId>/browser/cookies")
def get_browser_cookies(workspaceId: str):
    """Read stored browser cookies for a workspace. Any member can view."""
    _require_member(workspaceId)
    try:
        item = workspaces_table.get_item(
            Key={"workspaceId": workspaceId},
            ProjectionExpression="browserCookies",
        ).get("Item", {})
        raw = item.get("browserCookies")
        cookies = json.loads(raw) if isinstance(raw, str) and raw else []
    except Exception:
        logger.warning(
            "failed to parse browser cookies, returning empty list",
            extra={
                "event": "workspace_api.browser_cookies.parse_failed",
                "workspaceId": workspaceId,
                "expected": True,
            },
            exc_info=True,
        )
        cookies = []
    return {"cookies": cookies}


@app.put("/workspaces/<workspaceId>/browser/cookies")
def set_browser_cookies(workspaceId: str):
    """Set browser cookies for a workspace. Admin-only.

    These cookies are injected into every AgentCore browser session at
    turn start so the agent can browse authenticated sites without
    needing to log in. The admin configures them from the dashboard
    (e.g. by exporting cookies from their browser or via an OAuth flow).

    Body: {"cookies": [{name, value, domain, path, ...}]}
    """
    _require_admin(workspaceId)
    body = app.current_event.json_body or {}
    cookies = body.get("cookies")
    if not isinstance(cookies, list):
        raise BadRequestError("cookies must be an array")

    from datetime import datetime, timezone as tz
    workspaces_table.update_item(
        Key={"workspaceId": workspaceId},
        UpdateExpression="SET browserCookies = :c, browserCookiesUpdatedAt = :t",
        ExpressionAttributeValues={
            ":c": json.dumps(cookies),
            ":t": datetime.now(tz.utc).isoformat(),
        },
    )
    return {"status": "ok", "count": len(cookies)}


@app.delete("/workspaces/<workspaceId>/browser/cookies")
def delete_browser_cookies(workspaceId: str):
    """Clear all browser cookies for a workspace. Admin-only."""
    _require_admin(workspaceId)
    workspaces_table.update_item(
        Key={"workspaceId": workspaceId},
        UpdateExpression="REMOVE browserCookies, browserCookiesUpdatedAt",
    )
    return {"status": "ok"}


# ============================================================
# Cron jobs (scheduled automations via EventBridge) — read-only
# ============================================================


@app.get("/workspaces/<workspaceId>/cron/jobs")
def list_cron_jobs(workspaceId: str):
    _require_member(workspaceId)
    prefix = f"{CRON_RULE_PREFIX}--{workspaceId}--"
    try:
        resp = events_client.list_rules(NamePrefix=prefix)
    except Exception:
        logger.exception(
            "failed to list eventbridge rules",
            extra={
                "event": "workspace_api.cron.list_failed",
                "workspaceId": workspaceId,
                "prefix": prefix,
            },
        )
        raise ServiceError(500, "Failed to list cron jobs")

    jobs = []
    for rule in resp.get("Rules", []):
        parts = rule["Name"].split("--", 2)
        job_name = parts[2] if len(parts) > 2 else rule["Name"]
        agent_id: Optional[str] = None
        try:
            targets = events_client.list_targets_by_rule(Rule=rule["Name"]).get("Targets", [])
            raw = targets[0].get("Input", "") if targets else ""
            if raw:
                meta = json.loads(raw)
                if isinstance(meta, dict) and isinstance(meta.get("agentId"), str):
                    agent_id = meta["agentId"]
        except (events_client.exceptions.ResourceNotFoundException, ValueError, TypeError):
            pass
        jobs.append({
            "name": job_name,
            "schedule": rule.get("ScheduleExpression", ""),
            "message": rule.get("Description", ""),
            "enabled": rule.get("State") == "ENABLED",
            **({"agentId": agent_id} if agent_id else {}),
        })
    return {"jobs": jobs}


# ============================================================
# Agents (user-defined per-workspace agents — CrewBot Agent Creator)
# ============================================================
#
# DDB table holds the index + a mirror of `def/config.json.required_secrets`
# so the deploy-check endpoint can diff against Secrets Manager without
# mounting EFS. The authoritative agent definition lives on EFS under
# /data/agents/{agentId}/def/; those files are only written by the creator
# session inside the sandbox (workspace-api never touches EFS).

agents_table = ddb.Table(os.environ["AGENTS_TABLE"])


AGENT_ID_RE = re.compile(r"^agt_[0-9a-f]{10}$")

# Human-editable fields. Name is shown in the UI + creator banner; the
# description feeds the supervisor's subagent-list prompt so the model
# can route to the right agent.
AGENT_NAME_MAX = 128
AGENT_DESC_MAX = 512


class CreateAgentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=AGENT_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=AGENT_DESC_MAX)


class UpdateAgentRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=AGENT_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=AGENT_DESC_MAX)


def _generate_agent_id() -> str:
    return f"agt_{secrets.token_hex(5)}"


def _require_agent(workspace_id: str, agent_id: str) -> dict:
    """Load an agents row and 404 if not present in this workspace. The
    DDB key (workspaceId, agentId) is the workspace-scoping enforcement
    point — no agentId can cross workspaces."""
    if not AGENT_ID_RE.match(agent_id):
        raise NotFoundError("Agent not found")
    item = agents_table.get_item(
        Key={"workspaceId": workspace_id, "agentId": agent_id}
    ).get("Item")
    if not item:
        raise NotFoundError("Agent not found")
    return item


def _list_workspace_secret_suffixes(workspace_id: str) -> set[str]:
    """Enumerate every secret under {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/
    and return the suffix set. Used by the deploy check to diff against
    `requiredSecrets`. Mirrors the pattern in list_integrations above."""
    prefix = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/"
    found: set[str] = set()
    paginator = secrets_client.get_paginator("list_secrets")
    for page in paginator.paginate(
        Filters=[{"Key": "name", "Values": [prefix]}],
        MaxResults=100,
    ):
        for secret in page.get("SecretList", []):
            name = secret.get("Name", "")
            if name.startswith(prefix):
                found.add(name[len(prefix):])
    return found


@app.post("/workspaces/<workspaceId>/agents")
def create_agent(workspaceId: str):
    """Create a draft agent row and return the creator session key.

    EFS scaffolding (/data/agents/{agentId}/{def,workdir}) is done by the
    chat-server on the first creator turn — workspace-api has no EFS
    mount, and two writers would race anyway.
    """
    _require_admin(workspaceId)
    _require_workspace(workspaceId)
    try:
        req = CreateAgentRequest(**(app.current_event.json_body or {}))
    except ValidationError as e:
        raise _validation_error(e)

    agent_id = _generate_agent_id()
    now = datetime.now(timezone.utc).isoformat()
    agents_table.put_item(
        Item={
            "workspaceId": workspaceId,
            "agentId": agent_id,
            "name": req.name,
            "description": req.description or "",
            "status": "draft",
            "createdBy": _caller(),
            "createdAt": now,
            "updatedAt": now,
            "requiredSecrets": [],
        },
        # Guard against id collisions — token_hex(5) is 2^40 outcomes,
        # but a conditional put is a cheap belt-and-braces.
        ConditionExpression="attribute_not_exists(agentId)",
    )
    logger.info(
        "created agent",
        extra={
            "event": "workspace_api.agent.created",
            "workspaceId": workspaceId,
            "agentId": agent_id,
        },
    )
    return {
        "agentId": agent_id,
        "name": req.name,
        "description": req.description or "",
        "status": "draft",
        "creatorSessionKey": f"creator/agent/{agent_id}",
    }, 201


@app.get("/workspaces/<workspaceId>/agents")
def list_agents(workspaceId: str):
    _require_member(workspaceId)
    result = agents_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspaceId),
    )
    # Hide rows that are on their way out. DDB TTL will delete them
    # shortly; the UI surfacing them would just be confusing. Sweeper
    # inside the chat-server still sees them via the APA list endpoint.
    items = [
        item for item in result.get("Items", [])
        if item.get("status") != "deletion_pending"
    ]
    return {"agents": items}


@app.get("/workspaces/<workspaceId>/agents/<agentId>")
def get_agent(workspaceId: str, agentId: str):
    _require_member(workspaceId)
    return _require_agent(workspaceId, agentId)


@app.patch("/workspaces/<workspaceId>/agents/<agentId>")
def update_agent(workspaceId: str, agentId: str):
    """Patch name/description only. The agent def (prompt.md, config.json,
    scripts, …) is edited by the creator session on EFS — this endpoint
    is strictly for the metadata surfaced in the UI + supervisor appendix."""
    _require_admin(workspaceId)
    _require_agent(workspaceId, agentId)
    try:
        req = UpdateAgentRequest(**(app.current_event.json_body or {}))
    except ValidationError as e:
        raise _validation_error(e)

    update_parts: list[str] = []
    values: dict = {}
    if req.name is not None:
        update_parts.append("#n = :n")
        values[":n"] = req.name
    if req.description is not None:
        update_parts.append("description = :d")
        values[":d"] = req.description
    if not update_parts:
        raise BadRequestError("Nothing to update")

    update_parts.append("updatedAt = :u")
    values[":u"] = datetime.now(timezone.utc).isoformat()

    kwargs: dict = {
        "Key": {"workspaceId": workspaceId, "agentId": agentId},
        "UpdateExpression": "SET " + ", ".join(update_parts),
        "ExpressionAttributeValues": values,
    }
    # DDB rejects an empty ExpressionAttributeNames. Only attach it when
    # we actually reserve a keyword (the `name` attribute).
    if req.name is not None:
        kwargs["ExpressionAttributeNames"] = {"#n": "name"}
    agents_table.update_item(**kwargs)
    return {"agentId": agentId, "status": "updated"}


@app.delete("/workspaces/<workspaceId>/agents/<agentId>")
def delete_agent(workspaceId: str, agentId: str):
    """Mark the agent for deletion. Two things happen asynchronously:

      1. DDB TTL auto-deletes the row once `ttl` elapses (set below to
         now + 1h). This is the durable "row is gone" signal.
      2. The chat-server sweeps /data/agents/ periodically and rm's any
         directory whose id isn't in a still-alive (draft | deployed)
         DDB row. So the EFS dir goes away within the sweeper's cycle
         (~1h), regardless of whether the DDB row has TTL'd yet.

    No cross-service call at delete time — the Lambda just marks the
    row, returns 204, and forgets. Race-safe: ids are random-hex so
    there's no recreate-with-same-id risk during the cleanup window.
    """
    import time as _time

    _require_admin(workspaceId)
    _require_agent(workspaceId, agentId)

    # TTL = 7 days. Plenty of slack for the sweeper to pick the row
    # up even across multi-day sandbox outages. The row is hidden from
    # the UI immediately (list_agents filter below), so the long TTL
    # only matters for the EFS cleanup contract: the sweeper's rule
    # is "rm dir iff the DDB row says status=deletion_pending", so we
    # need the row to still exist when the sweeper runs.
    ttl_at = int(_time.time()) + 7 * 24 * 3600
    agents_table.update_item(
        Key={"workspaceId": workspaceId, "agentId": agentId},
        UpdateExpression="SET #s = :s, #t = :t, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status", "#t": "ttl"},
        ExpressionAttributeValues={
            ":s": "deletion_pending",
            ":t": ttl_at,
            ":u": datetime.now(timezone.utc).isoformat(),
        },
    )
    logger.info(
        "agent marked for deletion",
        extra={
            "event": "workspace_api.agent.marked_for_deletion",
            "workspaceId": workspaceId,
            "agentId": agentId,
            "ttlAt": ttl_at,
        },
    )
    return {}, 204


@app.post("/workspaces/<workspaceId>/agents/<agentId>/deploy")
def deploy_agent(workspaceId: str, agentId: str):
    """Soft-block deploy check: list available secrets (workspace-level
    integrations, custom, and agent-scoped) and diff against the DDB
    mirror of `config.json.required_secrets` maintained by the creator.

    Returns `{missing: [...], status: "missing_secrets"}` when secrets are
    missing and `?override=true` is NOT set. Returns 200 with status
    `deployed` once the flip succeeds.

    No hard-block validation in v1 — matches the spec ("soft block with
    override").
    """
    _require_admin(workspaceId)
    agent = _require_agent(workspaceId, agentId)
    override = _qs_flag("override")

    required: list[str] = agent.get("requiredSecrets") or []
    available = _list_workspace_secret_suffixes(workspaceId)

    # A required name is satisfied if it matches a typed integration
    # secret basename directly (e.g. `claude-token`) or a workspace
    # custom secret under the `custom-` prefix after normalisation.
    # There is no agent-scoped secret tier — all secrets live at
    # workspace level.
    normalized_custom = {
        s[len(CUSTOM_SECRET_PREFIX):] for s in available
        if s.startswith(CUSTOM_SECRET_PREFIX)
    }

    def _is_satisfied(name: str) -> bool:
        norm = _normalize_custom_name(name)
        return name in available or norm in normalized_custom

    missing = [n for n in required if not _is_satisfied(n)]

    if missing and not override:
        logger.info(
            "deploy blocked on missing secrets",
            extra={
                "event": "workspace_api.agent.deploy_blocked",
                "workspaceId": workspaceId,
                "agentId": agentId,
                "missingCount": len(missing),
            },
        )
        return {
            "agentId": agentId,
            "status": "missing_secrets",
            "missing": missing,
        }

    agents_table.update_item(
        Key={"workspaceId": workspaceId, "agentId": agentId},
        UpdateExpression="SET #s = :d, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":d": "deployed",
            ":u": datetime.now(timezone.utc).isoformat(),
        },
    )
    logger.info(
        "agent deployed",
        extra={
            "event": "workspace_api.agent.deployed",
            "workspaceId": workspaceId,
            "agentId": agentId,
            "override": override,
            "missingCount": len(missing),
        },
    )
    return {
        "agentId": agentId,
        "status": "deployed",
        # Surface what was overridden so the UI can display a warning banner.
        "missing": missing if override else [],
    }


# ============================================================
# Workspace access gate
# ============================================================
# Core invariant: load the workspace row and 404 if missing. Anything
# beyond existence (subscription status, plan tier, custom approval
# flow) is delegated to `workspace_access_hook.check_access`. Core
# does not know what the gate is checking; it just asks. On core
# extraction, the overlay hook file is replaced by a no-op stub.

def _require_workspace(workspace_id: str) -> dict:
    """Load a workspace row and run the access hook. Returns the row
    on success; raises NotFoundError (404) if missing, or whatever the
    access hook raises (typically ServiceError 402 in overlay deployments
    that gate on subscription state)."""
    workspace = workspaces_table.get_item(Key={"workspaceId": workspace_id}).get("Item")
    if not workspace:
        raise NotFoundError("Workspace not found")
    from workspace_access_hook import check_access

    check_access(workspace)
    return workspace


# ============================================================
# Magic link auth — extracted to lambda/workspace-api/auth_routes.py
# ============================================================
# Magic-link sign-in (Cognito admin_set_user_password + email delivery
# + branded HTML template + env-specific signup gate) is entirely
# overlay-shaped and lives in the auth_routes addon, registered
# at the bottom of this file. Core has no public auth surface; operators
# provision users some other way.


# ============================================================
# Addon registration
# ============================================================
# Overlay-only route addons attach themselves to the resolver here. The
# addon module is imported by name; on core extraction the file ships
# as a no-op `register(app)` that registers nothing. Core's index.py
# stays neutral — it doesn't know what an addon does.
import auth_routes  # noqa: E402
import billing_routes  # noqa: E402

billing_routes.register(app)
auth_routes.register(app)


# ============================================================
# Lambda entry point
# ============================================================

@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    return app.resolve(event, context)

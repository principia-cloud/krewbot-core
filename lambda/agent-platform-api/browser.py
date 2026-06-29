"""Browser session, cookie, and profile routes for the Agent Platform API.

Two cookie/auth sources, both restored at session start:

  1. **AgentCore profiles** — saved by the agent after a user completes
     a live-view login (captures cookies + localStorage + IndexedDB).
     One profile per workspace, shared across all sessions.

  2. **DDB cookies** — set by the admin through the workspace console.
     Injected via Playwright `context.addCookies()` by agent.ts after
     the session starts (on top of whatever the profile restored).

Routes:
  POST   /browser/sessions                  create/reuse (restores profile + returns DDB cookies)
  GET    /browser/sessions/current          refresh URLs (automation + optional live-view)
  DELETE /browser/sessions/{sessionId}      stop a session
  POST   /browser/sessions/{sessionId}/save-profile   save session → workspace profile
  GET    /browser/cookies                   read DDB cookies (for agent.ts injection)
"""

import json
import os
from datetime import datetime, timezone
from typing import Optional

import boto3
import botocore.session
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler.exceptions import (
    BadRequestError,
    NotFoundError,
    ServiceError,
)
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import ClientError


# Reuse Powertools JSON logging; shared across index.py via the same root.
logger = Logger(service="agent-platform-api")


AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BROWSER_ID = "aws.browser.v1"
SESSION_TIMEOUT = 900  # 15 minutes idle

_agentcore = None
_agentcore_cp = None


def _dp_client():
    global _agentcore
    if _agentcore is None:
        _agentcore = boto3.client("bedrock-agentcore", region_name=AWS_REGION)
    return _agentcore


def _cp_client():
    global _agentcore_cp
    if _agentcore_cp is None:
        _agentcore_cp = boto3.client("bedrock-agentcore-control", region_name=AWS_REGION)
    return _agentcore_cp


# ============================================================================
# Helpers
# ============================================================================

def _session_name(workspace_id: str, session_key: str) -> str:
    return f"{workspace_id}--{session_key}"


def _profile_name(workspace_id: str) -> str:
    # AgentCore profile names: [a-zA-Z][a-zA-Z0-9_]{0,47}
    safe = workspace_id.replace("-", "_").replace(".", "_")
    return f"exampleprofile_{safe}"


def _find_active_session(name: str) -> Optional[dict]:
    """Returns a READY session for this name, or None."""
    try:
        resp = _dp_client().list_browser_sessions(
            browserIdentifier=BROWSER_ID,
            status="READY",
        )
        for session in resp.get("items", []):
            if session.get("name") == name:
                return session
    except ClientError:
        logger.warning(
            "list_browser_sessions failed",
            extra={
                "event": "agent_platform.browser.list_sessions_failed",
                "sessionName": name,
            },
            exc_info=True,
        )
    return None


def _get_stream_endpoint(session_id: str, stream: str = "automationStream") -> str:
    resp = _dp_client().get_browser_session(
        browserIdentifier=BROWSER_ID,
        sessionId=session_id,
    )
    endpoint = resp.get("streams", {}).get(stream, {}).get("streamEndpoint", "")
    if not endpoint:
        raise ServiceError(502, f"Session has no {stream} endpoint")
    return endpoint


def _presign_url(url: str, expires: int = 300) -> str:
    bs = botocore.session.get_session()
    credentials = bs.get_credentials().get_frozen_credentials()
    request = AWSRequest(method="GET", url=url)
    signer = SigV4QueryAuth(credentials, "bedrock-agentcore", AWS_REGION, expires=expires)
    signer.add_auth(request)
    return request.url


def _read_profile_id(table, workspace_id: str) -> Optional[str]:
    """Read the workspace's browser profileId from DDB."""
    try:
        item = table.get_item(
            Key={"workspaceId": workspace_id},
            ProjectionExpression="browserProfileId",
        ).get("Item", {})
        return item.get("browserProfileId") or None
    except Exception:
        logger.warning(
            "failed to read browserProfileId, treating as missing",
            extra={
                "event": "agent_platform.browser.profile_read_failed",
                "workspaceId": workspace_id,
            },
            exc_info=True,
        )
        return None


def _ensure_profile(table, workspace_id: str) -> str:
    """Get or create the workspace's browser profile. Stores the
    profileId in DDB so we don't need list_browser_profiles on every
    session start."""
    existing = _read_profile_id(table, workspace_id)
    if existing:
        return existing

    name = _profile_name(workspace_id)
    try:
        resp = _cp_client().create_browser_profile(
            name=name,
            description=f"Shared browser profile for workspace {workspace_id}",
        )
        profile_id = resp["profileId"]
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConflictException":
            # Profile already exists (created in a previous call that
            # didn't persist the ID to DDB). Look it up by name.
            profile_id = _find_profile_by_name(name)
            if not profile_id:
                raise ServiceError(502, f"Profile {name} exists but couldn't be found")
        else:
            raise

    # Persist for future lookups
    table.update_item(
        Key={"workspaceId": workspace_id},
        UpdateExpression="SET browserProfileId = :p",
        ExpressionAttributeValues={":p": profile_id},
    )
    return profile_id


def _find_profile_by_name(name: str) -> Optional[str]:
    """Fallback: find a profile by name via list or get. Used when
    create returns ConflictException (profile exists but ID isn't in
    DDB)."""
    # Try get_browser_profile with the name as identifier (some
    # AgentCore APIs accept names OR IDs).
    try:
        resp = _cp_client().get_browser_profile(profileIdentifier=name)
        pid = resp.get("profileId")
        if pid:
            logger.info(
                "found profile by name via get",
                extra={
                    "event": "agent_platform.browser.profile_found_via_get",
                    "profileName": name,
                    "profileId": pid,
                },
            )
            return pid
    except Exception as e:
        logger.info(
            "get_browser_profile failed; falling back to list",
            extra={
                "event": "agent_platform.browser.profile_get_failed",
                "profileName": name,
                "errMessage": str(e),
                "expected": True,
            },
        )

    # Fallback: list all profiles and scan
    try:
        resp = _cp_client().list_browser_profiles()
        # Try every plausible key for the items list
        items = []
        for key in ("items", "browserProfiles", "profiles"):
            if key in resp and isinstance(resp[key], list):
                items = resp[key]
                break
        logger.info(
            "list_browser_profiles scanned",
            extra={
                "event": "agent_platform.browser.profile_list_scanned",
                "profileName": name,
                "itemCount": len(items),
            },
        )
        for p in items:
            for field in ("name", "profileName", "browserProfileName"):
                if p.get(field) == name:
                    return p.get("profileId")
    except Exception:
        logger.exception(
            "list_browser_profiles failed",
            extra={
                "event": "agent_platform.browser.profile_list_failed",
                "profileName": name,
            },
        )

    return None


def _read_cookies(table, workspace_id: str) -> list:
    try:
        item = table.get_item(
            Key={"workspaceId": workspace_id},
            ProjectionExpression="browserCookies",
        ).get("Item", {})
        raw = item.get("browserCookies")
        if raw:
            return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        logger.warning(
            "failed to read browserCookies, returning empty list",
            extra={
                "event": "agent_platform.browser.cookies_read_failed",
                "workspaceId": workspace_id,
                "expected": True,
            },
            exc_info=True,
        )
    return []


# ============================================================================
# Route registration
# ============================================================================

def register_browser_routes(app, with_workspace, workspaces_table):

    @app.post("/browser/sessions")
    @with_workspace
    def create_browser_session(workspace_id: str):
        """Create or reuse an AgentCore browser session.

        Restores from the workspace's AgentCore profile (if one exists)
        AND returns DDB cookies for agent.ts to inject via Playwright.
        """
        body = app.current_event.json_body or {}
        session_key = body.get("sessionKey", "")
        if not session_key:
            raise BadRequestError("sessionKey is required")

        name = _session_name(workspace_id, session_key)
        cookies = _read_cookies(workspaces_table, workspace_id)

        # Reuse existing READY session if one exists for this name.
        existing = _find_active_session(name)
        if existing:
            session_id = existing["sessionId"]
            auto_url = _get_stream_endpoint(session_id, "automationStream")
            return {
                "sessionId": session_id,
                "automationUrl": _presign_url(auto_url),
                "cookies": cookies,
                "expiresAt": existing.get("expiresAt", ""),
                "reused": True,
            }

        # Create new session — restore from profile if available
        kwargs = {
            "browserIdentifier": BROWSER_ID,
            "name": name,
            "sessionTimeoutSeconds": SESSION_TIMEOUT,
            "viewPort": {"width": 1920, "height": 1080},
        }
        profile_id = _read_profile_id(workspaces_table, workspace_id)
        if profile_id:
            kwargs["profileConfiguration"] = {"profileIdentifier": profile_id}

        try:
            resp = _dp_client().start_browser_session(**kwargs)
        except ClientError as e:
            raise ServiceError(502, f"AgentCore start_browser_session failed: {e}")

        session_id = resp["sessionId"]
        streams = resp.get("streams", {})
        auto_url = streams.get("automationStream", {}).get("streamEndpoint", "")
        if not auto_url:
            auto_url = _get_stream_endpoint(session_id, "automationStream")

        return {
            "sessionId": session_id,
            "automationUrl": _presign_url(auto_url),
            "cookies": cookies,
            "expiresAt": resp.get("expiresAt", ""),
            "reused": False,
            "profileRestored": profile_id is not None,
        }

    @app.get("/browser/sessions/current")
    @with_workspace
    def get_current_session(workspace_id: str):
        """Refresh presigned URLs. Pass liveView=true for a 5-min
        live-view URL the user can open to log in interactively."""
        session_key = app.current_event.get_query_string_value("sessionKey") or ""
        if not session_key:
            raise BadRequestError("sessionKey query param required")

        name = _session_name(workspace_id, session_key)
        existing = _find_active_session(name)
        if not existing:
            raise NotFoundError("No active session for this sessionKey")

        session_id = existing["sessionId"]
        auto_url = _get_stream_endpoint(session_id, "automationStream")
        cookies = _read_cookies(workspaces_table, workspace_id)

        result = {
            "sessionId": session_id,
            "automationUrl": _presign_url(auto_url),
            "cookies": cookies,
            "expiresAt": existing.get("expiresAt", ""),
        }

        live_view = app.current_event.get_query_string_value("liveView")
        if live_view and live_view.lower() == "true":
            try:
                lv_url = _get_stream_endpoint(session_id, "liveViewStream")
                # BrowserLiveView's DCV SDK expects HTTPS — it handles
                # the WebSocket upgrade internally. AgentCore returns
                # wss:// but generateLiveViewUrl in the TS SDK produces
                # https://.
                lv_url = lv_url.replace("wss://", "https://", 1)
                result["liveViewUrl"] = _presign_url(lv_url, expires=300)
            except Exception:
                logger.warning(
                    "live-view endpoint unavailable",
                    extra={
                        "event": "agent_platform.browser.live_view_unavailable",
                        "workspaceId": workspace_id,
                        "sessionId": session_id,
                        "expected": True,
                    },
                    exc_info=True,
                )
                result["liveViewUrl"] = None

        return result

    @app.delete("/browser/sessions/<sessionId>")
    @with_workspace
    def stop_browser_session(workspace_id: str, sessionId: str):
        try:
            _dp_client().stop_browser_session(
                browserIdentifier=BROWSER_ID,
                sessionId=sessionId,
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code != "ResourceNotFoundException":
                raise ServiceError(502, f"AgentCore stop failed: {e}")
        return {"status": "ok"}

    @app.post("/browser/sessions/<sessionId>/save-profile")
    @with_workspace
    def save_profile(workspace_id: str, sessionId: str):
        """Save the session's auth state to the workspace's AgentCore
        profile. Called by the agent after the user finishes logging
        in via the live-view link. Creates the profile on first call."""
        profile_id = _ensure_profile(workspaces_table, workspace_id)
        try:
            _dp_client().save_browser_session_profile(
                browserIdentifier=BROWSER_ID,
                sessionId=sessionId,
                profileIdentifier=profile_id,
            )
        except ClientError as e:
            raise ServiceError(502, f"save_browser_session_profile failed: {e}")
        return {"status": "ok", "profileId": profile_id}

    @app.get("/browser/cookies")
    @with_workspace
    def load_cookies(workspace_id: str):
        """Read DDB cookies (admin-managed via workspace console)."""
        return {"cookies": _read_cookies(workspaces_table, workspace_id)}

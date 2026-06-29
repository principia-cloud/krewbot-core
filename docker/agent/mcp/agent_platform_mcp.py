"""Agent Platform MCP — workspace-scoped operations via the Agent Platform API.

Replaces the file-based cron MCP (write to /control + poll for response) and
the file-snapshot directory MCP. Every tool is a single HTTPS call to the
per-workspace API, authenticated with the API key the sidecar materializes
to /config/secrets/agent-platform-key.

Tools:
    list_members()
        Workspace member roster (Cognito + Telegram identities).

    get_workspace()
        Workspace metadata (name, status).

    list_known_chats(adapter=None)
        Every chat the bot has ever observed across any adapter.

    list_known_people(adapter=None)
        Every person the bot has ever observed sending a message.

    list_cron_jobs()
        Active EventBridge cron rules for this workspace.

    create_cron_job(name, schedule, message, target=None)
        Synchronous create. Returns success or error inline — no request_id,
        no polling. `target` defaults to the originating chat (TURN_ADAPTER /
        TURN_THREAD_ID env vars set by chat-server).

    delete_cron_job(name)
        Synchronous delete.

    list_integrations()
        Names of every integration credential the workspace has configured
        (typed + custom). Names are the exact basenames `read_integration_secret`
        accepts.

    read_integration_secret(name)
        Returns the credential value the workspace admin stored. Use sparingly:
        treat the value as sensitive and never echo it back to the user verbatim.
"""

import json
import os
import re
import sys
from pathlib import Path

# Make colocated log.py importable under every load mode (see telegram_mcp.py).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx
from mcp.server.fastmcp import FastMCP

from platform_log import init_logger, log_catch

logger = init_logger("mcp-agent-platform")

mcp = FastMCP("agent_platform")

API_URL = (os.environ.get("AGENT_PLATFORM_API_URL", "") or "").rstrip("/")
KEY_PATH = Path(
    os.environ.get("AGENT_PLATFORM_KEY_PATH", "/config/secrets/agent-platform-key")
)

# Set by chat-server on the MCP subprocess so create_cron_job can default
# the cron's reply target to the chat that started this turn.
TURN_ADAPTER = os.environ.get("TURN_ADAPTER", "")
TURN_THREAD_ID = os.environ.get("TURN_THREAD_ID", "")

# Set by chat-server only on creator sessions (runCreatorTurnImpl).
# Empty string in every other session. Used as the default agent
# association for cron jobs created inside the creator chat — the
# agent being edited owns any schedule it spawns. Re-checked at
# call time of the creator-only tools further down for defense-
# in-depth.
_CREATOR_AGENT_ID = os.environ.get("CREATOR_AGENT_ID", "")

_VALID_JOB_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_VALID_SCHEDULE = re.compile(r"^(cron|rate)\(")
_VALID_ADAPTERS = {"telegram", "slack", "discord", "whatsapp", "teams", "web"}

_CHAT_PUBLIC_FIELDS = {
    "adapter", "threadId", "chatId", "type", "title", "isDM",
    "firstSeenAt", "lastSeenAt",
}
_PERSON_PUBLIC_FIELDS = {
    "adapter", "userId", "userName", "fullName", "isBot",
    "firstSeenAt", "lastSeenAt",
}


def _load_key() -> str:
    try:
        return KEY_PATH.read_text().strip()
    except FileNotFoundError:
        logger.debug(
            "agent-platform-key not yet present",
            extra={
                "event": "mcp.agent_platform.key.missing",
                "path": str(KEY_PATH),
                "expected": True,
            },
        )
        return ""
    except OSError as exc:
        log_catch(
            logger,
            "mcp.agent_platform.key.read_failed",
            exc,
            path=str(KEY_PATH),
        )
        return ""


def _request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict | str]:
    """One HTTP round trip. Returns (status, parsed-json-or-text)."""
    if not API_URL:
        logger.warning(
            "AGENT_PLATFORM_API_URL not set",
            extra={"event": "mcp.agent_platform.api_url_missing"},
        )
        return 0, {"error": "AGENT_PLATFORM_API_URL not set"}
    key = _load_key()
    if not key:
        return 0, {"error": "agent-platform-key not yet available"}
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.request(
                method,
                f"{API_URL}{path}",
                headers={"Authorization": f"Bearer {key}"},
                json=payload,
            )
    except httpx.HTTPError as e:
        log_catch(
            logger,
            "mcp.agent_platform.transport_failed",
            e,
            method=method,
            path=path,
        )
        return 0, {"error": f"transport error: {e}"}
    text = resp.text
    if not text:
        return resp.status_code, {}
    try:
        return resp.status_code, resp.json()
    except json.JSONDecodeError as exc:
        log_catch(
            logger,
            "mcp.agent_platform.bad_json",
            exc,
            method=method,
            path=path,
            status=resp.status_code,
            bodySnippet=text[:200],
        )
        return resp.status_code, text


def _err(status: int, body) -> str:
    if isinstance(body, dict):
        msg = body.get("error") or body.get("message") or json.dumps(body)
    else:
        msg = str(body)
    return json.dumps({"status": "error", "httpStatus": status, "error": msg})


def _pick(item: dict, allowed: set[str]) -> dict:
    return {k: v for k, v in item.items() if k in allowed}


# ===========================================================================
# Workspace + members
# ===========================================================================

@mcp.tool()
def list_members() -> str:
    """Return the workspace member roster.

    Each entry has `userId` (Cognito sub), `role` ("admin" or "member"),
    and optional `telegramUserId` / `telegramUsername` if the member has
    linked their Telegram identity.
    """
    status, body = _request("GET", "/members")
    if status != 200:
        return _err(status, body)
    members = body.get("members", []) if isinstance(body, dict) else []
    if not members:
        return "No members."
    return json.dumps(members, indent=2, sort_keys=True)


@mcp.tool()
def get_workspace() -> str:
    """Return workspace metadata (name, status, etc.)."""
    status, body = _request("GET", "/workspace")
    if status != 200:
        return _err(status, body)
    return json.dumps(body, indent=2, sort_keys=True, default=str)


# ===========================================================================
# Chat directory
# ===========================================================================

@mcp.tool()
def list_known_chats(adapter: str | None = None) -> str:
    """List every chat the bot has ever observed, across all adapters.

    Each entry includes `adapter`, `threadId`, `chatId`, `type`, `title`,
    `isDM`, `firstSeenAt`, and `lastSeenAt`. The `threadId` is the string
    you pass as `target.threadId` to `create_cron_job` to route a cron
    reply into this chat.

    This tool deliberately does NOT return any message content — only
    metadata about which chats exist.

    Args:
        adapter: Optional filter, e.g. "telegram", "slack", "whatsapp",
            "teams", "web". When omitted, returns chats from every adapter.
    """
    status, body = _request("GET", "/chats")
    if status != 200:
        return _err(status, body)
    chats = body.get("chats", []) if isinstance(body, dict) else []
    if adapter:
        chats = [c for c in chats if c.get("adapter") == adapter]
    if not chats:
        return "No chats known."
    redacted = [_pick(c, _CHAT_PUBLIC_FIELDS) for c in chats]
    return json.dumps(redacted, indent=2, sort_keys=True, default=str)


@mcp.tool()
def list_known_people(adapter: str | None = None) -> str:
    """List every person the bot has ever observed sending a message.

    Each entry includes `adapter`, `userId`, `userName`, `fullName`,
    `isBot`, `firstSeenAt`, and `lastSeenAt`. This is observation-only:
    a person appears here once they've sent at least one message the
    bot saw.

    Args:
        adapter: Optional filter, e.g. "telegram", "slack", ...
    """
    status, body = _request("GET", "/people")
    if status != 200:
        return _err(status, body)
    people = body.get("people", []) if isinstance(body, dict) else []
    if adapter:
        people = [p for p in people if p.get("adapter") == adapter]
    if not people:
        return "No people known."
    redacted = [_pick(p, _PERSON_PUBLIC_FIELDS) for p in people]
    return json.dumps(redacted, indent=2, sort_keys=True, default=str)


# ===========================================================================
# Cron CRUD — synchronous via the Agent Platform API
# ===========================================================================

@mcp.tool()
def list_cron_jobs() -> str:
    """List all active cron jobs for this workspace."""
    status, body = _request("GET", "/cron/jobs")
    if status != 200:
        return _err(status, body)
    jobs = body.get("jobs", []) if isinstance(body, dict) else []
    if not jobs:
        return "No cron jobs configured."
    return json.dumps(jobs, indent=2, sort_keys=True)


@mcp.tool()
def create_cron_job(
    name: str,
    schedule: str,
    message: str,
    target: dict | None = None,
    agent_id: str | None = None,
) -> str:
    """Create a scheduled cron job that delivers a message to the agent.

    When the cron fires, the agent runs a fresh turn with `message` as the
    prompt. If `target` is set, the agent's final text reply is delivered
    into that chat via the Chat SDK adapter; otherwise the reply is dropped
    and the cron is treated as a pure-side-effect job (e.g. updates to
    `context.md`, API calls).

    Synchronous: returns the result of the create immediately (success or
    error). No request_id, no polling.

    Args:
        name: Job name (alphanumeric, hyphens, underscores, max 64 chars)
        schedule: AWS EventBridge schedule expression, e.g. "rate(5 minutes)"
            or "cron(0 9 * * ? *)"
        message: The prompt/instruction the agent will receive when this
            cron fires
        target: Optional routing target for the agent's reply. Shape:
            {"adapter": "telegram"|"slack"|..., "threadId": "..."}.
            Defaults to the chat this cron is being created from (when
            invoked inside a chat-originated turn). To target a different
            chat, look up its threadId via `list_known_chats`.
        agent_id: Optional id of the deployed agent this schedule is FOR.
            When set, the schedule is associated with that agent in the
            UI and is automatically deleted when the agent is deleted.
            Set this whenever the user is asking you to schedule work
            on behalf of a specific deployed agent (e.g. "have the
            Newsletter Agent run every morning"). Inside a creator
            session this defaults automatically to the agent being
            edited; set it explicitly otherwise.
    """
    if not _VALID_JOB_NAME.match(name):
        return json.dumps({
            "status": "error",
            "error": f"Invalid job name: {name!r}. Must match [a-zA-Z0-9_-]{{1,64}}",
        })
    if not _VALID_SCHEDULE.match(schedule):
        return json.dumps({
            "status": "error",
            "error": f"Invalid schedule: {schedule!r}. Must start with cron( or rate(",
        })

    resolved_target: dict | None
    if target is None:
        if TURN_ADAPTER and TURN_THREAD_ID:
            resolved_target = {"adapter": TURN_ADAPTER, "threadId": TURN_THREAD_ID}
        else:
            resolved_target = None
    else:
        adapter = target.get("adapter")
        thread_id = target.get("threadId")
        if not isinstance(adapter, str) or adapter not in _VALID_ADAPTERS:
            return json.dumps({
                "status": "error",
                "error": f"Invalid target.adapter: {adapter!r}. Must be one of {sorted(_VALID_ADAPTERS)}",
            })
        if not isinstance(thread_id, str) or not thread_id:
            return json.dumps({
                "status": "error",
                "error": "target.threadId must be a non-empty string",
            })
        resolved_target = {"adapter": adapter, "threadId": thread_id}

    # Default the agent association when running inside a creator
    # session — the agent being edited owns any cron it spawns.
    resolved_agent_id = agent_id or (_CREATOR_AGENT_ID or None)
    if resolved_agent_id is not None and not isinstance(resolved_agent_id, str):
        return json.dumps({
            "status": "error",
            "error": "agent_id must be a string when provided",
        })

    payload: dict = {"name": name, "schedule": schedule, "message": message}
    if resolved_target is not None:
        payload["target"] = resolved_target
    if resolved_agent_id:
        payload["agentId"] = resolved_agent_id

    status, body = _request("POST", "/cron/jobs", payload)
    if status != 200:
        return _err(status, body)

    target_note = (
        f" (target: {resolved_target['adapter']}:{resolved_target['threadId']})"
        if resolved_target is not None
        else " (no target — reply will be dropped)"
    )
    agent_note = f" (for agent: {resolved_agent_id})" if resolved_agent_id else ""
    rule_name = body.get("ruleName", "?") if isinstance(body, dict) else "?"
    return f"Cron job '{name}' created (rule={rule_name}){target_note}{agent_note}."


@mcp.tool()
def delete_cron_job(name: str) -> str:
    """Delete a scheduled cron job. Synchronous."""
    if not _VALID_JOB_NAME.match(name):
        return json.dumps({"status": "error", "error": f"Invalid job name: {name!r}"})

    status, body = _request("DELETE", f"/cron/jobs/{name}")
    if status != 200:
        return _err(status, body)
    return f"Cron job '{name}' deleted."


# ===========================================================================
# Integration credentials — read-only view of /config/secrets
# ===========================================================================
#
# The sidecar's sync loop (docker/sidecar/jobs/sync.py) mirrors every
# per-workspace Secrets Manager entry under the workspace secrets prefix
# to a file at SECRETS_DIR/<basename>. We expose two tools here so the model
# can discover and consume those credentials without having to shell out
# to `ls` / `cat`. The filesystem is the source of truth; these tools are
# just ergonomics on top.
#
# SECRET_SYSTEM_BASENAMES holds names that belong to the platform, not to
# a user integration (the chat-server's API key, the cron-trigger HMAC
# key). The model never needs them — hide from list + deny on read.
SECRETS_DIR = Path(os.environ.get("SECRETS_DIR", "/config/secrets"))
SECRET_SYSTEM_BASENAMES: frozenset[str] = frozenset({
    "agent-platform-key",
    "cron-trigger-key",
})
CUSTOM_SECRET_PREFIX = "custom-"
# Allows uppercase + underscores in the user-facing name; storage key is
# normalised (see workspace-api's _normalize_custom_name). Accepted here
# so the agent can pass back whatever the admin typed.
_VALID_SECRET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,126}$")


def _normalize_secret_name(name: str) -> str:
    """Match workspace-api's _normalize_custom_name so the agent can call
    read_integration_secret with either the storage key or the friendly
    name the admin originally set."""
    return name.lower().replace("_", "-")


def _list_secret_basenames() -> list[str]:
    """Every file under SECRETS_DIR that isn't a system credential.
    Silently skips dotfiles, subdirectories, and the system blocklist."""
    try:
        entries = sorted(p.name for p in SECRETS_DIR.iterdir() if p.is_file())
    except FileNotFoundError:
        return []
    except PermissionError as exc:
        log_catch(
            logger,
            "mcp.secrets.list_denied",
            exc,
            secretsDir=str(SECRETS_DIR),
        )
        return []
    return [
        name for name in entries
        if not name.startswith(".")
        and name not in SECRET_SYSTEM_BASENAMES
    ]


def _parse_custom_envelope(raw: str) -> tuple[str, str | None]:
    """Parse the `{"value", "displayName"}` envelope workspace-api writes
    into custom-* secrets. Returns (raw_value, display_name_or_None).

    Tolerates legacy secrets that pre-date the envelope: if `raw` is not
    a JSON object with a string `value`, it's treated as the raw value
    itself with no display name.
    """
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw, None
    if not isinstance(parsed, dict):
        return raw, None
    value = parsed.get("value")
    if not isinstance(value, str):
        return raw, None
    display = parsed.get("displayName")
    return value, display if isinstance(display, str) and display else None


@mcp.tool()
def list_integrations() -> str:
    """List the integration credentials configured for this workspace.

    Returns a JSON array of `{name, kind, displayName}` objects:
      - `name` is the value you pass to `read_integration_secret`. For
        typed integrations it's the basename (e.g. `claude-token`); for
        custom ones it's the short key (e.g. `github-pat`) — the
        `custom-` storage prefix is stripped for you.
      - `kind` is `"typed"` (set via `PUT /integrations/{name}`) or
        `"custom"` (admin-defined via `PUT /integrations/{name}` with
        `custom=true`).
      - `displayName` is the admin's original human-friendly name
        (e.g. `My_GitHub_PAT`). For typed integrations and for custom
        secrets predating the displayName feature, it mirrors `name`.

    Values are never returned here — call `read_integration_secret` for
    a single credential when you need the actual token.
    """
    out = []
    for basename in _list_secret_basenames():
        if basename.startswith(CUSTOM_SECRET_PREFIX):
            short = basename[len(CUSTOM_SECRET_PREFIX):]
            display: str | None = None
            # The secret file is a JSON envelope carrying the display
            # name alongside the raw value. Peek at it for the list.
            try:
                _, display = _parse_custom_envelope(
                    (SECRETS_DIR / basename).read_text()
                )
            except OSError as exc:
                log_catch(
                    logger, "mcp.secrets.list_read_failed", exc,
                    secretName=basename,
                )
            out.append({
                "name": short,
                "kind": "custom",
                "displayName": display or short,
            })
        else:
            out.append({
                "name": basename,
                "kind": "typed",
                "displayName": basename,
            })
    return json.dumps(out)


@mcp.tool()
def read_integration_secret(name: str) -> str:
    """Return the value of a single integration credential.

    Treat the result as sensitive. Use it to authenticate outbound calls
    (`curl -H "Authorization: Bearer $TOKEN" …`, git push, API SDK init)
    and never echo it back verbatim in chat replies or log lines.

    Args:
        name: Either the short name returned by `list_integrations`
            (e.g. `github-pat` for a custom integration, `claude-token`
            for a typed one) OR the admin's original friendly name
            (`My_GitHub_PAT`). Friendly names are lowercased and
            underscore-to-dash normalised before lookup.
    """
    if not isinstance(name, str) or not _VALID_SECRET_NAME.match(name):
        return json.dumps({
            "status": "error",
            "error": f"Invalid secret name: {name!r}",
        })
    normalized = _normalize_secret_name(name)
    if normalized in SECRET_SYSTEM_BASENAMES:
        return json.dumps({
            "status": "error",
            "error": f"Secret {name!r} is platform-internal and not readable",
        })

    # Resolution order: exact match first (covers typed basenames and
    # any legacy caller still passing `custom-…`), then the custom-
    # prefixed form. This lets the agent pass whichever shape
    # `list_integrations` returned.
    candidates = [normalized]
    if not normalized.startswith(CUSTOM_SECRET_PREFIX):
        candidates.append(f"{CUSTOM_SECRET_PREFIX}{normalized}")

    path: Path | None = None
    for candidate in candidates:
        p = SECRETS_DIR / candidate
        if p.is_file():
            path = p
            break
    if path is None:
        return json.dumps({
            "status": "error",
            "error": f"No secret configured for {name!r}",
        })
    try:
        # strict resolution — reject anything whose realpath escapes
        # SECRETS_DIR (defence-in-depth even though the regex already
        # forbids slashes and dotfiles).
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        return json.dumps({
            "status": "error",
            "error": f"No secret configured for {name!r}",
        })
    except OSError as exc:
        log_catch(
            logger,
            "mcp.secrets.resolve_failed",
            exc,
            secretName=name,
        )
        return json.dumps({
            "status": "error",
            "error": f"Cannot read secret {name!r}",
        })
    secrets_root = SECRETS_DIR.resolve(strict=False)
    try:
        resolved.relative_to(secrets_root)
    except ValueError:
        logger.warning(
            "secret path escaped SECRETS_DIR",
            extra={
                "event": "mcp.secrets.path_escape_rejected",
                "secretName": name,
                "resolved": str(resolved),
            },
        )
        return json.dumps({
            "status": "error",
            "error": f"Invalid secret name: {name!r}",
        })

    try:
        raw = resolved.read_text()
    except OSError as exc:
        log_catch(
            logger,
            "mcp.secrets.read_failed",
            exc,
            secretName=name,
        )
        return json.dumps({
            "status": "error",
            "error": f"Cannot read secret {name!r}",
        })

    # Custom secrets are stored as a `{"value", "displayName"}` envelope;
    # unwrap to the raw value. Typed secrets (and pre-envelope custom
    # secrets) fall through unchanged thanks to the parser's fallback.
    if resolved.name.startswith(CUSTOM_SECRET_PREFIX):
        value, _ = _parse_custom_envelope(raw)
    else:
        value = raw

    logger.info(
        "integration secret read",
        extra={"event": "mcp.secrets.read", "secretName": name},
    )
    # Plain string (not JSON-wrapped) so the model can splice it directly
    # into a header/body. Trailing newlines are stripped — Secrets Manager
    # round-trips them faithfully but API consumers usually don't want one.
    return value.rstrip("\n")


# ===========================================================================
# Creator-only tools — gated by CREATOR_AGENT_ID env var.
#
# These tools are registered ONLY when CREATOR_AGENT_ID is set in the MCP
# subprocess's environment. chat-server's runCreatorTurnImpl sets that
# var; every other session (supervisor, cron, bg, runtime agent, test
# chat) leaves it unset. Result: these tools are literally not visible
# to the model in any non-creator session — nothing to refuse, nothing
# to discover.
#
# The tools also re-check the env at call time (defense in depth) so a
# misconfigured session that somehow carries the env without being a
# real creator session still can't mutate agents belonging to other
# contexts.
# ===========================================================================

# (_CREATOR_AGENT_ID is defined near the top of the file so
# create_cron_job can default to it without a forward ref.)

if _CREATOR_AGENT_ID:
    @mcp.tool()
    def create_workspace_secret(name: str, value: str) -> str:
        """Save a workspace-level custom secret the user just gave you.

        Use this when the user provides a credential mid-chat (e.g. an
        Asana API token) and explicitly consents to saving it. The secret
        lands in the same workspace storage the Integrations UI manages,
        so every agent in the workspace can then reference it by name.

        Rules:
          - Only call after the user has explicitly confirmed they want
            this value saved. Do not save opportunistically.
          - Names are normalised (lowercased, underscores → dashes). The
            value can be up to 8 KB.
          - Secret VALUES are never returned by any API or tool. Once saved,
            you can only reference the secret by name; the runtime agent
            reads it from /config/secrets/custom-{normalized-name}.

        Args:
            name: human-friendly identifier (letters/digits/underscores/
                dashes, up to 63 chars).
            value: the secret value, as the user supplied it.

        Returns JSON describing the normalised name + display name on
        success, or an error payload.
        """
        status, body = _request(
            "POST",
            "/workspace/custom-secrets",
            payload={"name": name, "value": value},
        )
        if status != 200:
            return _err(status, body)
        return json.dumps(body if isinstance(body, dict) else {"status": "ok"})

    @mcp.tool()
    def delete_workspace_secret(name: str) -> str:
        """Remove a workspace custom secret. Idempotent — succeeds even
        if no secret by that name exists.

        Use sparingly; most deletions are done by the admin through the
        Integrations UI. Typical creator-side use is undoing a typo
        immediately after calling `create_workspace_secret`.

        Args:
            name: same human-friendly identifier used at creation. Gets
                normalised the same way on the server.
        """
        status, body = _request("DELETE", f"/workspace/custom-secrets/{name}")
        if status != 200:
            return _err(status, body)
        return json.dumps(body if isinstance(body, dict) else {"status": "ok"})

    @mcp.tool()
    def save_agent_metadata(
        required_secrets: list[str] | None = None,
        description: str | None = None,
    ) -> str:
        """Mirror this agent's `required_secrets` and/or `description` onto
        the platform's DDB row so the deploy-check can diff against
        available secrets without reading EFS.

        Call this whenever you update `def/config.json.required_secrets`
        or the description — the platform's view becomes stale otherwise
        and the user sees a misleading deploy-check banner.

        Args:
            required_secrets: exact basenames the runtime agent expects
                under /config/secrets/ (e.g. ["notion-token", "asana-token"]).
                Pass an empty list to clear.
            description: one-sentence summary of what the agent does. Used
                by the workspace supervisor to route requests.

        Returns success JSON on ok, error JSON on failure.
        """
        payload: dict = {}
        if required_secrets is not None:
            payload["requiredSecrets"] = required_secrets
        if description is not None:
            payload["description"] = description
        if not payload:
            return json.dumps({
                "status": "error",
                "error": "Pass at least one of required_secrets or description.",
            })
        status, body = _request(
            "PUT",
            f"/agents/{_CREATOR_AGENT_ID}/metadata",
            payload=payload,
        )
        if status != 200:
            return _err(status, body)
        return json.dumps({"status": "ok", "agentId": _CREATOR_AGENT_ID})


# ===========================================================================
# Browser — live-view login + profile management
# ===========================================================================

SESSION_KEY = os.environ.get("SESSION_KEY", "")


@mcp.tool()
def browser_request_user_login(instructions: str | None = None) -> str:
    """Get a live-view URL the user can open to log in interactively.

    When you encounter a login page, captcha, or MFA challenge that you
    can't get past with Playwright tools, call this to get a URL you
    can send to the user. They open it in their browser, see the same
    browser you're connected to (live, bidirectional), and type their
    credentials. The URL expires in 5 minutes.

    After the user confirms they're done, call `browser_save_profile()`
    to persist the login so future sessions start pre-authenticated.

    Args:
        instructions: Optional context to include in the message to the
            user (e.g. "Please log in to Gmail").
    """
    if not SESSION_KEY:
        return json.dumps({"status": "error", "error": "SESSION_KEY not set"})

    status, body = _request(
        "GET",
        f"/browser/sessions/current?sessionKey={SESSION_KEY}&liveView=true",
    )
    if status != 200:
        return _err(status, body)

    lv_url = body.get("liveViewUrl") if isinstance(body, dict) else None
    if not lv_url:
        return json.dumps({
            "status": "error",
            "error": "No live-view URL available — is there an active browser session?",
        })

    session_id = body.get("sessionId", "?") if isinstance(body, dict) else "?"
    hint = f" {instructions}" if instructions else ""

    # Build a user-friendly URL that renders the DCV live-view in the
    # workspace console. The raw presigned URL is base64-encoded in the
    # query param so the user sees a clean link, not a 1700-char blob.
    import base64
    encoded = base64.b64encode(lv_url.encode()).decode()
    app_url = os.environ["APP_URL"]
    user_url = f"{app_url}/browser-live?url={encoded}"

    return (
        f"Send this link to the user and ask them to open it, log in, "
        f"then reply 'done'.{hint}\n\n"
        f"Link: {user_url}\n\n"
        f"After they confirm, call `browser_save_profile()` to persist "
        f"the login for future sessions.\n"
        f"(session_id={session_id})"
    )


@mcp.tool()
def browser_save_profile() -> str:
    """Save the current browser session's auth state (cookies,
    localStorage, IndexedDB) to the workspace's profile.

    Call this AFTER the user finishes logging in via the live-view
    link. Future browser sessions for this workspace will start
    pre-authenticated — no need to log in again.

    This is the ONLY way to persist login state across browser
    sessions. Without calling this, the login is lost when the
    session times out (15 min idle).
    """
    if not SESSION_KEY:
        return json.dumps({"status": "error", "error": "SESSION_KEY not set"})

    # First, find the active session for this session key
    status, body = _request(
        "GET",
        f"/browser/sessions/current?sessionKey={SESSION_KEY}",
    )
    if status != 200:
        return _err(status, body)

    session_id = body.get("sessionId") if isinstance(body, dict) else None
    if not session_id:
        return json.dumps({"status": "error", "error": "No active browser session"})

    # Save the profile
    status, body = _request("POST", f"/browser/sessions/{session_id}/save-profile")
    if status != 200:
        return _err(status, body)

    return "Profile saved. Future browser sessions will start with this login state."


if __name__ == "__main__":
    mcp.run()

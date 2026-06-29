"""Chat MCP — proactive cross-chat / multi-message send + background tasks.

Wraps the chat-server's loopback `/internal/*` endpoints so the agent can:

    * push a message to any chat on any adapter from within a turn
      (chat_send / chat_send_file),
    * spawn, stop, and list long-running background tasks that run in
      parallel to the main conversation (spawn_background_task /
      stop_background_task / list_background_tasks).

The background-task tools are only registered when `IS_BACKGROUND != "1"`
— background turns themselves don't get them (flat recursion model).

When to use chat_send vs. just writing text:

    - **Reply to the current chat:** just write text as your final
      assistant message. The runtime posts it automatically. Do NOT call
      this tool for regular replies — it's redundant.
    - **Send an additional message before/during your reply:** use this
      tool (e.g. send a "working on it..." while you compute).
    - **Send a message to a DIFFERENT chat than the one that sent you
      this turn:** use this tool with explicit `adapter` + `thread_id`.
    - **Schedule a future / recurring message:** use `create_cron_job`,
      not this tool.

Under the hood, the chat-server calls Chat SDK's `adapter.postMessage()`
which is the same uniform send API every adapter implements (telegram,
slack, whatsapp, teams). No per-platform logic here.
"""

import os
import sys
from pathlib import Path

# Ensure log.py (colocated in this directory) is importable regardless of
# how this module was loaded: as a script (python3 /app/mcp/chat_mcp.py
# — subprocess case, script dir auto-added) or via importlib's
# spec_from_file_location (integration tests — no auto-add).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx
from mcp.server.fastmcp import FastMCP

from platform_log import init_logger, log_catch

logger = init_logger("mcp-chat")

mcp = FastMCP("chat")

# Loopback endpoint served by the chat-server inside the same container.
CHAT_SERVER_URL = os.environ.get("CHAT_SERVER_URL", "http://localhost:8080")
INTERNAL_KEY_PATH = Path(
    os.environ.get("INTERNAL_KEY_PATH", "/config/secrets/cron-trigger-key")
)

# Auto-default adapter/thread_id for the "send to current chat" case.
# Set by agent.ts:buildMcpServers per turn.
TURN_ADAPTER = os.environ.get("TURN_ADAPTER", "")
TURN_THREAD_ID = os.environ.get("TURN_THREAD_ID", "")
# Session working directory — used by chat_send_file to resolve relative
# paths (e.g. ".playwright-mcp/page.png") to absolute paths the
# chat-server can read from EFS.
SESSION_CWD = os.environ.get("SESSION_CWD", "")
# Parent session key (same as the main turn's sessionKey). Forwarded
# to /internal/spawn so the bg task reuses this turn's cwd.
SESSION_KEY = os.environ.get("SESSION_KEY", "")
# Background turns set IS_BACKGROUND=1; the spawn/stop/list tools are
# not registered when that's set (flat recursion rule).
IS_BACKGROUND = os.environ.get("IS_BACKGROUND", "0") == "1"
# Identifier of the currently-running main-thread turn, used for
# "stoppedBy" attribution when the model calls stop_background_task.
# We don't have a real turnId from the chat-server process (turns are
# short-lived and anonymous from the MCP subprocess perspective), so
# we use the PID of the Claude CLI process as a pragmatic proxy.
CALLER_TURN_ID = f"pid-{os.getpid()}"


def _load_internal_key() -> str:
    try:
        return INTERNAL_KEY_PATH.read_text().strip()
    except FileNotFoundError:
        # Expected before the sidecar has materialized the file.
        logger.debug(
            "internal key file not yet present",
            extra={
                "event": "mcp.chat.key.missing",
                "path": str(INTERNAL_KEY_PATH),
                "expected": True,
            },
        )
        return ""
    except OSError as exc:
        log_catch(
            logger,
            "mcp.chat.key.read_failed",
            exc,
            path=str(INTERNAL_KEY_PATH),
        )
        return ""


@mcp.tool()
async def chat_send(
    text: str,
    adapter: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Send a message proactively to any chat on any platform.

    Use this ONLY when you need to do something other than reply to the
    current chat. For a normal reply — the chat that sent you this turn
    — just write your response text and end the turn. The runtime posts
    your text automatically, no tool call needed.

    Use cases for this tool:
      - Send an extra message mid-turn (status update, follow-up, etc.)
      - Send a message to a DIFFERENT chat than the one that sent you
        this turn (look up the destination with `list_known_chats`)
      - Send a message from a cron turn to a chat other than the cron's
        pre-configured target

    On the WEB channel this works too, but only for BACKGROUND TASKS:
    a web-originated bg task's turn defaults `adapter` to "web", and the
    message is delivered into the originating web session's transcript
    (it appears in the UI on the next poll/refresh — near-live). This is
    how a bg task streams incremental progress to a web user. In a normal
    (inline) web turn there's no adapter, so don't call this — just write
    text and it streams live over SSE.

    Args:
        text: The message text (plain text, will be posted as-is).
        adapter: Target adapter name — "telegram", "slack", "whatsapp",
            "teams", or "web" (web only from a background task; defaults
            to the current turn's adapter, if set).
        thread_id: Target thread_id (the full Chat-SDK-encoded string
            like "telegram:12345", NOT just the numeric chat id). Look
            it up via `list_known_chats` for chats you don't already
            have. Defaults to the current turn's thread_id, if set.

    Returns:
        A short confirmation string, or an error message.
    """
    resolved_adapter = (adapter or TURN_ADAPTER).strip()
    resolved_thread_id = (thread_id or TURN_THREAD_ID).strip()

    if not resolved_adapter or not resolved_thread_id:
        return (
            "Error: adapter and thread_id are required. Either pass them "
            "explicitly, or call this tool from a turn where "
            "TURN_ADAPTER and TURN_THREAD_ID are set (an inbound chat "
            "turn, or a cron turn with a target)."
        )
    if not text or not text.strip():
        return "Error: text must be a non-empty string."

    key = _load_internal_key()
    if not key:
        return "Error: internal key not available — cannot authenticate to chat-server."

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{CHAT_SERVER_URL}/internal/chat-send",
                headers={"X-Internal-Key": key},
                json={
                    "adapter": resolved_adapter,
                    "threadId": resolved_thread_id,
                    "text": text,
                },
                timeout=15.0,
            )
    except httpx.HTTPError as e:
        log_catch(
            logger,
            "mcp.chat.send.http_failed",
            e,
            adapterName=resolved_adapter,
            threadId=resolved_thread_id,
        )
        return f"Error calling chat-server: {e}"

    if resp.status_code == 200:
        try:
            body = resp.json()
            return f"Sent to {resolved_adapter}:{resolved_thread_id} (id={body.get('id', '?')})."
        except ValueError as exc:
            log_catch(
                logger,
                "mcp.chat.send.bad_response_json",
                exc,
                adapterName=resolved_adapter,
                threadId=resolved_thread_id,
            )
            return f"Sent to {resolved_adapter}:{resolved_thread_id}."
    logger.warning(
        "chat-server non-200 response",
        extra={
            "event": "mcp.chat.send.non_2xx",
            "adapterName": resolved_adapter,
            "threadId": resolved_thread_id,
            "status": resp.status_code,
            "bodySnippet": resp.text[:200],
        },
    )
    return f"Error ({resp.status_code}): {resp.text}"


@mcp.tool()
async def chat_send_file(
    file_path: str,
    caption: str | None = None,
    adapter: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Send a file (image, document, etc.) to a chat.

    Use this to send screenshots, generated files, or any other file
    to the current chat or a specific chat. The file is uploaded and
    delivered as an attachment — the user sees the actual image/document,
    not a file path.

    Common use case: after taking a browser screenshot, call this tool
    with the screenshot path to send the image to the user.

    Args:
        file_path: Absolute path to the file to send (must be under
            /data/sessions/ for security).
        caption: Optional text to accompany the file (e.g. "Here's the
            screenshot of example.com").
        adapter: Target adapter (defaults to current turn's adapter).
        thread_id: Target thread (defaults to current turn's thread).
    """
    resolved_adapter = (adapter or TURN_ADAPTER).strip()
    resolved_thread_id = (thread_id or TURN_THREAD_ID).strip()

    if not resolved_adapter or not resolved_thread_id:
        return "Error: adapter and thread_id required."
    if not file_path or not file_path.strip():
        return "Error: file_path required."

    # Resolve relative paths against the session's working directory.
    # The Playwright MCP returns paths like ".playwright-mcp/page.png"
    # relative to the session cwd; the chat-server endpoint needs the
    # absolute path to read the file from EFS.
    resolved_path = file_path.strip()
    if not os.path.isabs(resolved_path) and SESSION_CWD:
        resolved_path = os.path.join(SESSION_CWD, resolved_path)

    key = _load_internal_key()
    if not key:
        return "Error: internal key not available."

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{CHAT_SERVER_URL}/internal/chat-send-file",
                headers={"X-Internal-Key": key},
                json={
                    "adapter": resolved_adapter,
                    "threadId": resolved_thread_id,
                    "filePath": resolved_path,
                    "caption": caption or "",
                    # Trusted (env-derived, not a model arg): lets the
                    # chat-server confine the file to THIS session's dir.
                    "sessionCwd": SESSION_CWD,
                },
                timeout=30.0,
            )
    except httpx.HTTPError as e:
        log_catch(
            logger,
            "mcp.chat.send_file.http_failed",
            e,
            adapterName=resolved_adapter,
            threadId=resolved_thread_id,
            filePath=resolved_path,
        )
        return f"Error calling chat-server: {e}"

    if resp.status_code == 200:
        return f"File sent to {resolved_adapter}:{resolved_thread_id}."
    logger.warning(
        "chat-server non-200 response for file send",
        extra={
            "event": "mcp.chat.send_file.non_2xx",
            "adapterName": resolved_adapter,
            "threadId": resolved_thread_id,
            "status": resp.status_code,
            "bodySnippet": resp.text[:200],
        },
    )
    return f"Error ({resp.status_code}): {resp.text}"


# ---------------------------------------------------------------------------
# Background-task tools — only registered for main-thread turns.
# Background turns don't get these (flat recursion: a bg task can't spawn
# another bg task). Gated by the IS_BACKGROUND env var set by
# agent.ts:buildMcpServers.
# ---------------------------------------------------------------------------

if not IS_BACKGROUND:

    @mcp.tool()
    async def spawn_background_task(
        prompt: str,
        resume_from: str | None = None,
    ) -> str:
        """Start a long-running background task and return its taskId immediately.

        Use this for work that would take more than ~30 seconds (deep
        research, long scrapes, multi-step build/test loops). The background
        task runs with the SAME tools you have except that it can't spawn
        more background tasks, and its working directory is THIS workspace's
        cwd — so any files it creates are visible to you in future turns.

        Do NOT use this for quick work you can finish inline in one or two
        tool calls. The spawn has overhead and a separate conversation
        context, so using it for short work is wasteful.

        Before spawning, call `list_background_tasks()` to see capacity.
        If the system is at capacity (error "at_capacity"):
          - if the request is long-running: tell the user "I'm at capacity
            with other long tasks; I'll handle this inline, which may take
            a while" and do it inline.
          - if the request is short: just do it inline silently.

        The background task's prompt MUST be self-contained — it starts
        fresh with no chat history. Include everything it needs to know.

        When it finishes, the user sees its final reply as a NEW message
        in this chat. You may also see the result in future turns as
        chat context.

        Args:
            prompt: Self-contained prompt for the background task. Include
                any context, acceptance criteria, and output format needed.
            resume_from: Optional taskId of a PRIOR task whose work you want
                to continue. The new task receives a summary of the old
                one's description/todo/snapshot automatically, and should
                read `{cwd}/bg-state/{prior-taskId}/` for any committed
                intermediate state.

        Returns:
            The new taskId on success, or a structured error string like
            "Error: at_capacity (3/3 active)" / "Error: resume_miss".
        """
        if not prompt or not prompt.strip():
            return "Error: prompt must be a non-empty string."
        if not SESSION_KEY:
            return (
                "Error: spawn_background_task requires a session context "
                "(SESSION_KEY). Not available here."
            )
        # Pick where the finished task's reply gets delivered. Adapter
        # channels (telegram/slack/whatsapp/teams) deliver via
        # adapter.postMessage to a persistent platform thread. The web
        # channel has no adapter, so we tag it "web" and the chat-server
        # writes the reply into this session's durable transcript instead
        # (picked up on the next page load / poll). Refuse only when there
        # is genuinely nowhere to deliver — e.g. a cron turn with no target.
        if TURN_ADAPTER and TURN_THREAD_ID:
            parent_adapter = TURN_ADAPTER
            parent_thread_id = TURN_THREAD_ID
        elif SESSION_KEY.startswith("http/"):
            parent_adapter = "web"
            # The web delivery path keys off parentSessionKey, not the
            # threadId; we still send a non-empty sentinel so the
            # chat-server's "parentThreadId required" check passes.
            parent_thread_id = SESSION_KEY
        else:
            return (
                "Error: spawn_background_task has no delivery target for this "
                "turn (no adapter thread, and not a web session). "
                "Not available here."
            )
        key = _load_internal_key()
        if not key:
            return "Error: internal key not available — cannot authenticate to chat-server."

        body = {
            "prompt": prompt,
            "parentSessionKey": SESSION_KEY,
            "parentAdapter": parent_adapter,
            "parentThreadId": parent_thread_id,
            "callerTurnId": CALLER_TURN_ID,
        }
        if resume_from:
            body["resumeFrom"] = resume_from

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{CHAT_SERVER_URL}/internal/spawn",
                    headers={"X-Internal-Key": key},
                    json=body,
                    timeout=15.0,
                )
        except httpx.HTTPError as e:
            log_catch(logger, "mcp.chat.bg_spawn.http_failed", e)
            return f"Error calling chat-server: {e}"

        if resp.status_code == 200:
            try:
                data = resp.json()
                task_id = data.get("taskId", "?")
                return (
                    f"Started background task `{task_id}`. It runs in parallel "
                    f"with this chat. Tell the user you've started it and they "
                    f"can keep chatting; its final result will arrive as a new "
                    f"message. Use stop_background_task('{task_id}') if needed."
                )
            except ValueError as exc:
                log_catch(logger, "mcp.chat.bg_spawn.bad_response_json", exc)
                return f"Error: spawn returned non-JSON response ({resp.status_code})."
        if resp.status_code == 429:
            # at_capacity — the model should fall through to inline or tell the user.
            try:
                data = resp.json()
                return (
                    f"Error: at_capacity ({data.get('active','?')}/{data.get('cap','?')} "
                    f"background tasks already running). Handle the user's request "
                    f"inline instead — and if it's long-running, tell them you're "
                    f"at capacity so they know it may take a while."
                )
            except ValueError:
                return "Error: at_capacity."
        if resp.status_code == 404:
            return f"Error: resume_miss — no history entry for taskId `{resume_from}`. Spawn without resume_from."
        return f"Error ({resp.status_code}): {resp.text[:200]}"


    @mcp.tool()
    async def stop_background_task(task_id: str) -> str:
        """Cancel a running background task and get back what it had done so far.

        The background task receives an abort signal and stops at the next
        safe point. The chat-server returns an immediate snapshot of what
        the task had accomplished (partial assistant text + recent tool
        calls), so you have context to reply to the user or spawn a
        follow-up task that picks up where this one left off.

        Use this when:
          - the user changes their mind or asks to cancel,
          - a task is clearly stuck or wrong,
          - you need to free a slot to spawn a different task.

        To resume the work later, call `spawn_background_task(prompt, resume_from=<taskId>)`.

        Args:
            task_id: The taskId returned by a prior spawn_background_task.

        Returns:
            JSON string with fields {aborted, stopped_by, snapshot,
            already_finished?, final_reply?}. On unknown taskId returns a
            short error string.
        """
        if not task_id or not task_id.strip():
            return "Error: task_id must be a non-empty string."
        key = _load_internal_key()
        if not key:
            return "Error: internal key not available."
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{CHAT_SERVER_URL}/internal/stop-bg",
                    headers={"X-Internal-Key": key},
                    json={"taskId": task_id.strip(), "callerTurnId": CALLER_TURN_ID},
                    timeout=15.0,
                )
        except httpx.HTTPError as e:
            log_catch(logger, "mcp.chat.bg_stop.http_failed", e, taskId=task_id)
            return f"Error calling chat-server: {e}"

        if resp.status_code == 404:
            return f"Error: unknown taskId `{task_id}` (never spawned or already evicted from history)."
        if resp.status_code != 200:
            return f"Error ({resp.status_code}): {resp.text[:200]}"
        # Return raw JSON so the model sees the full snapshot.
        return resp.text


    @mcp.tool()
    async def list_background_tasks() -> str:
        """List running and recently-finished background tasks.

        Call this:
          - BEFORE spawning a new task, to check capacity (the system caps
            concurrent bg tasks; if all slots are used, spawn will fail
            with "at_capacity"),
          - when the user asks "what are you still working on?" or "what
            happened to task X?",
          - before deciding whether to spawn a resume_from task.

        Returns JSON with fields:
          - cap: max concurrent bg tasks.
          - activeCount: how many are running right now.
          - active: list of running tasks (taskId, startedAt, ageMs,
            promptPreview, snapshot).
          - recent: list of recently-finished tasks (taskId, stoppedBy,
            durationMs, promptPreview, snapshot, finalReplyChars). The
            `stoppedBy.by` field tells you who/what ended it: "natural"
            (completed normally), "model" (you stopped it),
            "timeout" (30min wall-clock), "container_shutdown" (workspace
            was restarted), or "error".
        """
        key = _load_internal_key()
        if not key:
            return "Error: internal key not available."
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{CHAT_SERVER_URL}/internal/list-bg",
                    headers={"X-Internal-Key": key},
                    timeout=10.0,
                )
        except httpx.HTTPError as e:
            log_catch(logger, "mcp.chat.bg_list.http_failed", e)
            return f"Error calling chat-server: {e}"

        if resp.status_code != 200:
            return f"Error ({resp.status_code}): {resp.text[:200]}"
        return resp.text


if __name__ == "__main__":
    mcp.run()

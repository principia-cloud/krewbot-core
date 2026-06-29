"""Telegram MCP — only the Telegram-specific operations that aren't
already covered by Chat SDK's generic reply path or by the
adapter-agnostic agent_platform_mcp.

Outbound text messages: handled by Chat SDK's `thread.post(reply)` for
webhook turns and `adapter.postMessage(threadId, reply)` for cron-triggered
turns. Both are uniform across every adapter (telegram/slack/discord/
whatsapp/teams), so no per-adapter MCP send tool is needed.

Chat directory listing: use `agent_platform_mcp.list_known_chats(adapter="telegram")`.

What's left here:
    - `download_attachment(file_id)` — Telegram-specific: resolves a
      Telegram file_id to a local path via getFile + file download.

The deleted tools (`send_message`, `send_file`, `send_photo`,
`get_messages`, `wait_for_reply`, `list_chats`) were either redundant
with Chat SDK's reply path, broken under webhook mode, no-ops, or are
now covered by the adapter-agnostic `agent_platform_mcp.list_known_chats`.
"""

import os
import sys
from datetime import datetime

# Make log.py (colocated in this directory) importable under every load
# mode: script (python3 /app/mcp/telegram_mcp.py), `import`-as-module,
# and importlib.util.spec_from_file_location (used by integration tests).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx
from mcp.server.fastmcp import FastMCP

from platform_log import init_logger, log_catch

logger = init_logger("mcp-telegram")

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
BASE_URL = f"https://api.telegram.org/bot{BOT_TOKEN}"
FILE_BASE_URL = f"https://api.telegram.org/file/bot{BOT_TOKEN}"

# Downloads land in the session cwd so the agent can Read them via paths
# relative to its confined working directory.
DOWNLOADS_DIR = os.environ.get(
    "TELEGRAM_DOWNLOADS_DIR",
    os.path.join(os.path.dirname(__file__), "downloads"),
)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

mcp = FastMCP("telegram")


async def _telegram_request(method: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE_URL}/{method}", json=params or {})
        resp.raise_for_status()
        return resp.json()


async def _download_telegram_file(file_id: str, filename_hint: str = "") -> str:
    """Download a file from Telegram by file_id. Returns the local path,
    or an empty string on failure. Path is confined to DOWNLOADS_DIR."""
    try:
        result = await _telegram_request("getFile", {"file_id": file_id})
    except Exception as exc:
        log_catch(logger, "mcp.telegram.get_file_failed", exc, fileId=file_id)
        return ""

    if not result.get("ok"):
        logger.warning(
            "telegram getFile returned not-ok",
            extra={
                "event": "mcp.telegram.get_file_not_ok",
                "fileId": file_id,
                "description": result.get("description"),
            },
        )
        return ""

    tg_file_path = result["result"]["file_path"]

    # Determine local filename — strip path components and dangerous chars
    # to prevent directory traversal via crafted Telegram filenames.
    if filename_hint:
        local_name = os.path.basename(filename_hint)
    else:
        local_name = os.path.basename(tg_file_path)
    local_name = local_name.replace("/", "_").replace("\\", "_").replace("\0", "_")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    local_name = f"{ts}_{local_name}"
    local_path = os.path.join(DOWNLOADS_DIR, local_name)

    # Final safety check — resolved path must stay inside DOWNLOADS_DIR
    if not os.path.realpath(local_path).startswith(os.path.realpath(DOWNLOADS_DIR)):
        logger.warning(
            "telegram download path escapes DOWNLOADS_DIR",
            extra={
                "event": "mcp.telegram.path_escape_rejected",
                "fileId": file_id,
                "attempted": local_path,
            },
        )
        return ""

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{FILE_BASE_URL}/{tg_file_path}")
            resp.raise_for_status()
            with open(local_path, "wb") as f:
                f.write(resp.content)
    except Exception as exc:
        log_catch(
            logger,
            "mcp.telegram.download_failed",
            exc,
            fileId=file_id,
            localPath=local_path,
        )
        return ""

    logger.info(
        "telegram file downloaded",
        extra={
            "event": "mcp.telegram.download_ok",
            "fileId": file_id,
            "localPath": local_path,
            "bytes": os.path.getsize(local_path) if os.path.exists(local_path) else 0,
        },
    )
    return local_path


@mcp.tool()
async def download_attachment(file_id: str) -> str:
    """Download a Telegram file by its file_id and return the local path.

    Use this when an inbound message includes a file_id (photos, documents,
    audio, video, voice notes, stickers). After downloading, Read the
    returned path to inspect the content.
    """
    if not file_id:
        return "Error: file_id is required."
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    path = await _download_telegram_file(file_id)
    if not path:
        return f"Failed to download file_id={file_id}."
    return path


if __name__ == "__main__":
    mcp.run()

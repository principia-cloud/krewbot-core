"""One-shot initialization of the user_context git repo.

Port of init_user_context_repo() from sync.sh. Runs once at supervisor
startup — if .git already exists, it's a no-op.
"""

import os
import subprocess
from pathlib import Path

from platform_log import init_logger, log_catch

logger = init_logger("sidecar-user-context")

USER_CONTEXT_DIR = Path(os.environ.get("USER_CONTEXT_DIR", "/data/user_context"))

_PLACEHOLDER_FILES = {
    "context.md": """\
# Team Context

Top-level team information, mission, and shared knowledge summaries.

The agent maintains this file as the team's primary knowledge base. Add:
- Team mission and goals
- Key projects and their status
- Shared terminology and conventions
- Links to external resources
- Any information that all team members should know

Keep this file under 200 lines — split detailed topics into decisions.md
or ask the admin to create dedicated documents.
""",
    "members.md": """\
# Members

Team roster and roles. The agent updates this file as members are added
or removed.

Format per member:
- **Name / handle** — role, responsibilities, context-modifier status

The admin manages membership via Telegram commands. When a new person
messages the bot who isn't listed here, the agent directs them to contact
the admin.
""",
    "decisions.md": """\
# Decisions

Log of key decisions made by the team. The agent appends entries here as
decisions are recorded during conversations.

Format per entry:
- **Date — Decision title**: description, rationale, who decided

Use this as the team's decision audit trail. When a past decision is
referenced in conversation, the agent reads this file to provide context.
""",
    "reminders.md": """\
# Reminders

Pending reminders set by team members. The agent appends entries here
and removes them once delivered.

Format per entry:
- **Due date/time — @member**: reminder text

The agent checks this file periodically and sends Telegram messages
when reminders come due. Delivered reminders are removed from the list.
""",
}


async def init_if_needed() -> None:
    """Initialize the user_context git repo if it doesn't exist yet."""
    if not USER_CONTEXT_DIR.exists():
        logger.info(
            "USER_CONTEXT_DIR does not exist, skipping init",
            extra={"event": "user_context.init.skipped", "path": str(USER_CONTEXT_DIR)},
        )
        return
    if (USER_CONTEXT_DIR / ".git").exists():
        logger.info(
            "user_context repo already initialized",
            extra={"event": "user_context.init.already_done"},
        )
        return

    logger.info(
        "initializing user_context git repo",
        extra={"event": "user_context.init.start", "path": str(USER_CONTEXT_DIR)},
    )
    try:
        def _run(*args: str) -> None:
            subprocess.run(args, cwd=USER_CONTEXT_DIR, check=True, capture_output=True)

        _run("git", "init", "-q", "-b", "main")
        _run("git", "config", "user.name", "platform-agent")
        _run("git", "config", "user.email", "agent@localhost")

        for filename, content in _PLACEHOLDER_FILES.items():
            (USER_CONTEXT_DIR / filename).write_text(content)

        _run("git", "add", "-A")
        _run("git", "commit", "-q", "-m", "initial scaffold")
        logger.info(
            "user_context repo initialized",
            extra={"event": "user_context.init.done"},
        )
    except Exception as exc:
        log_catch(
            logger,
            "user_context.init.failed",
            exc,
            path=str(USER_CONTEXT_DIR),
        )

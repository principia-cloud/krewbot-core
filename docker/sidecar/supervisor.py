"""Sidecar supervisor — runs sidecar jobs as concurrent async loops.

After the agent-platform API takeover the sidecar's only ongoing job is
the secret/SSM/JWKS sync loop. The user_context one-shot still runs at
boot. Cron CRUD, chat-directory upserts/snapshots, members/workspace
mirroring, and the janitor have all moved to the Agent Platform API
Lambda or are no longer needed.

Entry point for the sidecar container: `python3 /app/supervisor.py`
"""

import asyncio
import sys

# /app is on sys.path already (WORKDIR), so `import log` finds log.py.
from platform_log import init_logger, log_catch

from jobs import sync, user_context

logger = init_logger("sidecar")


async def supervise(name: str, coro_fn, restart_delay: int = 5) -> None:
    """Run an async job loop, restarting on unhandled exceptions."""
    while True:
        try:
            await coro_fn()
        except Exception as exc:
            log_catch(
                logger,
                "supervisor.job.crashed",
                exc,
                job=name,
                restartDelaySec=restart_delay,
            )
            await asyncio.sleep(restart_delay)


async def main() -> None:
    logger.info("sidecar supervisor starting", extra={"event": "supervisor.start"})

    # One-shot init (not supervised — runs once, fails loudly on error)
    await user_context.init_if_needed()

    # Supervised long-running job — secrets/SSM/JWKS sync.
    await asyncio.gather(
        supervise("sync", sync.sync_loop),
    )


if __name__ == "__main__":
    asyncio.run(main())

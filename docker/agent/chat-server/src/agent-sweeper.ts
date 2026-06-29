/**
 * agent-sweeper.ts — EFS cleanup for agents marked deletion_pending.
 *
 * Runs in the chat-server process. On startup and hourly thereafter,
 * lists the workspace's agents via the Agent Platform API and `rm -rf`s
 * /data/agents/{agentId}/ for any row whose status is
 * `deletion_pending`.
 *
 * Rule is deliberately narrow:
 *   - "status=deletion_pending" → rm the dir.
 *   - Row missing in DDB → SKIP. We don't rm dirs on the basis of
 *     a missing row; that risks wiping newly-scaffolded agents whose
 *     DDB writes race the sweeper, and isn't worth the tiny extra
 *     cleanup for the (sandbox-down-for-7-days) edge case where a DDB
 *     row TTLs before the sweeper ever sees it. Orphans from that
 *     scenario need a human to clean up.
 *
 * The 7-day DDB TTL (set by the Management API DELETE handler) is the
 * contract that guarantees the row is still around when the sweeper
 * runs. Plenty of slack for sandbox restarts + brief outages.
 */

import { rmSync, existsSync } from "node:fs";
import { agentPaths, AGENTS_ROOT } from "./agent-def.js";
import { platformClient } from "./platform-client.js";
import { rootLogger, logCatch } from "./logger.js";

/** How often the sweeper fires, in ms. Hourly is generous — the DDB
 * TTL window is 7 days, so even much-less-frequent sweeps would be
 * correct. Hourly just keeps the EFS footprint tidy. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Run one sweep pass. Exported for unit tests; production calls
 * `startAgentSweeper()` which wires this into an interval. */
export async function sweepPendingAgentDeletes(): Promise<{
  scanned: number;
  removed: number;
  failed: number;
}> {
  let rows: Awaited<ReturnType<typeof platformClient.listAgents>>;
  try {
    rows = await platformClient.listAgents();
  } catch (err) {
    logCatch(rootLogger, "agent_sweeper.list_agents_failed", err);
    return { scanned: 0, removed: 0, failed: 0 };
  }

  const pending = rows.filter((r) => r.status === "deletion_pending");
  let removed = 0;
  let failed = 0;

  for (const row of pending) {
    const { root } = agentPaths(row.agentId);
    // Paranoid path check — agentPaths always joins under AGENTS_ROOT,
    // but if that invariant ever breaks we want to see the bug, not
    // rm -rf / .
    if (!root.startsWith(AGENTS_ROOT + "/")) {
      rootLogger.warn(
        {
          event: "agent_sweeper.rejected_path",
          agentId: row.agentId,
          root,
        },
        "refusing to rm a path outside AGENTS_ROOT",
      );
      failed += 1;
      continue;
    }

    // Cron cleanup runs before the EFS rm so a partial failure leaves
    // schedules cleaned but the dir intact (the next sweep will rm it).
    // Best-effort: log and continue if APA is unreachable.
    try {
      const result = await platformClient.deleteCronJobsByAgent(row.agentId);
      if (result.deleted.length > 0 || result.skipped.length > 0) {
        rootLogger.info(
          {
            event: "agent_sweeper.crons_removed",
            agentId: row.agentId,
            deleted: result.deleted,
            skipped: result.skipped,
          },
          "agent crons cleaned up",
        );
      }
    } catch (err) {
      logCatch(rootLogger, "agent_sweeper.crons_failed", err, {
        agentId: row.agentId,
      });
    }

    if (!existsSync(root)) {
      // Already gone (previous sweep cleaned it, or the agent never
      // had a scaffolded dir). Nothing to do; the DDB row will TTL out
      // naturally in up to 7 days.
      continue;
    }
    try {
      rmSync(root, { recursive: true, force: true });
      removed += 1;
      rootLogger.info(
        { event: "agent_sweeper.removed", agentId: row.agentId, root },
        "agent EFS dir removed",
      );
    } catch (err) {
      failed += 1;
      logCatch(rootLogger, "agent_sweeper.rm_failed", err, {
        agentId: row.agentId,
        root,
      });
    }
  }

  rootLogger.info(
    {
      event: "agent_sweeper.pass_complete",
      scanned: pending.length,
      removed,
      failed,
    },
    "agent sweeper pass complete",
  );

  return { scanned: pending.length, removed, failed };
}

/** Kick off the sweeper. Runs once immediately (await'd so the boot
 * sequence has a clean initial state) and schedules further passes
 * hourly. Never throws — failures inside the sweep are logged only. */
export async function startAgentSweeper(): Promise<void> {
  try {
    await sweepPendingAgentDeletes();
  } catch (err) {
    logCatch(rootLogger, "agent_sweeper.startup_pass_failed", err);
  }
  const timer = setInterval(() => {
    sweepPendingAgentDeletes().catch((err) =>
      logCatch(rootLogger, "agent_sweeper.periodic_pass_failed", err),
    );
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper — the
  // chat-server's HTTP server is the real liveness anchor.
  timer.unref?.();
}

/**
 * Watches /config/secrets and fires a debounced callback whenever the
 * sidecar materializes a change. Two independent triggers, because neither
 * is sufficient on its own across our deployments:
 *
 *   - fs.watch (inotify): sub-second, but inotify is a LOCAL-kernel facility.
 *     On the real platform /config is an EFS (NFS) mount written by a
 *     SEPARATE task (the sidecar); NFS delivers no change events to other
 *     clients, so fs.watch never fires there. Kept for local/dev where the
 *     dir is an ordinary filesystem and we want instant response.
 *   - poll (setInterval): re-reads on an interval, which DOES reflect NFS
 *     writes (a read hits the server). This is the load-bearing path on EFS,
 *     and restores the behavior of the original 30s poll — now at `pollMs`
 *     (default 1s). The poll interval is ADDITIVE to the sidecar's ~5s SSM
 *     tick, so worst-case end-to-end propagation is ~sidecar + pollMs (≈6s
 *     at 1s vs ≈10s at 5s); a no-change tick is a couple of small reads, so
 *     1s is cheap.
 *
 * Both funnel through a shared debounce. The downstream callback
 * (maybeReloadChatSdk) is hash-gated, so a poll that finds no change — or a
 * burst from the sidecar's per-file atomic renames (write_if_changed in
 * sync.py) — is cheap; debouncing just collapses the burst into one wake.
 */

import * as fs from "node:fs";
import type { Logger } from "pino";
import { logCatch } from "./logger.js";

export interface SecretsWatcherOptions {
  dir: string;
  onChange: () => void;
  logger: Logger;
  debounceMs?: number;
  restartDelayMs?: number;
  /**
   * Poll interval for the NFS-safe fallback. Defaults to 1s. The poll calls
   * onChange unconditionally each tick; the hash-gated callback makes a
   * no-change tick a couple of small file reads. Additive to the sidecar's
   * ~5s tick for worst-case propagation, so lower = lower worst case.
   */
  pollMs?: number;
}

export interface SecretsWatcherHandle {
  /** Stop the watcher and cancel any pending debounce. Test-only. */
  stop: () => void;
}

export function startSecretsWatcher(
  opts: SecretsWatcherOptions,
): SecretsWatcherHandle {
  const debounceMs = opts.debounceMs ?? 500;
  const restartDelayMs = opts.restartDelayMs ?? 1_000;
  const pollMs = opts.pollMs ?? 1_000;

  let debounceTimer: NodeJS.Timeout | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  function schedule(): void {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        opts.onChange();
      } catch (err) {
        logCatch(opts.logger, "chat.reload.failed", err);
      }
    }, debounceMs);
    debounceTimer.unref();
  }

  function start(): void {
    if (stopped) return;
    try {
      watcher = fs.watch(opts.dir, { persistent: false }, () => schedule());
      watcher.on("error", (err) => {
        logCatch(opts.logger, "chat.reload.watcher_error", err);
        try {
          watcher?.close();
        } catch {
          // close() can throw if the watcher is already gone — ignore.
        }
        watcher = null;
        restartTimer = setTimeout(start, restartDelayMs);
        restartTimer.unref();
      });
      opts.logger.info(
        { event: "chat.reload.watcher_started", dir: opts.dir },
        "secrets watcher started",
      );
    } catch (err) {
      // Directory may not exist yet at boot (sidecar still creating it).
      logCatch(opts.logger, "chat.reload.watcher_start_failed", err);
      restartTimer = setTimeout(start, restartDelayMs);
      restartTimer.unref();
    }
  }

  start();

  // NFS-safe fallback: inotify is silent for EFS writes made by the sidecar
  // (a separate NFS client), so poll on an interval too. Routed through the
  // same debounce; the hash-gated onChange makes a no-change tick cheap.
  pollTimer = setInterval(schedule, pollMs);
  pollTimer.unref();

  return {
    stop: () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (restartTimer) clearTimeout(restartTimer);
      if (pollTimer) clearInterval(pollTimer);
      debounceTimer = null;
      restartTimer = null;
      pollTimer = null;
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      watcher = null;
    },
  };
}

/**
 * turn-queue-config.ts — cluster-wide TurnQueue + bg-pool tuning knobs.
 *
 * Single source of truth: a platform-wide SSM parameter holding a JSON
 * blob (declared in CDK at lib/cluster-stack.ts; the exact name is the
 * operator's `cfg.infrastructureNames.platformConfigSsmParameter`). The
 * sidecar mirrors it into /config/turn-queue.json on every sync tick;
 * chat-server reads that file once at startup.
 *
 * Resolution order (first non-null wins):
 *   1. /config/turn-queue.json        — operator-tunable, vended by sidecar
 *   2. process.env.<KEY>              — escape hatch for local dev / tests
 *   3. hard-coded defaults below
 *
 * To rotate cluster-wide:
 *   1) edit the CDK SSM resource in lib/cluster-stack.ts → cdk deploy ClusterStack
 *   2) force-redeploy sandbox services (chat-server only re-reads at boot)
 *
 * No polling — values are read once at boot. If you want a hot reload
 * later, the sidecar already write-if-changes the file; chat-server
 * could fs.watch it.
 *
 * Concurrency caps are explicit numbers — there is no auto-sizing from
 * container memory. The 500-MiB-worst-case-per-turn formula was
 * conservative on paper and never matched empirical peaks (~250-300
 * MiB per Claude CLI subprocess); we now just pick the slot count we
 * want and trust observed reality.
 */

import { readFileSync } from "node:fs";
import { rootLogger, logCatch } from "./logger.js";

const CONFIG_PATH = "/config/turn-queue.json";

/** Shape of the JSON document the sidecar writes. All fields optional —
 * any field missing falls through to env / default. Keep aligned with
 * the operator-facing SSM parameter contract. */
interface TurnQueueConfigFile {
  /** Hard cap on concurrent foreground (mainQueue) turns. */
  maxConcurrent?: number;
  /** Waiting-list cap. Submissions past this are rejected synchronously. */
  maxQueue?: number;
  /** How long a queued submission may wait before resolving as AT_CAPACITY. */
  maxWaitMs?: number;
  /** Max concurrent background tasks (bgRegistry admission gate). */
  maxBgConcurrent?: number;
  /** Wall-clock kill threshold for any single bg task. */
  bgWallMs?: number;
  /** History retention window for finished bg tasks. */
  bgHistoryTtlMs?: number;
  /** Max retained finished-bg-task records. */
  bgHistoryMaxEntries?: number;
}

function readConfigFile(): TurnQueueConfigFile {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as TurnQueueConfigFile;
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is expected pre-sidecar-sync; everything else worth flagging.
    if (code === "ENOENT") {
      rootLogger.info(
        { event: "turn_queue.config.file_missing", path: CONFIG_PATH, expected: true },
        "platform turn-queue config not present yet, using env/defaults",
      );
    } else {
      logCatch(rootLogger, "turn_queue.config.read_failed", err, { path: CONFIG_PATH });
    }
    return {};
  }
}

/** Resolve a single integer value across file → env → default. */
function pickInt(
  fileValue: number | undefined,
  envName: string,
  defaultValue: number,
  minimum = 0,
): number {
  const raw =
    fileValue !== undefined && Number.isFinite(fileValue)
      ? fileValue
      : process.env[envName] !== undefined
      ? parseInt(process.env[envName] as string, 10)
      : defaultValue;
  if (!Number.isFinite(raw)) return defaultValue;
  return Math.max(minimum, raw as number);
}

const fileCfg = readConfigFile();

export interface ResolvedTurnQueueConfig {
  maxConcurrent: number;
  maxQueue: number;
  maxWaitMs: number;
  maxBgConcurrent: number;
  bgWallMs: number;
  bgHistoryTtlMs: number;
  bgHistoryMaxEntries: number;
  /** True when /config/turn-queue.json was successfully read. Logged at
   * startup so operators can confirm the sidecar-vended config landed. */
  source: "file" | "env_or_default";
}

export const turnQueueConfig: ResolvedTurnQueueConfig = {
  // Defaults are floors — if SSM is missing or malformed we still have a
  // sane config. Production values come from the CDK-declared SSM param.
  maxConcurrent: pickInt(fileCfg.maxConcurrent, "MAX_CONCURRENT_TURNS", 4, 1),
  maxQueue: pickInt(fileCfg.maxQueue, "MAX_QUEUED_TURNS", 20, 1),
  maxWaitMs: pickInt(fileCfg.maxWaitMs, "MAX_TURN_WAIT_MS", 60000, 1000),
  maxBgConcurrent: pickInt(fileCfg.maxBgConcurrent, "MAX_CONCURRENT_BG_TURNS", 4, 1),
  bgWallMs: pickInt(fileCfg.bgWallMs, "BG_TASK_MAX_WALL_MS", 21_600_000, 60_000),
  bgHistoryTtlMs: pickInt(fileCfg.bgHistoryTtlMs, "BG_HISTORY_TTL_MS", 3_600_000, 60_000),
  bgHistoryMaxEntries: pickInt(fileCfg.bgHistoryMaxEntries, "BG_HISTORY_MAX_ENTRIES", 50, 1),
  source: Object.keys(fileCfg).length > 0 ? "file" : "env_or_default",
};

rootLogger.info(
  { event: "turn_queue.config.loaded", ...turnQueueConfig },
  "turn-queue config loaded",
);

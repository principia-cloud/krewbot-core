/**
 * bg-types.ts — shared type declarations for the background-task
 * registry. The registry itself (bgActive/bgHistory maps + lifecycle)
 * lives in index.ts; these types are split out so routes/tasks.ts can
 * serialize entries without importing index.ts (which boots the server).
 */

import type { BackgroundSnapshot } from "./agent.js";

export type BgStopAttribution = {
  /** Who/what ended this task. Surfaced to the model via list/stop and
   * to members via the Tasks UI. */
  by: "natural" | "model" | "user" | "timeout" | "container_shutdown" | "error";
  /** For by="model": the turnId of the main-thread turn that called stop. */
  turnId?: string;
  /** For by="user": the Cognito sub of the member who clicked Stop. */
  userId?: string;
  /** Free text (error message, timeout hint, stopping user's email, etc). */
  reason?: string;
  /** Epoch ms. */
  at: number;
};

export interface BgActiveEntry {
  taskId: string;
  abort: AbortController;
  startedAt: number;
  prompt: string;
  parentSessionKey: string;
  parentAdapter: string;
  parentThreadId: string;
  callerTurnId?: string;
  snapshot: BackgroundSnapshot;
  /** setTimeout handle for the wall-clock abort. */
  walltimeTimer?: NodeJS.Timeout;
}

export interface BgHistoryEntry {
  taskId: string;
  startedAt: number;
  endedAt: number;
  prompt: string;
  parentSessionKey: string;
  parentAdapter: string;
  parentThreadId: string;
  finalReply: string;
  snapshot: BackgroundSnapshot;
  stoppedBy: BgStopAttribution;
}

/** Result of stopping a background task by id (shared by the internal
 * MCP-facing route and the user-facing Tasks route). */
export type BgStopOutcome =
  | { kind: "aborted"; snapshot: BackgroundSnapshot; attribution: BgStopAttribution }
  | { kind: "already_finished"; entry: BgHistoryEntry }
  | { kind: "not_found" };

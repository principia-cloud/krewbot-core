/**
 * tasks.ts — user-facing view of the workspace's running work: the
 * foreground TurnQueue (active turns + waiting entries) and the
 * background-task registry (active + recently finished), plus a stop
 * action for background tasks.
 *
 * Dependencies are injected (TasksDeps) because the registries live in
 * index.ts, which boots the server on import — DI keeps the
 * serializers pure and unit-testable. The privacy rule lives in
 * serializeForeground: an http-sourced turn is another member's
 * private chat, so its snapshot is only included for the owner
 * (sessionKey `http/{sub}/...`); cron/webhook turns run in shared
 * channels and are visible to every member.
 */

import * as http from "node:http";
import { rootLogger } from "../logger.js";
import type { BackgroundSnapshot, TurnQueueInspection, TurnSource } from "../agent.js";
import type { BgActiveEntry, BgHistoryEntry, BgStopAttribution, BgStopOutcome } from "../bg-types.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const PROMPT_PREVIEW_CHARS = 140;
const REPLY_PREVIEW_CHARS = 500;
const SNAPSHOT_TEXT_CHARS = 4000;
const RECENT_LIMIT = 20;

export interface TasksDeps {
  getForeground(): TurnQueueInspection;
  fgLimits: { maxConcurrent: number; maxQueue: number; maxWaitMs: number };
  bgLimits: { maxConcurrent: number; wallMs: number; historyTtlMs: number };
  listBgActive(): BgActiveEntry[];
  /** Pruned history, any order — serialization sorts newest-first and caps. */
  listBgRecent(): BgHistoryEntry[];
  stopBg(taskId: string, attribution: BgStopAttribution): BgStopOutcome;
}

export interface SerializedFgTurn {
  id: string;
  source: TurnSource;
  jobName?: string;
  adapterName?: string;
  startedAt: number;
  ageMs: number;
  isMine: boolean;
  snapshot?: BackgroundSnapshot;
}

export interface SerializedFgWaiting {
  id: string;
  source: TurnSource;
  adapterName?: string;
  coalesceKey?: string;
  enqueuedAt: number;
  waitedMs: number;
}

/** Clamp a snapshot for the wire: keep the TAIL of the assistant text
 * (the newest output is what a live feed needs) — the tool trail is
 * already bounded upstream (20 entries × 120-char summaries). */
export function clampSnapshot(
  snap: BackgroundSnapshot,
  maxText: number = SNAPSHOT_TEXT_CHARS,
): BackgroundSnapshot {
  if (snap.assistantText.length <= maxText) return snap;
  return {
    assistantText: snap.assistantText.slice(-maxText),
    toolCallTrail: snap.toolCallTrail,
  };
}

/** True when an http-source sessionKey (`http/{sub}/{sessionId}`)
 * belongs to the requesting member. */
function ownsHttpSession(sessionKey: string, sub: string): boolean {
  return sessionKey.startsWith(`http/${sub}/`);
}

export function serializeForeground(
  insp: TurnQueueInspection,
  sub: string,
  now: number,
): { active: SerializedFgTurn[]; waiting: SerializedFgWaiting[] } {
  const active = insp.active.map((t) => {
    const isMine = t.source === "http" && ownsHttpSession(t.sessionKey, sub);
    // Privacy gate: other members' web chats show as an opaque "busy"
    // row; shared-channel turns (cron/webhook) are visible to everyone.
    const snapshotVisible = t.source !== "http" || isMine;
    return {
      id: t.id,
      source: t.source,
      jobName: t.jobName,
      adapterName: t.adapterName,
      startedAt: t.startedAt,
      ageMs: Math.max(0, now - t.startedAt),
      isMine,
      snapshot: snapshotVisible && t.snapshot ? clampSnapshot(t.snapshot) : undefined,
    };
  });
  const waiting = insp.waiting.map((w) => ({
    id: w.id,
    source: w.source,
    adapterName: w.adapterName,
    coalesceKey: w.coalesceKey,
    enqueuedAt: w.enqueuedAt,
    waitedMs: Math.max(0, now - w.enqueuedAt),
  }));
  return { active, waiting };
}

export function serializeBgActive(entries: BgActiveEntry[], now: number) {
  return entries.map((e) => ({
    taskId: e.taskId,
    startedAt: e.startedAt,
    ageMs: Math.max(0, now - e.startedAt),
    promptPreview: e.prompt.slice(0, PROMPT_PREVIEW_CHARS),
    parentAdapter: e.parentAdapter,
    snapshot: clampSnapshot(e.snapshot),
  }));
}

export function serializeBgRecent(entries: BgHistoryEntry[]) {
  return entries
    .slice()
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, RECENT_LIMIT)
    .map((h) => ({
      taskId: h.taskId,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      durationMs: h.endedAt - h.startedAt,
      promptPreview: h.prompt.slice(0, PROMPT_PREVIEW_CHARS),
      parentAdapter: h.parentAdapter,
      stoppedBy: h.stoppedBy,
      finalReplyPreview: h.finalReply.slice(0, REPLY_PREVIEW_CHARS),
      snapshot: clampSnapshot(h.snapshot),
    }));
}

/** GET /api/tasks — full state of both pools for the Tasks UI. */
export function handleTasksList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  deps: TasksDeps,
): void {
  const now = Date.now();
  const fg = serializeForeground(deps.getForeground(), sub, now);
  json(res, 200, {
    now,
    foreground: {
      limits: deps.fgLimits,
      active: fg.active,
      waiting: fg.waiting,
    },
    background: {
      limits: deps.bgLimits,
      active: serializeBgActive(deps.listBgActive(), now),
      recent: serializeBgRecent(deps.listBgRecent()),
    },
  });
}

/** POST /api/tasks/background/:taskId/stop — abort a running background
 * task on behalf of a workspace member. Any member may stop any task
 * (same authority the model has via stop_background_task); the
 * attribution records who, for the history row and the model's view. */
export function handleTaskStop(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  email: string | undefined,
  taskId: string,
  deps: TasksDeps,
): void {
  if (!taskId) return json(res, 400, { error: "taskId required" });
  const outcome = deps.stopBg(taskId, {
    by: "user",
    userId: sub,
    reason: email,
    at: Date.now(),
  });
  if (outcome.kind === "not_found") {
    return json(res, 404, { error: "unknown_task", taskId });
  }
  if (outcome.kind === "already_finished") {
    return json(res, 200, {
      ok: true,
      alreadyFinished: true,
      taskId,
      stoppedBy: outcome.entry.stoppedBy,
      finalReplyPreview: outcome.entry.finalReply.slice(0, REPLY_PREVIEW_CHARS),
    });
  }
  rootLogger.info(
    { event: "routes.tasks.stopped", taskId, userId: sub },
    `bg task ${taskId} stopped from Tasks UI`,
  );
  json(res, 200, {
    ok: true,
    taskId,
    aborted: true,
    stoppedBy: outcome.attribution,
    snapshot: clampSnapshot(outcome.snapshot),
  });
}

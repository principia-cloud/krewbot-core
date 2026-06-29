/**
 * index.ts — Main HTTP server entry point.
 *
 * Single-container architecture: Chat SDK server + TS Agent SDK.
 * Routes are organized into layers that run in order:
 *   1. CORS preflight
 *   2. Public routes (no auth): health, auth config, static/SPA
 *   3. Host-validated routes (non-JWT auth): cron trigger, telegram webhook
 *   4. Authenticated routes (JWT + membership): all /api/* endpoints
 */

// The TS Agent SDK writes debug logs to $HOME/.claude/debug after each turn.
// With read-only rootfs, /home/agent is not writable. Point HOME at /tmp
// (tmpfs mount) so the SDK can write freely. Per-session HOMEs for the
// Claude CLI subprocess are set separately via query() options.env.HOME.
if (!process.env.HOME || !process.env.HOME.startsWith("/data")) {
  process.env.HOME = "/tmp";
}

import * as http from "node:http";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { authenticate, type AuthResult } from "./auth.js";
import { handleMe } from "./routes/me.js";
import { listSessions, createSession, deleteSession, renameSession } from "./routes/sessions.js";
import {
  submitChat,
  streamChat,
  getActiveTurn,
  cancelChat,
  submitCreatorChat,
  streamCreatorChat,
  cancelCreatorChat,
} from "./routes/chat.js";
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  renameFile,
  listAgentDefFiles,
  readAgentDefFile,
  listAgentLiveDefFiles,
  readAgentLiveDefFile,
  listAgentWorkdirFiles,
  readAgentWorkdirFile,
} from "./routes/files.js";
import { handleListContext, handleReadContext, handleContextGraph } from "./routes/context.js";
import { handleMessages, handleCreatorMessages } from "./routes/messages.js";
import { handleAuthConfig } from "./routes/auth-config.js";
import { handleTasksList, handleTaskStop, type TasksDeps } from "./routes/tasks.js";
import {
  deployAgent,
  createAgentTestSession,
  uploadDraftZip,
  MAX_ZIP_BYTES,
} from "./routes/agents.js";
import { runAgentTurn, runBackgroundTurn, inspectTurnQueue, AT_CAPACITY, type BackgroundSnapshot } from "./agent.js";
import type { BgStopAttribution, BgActiveEntry, BgHistoryEntry, BgStopOutcome } from "./bg-types.js";
import { confineToSessionDir } from "./paths.js";
import { subscribeInbox, publishInbox } from "./session-inbox.js";
import { webSessionDir, appendWebSessionMessage } from "./web-delivery.js";
import { turnQueueConfig } from "./turn-queue-config.js";
import { answerPendingQuestion, type AskUserAnswer } from "./ask-user-mcp.js";
import { platformClient } from "./platform-client.js";
import { initChatSdk, maybeReloadChatSdk, handleWebhook, getAdapterByName, isMarkdownParseError } from "./chat.js";
import { startSecretsWatcher } from "./secrets-watcher.js";
import { commonMarkToTelegramMarkdown } from "./telegram-markdown.js";
import { rootLogger, logCatch } from "./logger.js";
import { flushLangfuse } from "./langfuse.js";

const PORT = 8080;
const WORKSPACE_ID = process.env.WORKSPACE_ID;

if (!WORKSPACE_ID) {
  rootLogger.fatal({ event: "boot.missing_env" }, "WORKSPACE_ID env var is required");
  process.exit(1);
}
if (!process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID) {
  rootLogger.fatal(
    { event: "boot.missing_env" },
    "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID env vars are required",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Same shape as `readBody` but yields the raw bytes — used by the
 * zip-upload route which streams a binary body directly (no multipart
 * wrapper) to keep the server-side parsing trivial. Caps at
 * `maxBytes` to prevent a single oversized upload from exhausting the
 * chat-server's memory; rejects with an error the route surfaces as
 * a 413. */
function readBodyBuffer(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Mark and stop accumulating, but DON'T destroy the socket —
        // doing so makes the client see a connection reset
        // ("Failed to fetch") instead of the 413 the route handler
        // is about to send. Drain remaining chunks silently and
        // resolve normally; the route layer surfaces 413 via the
        // throw below.
        oversized = true;
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (oversized) {
        reject(Object.assign(new Error("body too large"), { code: "EBODY2BIG" }));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

function validateHost(req: http.IncomingMessage): boolean {
  const host = req.headers["host"];
  if (!host) return false;
  const firstLabel = host.split(":")[0].split(".")[0];
  return firstLabel === WORKSPACE_ID;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

type Params = Record<string, string>;
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Params) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const regexStr = path
    .replace(/\*/g, "(?<wildcard>.*)")
    .replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return { method, pattern: new RegExp(`^${regexStr}$`), handler };
}

function dispatch(
  method: string,
  pathname: string,
  routes: Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.pattern);
    if (match) {
      r.handler(req, res, match.groups || {});
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cron trigger (API-key auth, not JWT)
// ---------------------------------------------------------------------------

interface CronTriggerBody {
  jobName?: string;
  message?: string;
  target?: { adapter?: string; threadId?: string };
  /** Set when the schedule was created on behalf of a specific agent.
   * Echoed from the EventBridge target Input — see APA's
   * create_cron_job. The chat-server uses this to skip triggers for
   * agents that have been marked deletion_pending so users stop
   * receiving messages from agents they thought they deleted. */
  agentId?: string;
}

function parseCronTarget(
  target: CronTriggerBody["target"],
): { adapter: string; threadId: string } | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { adapter, threadId } = target;
  if (typeof adapter !== "string" || !adapter) return undefined;
  if (typeof threadId !== "string" || !threadId) return undefined;
  return { adapter, threadId };
}

/** Compress a turn-failure error string into something fit for a chat
 * notice. Maps common SDK / CLI / platform errors to short human reasons
 * (rate-limit, auth, subscription, queue) and falls back to the first
 * 200 chars of the raw message otherwise. Keeps the user-facing notice
 * readable while leaving the full error in CloudWatch. */
function summarizeCronError(raw: string): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "unknown error (no message)";
  const lower = msg.toLowerCase();
  if (lower.includes("rate") && lower.includes("limit")) return "rate limit exceeded — try again later";
  if (lower.includes("429")) return "rate limit (HTTP 429) — try again later";
  if (lower.includes("subscription")) return msg.slice(0, 200);
  if (lower.includes("at_capacity")) return "workspace at capacity — too many concurrent turns";
  if (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("401")) return "authentication failed — check Claude credentials";
  if (lower.includes("max_turns")) return "model loop hit max-turns cap";
  if (lower.includes("max_budget")) return "model loop hit budget cap";
  if (lower.includes("exited with code")) {
    // The SDK's generic "Claude Code process exited with code N" — useful
    // information is in CloudWatch (lastResultErrors / stderrTail), not
    // in this string. Tell the user to check logs.
    return `${msg.slice(0, 80)} (check CloudWatch for details)`;
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

/** Post a short plaintext notice to a cron's routing target. Used for
 * error notices — the success path goes through `chat_send` from the
 * agent itself. Swallows "no such adapter" silently (target was set by
 * a cron created under a different adapter config and is no longer
 * reachable); other errors bubble to the caller's `.catch` for logging. */
async function postToCronTarget(
  target: { adapter: string; threadId: string },
  text: string,
): Promise<void> {
  const adapter = getAdapterByName(target.adapter) as
    | {
        postMessage?: (
          threadId: string,
          message: { markdown: string } | string,
        ) => Promise<{ id?: string }>;
      }
    | undefined;
  if (!adapter?.postMessage) return;
  await adapter.postMessage(target.threadId, text);
}

/**
 * Run a cron turn detached from the HTTP response. The cron turn is
 * stateless (agent.ts sets `continue: false` when source === "cron")
 * and receives the target chat as metadata via TURN_ADAPTER /
 * TURN_THREAD_ID env vars on the chat MCP subprocess. The agent is
 * responsible for calling `chat_send` to deliver any output — the
 * infrastructure does NOT post the reply text automatically for cron
 * turns. Rationale: unified outbound path (chat_send is the only way
 * to send mid-turn, same for inbound and cron), no special
 * adapter.postMessage branch in the cron code path, and the agent has
 * full control over what/when/where to send.
 *
 * Why detached: EventBridge retries non-2xx. We ACK immediately so a
 * slow turn can't re-fire the cron. If the turn fails, we log; we
 * don't retry, because a retried cron would double-act.
 */
function runCronTurnDetached(
  jobName: string,
  message: string,
  target: { adapter: string; threadId: string } | undefined,
): void {
  // Prepend a per-turn reminder so the model doesn't have to remember
  // the cron convention just from TOOLS.md. Makes the behavior
  // deterministic for the common case of a scheduled send.
  const cronPrompt = target
    ? `[cron job "${jobName}" — stateless turn]
You are running a scheduled cron job. Your reply text is NOT automatically delivered anywhere. To send a message as part of this cron run, call the \`chat_send\` tool. Its \`adapter\` and \`thread_id\` default to the cron target (${target.adapter}:${target.threadId}), so \`chat_send(text="...")\` with no arguments delivers to the right chat.

Task:
${message}`
    : `[cron job "${jobName}" — stateless, side-effect only]
You are running a scheduled cron job with no chat destination. Any text reply you produce is discarded. Complete the task; use tools like Write/Bash/context MCP as needed.

Task:
${message}`;

  runAgentTurn({
    sessionKey: `http/system-cron/${jobName}`,
    prompt: cronPrompt,
    source: "cron",
    callerId: "system-cron",
    cronTarget: target,
    // Coalesce by jobName: EventBridge retries + rapid scheduled fires
    // of the same cron collapse to "at most 1 active + 1 waiting" in
    // the TurnQueue. Matches Chat SDK's per-channel dedup semantics.
    coalesceKey: `cron:${jobName}`,
  })
    .then((result) => {
      const ctx = {
        source: "cron",
        jobName,
        adapterName: target?.adapter,
        threadId: target?.threadId,
      };
      if (result.error === AT_CAPACITY) {
        rootLogger.warn(
          { event: "cron.turn.dropped", reason: "at_capacity_or_superseded", ...ctx },
          `cron ${jobName}: rejected by TurnQueue (at capacity or superseded by later fire)`,
        );
        return;
      }
      // Cron-turn errors used to disappear entirely — a scheduled
      // reminder that failed on subscription/auth/usage-cap gave the
      // user zero signal. If a target chat exists, post a short notice
      // carrying the turnId ref so it's diagnosable. Aborts and
      // soft-errors both count; the user asked for something to happen
      // on this schedule, and nothing did.
      if (result.error && !result.aborted && target) {
        const ref = result.turnId ? ` (ref: ${result.turnId.slice(0, 8)})` : "";
        // Surface the actual error string (truncated) so the user can
        // tell auth/rate-limit/code crashes apart at a glance instead
        // of getting an opaque "failed" notice. The previous behaviour
        // of "Scheduled task X failed" without context made the same
        // recurring transient look like a never-ending fire.
        const reason = summarizeCronError(result.error);
        const notice = `Scheduled task "${jobName}" failed${ref}: ${reason}`;
        postToCronTarget(target, notice).catch((postErr) =>
          logCatch(rootLogger, "cron.error_notice.post_failed", postErr, ctx),
        );
      }
      rootLogger.info(
        { event: "cron.turn.done", replyChars: (result.reply || "").length, turnError: result.error, ...ctx },
        `cron ${jobName}: turn complete`,
      );
    })
    .catch((err) =>
      logCatch(rootLogger, "cron.turn.error", err, {
        source: "cron",
        jobName,
        adapterName: target?.adapter,
        threadId: target?.threadId,
      }),
    )
    .finally(() => {
      // Flush any Langfuse traces opened by the cron turn before the
      // promise chain resolves. ECS task itself stays alive; this bounds
      // the max-loss window to one turn if the task is killed next.
      flushLangfuse().catch(() => void 0);
    });
}

// ---------------------------------------------------------------------------
// Background task registry
// ---------------------------------------------------------------------------
//
// The chat-server holds an in-process registry of live background tasks
// (spawned by the agent via the chat MCP's spawn_background_task tool).
// Each entry carries an AbortController so the parent's next turn can
// stop the task, plus a rolling snapshot of progress so "what was that
// task doing?" can be answered honestly after an abort. Ephemeral — the
// durable backup is the EFS `bg-state/{taskId}/` folder convention the
// model is instructed to maintain.

/** All bg-pool tuning comes from the platform-wide turn-queue config
 * (sidecar-vended /config/turn-queue.json, with env-var and default
 * fallbacks). See turn-queue-config.ts for the resolution order. */
const MAX_CONCURRENT_BG_TURNS = turnQueueConfig.maxBgConcurrent;
/** Max wall time for a single bg task before we abort it. Guards
 * runaway loops and forgotten tasks. */
const BG_TASK_MAX_WALL_MS = turnQueueConfig.bgWallMs;
/** History retention window for recently-completed bg tasks (so the
 * model can ask `list_background_tasks` and see context about tasks
 * that finished/aborted in the recent past). */
const BG_HISTORY_TTL_MS = turnQueueConfig.bgHistoryTtlMs;
const BG_HISTORY_MAX_ENTRIES = turnQueueConfig.bgHistoryMaxEntries;

const bgActive = new Map<string, BgActiveEntry>();
const bgHistory: BgHistoryEntry[] = [];

function pruneBgHistory(): void {
  const cutoff = Date.now() - BG_HISTORY_TTL_MS;
  while (bgHistory.length > 0 && bgHistory[0].endedAt < cutoff) {
    bgHistory.shift();
  }
  while (bgHistory.length > BG_HISTORY_MAX_ENTRIES) {
    bgHistory.shift();
  }
}

/** Deliver a finished background task's reply to a web (HTTP) session by
 * appending it to the session's durable transcript side-file (see
 * web-delivery.ts — the same sink mid-task chat_send to web now uses).
 * Best-effort: logs and swallows on failure, matching the adapter
 * postMessage path's posture. */
function deliverWebBgReply(parentSessionKey: string, taskId: string, content: string): void {
  const dir = webSessionDir(parentSessionKey);
  if (!dir) {
    rootLogger.warn(
      { event: "bg.reply.web_unresolved_session", taskId, parentSessionKey },
      "web bg delivery: bad sessionKey shape or unresolved session dir",
    );
    return;
  }
  appendWebSessionMessage(dir, content, taskId);
}

function finalizeBgTask(entry: BgActiveEntry, finalReply: string, stoppedBy: BgStopAttribution): void {
  if (entry.walltimeTimer) clearTimeout(entry.walltimeTimer);
  bgActive.delete(entry.taskId);
  bgHistory.push({
    taskId: entry.taskId,
    startedAt: entry.startedAt,
    endedAt: stoppedBy.at,
    prompt: entry.prompt,
    parentSessionKey: entry.parentSessionKey,
    parentAdapter: entry.parentAdapter,
    parentThreadId: entry.parentThreadId,
    finalReply,
    snapshot: entry.snapshot,
    stoppedBy,
  });
  pruneBgHistory();
  rootLogger.info(
    {
      event: "bg.done",
      taskId: entry.taskId,
      stoppedBy: stoppedBy.by,
      turnId: stoppedBy.turnId,
      durationMs: stoppedBy.at - entry.startedAt,
      replyChars: finalReply.length,
    },
    `bg task ${entry.taskId}: ${stoppedBy.by}`,
  );
}

function oneLineSnapshot(snap: BackgroundSnapshot): string {
  const lastToolNames = snap.toolCallTrail.slice(-3).map((t) => t.name).join(",");
  const textPreview = snap.assistantText.replace(/\s+/g, " ").slice(0, 80);
  return `tools=[${lastToolNames}] text="${textPreview}${snap.assistantText.length > 80 ? "…" : ""}"`;
}

// ---------------------------------------------------------------------------
// Internal chat-send (loopback-only, shared-secret gated)
// ---------------------------------------------------------------------------

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

interface ChatSendBody {
  adapter?: string;
  threadId?: string;
  text?: string;
}

/**
 * POST /internal/chat-send — loopback-only proactive send endpoint.
 *
 * Called by the chat MCP subprocess via http://localhost:8080 when the
 * agent wants to push a message to a chat other than the one its reply
 * text auto-routes to, or send multiple messages in one turn.
 *
 * Two layers of auth:
 *   1. The request socket must be loopback (127.0.0.1 / ::1). External
 *      traffic arriving via Docker's bridge network has a different
 *      remote address, so this structurally blocks non-local callers.
 *   2. Shared secret in X-Internal-Key (reuses cron-trigger-key — the
 *      same workspace-scoped Secrets Manager value already mounted to
 *      both chat-server and the MCP subprocesses).
 *
 * Uses Chat SDK's uniform `Adapter.postMessage(threadId, text)` API,
 * which every adapter implements identically — same path that
 * handleCronTrigger uses for cron reply delivery.
 */
async function handleInternalChatSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!isLoopback(req)) {
    rootLogger.warn(
      { event: "internal.chat_send.non_loopback", remoteAddress: req.socket.remoteAddress },
      "non-loopback request rejected",
    );
    return json(res, 403, { error: "loopback only" });
  }

  const key = (() => {
    try {
      return fs.readFileSync("/config/secrets/cron-trigger-key", "utf-8").trim();
    } catch (err) {
      logCatch(rootLogger, "internal.chat_send.key_read_failed", err, {
        path: "/config/secrets/cron-trigger-key",
        expected: true,
      });
      return "";
    }
  })();
  if (!key) return json(res, 503, { error: "Internal key not yet available" });

  const provided = ((req.headers["x-internal-key"] as string) || "").trim();
  if (!provided || !timingSafeEqual(provided, key))
    return json(res, 401, { error: "Invalid internal key" });

  let body: ChatSendBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    logCatch(rootLogger, "internal.chat_send.bad_json", err);
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const { adapter: adapterName, threadId, text } = body;
  if (typeof adapterName !== "string" || !adapterName)
    return json(res, 400, { error: "adapter required" });
  if (typeof threadId !== "string" || !threadId)
    return json(res, 400, { error: "threadId required" });
  if (typeof text !== "string" || !text)
    return json(res, 400, { error: "text required" });

  // Web target: there's no Chat SDK adapter to postMessage into. A
  // web-originated bg task's chat_send arrives here with adapter="web"
  // and threadId set to the originating web session key
  // (`http/<sub>/<sessionId>` — see chat_mcp.py spawn_background_task and
  // TURN_THREAD_ID). Deliver by appending to that session's transcript
  // side-file and nudging any open client to refetch, so mid-task
  // chat_sends surface incrementally instead of only the final reply.
  if (adapterName === "web") {
    const dir = webSessionDir(threadId);
    if (!dir)
      return json(res, 400, { error: `Not a valid web session key: ${threadId}` });
    const ok = appendWebSessionMessage(dir, text);
    if (!ok) return json(res, 500, { error: "web session append failed" });
    publishInbox(threadId, "bg_reply", {});
    rootLogger.info(
      { event: "internal.chat_send.web_delivered", sessionKey: threadId, chars: text.length },
      "chat_send delivered to web session transcript",
    );
    return json(res, 200, { ok: true, delivered: "web" });
  }

  const adapter = getAdapterByName(adapterName) as
    | {
        postMessage?: (
          threadId: string,
          message: { markdown: string } | string,
        ) => Promise<{ id?: string }>;
      }
    | undefined;
  if (!adapter?.postMessage)
    return json(res, 404, { error: `No such adapter: ${adapterName}` });

  try {
    // For Telegram, pre-translate to its dialect (same reasoning as
    // chat.ts:handleMessage — see telegram-markdown.ts).
    const safeText =
      adapterName === "telegram"
        ? commonMarkToTelegramMarkdown(text)
        : text;
    const result = await adapter.postMessage(threadId, { markdown: safeText });
    rootLogger.info(
      {
        event: "internal.chat_send.delivered",
        adapterName,
        threadId,
        chars: text.length,
      },
      "delivered",
    );
    json(res, 200, { ok: true, id: result?.id });
  } catch (err) {
    if (isMarkdownParseError(err)) {
      logCatch(rootLogger, "internal.chat_send.markdown_rejected", err, {
        adapterName,
        threadId,
        expected: true,
      });
      try {
        const result = await adapter.postMessage(threadId, text);
        rootLogger.info(
          {
            event: "internal.chat_send.delivered",
            adapterName,
            threadId,
            fallback: "plain",
          },
          "delivered (plain-text fallback)",
        );
        return json(res, 200, { ok: true, id: result?.id, fallback: "plain" });
      } catch (fallbackErr) {
        logCatch(rootLogger, "internal.chat_send.fallback_failed", fallbackErr, {
          adapterName,
          threadId,
        });
        const m = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return json(res, 500, { error: m });
      }
    }
    logCatch(rootLogger, "internal.chat_send.post_failed", err, { adapterName, threadId });
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
}

// ---------------------------------------------------------------------------
// Internal file-send — loopback-only, same auth as chat-send
// ---------------------------------------------------------------------------

interface ChatSendFileBody {
  adapter?: string;
  threadId?: string;
  filePath?: string;
  caption?: string;
  // The calling turn's working dir, forwarded by chat_mcp from its trusted
  // SESSION_CWD env. Used to confine filePath to the caller's own session.
  sessionCwd?: string;
}

async function handleInternalChatSendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!isLoopback(req)) {
    rootLogger.warn(
      {
        event: "internal.chat_send_file.non_loopback",
        remoteAddress: req.socket.remoteAddress,
      },
      "non-loopback request rejected",
    );
    return json(res, 403, { error: "loopback only" });
  }

  const key = (() => {
    try {
      return fs.readFileSync("/config/secrets/cron-trigger-key", "utf-8").trim();
    } catch (err) {
      logCatch(rootLogger, "internal.chat_send_file.key_read_failed", err, {
        path: "/config/secrets/cron-trigger-key",
        expected: true,
      });
      return "";
    }
  })();
  if (!key) return json(res, 503, { error: "Internal key not yet available" });

  const provided = ((req.headers["x-internal-key"] as string) || "").trim();
  if (!provided || !timingSafeEqual(provided, key))
    return json(res, 401, { error: "Invalid internal key" });

  let body: ChatSendFileBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    logCatch(rootLogger, "internal.chat_send_file.bad_json", err);
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const { adapter: adapterName, threadId, filePath, caption, sessionCwd } = body;
  if (typeof adapterName !== "string" || !adapterName)
    return json(res, 400, { error: "adapter required" });
  if (typeof threadId !== "string" || !threadId)
    return json(res, 400, { error: "threadId required" });
  if (typeof filePath !== "string" || !filePath)
    return json(res, 400, { error: "filePath required" });
  if (typeof sessionCwd !== "string" || !sessionCwd)
    return json(res, 400, { error: "sessionCwd required" });

  // Security: confine the file to the CALLING session's own directory.
  // sessionCwd comes from chat_mcp's trusted SESSION_CWD env (not a model
  // arg), so a turn can only send its own session's files — not another
  // session/user's transcripts under the shared /data/sessions/ tree.
  // confineToSessionDir realpaths the target (resolving symlinks + ..) and
  // checks containment, so it also blocks /config/secrets/* and traversal.
  const resolved = confineToSessionDir(filePath, sessionCwd);
  if (!resolved) {
    rootLogger.warn(
      { event: "internal.chat_send_file.path_rejected", filePath, sessionCwd },
      "chat_send_file path outside caller session",
    );
    return json(res, 400, {
      error: "filePath must be a file inside the current session directory",
    });
  }

  const adapter = getAdapterByName(adapterName) as
    | {
        postMessage?: (
          threadId: string,
          message: Record<string, unknown>,
        ) => Promise<{ id?: string }>;
      }
    | undefined;
  if (!adapter?.postMessage)
    return json(res, 404, { error: `No such adapter: ${adapterName}` });

  try {
    const fileData = fs.readFileSync(resolved);
    const filename = resolved.split("/").pop() || "file";
    const mimeType = filename.endsWith(".png") ? "image/png"
      : filename.endsWith(".jpg") || filename.endsWith(".jpeg") ? "image/jpeg"
      : filename.endsWith(".pdf") ? "application/pdf"
      : "application/octet-stream";

    const message: Record<string, unknown> = {
      files: [{ data: fileData, filename, mimeType }],
    };
    if (caption) {
      message.markdown = adapterName === "telegram"
        ? commonMarkToTelegramMarkdown(caption)
        : caption;
    }

    const result = await adapter.postMessage(threadId, message);
    rootLogger.info(
      {
        event: "internal.chat_send_file.delivered",
        adapterName,
        threadId,
        filename,
        bytes: fileData.length,
      },
      "delivered file",
    );
    json(res, 200, { ok: true, id: result?.id });
  } catch (err) {
    logCatch(rootLogger, "internal.chat_send_file.failed", err, {
      adapterName,
      threadId,
      filePath: resolved,
    });
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
}

async function handleCronTrigger(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const cronKey = (() => {
    try {
      return fs.readFileSync("/config/secrets/cron-trigger-key", "utf-8").trim();
    } catch (err) {
      logCatch(rootLogger, "cron.trigger.key_read_failed", err, {
        path: "/config/secrets/cron-trigger-key",
        expected: true,
      });
      return "";
    }
  })();
  if (!cronKey) return json(res, 503, { error: "Cron trigger key not yet available" });

  const provided = ((req.headers["x-cron-key"] as string) || "").trim();
  if (!provided || !timingSafeEqual(provided, cronKey))
    return json(res, 401, { error: "Invalid cron trigger key" });

  let body: CronTriggerBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    logCatch(rootLogger, "cron.trigger.bad_json", err);
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const jobName = body.jobName || "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(jobName))
    return json(res, 400, { error: "Invalid jobName" });

  // If the schedule was attached to an agent, refuse to fire it when
  // that agent has been deleted (or is in flight to be). This closes
  // the up-to-1h window between the user clicking Delete and the
  // chat-server's agent-sweeper pass — without this, a deleted agent
  // can keep posting messages until the sweeper finally rm's the
  // EventBridge rule. We also kick a best-effort APA bulk-delete so
  // the rule stops firing on the next minute, not just the next sweep.
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  if (agentId) {
    let agentRow: { agentId: string; status: string } | undefined;
    try {
      const rows = await platformClient.listAgents();
      agentRow = rows.find((r) => r.agentId === agentId);
    } catch (err) {
      // APA outage: fail-open — running a turn for an agent whose row
      // we can't read is the safer mode (the supervisor will surface
      // a sensible error if the agent is genuinely gone).
      logCatch(rootLogger, "cron.trigger.list_agents_failed", err, {
        agentId,
        jobName,
      });
    }
    if (agentRow && agentRow.status !== "draft" && agentRow.status !== "deployed") {
      rootLogger.info(
        {
          event: "cron.trigger.agent_deleted_skip",
          agentId,
          jobName,
          agentStatus: agentRow.status,
        },
        "skipping cron fire — agent is being deleted",
      );
      // Opportunistic cleanup so the rule stops emitting events.
      // Fire-and-forget; the agent-sweeper would handle this on its
      // next pass anyway, but doing it here means the orphan rule
      // can be gone within seconds rather than up to an hour.
      void platformClient.deleteCronJobsByAgent(agentId).catch((err) =>
        logCatch(rootLogger, "cron.trigger.cleanup_failed", err, {
          agentId,
          jobName,
        }),
      );
      // 200 instead of 4xx: EventBridge would otherwise retry per the
      // rule's retry policy, defeating the point of skipping.
      return json(res, 200, {
        status: "skipped",
        reason: "agent_deleted",
        agentId,
        jobName,
      });
    }
  }

  const target = parseCronTarget(body.target);
  const message = body.message || `Cron job "${jobName}" triggered`;

  runCronTurnDetached(jobName, message, target);

  json(res, 200, { status: "accepted", jobName, target });
}

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------

const publicRoutes: Route[] = [
  route("GET", "/health", (_req, res) => {
    json(res, 200, { status: "ok", workspaceId: WORKSPACE_ID });
  }),
  route("GET", "/api/auth/config", (req, res) => handleAuthConfig(req, res)),
];

// ---------------------------------------------------------------------------
// Host-validated routes — non-JWT auth (API key, webhook secret)
// ---------------------------------------------------------------------------

const hostValidatedRoutes: Route[] = [
  route("POST", "/cron", handleCronTrigger),
  // GET serves the Meta/WhatsApp webhook verification challenge
  // (hub.mode/hub.verify_token/hub.challenge). The adapter echoes the
  // challenge with 200 when the verify token matches. Without this route the
  // GET falls through to the JWT-auth layer and returns 401, which Meta
  // reports as "callback URL not reachable". Telegram has no GET handshake,
  // so this never mattered before WhatsApp.
  route("GET", "/webhooks/:adapter", (req, res, { adapter }) => handleWebhook(adapter, req, res)),
  route("POST", "/webhooks/:adapter", (req, res, { adapter }) => handleWebhook(adapter, req, res)),
];

// ---------------------------------------------------------------------------
// Background-task internal endpoints (loopback-only, same auth scheme)
// ---------------------------------------------------------------------------

/** Guard helper shared by all three /internal/* bg handlers. */
function requireLoopbackAndKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  event: string,
): boolean {
  if (!isLoopback(req)) {
    rootLogger.warn({ event: `${event}.non_loopback`, remoteAddress: req.socket.remoteAddress }, "non-loopback request rejected");
    json(res, 403, { error: "loopback only" });
    return false;
  }
  const key = (() => {
    try {
      return fs.readFileSync("/config/secrets/cron-trigger-key", "utf-8").trim();
    } catch (err) {
      logCatch(rootLogger, `${event}.key_read_failed`, err, { path: "/config/secrets/cron-trigger-key", expected: true });
      return "";
    }
  })();
  if (!key) {
    json(res, 503, { error: "Internal key not yet available" });
    return false;
  }
  const provided = ((req.headers["x-internal-key"] as string) || "").trim();
  if (!provided || !timingSafeEqual(provided, key)) {
    json(res, 401, { error: "Invalid internal key" });
    return false;
  }
  return true;
}

interface SpawnBody {
  prompt?: string;
  parentSessionKey?: string;
  parentAdapter?: string;
  parentThreadId?: string;
  callerTurnId?: string;
  resumeFrom?: string;
}

/**
 * POST /internal/spawn — create a new background task.
 *
 * Called by `spawn_background_task` in chat_mcp.py. Admission gate:
 *   - bgActive.size < MAX_CONCURRENT_BG_TURNS
 *   - optional resumeFrom taskId must exist in bgHistory
 * On success, creates an AbortController, registers the entry, and fires
 * runBackgroundTurn detached. The parent's turn gets {taskId} back and
 * can `stop_background_task(taskId)` later.
 */
async function handleInternalSpawn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireLoopbackAndKey(req, res, "internal.spawn")) return;

  let body: SpawnBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    logCatch(rootLogger, "internal.spawn.bad_json", err);
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const { prompt, parentSessionKey, parentAdapter, parentThreadId, callerTurnId, resumeFrom } = body;
  if (typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: "prompt required" });
  if (typeof parentSessionKey !== "string" || !parentSessionKey) return json(res, 400, { error: "parentSessionKey required" });
  if (typeof parentAdapter !== "string" || !parentAdapter) return json(res, 400, { error: "parentAdapter required" });
  if (typeof parentThreadId !== "string" || !parentThreadId) return json(res, 400, { error: "parentThreadId required" });

  if (bgActive.size >= MAX_CONCURRENT_BG_TURNS) {
    rootLogger.warn(
      { event: "bg.spawn.rejected", reason: "at_capacity", active: bgActive.size, cap: MAX_CONCURRENT_BG_TURNS },
      "bg spawn rejected: at capacity",
    );
    return json(res, 429, { error: "at_capacity", active: bgActive.size, cap: MAX_CONCURRENT_BG_TURNS });
  }

  // Resume context — optional. When provided, prepend a summary of the
  // prior task's description/todo/snapshot so the new task can pick up.
  let effectivePrompt = prompt;
  if (resumeFrom) {
    const prior = bgHistory.find((h) => h.taskId === resumeFrom);
    if (!prior) {
      return json(res, 404, { error: "resume_miss", taskId: resumeFrom });
    }
    const trail = prior.snapshot.toolCallTrail
      .map((t) => `- ${t.name} (${t.summary})`)
      .join("\n") || "(no tool calls recorded)";
    effectivePrompt =
      `You are resuming work from a previous background task (taskId=${resumeFrom}) that ` +
      `stopped with status="${prior.stoppedBy.by}"${prior.stoppedBy.reason ? ` (${prior.stoppedBy.reason})` : ""}.\n\n` +
      `Its original prompt was:\n---\n${prior.prompt}\n---\n\n` +
      `Recent tool calls it made:\n${trail}\n\n` +
      `Last assistant text:\n---\n${prior.snapshot.assistantText.slice(-2000)}\n---\n\n` +
      `On-disk state for that task may exist at {cwd}/bg-state/${resumeFrom}/ — read it before starting. ` +
      `Then continue the work with this new instruction:\n\n${prompt}`;
  }

  const taskId = crypto.randomUUID();
  const abort = new AbortController();
  const startedAt = Date.now();

  const entry: BgActiveEntry = {
    taskId,
    abort,
    startedAt,
    prompt: effectivePrompt,
    parentSessionKey,
    parentAdapter,
    parentThreadId,
    callerTurnId,
    snapshot: { assistantText: "", toolCallTrail: [] },
  };
  // Wall-clock abort — fires if the task runs longer than BG_TASK_MAX_WALL_MS.
  entry.walltimeTimer = setTimeout(() => {
    if (!bgActive.has(taskId)) return;
    rootLogger.warn(
      { event: "bg.timeout", taskId, wallMs: BG_TASK_MAX_WALL_MS },
      `bg task ${taskId} hit wall-clock limit`,
    );
    // Set the attribution before abort() so the finalize block reads
    // "timeout" rather than the generic "error: aborted".
    stopAttributionOverrides.set(taskId, {
      by: "timeout",
      reason: `wall-clock ${BG_TASK_MAX_WALL_MS}ms exceeded`,
      at: Date.now(),
    });
    abort.abort();
  }, BG_TASK_MAX_WALL_MS);
  entry.walltimeTimer.unref?.();

  bgActive.set(taskId, entry);
  rootLogger.info(
    { event: "bg.spawn.accepted", taskId, parentSessionKey, callerTurnId, resumeFrom: resumeFrom ?? null, cap: MAX_CONCURRENT_BG_TURNS, active: bgActive.size },
    `bg task ${taskId} accepted`,
  );

  // Fire-and-forget. The detached runBackgroundTurn will call back into
  // bgActive via entry.snapshot (updated through onProgress) and deliver
  // its final reply through the adapter. We never await this.
  void (async () => {
    const appendPrompt =
      `\n\n---\nSYSTEM INSTRUCTION (enforced runtime contract — do not remove): ` +
      `Before starting work, create \`{cwd}/bg-state/${taskId}/description.md\` with a ` +
      `one-paragraph description of what you are about to do, and \`{cwd}/bg-state/${taskId}/todo.md\` ` +
      `with a checklist of the concrete steps. Update \`todo.md\` as you complete steps. ` +
      `If you make substantial progress that would be hard to redo, commit intermediate notes ` +
      `to \`{cwd}/bg-state/${taskId}/notes.md\`. These files survive container restarts — ` +
      `they are the only way a future task can recover your work if this one is stopped or killed.\n`;

    let stoppedBy: BgStopAttribution = { by: "natural", at: Date.now() };
    let finalReply = "";
    try {
      const result = await runBackgroundTurn({
        sessionKey: `bg/${taskId}`,
        prompt: effectivePrompt + appendPrompt,
        source: "http",
        callerId: "bg-spawn",
        adapterName: parentAdapter,
        threadId: parentThreadId,
        parentSessionKey,
        abortController: abort,
        onProgress: (snap) => {
          const e = bgActive.get(taskId);
          if (e) e.snapshot = snap;
        },
      });
      finalReply = result.reply || "";
      if (result.error === "aborted") {
        // Caller (stop_background_task) OR wall-clock timer set the
        // attribution before calling abort(). Fall back to generic if
        // neither did (shouldn't happen in practice).
        stoppedBy = stopAttributionOverrides.get(taskId) ?? { by: "error", reason: "aborted", at: Date.now() };
      } else if (result.error) {
        stoppedBy = { by: "error", reason: result.error, at: Date.now() };
      } else {
        stoppedBy = { by: "natural", at: Date.now() };
      }
    } catch (err) {
      logCatch(rootLogger, "bg.run.exception", err, { taskId });
      stoppedBy = { by: "error", reason: err instanceof Error ? err.message : String(err), at: Date.now() };
    } finally {
      stopAttributionOverrides.delete(taskId);
      // Post the final reply (if any) back to the originating chat. Empty
      // replies on abort are swallowed — the parent chat already saw the
      // "Started bg task ..." ack.
      if (finalReply.trim()) {
        const header = `_(bg task ${taskId.slice(0, 8)} ${stoppedBy.by})_\n\n`;
        if (parentAdapter === "web") {
          // Web has no adapter to postMessage into — persist the reply to
          // the originating session's transcript side-file, which the
          // browser merges in on its next load/poll.
          deliverWebBgReply(parentSessionKey, taskId, header + finalReply);
        } else {
          try {
            const adapter = getAdapterByName(parentAdapter) as
              | { postMessage?: (threadId: string, message: { markdown: string } | string) => Promise<{ id?: string }> }
              | undefined;
            if (adapter?.postMessage) {
              const safe = parentAdapter === "telegram"
                ? commonMarkToTelegramMarkdown(header + finalReply)
                : header + finalReply;
              await adapter.postMessage(parentThreadId, { markdown: safe });
            }
          } catch (err) {
            logCatch(rootLogger, "bg.reply.post_failed", err, { taskId, parentAdapter, parentThreadId });
          }
        }
      }
      // Nudge the web session's open inbox so the browser refetches the
      // transcript (the reply) and file tree (anything the task wrote)
      // instantly, rather than waiting for the fallback poll. No-op when
      // the session isn't open. bg_reply only fires when there's a reply
      // to show; files_changed fires regardless (a task can write files
      // even when it ends with no final message).
      if (parentAdapter === "web") {
        if (finalReply.trim()) publishInbox(parentSessionKey, "bg_reply", { taskId });
        publishInbox(parentSessionKey, "files_changed", { taskId });
      }
      finalizeBgTask(entry, finalReply, stoppedBy);
    }
  })();

  json(res, 200, { ok: true, taskId });
}

/** Bridge between stop_background_task's attribution (who/why) and the
 * runBackgroundTurn finally block. The stop handler puts the intended
 * attribution here; the finalize path reads it. */
const stopAttributionOverrides = new Map<string, BgStopAttribution>();

/** Abort a running bg task with the given attribution. Shared by the
 * internal MCP-facing stop route and the user-facing Tasks route; the
 * actual finalization (bgHistory entry, reply delivery) happens async
 * in the spawn's finally block, which reads stopAttributionOverrides. */
function stopBgTaskCore(taskId: string, attribution: BgStopAttribution): BgStopOutcome {
  const entry = bgActive.get(taskId);
  if (!entry) {
    // Maybe it already completed — check history.
    const past = bgHistory.find((h) => h.taskId === taskId);
    if (past) return { kind: "already_finished", entry: past };
    return { kind: "not_found" };
  }
  stopAttributionOverrides.set(taskId, attribution);
  entry.abort.abort();
  rootLogger.info(
    { event: "bg.aborted", taskId, by: attribution.by, turnId: attribution.turnId, userId: attribution.userId },
    `bg task ${taskId} aborted (by=${attribution.by})`,
  );
  return { kind: "aborted", snapshot: entry.snapshot, attribution };
}

interface StopBgBody {
  taskId?: string;
  callerTurnId?: string;
}

/**
 * POST /internal/stop-bg — abort a running background task and return
 * the current snapshot (so the caller has immediate context).
 */
async function handleInternalStopBg(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireLoopbackAndKey(req, res, "internal.stop_bg")) return;

  let body: StopBgBody;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    logCatch(rootLogger, "internal.stop_bg.bad_json", err);
    return json(res, 400, { error: "Invalid JSON body" });
  }
  const { taskId, callerTurnId } = body;
  if (typeof taskId !== "string" || !taskId) return json(res, 400, { error: "taskId required" });

  const outcome = stopBgTaskCore(taskId, {
    by: "model",
    turnId: callerTurnId,
    at: Date.now(),
  });
  if (outcome.kind === "already_finished") {
    return json(res, 200, {
      ok: true,
      alreadyFinished: true,
      taskId,
      stoppedBy: outcome.entry.stoppedBy,
      snapshot: outcome.entry.snapshot,
      finalReply: outcome.entry.finalReply,
    });
  }
  if (outcome.kind === "not_found") {
    return json(res, 404, { error: "unknown taskId", taskId });
  }

  // Return immediate snapshot — finalization happens async in the bg
  // task's finally block, but the snapshot we have right now is what
  // the model needs to decide its next move.
  json(res, 200, {
    ok: true,
    taskId,
    aborted: true,
    stoppedBy: outcome.attribution,
    snapshot: outcome.snapshot,
  });
}

/**
 * GET /internal/list-bg — list active + recent background tasks.
 * Used by `list_background_tasks` to let the model decide whether to
 * spawn, wait, or answer inline.
 */
async function handleInternalListBg(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!requireLoopbackAndKey(req, res, "internal.list_bg")) return;
  pruneBgHistory();

  const active = Array.from(bgActive.values()).map((e) => ({
    taskId: e.taskId,
    startedAt: e.startedAt,
    ageMs: Date.now() - e.startedAt,
    promptPreview: e.prompt.slice(0, 140),
    parentAdapter: e.parentAdapter,
    parentThreadId: e.parentThreadId,
    snapshot: oneLineSnapshot(e.snapshot),
  }));
  const recent = bgHistory.slice().reverse().slice(0, 20).map((h) => ({
    taskId: h.taskId,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    durationMs: h.endedAt - h.startedAt,
    promptPreview: h.prompt.slice(0, 140),
    parentAdapter: h.parentAdapter,
    parentThreadId: h.parentThreadId,
    stoppedBy: h.stoppedBy,
    finalReplyChars: h.finalReply.length,
    snapshot: oneLineSnapshot(h.snapshot),
  }));
  json(res, 200, {
    cap: MAX_CONCURRENT_BG_TURNS,
    activeCount: active.length,
    active,
    recent,
  });
}

// Loopback-only internal routes — bypass Host-header validation because
// the MCP subprocess reaches them via `http://localhost:8080`, where the
// Host header is "localhost:8080" (not "{workspaceId}.{DOMAIN_NAME}").
// The handlers themselves enforce:
//   1. req.socket.remoteAddress must be 127.0.0.1/::1 (structural)
//   2. X-Internal-Key must match /config/secrets/cron-trigger-key
// Together these mean the endpoint is unreachable from outside the
// sandbox container.
const internalRoutes: Route[] = [
  route("POST", "/internal/chat-send", handleInternalChatSend),
  route("POST", "/internal/chat-send-file", handleInternalChatSendFile),
  route("POST", "/internal/spawn", handleInternalSpawn),
  route("POST", "/internal/stop-bg", handleInternalStopBg),
  route("GET", "/internal/list-bg", handleInternalListBg),
];

// ---------------------------------------------------------------------------
// Authenticated routes — JWT + workspace membership
// ---------------------------------------------------------------------------

/** Dependency bundle for the Tasks routes (routes/tasks.ts). Built once
 * at module level — both registries (TurnQueue, bg maps) are module
 * singletons, so the closures stay valid for the process lifetime. */
const tasksDeps: TasksDeps = {
  getForeground: inspectTurnQueue,
  fgLimits: {
    maxConcurrent: turnQueueConfig.maxConcurrent,
    maxQueue: turnQueueConfig.maxQueue,
    maxWaitMs: turnQueueConfig.maxWaitMs,
  },
  bgLimits: {
    maxConcurrent: MAX_CONCURRENT_BG_TURNS,
    wallMs: BG_TASK_MAX_WALL_MS,
    historyTtlMs: BG_HISTORY_TTL_MS,
  },
  listBgActive: () => Array.from(bgActive.values()),
  listBgRecent: () => {
    pruneBgHistory();
    return bgHistory;
  },
  stopBg: stopBgTaskCore,
};

function authedRoutes(sub: string, auth: Extract<AuthResult, { ok: true }>): Route[] {
  // Admin-only handler wrapper. Mirrors `_require_admin` in
  // lambda/workspace-api/index.py so the chat-server's parallel agent
  // lifecycle endpoints (mutations + reads of in-progress drafts) are
  // gated identically. Without this, any workspace member could rewrite
  // and deploy any agent, persistently affecting what runs under the
  // admin's supervisor session with workspace-wide credentials.
  const adminOnly = (h: Handler): Handler => {
    return (req, res, params) => {
      if (auth.role !== "admin") {
        return json(res, 403, { error: "Must be a workspace admin" });
      }
      return h(req, res, params);
    };
  };
  return [
    route("GET", "/api/me", (req, res) => handleMe(req, res, auth)),

    // Sessions
    route("GET", "/api/sessions", (req, res) => listSessions(req, res, sub)),
    route("POST", "/api/sessions", (req, res) => createSession(req, res, sub)),
    route("DELETE", "/api/sessions/:id", (req, res, { id }) => deleteSession(req, res, sub, id)),
    route("PATCH", "/api/sessions/:id", async (req, res, { id }) => renameSession(await readBody(req), res, sub, id)),

    // Chat
    route("POST", "/api/sessions/:id/chat", async (req, res, { id }) => submitChat(await readBody(req), res, sub, id, auth.claims.email as string | undefined)),
    route("GET", "/api/sessions/:id/chat/stream", (req, res, { id }) => streamChat(req, res, sub, id)),
    route("GET", "/api/sessions/:id/chat/active", (req, res, { id }) => getActiveTurn(req, res, sub, id)),
    // Per-chat token tally from the platform's per-session usage rollup
    // (written fire-and-forget after each turn — the tally can trail the
    // latest turn by a beat). Failures degrade to enabled:false so the
    // chat UI never breaks over an observability read.
    route("GET", "/api/sessions/:id/usage", async (req, res, { id }) => {
      const sessionKey = `http/${sub}/${id}`;
      let usage;
      try {
        usage = await platformClient.getSessionUsage(sessionKey);
      } catch (err) {
        logCatch(rootLogger, "usage.session_read_failed", err, { sessionKey });
        usage = {
          sessionKey,
          enabled: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          turns: 0,
          apiCalls: 0,
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(usage));
    }),
    route("GET", "/api/sessions/:id/inbox/stream", (req, res, { id }) => subscribeInbox(req, res, `http/${sub}/${id}`)),
    route("DELETE", "/api/sessions/:id/chat/:requestId", (req, res, { id, requestId }) => cancelChat(req, res, sub, id, requestId)),

    // Tasks — running work across both pools (foreground turn queue +
    // background registry) for the Tasks UI. Any member may view and
    // stop background tasks; per-turn privacy is gated in the handler.
    route("GET", "/api/tasks", (req, res) => handleTasksList(req, res, sub, tasksDeps)),
    route("POST", "/api/tasks/background/:taskId/stop", (req, res, { taskId }) =>
      handleTaskStop(req, res, sub, auth.claims.email as string | undefined, taskId, tasksDeps)),

    // Answer to an in-flight ask_user_question. The MCP handler
    // running in the active turn is awaiting a Promise; this looks
    // it up by sessionKey and resolves it. Body shape:
    //   { answers: [{ header: string, labels: string[] }, ...] }
    route("POST", "/api/sessions/:id/answer-question", async (req, res, { id }) => {
      let parsed: AskUserAnswer | null = null;
      try {
        parsed = JSON.parse(await readBody(req)) as AskUserAnswer;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      if (!parsed || !Array.isArray(parsed.answers)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "answers must be an array" }));
        return;
      }
      const sessionKey = `http/${sub}/${id}`;
      const ok = answerPendingQuestion(sessionKey, parsed);
      if (!ok) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No pending question for this session" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),

    // Creator chat — one session per agent, keyed by agentId. Uses the
    // same SSE pipeline as regular chat; sessionKey format is
    // `creator/agent/{agentId}` (parsed by agent.ts to dispatch into
    // runCreatorTurnImpl).
    route(
      "POST",
      "/api/agents/:agentId/creator/chat",
      adminOnly(async (req, res, { agentId }) =>
        submitCreatorChat(
          await readBody(req),
          res,
          sub,
          agentId,
          auth.claims.email as string | undefined,
        ),
      ),
    ),
    route(
      "GET",
      "/api/agents/:agentId/creator/chat/stream",
      adminOnly((req, res, { agentId }) => streamCreatorChat(req, res, sub, agentId)),
    ),
    route(
      "DELETE",
      "/api/agents/:agentId/creator/chat/:requestId",
      adminOnly((req, res, { agentId, requestId }) =>
        cancelCreatorChat(req, res, sub, agentId, requestId),
      ),
    ),
    route(
      "GET",
      "/api/agents/:agentId/creator/messages",
      adminOnly((req, res, { agentId }) =>
        handleCreatorMessages(req, res, sub, agentId),
      ),
    ),

    // Agent def/ file browser (read-only). Gives the UI a way to show
    // what the creator has built without asking the creator to paste
    // contents back into chat. Writes still only happen through the
    // creator session's own filesystem tools.
    route(
      "GET",
      "/api/agents/:agentId/def/files",
      adminOnly((req, res, { agentId }) => listAgentDefFiles(req, res, sub, agentId)),
    ),
    route(
      "GET",
      "/api/agents/:agentId/def/files/*",
      adminOnly((req, res, { agentId, wildcard }) =>
        readAgentDefFile(req, res, sub, agentId, wildcard || ""),
      ),
    ),

    // Read-only views of the LIVE deployed def/ snapshot and the
    // runtime workdir/. Used by the Agents-page Explore panel so
    // users can inspect what's actually being routed to (vs.
    // /def/files which shows the creator's in-progress draft).
    route(
      "GET",
      "/api/agents/:agentId/live-def/files",
      adminOnly((req, res, { agentId }) => listAgentLiveDefFiles(req, res, sub, agentId)),
    ),
    route(
      "GET",
      "/api/agents/:agentId/live-def/files/*",
      adminOnly((req, res, { agentId, wildcard }) =>
        readAgentLiveDefFile(req, res, sub, agentId, wildcard || ""),
      ),
    ),
    route(
      "GET",
      "/api/agents/:agentId/workdir/files",
      adminOnly((req, res, { agentId }) => listAgentWorkdirFiles(req, res, sub, agentId)),
    ),
    route(
      "GET",
      "/api/agents/:agentId/workdir/files/*",
      adminOnly((req, res, { agentId, wildcard }) =>
        readAgentWorkdirFile(req, res, sub, agentId, wildcard || ""),
      ),
    ),

    // One-shot deploy: secret check → promote def-draft → flip DDB
    // status. Replaces the frontend orchestrating two separate calls
    // to chat-server (promote) + management-API (status flip).
    route(
      "POST",
      "/api/agents/:agentId/deploy",
      adminOnly((req, res, { agentId }) => deployAgent(req, res, sub, agentId)),
    ),
    // Create a workspace chat session pinned to test one agent (loaded
    // from def-draft). Called by the Test button.
    route(
      "POST",
      "/api/agents/:agentId/test-session",
      adminOnly(async (req, res, { agentId }) =>
        createAgentTestSession(await readBody(req), res, sub, agentId),
      ),
    ),

    // Upload a zip into def-draft/. Body is raw zip bytes (no
    // multipart wrapper). The frontend POSTs the dropped File's
    // ArrayBuffer; the response carries a markdown summary the
    // frontend then submits as a synthetic user message so the
    // creator AI is told what was uploaded.
    route(
      "POST",
      "/api/agents/:agentId/uploads/zip",
      adminOnly(async (req, res, { agentId }) => {
        let buf: Buffer;
        try {
          buf = await readBodyBuffer(req, MAX_ZIP_BYTES);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "EBODY2BIG") {
            return json(res, 413, {
              error: `Zip exceeds ${MAX_ZIP_BYTES / (1024 * 1024)} MB limit`,
            });
          }
          throw err;
        }
        const url = new URL(req.url || "/", "http://x");
        const origName = url.searchParams.get("name") || "upload.zip";
        uploadDraftZip(buf, res, sub, agentId, origName);
      }),
    ),

    // Messages
    route("GET", "/api/sessions/:id/messages", (req, res, { id }) => handleMessages(req, res, sub, id)),

    // Files
    route("GET", "/api/sessions/:id/files", (req, res, { id }) => listFiles(req, res, sub, id)),
    route("GET", "/api/sessions/:id/files/*", (req, res, { id, wildcard }) => readFile(req, res, sub, id, wildcard || "")),
    route("PUT", "/api/sessions/:id/files/*", async (req, res, { id, wildcard }) => writeFile(await readBody(req), res, sub, id, wildcard || "")),
    route("PATCH", "/api/sessions/:id/files/*", async (req, res, { id, wildcard }) => renameFile(await readBody(req), res, sub, id, wildcard || "")),
    route("DELETE", "/api/sessions/:id/files/*", (req, res, { id, wildcard }) => deleteFile(res, sub, id, wildcard || "")),

    // Context
    route("GET", "/api/context", (req, res) => handleListContext(req, res)),
    route("GET", "/api/context/graph", (req, res) => handleContextGraph(req, res)),
    route("GET", "/api/context/*", (req, res, { wildcard }) => handleReadContext(req, res, wildcard || "")),

    // Cron jobs are READ via the workspace-api Lambda (frontend) and
    // CRUD'd via the agent_platform_mcp (model). chat-server has no
    // role in the cron control plane.
  ];
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
  const method = req.method || "GET";

  // CORS preflight
  if (pathname.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  // Layer 1: public routes — no auth
  if (dispatch(method, pathname, publicRoutes, req, res)) return;

  // Layer 2: internal loopback routes — skip Host-header validation
  // because the MCP subprocess connects via localhost:8080 and the
  // handler enforces loopback + shared-secret auth internally.
  if (dispatch(method, pathname, internalRoutes, req, res)) return;

  // Layer 3: host validation — all remaining routes require it
  if (!validateHost(req))
    return json(res, 400, { error: "Host header does not match workspace" });

  // Layer 4: host-validated routes (API key / webhook secret auth)
  if (dispatch(method, pathname, hostValidatedRoutes, req, res)) return;

  // Layer 5: JWT + membership auth
  const auth = await authenticate(req);
  if (!auth.ok) return json(res, auth.status, { error: auth.error });

  // Layer 6: authenticated API routes
  if (dispatch(method, pathname, authedRoutes(auth.sub, auth), req, res)) return;

  json(res, 404, { error: "Not found" });
});

// Initialize Chat SDK with Telegram webhook adapter
initChatSdk();

// Agent EFS-cleanup sweeper: rm /data/agents/{id}/ for any DDB row
// flagged deletion_pending by the Management API. Hourly after an
// initial pass at startup; doesn't keep the event loop alive.
import("./agent-sweeper.js")
  .then(({ startAgentSweeper }) => startAgentSweeper())
  .catch((err) => logCatch(rootLogger, "agent_sweeper.start_failed", err));

// React to adapter-secret rotations as soon as the sidecar materializes
// them under /config/secrets. Replaces a 30s setInterval — combined
// with sidecar's 5s SSM tick, end-to-end propagation of a rotated bot
// token is single-digit seconds instead of ~45s.
startSecretsWatcher({
  dir: "/config/secrets",
  onChange: maybeReloadChatSdk,
  logger: rootLogger,
});

// Graceful shutdown: ECS sends SIGTERM on deploys. Abort in-flight bg
// tasks with a "container_shutdown" attribution so the parent chat sees
// a clean reason (the model can recover from the bg-state/ folder on
// the next turn). Then flush Langfuse traces so the last turn's spans
// land before the process exits. Both steps bounded so a slow downstream
// can't block ECS stop-timeout.
async function shutdown(signal: string): Promise<void> {
  rootLogger.info({ event: "boot.shutdown", signal, bgActiveCount: bgActive.size }, `received ${signal}`);

  // 1. Mark all active bg tasks and abort them. The finalize path in
  //    handleInternalSpawn's fire-and-forget block picks this up and
  //    posts a "stopped" notice to each parent chat.
  for (const [taskId, entry] of bgActive.entries()) {
    stopAttributionOverrides.set(taskId, {
      by: "container_shutdown",
      reason: `received ${signal}`,
      at: Date.now(),
    });
    try {
      entry.abort.abort();
    } catch (err) {
      logCatch(rootLogger, "boot.shutdown.bg_abort_failed", err, { taskId });
    }
  }

  // 2. Wait up to 10s for bg task finalizers to run (posts "stopped"
  //    message to each parent chat).
  if (bgActive.size > 0) {
    const deadline = Date.now() + 10_000;
    while (bgActive.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (bgActive.size > 0) {
      rootLogger.warn(
        { event: "boot.shutdown.bg_wait_timeout", stillActive: bgActive.size },
        "bg tasks did not finalize within 10s of shutdown",
      );
    }
  }

  // 3. Flush Langfuse.
  try {
    await Promise.race([
      flushLangfuse(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err) {
    logCatch(rootLogger, "boot.shutdown.flush_failed", err);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, () => {
  rootLogger.info(
    { event: "boot.listening", port: PORT },
    `chat server listening on port ${PORT}`,
  );
});

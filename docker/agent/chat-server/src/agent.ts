/**
 * agent.ts — TS Agent SDK integration.
 *
 * Replaces agent_turn.py + dispatcher.py's _run_turn logic. Calls
 * query() in-process with per-session cwd/HOME, canUseTool confinement,
 * and Python MCP servers via stdio.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, cpSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, McpStdioServerConfig, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  buildCanUseTool,
  buildSupervisorCanUseTool,
  createSubagentRegistry,
  buildBashBackgroundPreToolUseHook,
} from "./sandbox.js";
import { buildSystemPrompt, setupClaudeCredentials, type Member } from "./prompt.js";
import {
  resolveLlmProvider,
  ANTHROPIC_DIRECT_MODEL,
} from "./llm-provider-config.js";
import {
  platformClient,
  PlatformApiError,
  loadAgentPlatformKey,
} from "./platform-client.js";
import { rootLogger, logCatch } from "./logger.js";
import { turnQueueConfig } from "./turn-queue-config.js";
import { tracedQuery } from "./instrumented-query.js";
import { buildAskUserMcp, cancelPendingQuestion } from "./ask-user-mcp.js";
import { agentPaths, loadAgentDef, AGENT_ID_RE } from "./agent-def.js";
import { buildSubagentMap, renderAgentsAppendix } from "./subagents.js";
import { measureMcpSchemas } from "./mcp-introspect.js";

// Per-process cache: each MCP server's tool schemas are deterministic
// given its env, so we measure once on first sighting. Keyed by server
// name so a Playwright that wins the attach race on a later turn also
// gets measured. Servers that fail measurement (timeout / spawn error)
// are NOT cached as success, so a subsequent turn retries.
const measuredMcpServers = new Set<string>();


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** MCP servers at /app/mcp/. Compiled JS is at /app/chat-server/agent.js. */
const MCP_DIR = join(dirname(__dirname), "mcp");
const SESSIONS_ROOT = "/data/sessions";
const CONFIG_DIR = "/config";

/**
 * Foreground Bash window for the CLI subprocess — 10 minutes, the limit
 * TOOLS.md documents. Without these the CLI defaults to 2 minutes and
 * then auto-moves the command to a background shell, which dies with the
 * CLI subprocess at turn end, silently losing the work. Shared by both
 * queryEnv blocks (regular + creator turns) and pinned by the
 * bash-background integration test. See sandbox.ts's run_in_background
 * deny for the explicit-background half of this contract.
 */
export const BASH_TIMEOUT_ENV = {
  BASH_DEFAULT_TIMEOUT_MS: "600000",
  BASH_MAX_TIMEOUT_MS: "600000",
} as const;

/** Where the turn came from. Used for logging and to gate cron-specific
 * stateless session behavior. */
export type TurnSource =
  | "telegram"
  | "slack"
  | "discord"
  | "whatsapp"
  | "teams"
  | "web"
  | "http"
  | "cron";

/** Routing target for a cron trigger's final reply. */
export interface CronTarget {
  adapter: string;
  threadId: string;
}

export interface TurnOptions {
  /** e.g. "telegram/dm/12345", "http/{userId}/{sessionId}", "http/system-cron/{jobName}" */
  sessionKey: string;
  /** The user-facing prompt text (already formatted with sender header). */
  prompt: string;
  /** Caller identity: Telegram user_id or Cognito sub. */
  callerId?: string;
  /** Caller email from JWT claims (HTTP turns only). Used as git commit author. */
  callerEmail?: string;
  /** Turn source for logging + cron-gating. */
  source?: TurnSource;
  /** Chat SDK adapter name for the originating chat (telegram/slack/...). */
  adapterName?: string;
  /** Chat SDK thread.id (encoded string form) for the originating chat. */
  threadId?: string;
  /** Cron-only: where to deliver this trigger's final reply. Used by the
   * cron MCP subprocess to default new cron targets to the same chat. */
  cronTarget?: CronTarget;
  /** Optional coalesce key for the global TurnQueue. At most one entry
   * (active OR waiting) may exist per key — a new submission with a
   * matching waiting-list entry replaces it (latest wins), matching
   * Chat SDK's `"queue"` coalesce semantics. Used for cron turns to
   * absorb EventBridge retries + rapid scheduled fires without spawning
   * redundant Claude subprocesses. Leave undefined for webhook/HTTP
   * turns (webhook is already serialized per-channel by Chat SDK
   * upstream). */
  coalesceKey?: string;
  /** Callback for streaming events to SSE consumers. */
  onEvent?: (event: unknown) => void;
  /** Background-task extensions (used only by runBackgroundTurn) ---------- */
  /** When set, the turn reuses this parent's session directory — same cwd,
   * same SANDBOX_SESSION_ROOT, so files created by the bg task land in
   * the parent workspace and the LD_PRELOAD Bash sandbox allows the same
   * paths. `sessionKey` still uniquely identifies the bg turn for logging. */
  parentSessionKey?: string;
  /** If true, HOME is placed under `/tmp/bg-home/{sanitizedKey}` (tmpfs)
   * and `rm -rf`'d in a finally block — transcripts die with the task. */
  ephemeralHome?: boolean;
  /** Lets the caller (bgRegistry) cancel this turn. Forwarded to the SDK
   * via `queryOpts.options.abortController`. */
  abortController?: AbortController;
  /** When true, the chat MCP hides the bg-spawn tools (flat recursion rule). */
  isBackground?: boolean;
  /** Called on every assistant/tool event with a rolling snapshot of what
   * the bg turn has done so far. Used by the bgRegistry to surface partial
   * state when a task is stopped or the container is restarted. */
  onProgress?: (snap: BackgroundSnapshot) => void;
}

export interface TurnResult {
  reply: string;
  sessionId?: string;
  error?: string;
  /** UUID for the turn — omitted on AT_CAPACITY rejections (they never
   * got a turn) but set on every runAgentTurnImpl return. Callers surface
   * the first 8 chars as a ref id so users can cite specific failures. */
  turnId?: string;
  /** True when the turn ended because the AbortController was fired
   * (bg task stop_background_task, parent-turn supersede). Callers treat
   * this as a deliberate cancellation, not an error. */
  aborted?: boolean;
  /** Set only when error === AT_CAPACITY. Lets the user-facing reply
   * explain *why* a turn was rejected (which slots are busy, how long we
   * waited, who's holding them) instead of a generic "I'm busy" message. */
  capacity?: CapacityInfo;
}

/** Reason a submission was rejected by the TurnQueue. */
export type AtCapacityReason = "queue_full" | "wait_timeout";

/** Describes one of the active turns currently holding a slot. Built from
 * `TurnOptions` at runOne() time and surfaced on AT_CAPACITY rejections so
 * we can name the blocker (e.g. "scheduled task 'autopost-buffer-tick'"). */
export interface ActiveDescriptor {
  source: TurnSource;
  /** Cron job name, when source=cron. */
  jobName?: string;
  /** Adapter name (telegram/slack/...), when source=webhook. */
  adapterName?: string;
  /** Epoch ms the turn started running. */
  startedAt: number;
}

/** Internal per-active-turn record. The descriptor is what CapacityInfo
 * surfaces on rejections; the rest exists for inspect() (Tasks UI). */
interface ActiveTurnRecord {
  id: string;
  descriptor: ActiveDescriptor;
  sessionKey: string;
  /** Rolling progress snapshot, updated on every SDK message via the
   * onProgress wrap in runOne(). Undefined until the first event. */
  snapshot?: BackgroundSnapshot;
}

/** Read-only view of the TurnQueue for the Tasks UI. */
export interface TurnQueueInspection {
  active: Array<{
    id: string;
    source: TurnSource;
    jobName?: string;
    adapterName?: string;
    startedAt: number;
    sessionKey: string;
    snapshot?: BackgroundSnapshot;
  }>;
  waiting: Array<{
    id: string;
    source: TurnSource;
    adapterName?: string;
    coalesceKey?: string;
    enqueuedAt: number;
    sessionKey: string;
  }>;
}

export interface CapacityInfo {
  reason: AtCapacityReason;
  active: number;
  max: number;
  waiting: number;
  /** Wall-clock ms the rejected entry spent in the queue. 0 for queue_full
   * (rejected synchronously at submit time, never enqueued). */
  waitedMs: number;
  /** Snapshot of the turns that were holding slots at rejection time. */
  activeDescriptors: ActiveDescriptor[];
}

/** Rolling snapshot of a background task's work. Kept in memory by the
 * bgRegistry; surfaced via `list_background_tasks` / `stop_background_task`.
 * Not persisted — the durable equivalent is the EFS `bg-state/{taskId}/`
 * folder convention that the model is instructed to maintain. */
export interface ToolCallEntry {
  /** MCP tool name (e.g. "Bash", "chat_send", "Read"). */
  name: string;
  /** One-line summary of args (truncated) — never includes full payloads. */
  summary: string;
  /** Epoch ms. */
  ts: number;
}
export interface BackgroundSnapshot {
  assistantText: string;
  toolCallTrail: ToolCallEntry[];
}

/** Sentinel error value returned by runAgentTurn when the TurnQueue
 * rejects a submission (queue full OR the waiting entry timed out
 * before it could run). Callers at HTTP boundaries map this to a 503
 * (cron → EventBridge retry) or to a user-visible "busy" message
 * (Chat SDK webhook). */
export const AT_CAPACITY = "at_capacity" as const;

/** Render a CapacityInfo into the user-visible reply that explains *why*
 * a turn was rejected. Names the blocker(s) when we can (cron job names,
 * adapter names) so the user knows what to wait for. Used by the HTTP,
 * webhook, and creator/test chat paths. */
export function renderAtCapacityReply(cap: CapacityInfo | undefined): string {
  if (!cap) {
    return "I'm currently handling other requests and couldn't get to this one in time. Please try again in a few minutes.";
  }
  const blockers = (cap.activeDescriptors ?? []).map((d) => {
    if (d.source === "cron" && d.jobName) return `scheduled task \`${d.jobName}\``;
    if (d.source === "cron") return "a scheduled task";
    if (d.source === "http") return "another chat";
    return d.adapterName ? `a ${d.adapterName} message` : `a ${d.source} message`;
  });
  // Dedupe and limit to 3 to keep the message short.
  const uniqueBlockers = Array.from(new Set(blockers)).slice(0, 3);
  const blockerPhrase =
    uniqueBlockers.length === 0
      ? `${cap.active} other turn${cap.active === 1 ? "" : "s"}`
      : uniqueBlockers.length === 1
      ? uniqueBlockers[0]
      : uniqueBlockers.slice(0, -1).join(", ") + " and " + uniqueBlockers.slice(-1);
  if (cap.reason === "queue_full") {
    return `I'm at capacity — ${cap.waiting} request${cap.waiting === 1 ? "" : "s"} are already in line and I'm running ${blockerPhrase}. Please try again in a couple of minutes.`;
  }
  const waitedSec = Math.round(cap.waitedMs / 1000);
  const verb = uniqueBlockers.length === 1 ? "is" : "are";
  return `I waited ${waitedSec}s for a free slot but ${blockerPhrase} ${verb} still running. Long-running tasks usually finish within a few minutes — please retry shortly.`;
}

// --- Global TurnQueue --------------------------------------------------
//
// Every call to runAgentTurn() goes through this queue. It caps
// concurrent Claude CLI subprocesses (runAgentTurnImpl spawns one per
// turn, each ~250-300 MiB observed peak) so we can't blow the sandbox
// container's memory limit.
//
// Sits DOWNSTREAM of Chat SDK's per-channel queue:
//   Chat SDK per-channel lock (serializes same-channel bursts,
//     coalesces intermediate messages via context.skipped)
//         ↓
//   handleMessage → runAgentTurn → TurnQueue (this)
//         ↓
//   runAgentTurnImpl (actual Claude subprocess spawn)
//
// So same-channel webhook bursts are already collapsed upstream by the
// time they reach us. TurnQueue handles cross-channel bursts + cron +
// HTTP chat — sources that Chat SDK doesn't see at all.
//
// Coalescing: when a submission carries a coalesceKey, at most one
// entry (active OR waiting) for that key may exist at a time:
//   - key neither active nor waiting → push normally
//   - key already active → push new entry to waiting (will run after)
//   - key already waiting → REPLACE the waiting entry (latest wins,
//     matches Chat SDK's "process latest + context.skipped" semantics)
// Used for cron (`cron:${jobName}`) so EventBridge retries + rapid
// scheduled fires collapse naturally. Webhook and HTTP turns don't set
// coalesceKey (per-channel dedup already handled by Chat SDK upstream).
//
// Caps are explicit numbers loaded from the platform-wide SSM parameter
// (vended into /config/turn-queue.json by the sidecar). No auto-sizing
// from container memory — the per-turn-MiB worst-case formula was
// always more conservative than reality and made the operator's math
// harder. See docker/agent/chat-server/src/turn-queue-config.ts.

const MAX_CONCURRENT_TURNS = turnQueueConfig.maxConcurrent;
const MAX_QUEUED_TURNS = turnQueueConfig.maxQueue;
const MAX_TURN_WAIT_MS = turnQueueConfig.maxWaitMs;

rootLogger.info(
  {
    event: "turn_queue.sizing",
    maxConcurrent: MAX_CONCURRENT_TURNS,
    maxQueue: MAX_QUEUED_TURNS,
    maxWaitMs: MAX_TURN_WAIT_MS,
    configSource: turnQueueConfig.source,
  },
  "turn queue sizing",
);

interface WaitingEntry {
  /** Stable id for inspection (Tasks UI); not used for queue logic. */
  id: string;
  opts: TurnOptions;
  resolve: (result: TurnResult) => void;
  enqueuedAt: number;
  /** Set when a waiting entry is replaced by a newer submission with
   * the same coalesceKey. The timer's callback checks this and skips
   * the timeout rejection so the resolve isn't double-called. */
  superseded: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/** Build a structured descriptor for an active turn from its options.
 * Used to populate CapacityInfo.activeDescriptors so the user-visible
 * reject message can name what's holding the slots. */
function describeActive(opts: TurnOptions, startedAt: number): ActiveDescriptor {
  const desc: ActiveDescriptor = { source: opts.source ?? "http", startedAt };
  // Cron sessions look like `http/system-cron/{jobName}` — pull jobName so
  // we can surface "scheduled task 'foo'" instead of an opaque sessionKey.
  if (desc.source === "cron") {
    const m = opts.sessionKey.match(/^http\/system-cron\/(.+)$/);
    if (m) desc.jobName = m[1];
  }
  if (opts.adapterName) desc.adapterName = opts.adapterName;
  return desc;
}

class TurnQueue {
  private active = new Set<string | null>();   // coalesce keys currently running; entries without a key use null-placeholder below
  private activeCount = 0;                      // strict count (entries without coalesceKey don't go in the Set)
  private waiting: WaitingEntry[] = [];
  /** One entry per concurrently-running turn. Keyed by a fresh symbol per
   * runOne() invocation; cleaned up in the runOne finally. Read at
   * rejection time to populate CapacityInfo, and by inspect() for the
   * Tasks UI (which also needs the rolling snapshot + sessionKey). */
  private activeTurns = new Map<symbol, ActiveTurnRecord>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueSize: number,
    private readonly maxWaitMs: number,
  ) {}

  get stats(): { active: number; waiting: number } {
    return { active: this.activeCount, waiting: this.waiting.length };
  }

  private snapshotDescriptors(): ActiveDescriptor[] {
    return Array.from(this.activeTurns.values(), (r) => r.descriptor);
  }

  /** Structured view of the queue for the Tasks UI. Snapshots are the
   * same rolling BackgroundSnapshot runAgentTurnImpl emits via
   * onProgress; sessionKey is included so the HTTP layer can apply its
   * ownership/privacy gate before serializing to clients. */
  inspect(): TurnQueueInspection {
    return {
      active: Array.from(this.activeTurns.values(), (r) => ({
        id: r.id,
        source: r.descriptor.source,
        jobName: r.descriptor.jobName,
        adapterName: r.descriptor.adapterName,
        startedAt: r.descriptor.startedAt,
        sessionKey: r.sessionKey,
        snapshot: r.snapshot,
      })),
      waiting: this.waiting.map((e) => ({
        id: e.id,
        source: e.opts.source ?? "http",
        adapterName: e.opts.adapterName,
        coalesceKey: e.opts.coalesceKey,
        enqueuedAt: e.enqueuedAt,
        sessionKey: e.opts.sessionKey,
      })),
    };
  }

  private buildCapacityInfo(reason: AtCapacityReason, waitedMs: number): CapacityInfo {
    return {
      reason,
      active: this.activeCount,
      max: this.maxConcurrent,
      waiting: this.waiting.length,
      waitedMs,
      activeDescriptors: this.snapshotDescriptors(),
    };
  }

  async submit(opts: TurnOptions): Promise<TurnResult> {
    const key = opts.coalesceKey;

    // Fast path: slot available AND no same-key entry already running.
    // For keyed submissions we must serialize same-key calls; if one is
    // already active, even with free slots, the new one goes to waiting.
    if (this.activeCount < this.maxConcurrent && !(key && this.active.has(key))) {
      return this.runOne(opts);
    }

    // Coalesce into an existing waiting entry with the same key.
    if (key) {
      const existingIdx = this.waiting.findIndex((e) => e.opts.coalesceKey === key);
      if (existingIdx !== -1) {
        const existing = this.waiting[existingIdx];
        existing.superseded = true;
        if (existing.timeoutHandle) clearTimeout(existing.timeoutHandle);
        // Old caller's result is discarded by callers who set a coalesceKey;
        // capacity payload is pro-forma since this isn't a real saturation.
        existing.resolve({
          reply: "",
          error: AT_CAPACITY,
          capacity: this.buildCapacityInfo("queue_full", Date.now() - existing.enqueuedAt),
        });
        // Fall through and enqueue the new one below (replacing in place).
        this.waiting.splice(existingIdx, 1);
        rootLogger.info(
          { event: "turn_queue.coalesced", coalesceKey: key },
          "coalesced waiting entry (latest wins)",
        );
      }
    }

    if (this.waiting.length >= this.maxQueueSize) {
      rootLogger.warn(
        {
          event: "turn_queue.full",
          active: this.activeCount,
          waiting: this.waiting.length,
          coalesceKey: key ?? null,
        },
        "queue full, rejecting",
      );
      return {
        reply: "",
        error: AT_CAPACITY,
        capacity: this.buildCapacityInfo("queue_full", 0),
      };
    }

    return new Promise<TurnResult>((resolve) => {
      const entry: WaitingEntry = {
        id: randomUUID(),
        opts,
        resolve,
        enqueuedAt: Date.now(),
        superseded: false,
      };
      entry.timeoutHandle = setTimeout(() => {
        if (entry.superseded) return;
        // Remove from waiting if still there.
        const idx = this.waiting.indexOf(entry);
        if (idx !== -1) this.waiting.splice(idx, 1);
        const waitedMs = Date.now() - entry.enqueuedAt;
        rootLogger.warn(
          {
            event: "turn_queue.wait_timeout",
            maxWaitMs: this.maxWaitMs,
            coalesceKey: opts.coalesceKey ?? null,
            sessionKey: opts.sessionKey,
          },
          "turn wait timeout",
        );
        resolve({
          reply: "",
          error: AT_CAPACITY,
          capacity: this.buildCapacityInfo("wait_timeout", waitedMs),
        });
      }, this.maxWaitMs);
      this.waiting.push(entry);
    });
  }

  private async runOne(opts: TurnOptions): Promise<TurnResult> {
    const key = opts.coalesceKey;
    this.activeCount++;
    if (key) this.active.add(key);
    const handle = Symbol("active-turn");
    const record: ActiveTurnRecord = {
      id: randomUUID(),
      descriptor: describeActive(opts, Date.now()),
      sessionKey: opts.sessionKey,
    };
    this.activeTurns.set(handle, record);
    // Tee progress into the record so inspect() can show what each
    // active turn is doing; the caller's own onProgress (bg registry)
    // keeps working unchanged.
    const callerProgress = opts.onProgress;
    const wrapped: TurnOptions = {
      ...opts,
      onProgress: (snap) => {
        record.snapshot = snap;
        callerProgress?.(snap);
      },
    };
    try {
      return await runAgentTurnImpl(wrapped);
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (key) this.active.delete(key);
      this.activeTurns.delete(handle);
      this.drainOne();
    }
  }

  private drainOne(): void {
    while (this.waiting.length > 0 && this.activeCount < this.maxConcurrent) {
      // Pick the first waiting entry whose key isn't already active.
      const idx = this.waiting.findIndex(
        (e) => !e.opts.coalesceKey || !this.active.has(e.opts.coalesceKey),
      );
      if (idx === -1) return;   // all waiting entries are same-key-blocked; wait for more drains
      const entry = this.waiting.splice(idx, 1)[0]!;
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry.superseded) continue;
      // Kick off without awaiting — runOne handles its own lifecycle and
      // calls drainOne again on completion.
      void this.runOne(entry.opts).then(entry.resolve);
    }
  }
}

const turnQueue = new TurnQueue(
  MAX_CONCURRENT_TURNS,
  MAX_QUEUED_TURNS,
  MAX_TURN_WAIT_MS,
);

/** Read-only view of the global TurnQueue (active turns + waiting
 * entries with snapshots) for the Tasks UI endpoints in index.ts. */
export function inspectTurnQueue(): TurnQueueInspection {
  return turnQueue.inspect();
}

// Periodically emit queue stats for monitoring.
setInterval(() => {
  const { active, waiting } = turnQueue.stats;
  if (active > 0 || waiting > 0) {
    rootLogger.info(
      {
        event: "turn_queue.stats",
        active,
        maxConcurrent: MAX_CONCURRENT_TURNS,
        waiting,
      },
      "turn queue stats",
    );
  }
}, 30_000).unref?.();

/** Sanitize session key for filesystem path (no traversal). */
function sanitizeSessionKey(key: string): string {
  return key
    .split("/")
    .map((seg) => seg.replace(/[^a-zA-Z0-9_-]/g, "_"))
    .join("/");
}

/** If the session key is `creator/agent/{agentId}`, return the agentId.
 * Otherwise null. Caller uses this to route into runCreatorTurnImpl.
 * Exported for unit testing. */
export function parseCreatorSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split("/");
  if (parts.length !== 3 || parts[0] !== "creator" || parts[1] !== "agent") {
    return null;
  }
  const agentId = parts[2];
  return AGENT_ID_RE.test(agentId) ? agentId : null;
}


/** Paths to the creator system prompt fragments, baked into the agent
 * image at /app/system_context/. The creator's prompt is composed from
 * SYSTEM.md (universal guidelines) + TOOLS.md (runtime tool catalog —
 * what the agent being built will inherit) + CREATOR_AGENT.md (the
 * creator's engineer persona). Compiled JS lives at
 * /app/chat-server/agent.js so dirname(__dirname) = /app. */
const SYSTEM_PROMPT_DIR = join(dirname(__dirname), "system_context");
const CREATOR_SYSTEM_PATH = join(SYSTEM_PROMPT_DIR, "SYSTEM.md");
const CREATOR_TOOLS_PATH = join(SYSTEM_PROMPT_DIR, "TOOLS.md");
const CREATOR_AGENT_PATH = join(SYSTEM_PROMPT_DIR, "CREATOR_AGENT.md");

/** Ring-capped stderr sink for the Claude CLI subprocess. Pass the
 * returned `capture` into `query().options.stderr`; read `buffer()`
 * afterward (e.g. into a `logCatch` stderrTail field) to recover the
 * last 8 KB of the CLI's diagnostics when the subprocess exits with an
 * error. Without this, the SDK spawns the CLI with stdio stderr =
 * "ignore" and the real cause (auth / rate limit / network) is lost. */
function createStderrSink(cap = 8 * 1024): {
  capture: (chunk: string) => void;
  buffer: () => string;
} {
  let buf = "";
  return {
    capture(chunk: string): void {
      buf += chunk;
      if (buf.length > cap) buf = buf.slice(buf.length - cap);
    },
    buffer(): string {
      return buf;
    },
  };
}

/** Load workspace metadata via the Agent Platform API.
 *
 * Falls back to env-derived defaults on lookup failure (cold start before
 * the sidecar has materialized the API key, transient API outage). The
 * fallback prevents an inbound message from hanging on platform
 * unavailability; the team name reverts to the workspaceId.
 */
async function loadWorkspaceConfig(): Promise<{ teamName: string }> {
  try {
    const ws = await platformClient.getWorkspace();
    return {
      teamName: (ws.name as string) || process.env.WORKSPACE_ID || "unknown",
    };
  } catch (err) {
    // Re-throw 4xx errors from the platform API so they surface to the
    // user instead of being swallowed by the fallback path. The Agent
    // Platform API's access hook (agent_platform_access_hook.py) is the
    // single chokepoint where operators can reject requests — e.g. a
    // a downstream overlay raising ServiceError(402) when a subscription
    // has lapsed. Whatever message the hook returns becomes the
    // user-facing error here; chat-server has no overlay knowledge of its own.
    if (err instanceof PlatformApiError && err.status >= 400 && err.status < 500) {
      throw new Error(extractApiErrorMessage(err));
    }
    logCatch(rootLogger, "agent.workspace_config.load_failed", err);
    return {
      teamName: process.env.WORKSPACE_ID || "unknown",
    };
  }
}

/** Pull the user-facing `message` field out of a Powertools error body
 *  (shape: `{"statusCode": N, "message": "..."}`). Falls back to the
 *  raw status/body if parsing fails. */
function extractApiErrorMessage(err: PlatformApiError): string {
  try {
    const parsed = JSON.parse(err.body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // body wasn't JSON — fall through
  }
  return `Platform API returned ${err.status}: ${err.body || err.message}`;
}

/** Load members via the Agent Platform API. Empty array on failure. */
async function loadMembers(): Promise<Member[]> {
  try {
    const members = await platformClient.getMembers();
    return members as unknown as Member[];
  } catch (err) {
    logCatch(rootLogger, "agent.members.load_failed", err);
    return [];
  }
}

function readOptionalSecret(name: string): string {
  try {
    return readFileSync(join(CONFIG_DIR, "secrets", name), "utf-8").trim();
  } catch (err) {
    // Missing is the normal "not configured" state for most of these.
    // Non-ENOENT failures are worth surfacing.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      rootLogger.info(
        { event: "agent.secret.missing", secretName: name, expected: true },
        "secret file not present",
      );
    } else {
      logCatch(rootLogger, "agent.secret.read_failed", err, {
        secretName: name,
        code,
      });
    }
    return "";
  }
}

/** Load Claude setup token from /config/secrets/. */
function loadClaudeToken(): string {
  return readOptionalSecret("claude-token");
}

/** Load Telegram bot token from /config/secrets/. */
function loadTelegramBotToken(): string {
  return readOptionalSecret("telegram-bot-token");
}

/** Optional Google Workspace credentials from /config/secrets/. */
function loadGoogleWorkspaceCreds(): string {
  return readOptionalSecret("google-account-token");
}

/** Optional Microsoft 365 credentials from /config/secrets/. */
function loadMicrosoft365Creds(): string {
  return readOptionalSecret("microsoft-account-token");
}

/** Optional Notion token from /config/secrets/. */
function loadNotionToken(): string {
  return readOptionalSecret("notion-token");
}

/**
 * Resolve which model the turn runs and how the Claude CLI authenticates.
 *
 * Default (anthropic-direct): the current `[1m]` Opus model via the
 * subscription OAuth token written to ~/.claude/.credentials.json — unchanged
 * from before this feature.
 *
 * Gateway mode: route the CLI at the central LLM gateway (LiteLLM → Bedrock)
 * via ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. The bearer is the workspace's
 * own `wsk_` key (the gateway validates it and attributes/charges usage to the
 * workspace). We must NOT write the OAuth creds file — `sk-ant-oat-*` tokens
 * only work against api.anthropic.com, never a custom base URL — so we set
 * SKIP_CLAUDE_CREDS_SETUP=1 and skip the claude-token requirement entirely.
 *
 * Returns the resolved model, the extra subprocess env to merge into queryEnv,
 * and whether to skip the OAuth credential setup. Throws in gateway mode if the
 * platform-wide gateway URL or the workspace key isn't available yet, so the
 * failure is explicit rather than a confusing CLI auth error.
 */
export interface ResolvedTurnProvider {
  mode: "anthropic-direct" | "gateway";
  model: string;
  extraEnv: Record<string, string>;
  skipCredsSetup: boolean;
}

export function resolveTurnProvider(): ResolvedTurnProvider {
  const cfg = resolveLlmProvider();
  if (cfg.mode !== "gateway") {
    return {
      mode: "anthropic-direct",
      model: ANTHROPIC_DIRECT_MODEL,
      extraEnv: {},
      skipCredsSetup: false,
    };
  }

  const baseUrl = (process.env.LLM_GATEWAY_URL || "").replace(/\/+$/, "");
  const token = loadAgentPlatformKey();
  if (!baseUrl) {
    throw new Error(
      "This workspace is configured to use the LLM gateway, but the gateway URL is not set on the sandbox. Contact an administrator.",
    );
  }
  if (!token) {
    throw new Error(
      "This workspace is configured to use the LLM gateway, but the workspace key is not available yet. If you recently provisioned this workspace, wait a few seconds and retry.",
    );
  }

  const extraEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: cfg.model,
    // Background/“small fast” calls must hit a gateway-mapped model too —
    // resolveLlmProvider guarantees smallFastModel is set in gateway mode.
    ANTHROPIC_SMALL_FAST_MODEL: cfg.smallFastModel ?? cfg.model,
    // OAuth subscription token won't authenticate against a custom base URL;
    // skip writing ~/.claude/.credentials.json (prompt.ts honors this).
    SKIP_CLAUDE_CREDS_SETUP: "1",
  };

  // Tell the CLI the gateway model's REAL context window so auto-compaction
  // fires before the model's true limit. The CLI doesn't recognize gateway
  // model names and otherwise assumes a Claude-ish ~200k window, compacting too
  // late and 400ing on smaller models (e.g. DeepSeek's 163,840). PCT_OVERRIDE
  // (% of that window) gives headroom for the output budget + request overhead.
  if (cfg.contextWindow && cfg.contextWindow > 0) {
    extraEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(cfg.contextWindow);
    extraEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = process.env.GATEWAY_AUTOCOMPACT_PCT || "85";
  }

  return { mode: "gateway", model: cfg.model, extraEnv, skipCredsSetup: true };
}

/**
 * Detect the gateway's hard-cap rejection (HTTP 402/429 surfaced by the CLI)
 * and turn it into a user-facing message instead of a raw API error. Returns
 * null when the error is not a recognizable over-budget signal.
 */
export function gatewayBudgetMessage(err: unknown): string | null {
  const text =
    err instanceof Error ? `${err.message}` : typeof err === "string" ? err : "";
  if (/\b402\b|\b429\b/.test(text) && /budget|quota|over.?limit|payment required|too many/i.test(text)) {
    return "This workspace has reached its monthly LLM spend limit. Usage is paused until the budget resets or an administrator raises it.";
  }
  return null;
}

/**
 * Detect the gateway's fail-closed model rejection (its pre-call hook 400s
 * models it can't serve) and replace the raw API error — which the CLI
 * relays verbatim, internals and all — with a clean user-facing message.
 * Matches both the current gateway detail ("is not available on this
 * gateway") and the pre-fix wording that leaked pricing internals.
 */
export function gatewayModelUnavailableMessage(err: unknown): string | null {
  const text =
    err instanceof Error ? `${err.message}` : typeof err === "string" ? err : "";
  if (/not available on this gateway|no authoritative price configured/i.test(text)) {
    return "This workspace's configured AI model isn't available right now. If it was just changed, retry in a minute — otherwise contact an administrator.";
  }
  return null;
}

/** Everything the workspace-mcp Google server needs at spawn time. */
export interface GoogleWorkspaceSetup {
  email: string;
  clientId: string;
  clientSecret: string;
  /** Directory holding `<urlencoded-email>.json` authorized_user files. */
  credsDir: string;
}

// The stored secret has no email (only an opaque account_name), but
// workspace-mcp keys credential files — and its per-call user binding —
// by the account's email address. Resolve it once per refresh_token per
// process: refresh → access token → Gmail profile. ~600ms on the first
// turn after boot, then cached.
const googleEmailCache = new Map<string, string>();

async function resolveGoogleEmail(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const cached = googleEmailCache.get(refreshToken);
  if (cached) return cached;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    // invalid_grant = user revoked or refresh expired — same reconnect
    // story as the Microsoft shim below.
    const expected = errText.includes("invalid_grant");
    rootLogger[expected ? "info" : "warn"](
      { event: "agent.google_workspace.refresh_failed", status: tokenResp.status, expected },
      "google refresh exchange failed",
    );
    throw new Error(`google token refresh failed (${tokenResp.status})`);
  }
  const { access_token } = (await tokenResp.json()) as { access_token?: string };
  if (!access_token) throw new Error("google refresh response missing access_token");
  const profResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!profResp.ok) throw new Error(`gmail profile lookup failed (${profResp.status})`);
  const { emailAddress } = (await profResp.json()) as { emailAddress?: string };
  if (!emailAddress) throw new Error("gmail profile response missing emailAddress");
  googleEmailCache.set(refreshToken, emailAddress);
  return emailAddress;
}

/**
 * Set up Google Workspace MCP credentials on disk for workspace-mcp
 * (taylorwilsdon/google_workspace_mcp): an `authorized_user` JSON file
 * named `<urlencoded-email>.json` under a per-session credentials dir.
 * Returns null when the integration isn't configured or setup failed —
 * the MCP is simply not spawned that turn (matches the M365 shim).
 */
async function setupGoogleWorkspace(
  credsJson: string,
  home: string,
): Promise<GoogleWorkspaceSetup | null> {
  if (!credsJson) return null;
  let creds: Record<string, string>;
  try {
    creds = JSON.parse(credsJson);
  } catch (err) {
    logCatch(rootLogger, "agent.google_workspace.bad_creds_json", err);
    return null;
  }
  const { client_id, client_secret, refresh_token } = creds;
  if (!client_id || !client_secret || !refresh_token) return null;

  let email: string;
  try {
    email = await resolveGoogleEmail(client_id, client_secret, refresh_token);
  } catch (err) {
    logCatch(rootLogger, "agent.google_workspace.email_resolve_failed", err);
    return null;
  }

  const credsDir = join(home, ".workspace-mcp", "credentials");
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(
    join(credsDir, `${encodeURIComponent(email)}.json`),
    JSON.stringify({
      type: "authorized_user",
      client_id,
      client_secret,
      refresh_token,
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  return { email, clientId: client_id, clientSecret: client_secret, credsDir };
}

/**
 * Exchange the stored Microsoft refresh_token for a fresh access_token.
 * Softeria's ms-365-mcp-server reads MS365_MCP_OAUTH_TOKEN at startup
 * but has no refresh path of its own — so we mint a fresh access token
 * per turn from the credentials the OAuth callback stashed in
 * `/config/secrets/microsoft-account-token`. The MCP subprocess lifetime
 * is per-turn (one query() per spawn), and Azure access tokens are
 * valid for ~1h, so a single token comfortably covers any reasonable
 * turn. Returns the access token, or "" if the integration isn't
 * configured / refresh failed.
 *
 * Refresh-token rotation: Azure may return a new refresh_token in the
 * response. We currently do not write it back to Secrets Manager — that
 * would require a roundtrip through the Agent Platform API and we want
 * this hot path to stay local. Stored refresh tokens expire after
 * ~90 days of inactivity; users reconnect from the Integrations UI when
 * that happens. Token rotation can be added later if the 90-day window
 * proves too short in practice.
 */
async function setupMicrosoft365(credsJson: string): Promise<string> {
  if (!credsJson) return "";
  let creds: Record<string, string>;
  try {
    creds = JSON.parse(credsJson);
  } catch (err) {
    logCatch(rootLogger, "agent.microsoft.bad_creds_json", err);
    return "";
  }
  const { client_id, client_secret, refresh_token, tenant_id = "common" } = creds;
  if (!client_id || !client_secret || !refresh_token) return "";

  const tokenUrl = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token,
    grant_type: "refresh_token",
    // `scope` on a refresh request defaults to whatever was originally
    // consented to. We pass it explicitly so we always get back the
    // same Graph scopes — and so a token-endpoint quirk on personal
    // MSA tenants (which sometimes silently drops scopes on refresh)
    // doesn't sneak through.
    scope: [
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Files.ReadWrite.All",
      "Sites.ReadWrite.All",
      "ChannelMessage.Send",
      "Chat.ReadWrite",
    ].join(" "),
  });

  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      // invalid_grant = user revoked or refresh expired. Surface
      // distinctly so the UI can prompt a reconnect via Logs Insights
      // filtering on this event.
      const expected = errText.includes("invalid_grant");
      rootLogger[expected ? "info" : "warn"](
        {
          event: "agent.microsoft.refresh_failed",
          status: resp.status,
          expected,
        },
        "microsoft refresh exchange failed",
      );
      return "";
    }
    const json = (await resp.json()) as { access_token?: string };
    if (!json.access_token) {
      rootLogger.warn(
        { event: "agent.microsoft.refresh_no_access_token" },
        "microsoft refresh response missing access_token",
      );
      return "";
    }
    return json.access_token;
  } catch (err) {
    logCatch(rootLogger, "agent.microsoft.refresh_failed", err);
    return "";
  }
}

/** Build MCP server configuration for the Agent SDK. */
function buildMcpServers(opts: {
  telegramBotToken: string;
  sessionCwd: string;
  sessionKey: string;
  callerId: string;
  source: string;
  adapterName: string;
  threadId: string;
  membersJson: string;
  contextCommitAuthor: string;
  home: string;
  browserCdpUrl?: string;
  /** Fresh Microsoft Graph access token (already exchanged from the
   * stored refresh_token). Empty string disables the M365 MCP. */
  microsoftAccessToken: string;
  /** Resolved Google Workspace setup (email + creds on disk). Null
   * disables the google_workspace MCP for this turn. */
  googleWorkspace: GoogleWorkspaceSetup | null;
  /** When true, the chat MCP hides the spawn/stop/list bg-task tools.
   * Background turns should not recursively spawn more background tasks. */
  isBackground?: boolean;
  /** When true (HTTP sessions only), exposes the in-process
   * `ask_user_question` tool. Adapter sessions (Telegram/Slack) and
   * cron turns must omit it — there's no clickable picker on those
   * surfaces, and blocking a turn waiting for a "click" doesn't fit
   * the message-arrives-as-a-new-turn model. */
  enableAskUser?: boolean;
}): Record<string, McpServerConfig> {
  const stdioServers: Record<string, McpStdioServerConfig> = {
    // Telegram MCP is intentionally minimal: only Telegram-specific
    // operations that Chat SDK's uniform reply path doesn't cover
    // (list_chats from the chat directory, download_attachment by file_id).
    // Outbound text replies go through thread.post / adapter.postMessage,
    // not through this MCP — see chat.ts:handleMessage and
    // index.ts:handleCronTrigger.
    telegram: {
      type: "stdio",
      // alwaysLoad: keep this small, frequently-used core server in the
      // immediate tool catalog instead of deferring it behind ToolSearch.
      // As of agent-sdk 0.3.x, tool search is on by default and ALL MCP
      // tools defer unless alwaysLoad is set — which is exactly what we
      // want for the heavy integrations (google_workspace ~110 tools,
      // notion, microsoft_365, playwright stay deferred), but the core
      // servers (telegram/context/agent_platform/chat) are used almost
      // every turn, so paying a ToolSearch round-trip for them hurts more
      // than it saves. alwaysLoad them; leave the heavy ones deferred.
      alwaysLoad: true,
      command: "python3",
      args: [join(MCP_DIR, "telegram_mcp.py")],
      env: {
        TELEGRAM_BOT_TOKEN: opts.telegramBotToken,
        TELEGRAM_DOWNLOADS_DIR: opts.sessionCwd,
      },
    },
    context: {
      type: "stdio",
      alwaysLoad: true, // core server — see telegram note
      command: "python3",
      args: [join(MCP_DIR, "context_mcp.py")],
      env: {
        USER_CONTEXT_DIR: process.env.USER_CONTEXT_DIR ?? "/data/user_context",
        CONTEXT_COMMIT_AUTHOR: opts.contextCommitAuthor,
        SESSION_CALLER_ID: opts.callerId,
        INBOUND_SOURCE: opts.source,
        MEMBERS_JSON: opts.membersJson,
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
      },
    },
    agent_platform: {
      // Direct HTTPS client to the Agent Platform API. Replaces the old
      // file-based cron MCP and the file-snapshot directory MCP. Tools:
      // list_members, get_workspace, list_known_chats, list_known_people,
      // list_cron_jobs, create_cron_job, delete_cron_job. All synchronous.
      type: "stdio",
      alwaysLoad: true, // core server — see telegram note
      command: "python3",
      args: [join(MCP_DIR, "agent_platform_mcp.py")],
      env: {
        AGENT_PLATFORM_API_URL: process.env.AGENT_PLATFORM_API_URL ?? "",
        AGENT_PLATFORM_KEY_PATH:
          process.env.AGENT_PLATFORM_KEY_PATH ?? "/config/secrets/agent-platform-key",
        // The adapter/thread this turn came from. Lets create_cron_job
        // default `target` to the originating chat so cron replies fire
        // back into the same chat by default.
        TURN_ADAPTER: opts.adapterName,
        TURN_THREAD_ID: opts.threadId,
        // browser_request_user_login + browser_save_profile need the
        // session key to find/interact with the current browser session.
        SESSION_KEY: opts.sessionKey,
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
      },
    },
    chat: {
      // Wraps the chat-server's loopback /internal/chat-send endpoint so
      // the agent can push a message to any adapter+thread mid-turn
      // without relying on the text-output reply path. Also exposes
      // spawn/stop/list background task tools when IS_BACKGROUND != "1".
      // Uses the same cron-trigger-key shared secret + loopback auth
      // as cron delivery. Defaults to the current turn's chat for
      // "extra message" use cases.
      type: "stdio",
      alwaysLoad: true, // core server — see telegram note
      command: "python3",
      args: [join(MCP_DIR, "chat_mcp.py")],
      env: {
        CONFIG_DIR,
        CHAT_SERVER_URL: "http://localhost:8080",
        INTERNAL_KEY_PATH: "/config/secrets/cron-trigger-key",
        TURN_ADAPTER: opts.adapterName,
        TURN_THREAD_ID: opts.threadId,
        // chat_send_file needs to resolve relative paths (from Playwright
        // MCP screenshots) to absolute paths the chat-server can read.
        SESSION_CWD: opts.sessionCwd,
        // Background turns don't get the spawn/stop/list tools (flat
        // recursion rule — a bg task can't spawn more bg tasks).
        IS_BACKGROUND: opts.isBackground ? "1" : "0",
        // For attribution when the bg task is stopped by a model call —
        // threaded back to the /internal/spawn registry entry.
        SESSION_KEY: opts.sessionKey,
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
      },
    },
  };

  // Google Workspace — only if the email-resolving setup succeeded.
  // Server: workspace-mcp (taylorwilsdon/google_workspace_mcp, PyPI),
  // which replaced the dormant npm `google-workspace-mcp` 2.3.6: that one
  // had NO tool filter at all and shipped ~75 tools / ~105 KB of schemas —
  // the heaviest server in the catalog. workspace-mcp's native service +
  // tier selection below yields 22 tools / ~42 KB (measured), covering the
  // mainstream surfaces; Slides/Forms/Tasks/Chat are dropped deliberately.
  // Credentials: authorized_user JSON pre-seeded by setupGoogleWorkspace
  // under the per-session home; client id/secret + the account email go
  // via env (USER_GOOGLE_EMAIL is also how per-call user binding works).
  if (opts.googleWorkspace) {
    stdioServers.google_workspace = {
      type: "stdio",
      // alwaysLoad: since the SDK 0.3 bump (background MCP connect), slow
      // servers can miss the turn's tool catalog entirely — the old google
      // server missed EVERY turn until this flag. Keep it for the new one.
      alwaysLoad: true,
      command: "workspace-mcp",
      args: [
        "--tools", "gmail", "drive", "calendar", "docs", "sheets",
        "--tool-tier", "core",
      ],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: opts.googleWorkspace.clientId,
        GOOGLE_OAUTH_CLIENT_SECRET: opts.googleWorkspace.clientSecret,
        USER_GOOGLE_EMAIL: opts.googleWorkspace.email,
        WORKSPACE_MCP_CREDENTIALS_DIR: opts.googleWorkspace.credsDir,
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
      },
    };
  }

  // Microsoft 365 — only if the refresh shim succeeded in minting a
  // fresh access token.
  //
  // NOTE: `--preset` is silently IGNORED on the pinned 0.114.4 — measured
  // 117 tools / ~526 KB of schemas (~130k tokens) with or without it, so
  // the "~25 tools" this comment used to claim was never true in prod.
  //
  // Gateway mode adds `--discovery` (upstream runtime tool discovery):
  // the server exposes only search-tools / get-tool-schema meta-tools
  // (9 tools, ~5 KB) and loads real tools on demand. Measured 526 KB →
  // 5 KB, which is the difference between blowing a 163k-window model's
  // context (the DeepSeek 400s) and fitting comfortably. It's MCP-side,
  // so it works through the LiteLLM gateway where the SDK's own Tool
  // Search feature is unavailable (non-first-party ANTHROPIC_BASE_URL).
  // Anthropic-direct keeps the full catalog — Opus's 1M window absorbs
  // it, and we don't want to change deployed behavior there.
  if (opts.microsoftAccessToken) {
    const gatewayMode = resolveLlmProvider().mode === "gateway";
    stdioServers.microsoft_365 = {
      type: "stdio",
      command: "ms-365-mcp-server",
      args: [
        "--preset",
        "mail,calendar,files,excel",
        ...(gatewayMode ? ["--discovery"] : []),
      ],
      env: {
        MS365_MCP_OAUTH_TOKEN: opts.microsoftAccessToken,
      },
    };
  }

  // Notion — only if token is configured.
  const notionToken = loadNotionToken();
  if (notionToken) {
    stdioServers.notion = {
      type: "stdio",
      command: "notion-mcp-server",
      args: [],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        }),
      },
    };
  }

  // Playwright MCP — connects to AgentCore's managed browser via a
  // pre-signed CDP WebSocket URL minted by the Agent Platform API at
  // turn start. Only spawned when a session is available (the Lambda
  // succeeded). The sandbox container has no AWS credentials; the URL
  // includes SigV4 auth in query params.
  if (opts.browserCdpUrl) {
    stdioServers.playwright = {
      type: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest", "--cdp-endpoint", opts.browserCdpUrl],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
        DISPLAY: "",
      },
    };
  }

  const servers: Record<string, McpServerConfig> = { ...stdioServers };

  // In-process MCP, HTTP-only. Adapter sessions and cron don't get a
  // clickable picker; they fall back to plain-text questions.
  if (opts.enableAskUser) {
    servers.ask_user = buildAskUserMcp({ sessionKey: opts.sessionKey });
  }

  return servers;
}

/**
 * Run a single agent turn. Called by Chat SDK event handlers and HTTP routes.
 *
 * Creates per-session dirs, writes credentials, builds system prompt,
 * and calls the TS Agent SDK's query() in-process.
 */
/**
 * Public entry point for all turn execution. Every caller (Chat SDK
 * webhook handlers, handleCronTrigger, submitHttpChat) goes through
 * here. Submits to the global TurnQueue, which enforces concurrency
 * + coalescing + bounded wait, then calls runAgentTurnImpl with the
 * actual Claude subprocess spawn once a slot is free.
 */
export function runAgentTurn(opts: TurnOptions): Promise<TurnResult> {
  return turnQueue.submit(opts);
}

/**
 * Private turn executor. Called only from TurnQueue.runOne after a
 * slot has been acquired. Spawns the Claude CLI subprocess, streams
 * events, and returns the final reply. Do not call directly — always
 * go through runAgentTurn() so the concurrency gate is enforced.
 */
async function runAgentTurnImpl(opts: TurnOptions): Promise<TurnResult> {
  const {
    sessionKey,
    prompt,
    callerId = "",
    callerEmail,
    source = "http",
    adapterName = "",
    threadId = "",
    cronTarget,
    onEvent,
    parentSessionKey,
    ephemeralHome,
    abortController,
    isBackground,
    onProgress,
  } = opts;

  // Creator sessions are a distinct flavor — confined to a single agent's
  // def/ directory, no workspace members / browser / context / chat MCPs,
  // and a dedicated system prompt. Forking the path keeps the regular
  // flow (cron / webhook / HTTP / bg) free of creator-specific branches.
  //
  // Test sessions are NOT a distinct flavor — the "Test" button in the
  // creator UI creates a regular workspace chat session and drives it
  // through the supervisor, which Task-dispatches to the agent-under-
  // test via the same subagent map the runtime uses. Same end-to-end
  // path, just more faithful to production.
  const creatorAgentId = parseCreatorSessionKey(sessionKey);
  if (creatorAgentId) {
    return runCreatorTurnImpl(opts, creatorAgentId);
  }

  const sanitizedKey = sanitizeSessionKey(sessionKey);
  // Background turns reuse the parent's session dir so their cwd is the
  // parent's workdir — files created by the bg task are visible to
  // future turns in the same workspace. The LD_PRELOAD Bash sandbox keys
  // off SANDBOX_SESSION_ROOT, so reusing the parent's sessionDir also
  // widens the sandbox to exactly the parent's scope (not wider).
  const effectiveKey = parentSessionKey ? sanitizeSessionKey(parentSessionKey) : sanitizedKey;
  const sessionDir = join(SESSIONS_ROOT, effectiveKey);
  // HOME placement: parent sessions use /data/sessions/<key>/home (persistent),
  // bg tasks use /tmp/bg-home/<sanitized-key> (tmpfs, dies with the task)
  // so their Claude CLI transcripts don't collide with the parent's.
  const home = ephemeralHome
    ? join("/tmp/bg-home", sanitizedKey)
    : join(sessionDir, "home");
  const cwd = join(sessionDir, "workdir");

  // Ensure per-session directories exist.
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  // Write Claude credentials to per-session HOME. Missing token is a
  // hard failure — without it the CLI subprocess exits with code 1 and
  // the real cause is buried in stderr. Fail fast with an admin-facing
  // message instead.
  // Resolve provider/model for this turn. In gateway mode the CLI authenticates
  // to the LLM gateway with the workspace key (set in queryEnv below) and we
  // skip the OAuth credentials file entirely — see resolveTurnProvider.
  const turnProvider = resolveTurnProvider();
  if (!turnProvider.skipCredsSetup) {
    const claudeToken = loadClaudeToken();
    if (!claudeToken) {
      rootLogger.warn(
        { event: "agent.claude_token.missing", sessionKey },
        "no claude-token found in /config/secrets/",
      );
      throw new Error(
        "Agent credentials are missing. If you did not set credentials please set them in the admin dashboard. If you recently changed them please wait a few seconds as it might take some time to refresh.",
      );
    }
    setupClaudeCredentials(claudeToken, home);
  }

  // Load config — workspace + members come from the Agent Platform API.
  const [{ teamName }, members] = await Promise.all([
    loadWorkspaceConfig(),
    loadMembers(),
  ]);
  const membersJson = JSON.stringify({ members });
  const telegramBotToken = loadTelegramBotToken();

  // Expose the originating chat to the cron MCP so any cron jobs created
  // during this turn default their routing target to the same chat. For
  // cron turns we use the triggering cronTarget so a cron that creates
  // another cron still inherits the same routing.
  const turnAdapter = source === "cron" ? (cronTarget?.adapter ?? "") : adapterName;
  const turnThreadId = source === "cron" ? (cronTarget?.threadId ?? "") : threadId;

  // Optional integrations.
  const googleWorkspace = await setupGoogleWorkspace(loadGoogleWorkspaceCreds(), home);
  const microsoftAccessToken = await setupMicrosoft365(loadMicrosoft365Creds());

  // AgentCore Browser: look up the session URL each turn. Session
  // creation is owned by the chat-creation pre-warm
  // (routes/sessions.ts:createSession), so by the time the user sends
  // their first message AgentCore is already READY. If no session
  // exists (pre-warm failed, AgentCore unavailable, no browser
  // configured) we run the turn without Playwright.
  let browserCdpUrl: string | undefined;
  try {
    const browserSession = await platformClient.getBrowserSession(sessionKey);
    if (!browserSession) {
      rootLogger.info(
        { event: "agent.browser.skipped", sessionKey, reason: "no_session" },
        "no AgentCore session for this sessionKey; skipping Playwright MCP",
      );
    } else {
      browserCdpUrl = browserSession.automationUrl || undefined;

      // Inject saved cookies (from DDB) transparently. connectOverCDP
      // attaches as a second client; browser.close() disconnects our
      // client only — the remote browser stays running for the
      // Playwright MCP to pick up.
      if (browserSession.cookies?.length && browserCdpUrl) {
        try {
          const { chromium } = await import("playwright");
          const browser = await chromium.connectOverCDP(browserCdpUrl);
          const ctx = browser.contexts()[0];
          if (ctx) {
            await ctx.addCookies(
              browserSession.cookies as unknown as Parameters<typeof ctx.addCookies>[0],
            );
          }
          await browser.close();
          rootLogger.info(
            {
              event: "agent.browser.cookies_injected",
              sessionKey,
              count: browserSession.cookies.length,
            },
            "injected saved cookies into AgentCore session",
          );
        } catch (err) {
          logCatch(rootLogger, "agent.browser.cookie_inject_failed", err, { sessionKey });
        }
      }
    }
  } catch (err) {
    logCatch(rootLogger, "agent.browser.unavailable", err, {
      sessionKey,
      expected: true,
    });
  }

  // Build system prompt. Brand placeholders come from env vars set by
  // CDK from `cfg.agentName` and `cfg.appDomain` — self-hosted
  // operators rebrand by setting AGENT_NAME / APP_URL in their config.
  const baseSystemPrompt = buildSystemPrompt({
    teamName,
    members,
    agentName: process.env.AGENT_NAME ?? "agent",
    appUrl: process.env.APP_URL ?? "",
  });

  // Derive context commit author from caller identity.
  // git --author requires "Name <email>" format.
  const agentNameForGit = process.env.AGENT_NAME ?? "agent";
  const contextCommitAuthor = callerEmail
    ? `${callerEmail.split("@")[0]} <${callerEmail}>`
    : `${agentNameForGit} <${callerId || "unknown"}@agent>`;

  // Build MCP servers config.
  const mcpServers = buildMcpServers({
    telegramBotToken,
    sessionCwd: cwd,
    sessionKey,
    callerId,
    source,
    adapterName: turnAdapter,
    threadId: turnThreadId,
    membersJson,
    contextCommitAuthor,
    home,
    browserCdpUrl,
    microsoftAccessToken,
    googleWorkspace,
    isBackground,
    // ask_user_question only makes sense when the user is on the web
    // chat (clickable picker). Adapter sessions get text questions
    // instead — the next user message lands as the next turn. Cron
    // sessions have no live user.
    enableAskUser: source === "http" && !isBackground,
  });

  // Fire-and-forget per-MCP schema measurement on first sighting. Pairs
  // with the `agent.context.tool_catalog` event (which only knows tool
  // names from SDK init) to give exact schema bytes per server.
  const stdioOnly: Record<string, McpStdioServerConfig> = {};
  for (const [n, cfg] of Object.entries(mcpServers)) {
    if ((cfg as { type?: string }).type === "stdio" && !measuredMcpServers.has(n)) {
      stdioOnly[n] = cfg as McpStdioServerConfig;
    }
  }
  if (Object.keys(stdioOnly).length > 0) {
    // Reserve names BEFORE the async gap to avoid concurrent turns
    // double-measuring the same server. On failure we drop the reservation
    // so the next turn retries.
    for (const n of Object.keys(stdioOnly)) measuredMcpServers.add(n);
    void measureMcpSchemas(stdioOnly).then((results) => {
      for (const r of results) {
        if (r.error) {
          measuredMcpServers.delete(r.server);
          rootLogger.warn(
            { event: "agent.context.mcp_schemas.failed", server: r.server, err: r.error },
            "mcp schema measurement failed",
          );
          continue;
        }
        rootLogger.info(
          {
            event: "agent.context.mcp_schemas",
            server: r.server,
            toolCount: r.toolCount,
            totalBytes: r.totalBytes,
            // Top-10 individual tools by size for whale-spotting; full
            // list omitted to keep log records under CW's 256 KB limit.
            topTools: [...r.tools].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
          },
          "mcp tool schema sizes",
        );
      }
    });
  }

  // Discover deployed subagents for this workspace and assemble the
  // SDK-native `agents` map. Only the top-level supervisor turn gets
  // subagents — background turns inherit their parent's behaviour, so
  // skip there to keep the recursion flat. Never throws: on error
  // (platform API outage, no deployed agents yet), the returned map is
  // empty and the supervisor behaves exactly as before.
  //
  // Test-chat sessions: a `.test-meta.json` marker in the session
  // directory (written by /api/agents/:id/test-session) pins the
  // supervisor to ONE agent loaded from def-draft/ — bypasses the
  // deployed-only filter so users can exercise unsaved changes.
  let testAgentId: string | undefined;
  if (!isBackground) {
    try {
      const meta = JSON.parse(
        readFileSync(join(sessionDir, ".test-meta.json"), "utf-8"),
      ) as { testAgentId?: unknown };
      if (typeof meta.testAgentId === "string") {
        testAgentId = meta.testAgentId;
      }
    } catch (err) {
      // ENOENT = ordinary session, common case. Anything else is a
      // malformed marker; ignore (regular session behaviour) but log.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logCatch(rootLogger, "agent.test_meta.read_failed", err, {
          sessionKey,
          expected: false,
        });
      }
    }
  }
  const { agents: subagentMap, deployed: deployedSubagents } = isBackground
    ? { agents: {}, deployed: [] }
    : await buildSubagentMap(testAgentId ? { testAgentId } : {});
  const hasSubagents = Object.keys(subagentMap).length > 0;
  let systemPrompt = hasSubagents
    ? baseSystemPrompt + "\n" + renderAgentsAppendix(deployedSubagents)
    : baseSystemPrompt;
  if (testAgentId && hasSubagents) {
    systemPrompt +=
      "\n\n## Test session\n\n" +
      `This is a test session for agent \`${testAgentId}\` loaded from its draft. ` +
      "When the user sends a message, delegate to that agent via the `Task` tool " +
      `with \`subagent_type: "${testAgentId}"\` so the user is exercising the agent ` +
      "they're editing, not the supervisor's general behaviour.";
  }

  // Skills dir for the Agent SDK.
  const userContextDir = process.env.USER_CONTEXT_DIR ?? "/data/user_context";
  const skillsDir = join(userContextDir, "skills");
  void skillsDir; // reserved for future skills mount; keeps linter quiet

  const turnId = randomUUID();
  const turnLogger = rootLogger.child({
    sessionKey,
    source,
    adapterName,
    threadId,
    userId: callerId,
    turnId,
  });
  turnLogger.info({ event: "agent.turn.start", cwd }, "turn start");

  // Outer try/catch catches setup-phase throws (subscription expired,
  // claude-token missing, platform API outage, etc.) and converts them
  // into a TurnResult carrying turnId so callers can cite a ref id.
  // The inner try/catch around tracedQuery returns (doesn't throw), so
  // this outer layer only fires for pre-query failures.
  try {

  // Defense in depth: build the subprocess env from only the variables
  // the Claude CLI actually needs. Even if someone later adds LANGFUSE_*
  // to process.env by accident, it won't be inherited by the subprocess
  // because we're not copying process.env wholesale — only the explicit
  // keys below are passed in.
  const queryEnv = {
    // Inherit PATH (and other safe inheritable vars) so Bash
    // commands like `date`, `python3`, `ls`, `cat` resolve to
    // their /usr/bin/ binaries. Setting `env: {}` (or any object
    // without PATH) replaces the entire env and leaves PATH
    // empty inside the spawned shell — every standard utility
    // then errors as "command not found", and the model
    // reasonably concludes those tools aren't installed.
    PATH:
      process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    // Per-session overrides — the values that DO need to differ
    // from the chat-server process env.
    HOME: home,
    SESSION_KEY: sessionKey,
    SANDBOX_SESSION_ROOT: sessionDir,
    // 10-min foreground Bash window — see BASH_TIMEOUT_ENV.
    ...BASH_TIMEOUT_ENV,
    // Gateway mode: ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL/SMALL_FAST_MODEL +
    // SKIP_CLAUDE_CREDS_SETUP. Empty object in anthropic-direct mode (no-op).
    ...turnProvider.extraEnv,
  };

  const assistantParts: string[] = [];
  let finalSessionId: string | undefined;

  const stderrSink = createStderrSink();

  // Build a supervisor-scoped permission callback. When a tool call
  // arrives from a subagent (agents map populated), the callback
  // resolves that subagent's per-agent scope — read on def/, write on
  // workdir/. Supervisor's own calls keep the existing cwd confinement.
  //
  // The SDK's `options.agentID` in canUseTool is a per-invocation
  // handle, NOT the agents-map key, so we need the SubagentStart
  // hook to record the (handle → agents-map key) mapping before
  // canUseTool runs. The hook is wired into queryOpts.options.hooks
  // below.
  const subagentRegistry = createSubagentRegistry();
  const canUseToolForTurn = hasSubagents
    ? buildSupervisorCanUseTool(
        { cwd },
        (agentTypeKey) => {
          if (!subagentMap[agentTypeKey]) return null;
          // For test sessions, the subagent reads from def-draft/ (the
          // user's unsaved edits), not the deployed def/. Mirrors what
          // buildSubagentMap loaded.
          const p = agentPaths(agentTypeKey);
          const isTest = agentTypeKey === testAgentId;
          return {
            cwd: p.workdir,
            extraRead: [isTest ? p.defDraftDir : p.defDir],
          };
        },
        subagentRegistry,
      )
    : buildCanUseTool(cwd);

  const queryOpts = {
    prompt,
    options: {
      systemPrompt,
      cwd,
      // Pin the model explicitly rather than inheriting the Claude CLI's
      // bundled default. Without this we drift silently when the CLI
      // updates — every deploy could swap tiers under us. Opus 4.7 is
      // the current flagship; the `[1m]` suffix selects the 1M-context
      // variant (autocompact threshold lifts from ~187k → ~987k,
      // effectively never fires given our ~80k baseline post-tool-trim).
      // Premium pricing kicks in only for the 200k–1M token range; turns
      // under 200k bill at the standard Opus rate.
      //
      // In gateway mode this is the workspace's configured Bedrock model
      // instead (resolveTurnProvider); anthropic-direct keeps the constant.
      model: turnProvider.model,
      // Cron and background sessions are stateless: each run is a fresh
      // conversation. Resuming would let the model see "I already did this"
      // in transcript history and short-circuit without re-executing.
      continue: source !== "cron" && !isBackground,
      permissionMode: "default",
      // SDK isolation: do NOT auto-load filesystem settings (settings.json,
      // CLAUDE.md, slash commands) from the session cwd/home. As of agent-sdk
      // 0.3.x, omitting settingSources loads all sources (CLI default) — but
      // the sandbox cwd is user-controllable, so auto-loading a planted
      // CLAUDE.md would be a prompt-injection vector and a behavior change vs
      // the prior SDK. Subagents are supplied explicitly via `agents`, so []
      // loses nothing.
      settingSources: [],
      env: queryEnv,
      canUseTool: canUseToolForTurn,
      mcpServers,
      // SDK-native subagents. Empty map = no Task routing (default).
      ...(hasSubagents ? { agents: subagentMap } : {}),
      // Hooks. PreToolUse is ALWAYS wired to deny run_in_background Bash:
      // the CLI dispatches a backgrounded Bash through its own
      // background-shell subsystem, which bypasses canUseTool, so this
      // hook is the only layer that actually blocks it (see
      // buildBashBackgroundPreToolUseHook). SubagentStart is added only in
      // supervisor mode to map the SDK's per-invocation handle → agents-map
      // key so canUseTool can scope subagent fs access to that agent's
      // workdir/def-draft/def.
      hooks: {
        PreToolUse: [
          { hooks: [buildBashBackgroundPreToolUseHook(turnLogger, { cwd })] },
        ],
        ...(hasSubagents
          ? {
              SubagentStart: [
                {
                  hooks: [
                    async (input) => {
                      if (input.hook_event_name !== "SubagentStart") {
                        return {};
                      }
                      // Record both the per-invocation handle (canUseTool
                      // sees this in options.agentID) AND the session_id
                      // (PreToolUse hook sees this in input.session_id) →
                      // the agents-map key. Either side can look up the
                      // workdir / scope from the registry.
                      subagentRegistry.record(input.agent_id, input.agent_type);
                      subagentRegistry.record(input.session_id, input.agent_type);
                      turnLogger.info(
                        {
                          event: "agent.subagent.start",
                          agentInvocationId: input.agent_id,
                          agentTypeKey: input.agent_type,
                          subagentSessionId: input.session_id,
                        },
                        "subagent started",
                      );
                      return {};
                    },
                  ],
                },
              ],
              // (Bash rewrite for subagents is done in
              // buildSupervisorCanUseTool via updatedInput — the SDK
              // honors that, but doesn't honor PreToolUse's updatedInput
              // for tool input. See sandbox.ts for the actual rewrite.)
            }
          : {}),
      },
      // No maxTurns cap — turns run to completion (the SDK omits
      // --max-turns when this is unset, so the CLI imposes no iteration
      // limit). Long agentic work is bounded by the per-Bash-call 10-min
      // cap and, for background turns, the bgWallMs wall-clock instead.
      stderr: stderrSink.capture,
      // Disable the SDK's built-in AskUserQuestion: in headless mode
      // it auto-resolves with an empty answer, leaving the user
      // staring at a question card and the model confused. HTTP
      // sessions get our `mcp__ask_user__ask_user_question`
      // replacement instead (see `enableAskUser` above).
      disallowedTools: ["AskUserQuestion"],
      // Optional caller-supplied AbortController (bg tasks use this so
      // stop_background_task can cancel a running turn).
      ...(abortController ? { abortController } : {}),
    } satisfies Options,
  };

  // Rolling tool-call trail for the bg snapshot. Capped at 20 entries
  // (drops oldest) so a long-running task can't balloon memory with
  // thousands of tool calls in one session.
  const toolCallTrail: ToolCallEntry[] = [];
  const pushToolCall = (name: string, summary: string): void => {
    toolCallTrail.push({ name, summary: summary.slice(0, 120), ts: Date.now() });
    if (toolCallTrail.length > 20) toolCallTrail.shift();
  };

  // Latest SDK `result` event, captured for diagnostics. The CLI emits
  // this with subtype="success" on normal completion, or one of the
  // "error_*" subtypes (with a populated `errors: string[]`) when the
  // model loop terminates abnormally without crashing the subprocess.
  // Captured here so we can surface a real reason in agent.turn.failed
  // instead of just "Claude Code process exited with code 1".
  let lastResultEvent: Record<string, unknown> | undefined;

  try {
    // tracedQuery wraps the SDK's query() and emits Langfuse spans per
    // event. It yields every event through unchanged, so the caller-side
    // bookkeeping (assistantParts for the return value, finalSessionId
    // for resumption, onEvent for SSE streaming) all stays here.
    for await (const event of tracedQuery(
      {
        sessionKey,
        source,
        adapterName,
        threadId,
        userId: callerId,
        turnId,
        input: prompt,
        providerMode: turnProvider.mode,
        model: turnProvider.model,
        abortSignal: abortController?.signal,
      },
      queryOpts,
    )) {
      onEvent?.(event);

      const msg = event as Record<string, unknown>;
      // SDK init event lands once per turn and carries the full tool
      // catalog the model sees. Bytes per tool are exact; combined with
      // the first message's `usage.cache_creation_input_tokens` (visible
      // in Langfuse) this pins down what's filling the context window.
      // MCP tool names follow `mcp__<server>__<tool>`; server names cannot
      // contain `__`, but tool names can have single underscores.
      if (msg.type === "system" && msg.subtype === "init") {
        const tools = (msg as Record<string, unknown>).tools;
        if (Array.isArray(tools)) {
          const perTool = tools.map((t) => {
            const name =
              typeof t === "string"
                ? t
                : ((t as Record<string, unknown>)?.name as string) ?? "?";
            return { name, bytes: JSON.stringify(t).length };
          });
          const buckets: Record<string, { count: number; bytes: number }> = {};
          for (const x of perTool) {
            const parts = x.name.split("__");
            const bucket =
              parts.length >= 3 && parts[0] === "mcp" ? `mcp__${parts[1]}` : "builtin";
            const b = (buckets[bucket] ??= { count: 0, bytes: 0 });
            b.count += 1;
            b.bytes += x.bytes;
          }
          const totalToolBytes = perTool.reduce((s, x) => s + x.bytes, 0);
          // Hashes for prompt-cache stability investigation. If two turns
          // in the same session show different systemPromptHash or
          // toolNamesHash, the prefix is drifting and Anthropic's prompt
          // cache won't hit. The hashes are SHA-256 hex truncated to 16
          // chars — collision-resistant enough to spot any real change.
          const { createHash } = await import("node:crypto");
          const systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
          const toolNamesHash = createHash("sha256").update(perTool.map((t) => t.name).sort().join(",")).digest("hex").slice(0, 16);
          turnLogger.info(
            {
              event: "agent.context.tool_catalog",
              toolCount: perTool.length,
              totalToolBytes,
              systemPromptBytes: systemPrompt.length,
              systemPromptHash,
              toolNamesHash,
              buckets,
              topTools: [...perTool].sort((a, b) => b.bytes - a.bytes).slice(0, 20),
            },
            "tool catalog size at turn start",
          );
        }
      }
      // Capture the per-message usage for prompt-cache diagnosis. Pairs
      // with the systemPromptHash / toolNamesHash above so we can tell
      // whether a cacheRead=0 turn was due to content drift or a
      // legitimate cold cache.
      if (msg.type === "assistant" && msg.message) {
        const usage = (msg.message as Record<string, unknown>).usage as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          turnLogger.info(
            {
              event: "agent.context.usage",
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheCreationInputTokens: usage.cache_creation_input_tokens,
              cacheReadInputTokens: usage.cache_read_input_tokens,
            },
            "per-message token usage",
          );
        }
        const content = (msg.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            // Assistant text → accumulator.
            if ("text" in block && typeof block.text === "string") {
              assistantParts.push(block.text);
            }
            // Tool-use events → rolling snapshot (bg tasks only care but
            // cost is negligible, and having it for all turns is handy).
            if ("type" in block && block.type === "tool_use" && "name" in block) {
              const name = typeof block.name === "string" ? block.name : "?";
              const input = (block as Record<string, unknown>).input;
              const summary = summarizeToolInput(input);
              pushToolCall(name, summary);
            }
          }
        }
      }
      // Capture SDK result events. is_error=true means the model loop
      // terminated abnormally (max_turns, max_budget, error_during_execution).
      // The CLI may then exit non-zero, surfacing as a thrown error in our
      // catch — we'll merge this into the failure log there.
      if (msg.type === "result") {
        lastResultEvent = msg;
        if (msg.is_error) {
          turnLogger.warn(
            {
              event: "agent.turn.result_error",
              subtype: msg.subtype,
              errors: msg.errors,
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              totalCostUsd: msg.total_cost_usd,
              turnId,
            },
            "SDK result event reported an error",
          );
        }
      }
      if (msg.session_id && typeof msg.session_id === "string") {
        finalSessionId = msg.session_id;
      }
      // Emit rolling snapshot for bg tasks. Copied to avoid external
      // callers mutating our internal array.
      onProgress?.({
        assistantText: assistantParts.join("\n"),
        toolCallTrail: toolCallTrail.slice(),
      });
    }
  } catch (err) {
    const aborted = abortController?.signal.aborted === true;
    const stderrTail = stderrSink.buffer();
    // Gateway hard-cap rejection (402/429) → friendly, user-facing message
    // rather than a raw "API error 429" leaking through. Check both the thrown
    // error and the CLI's stderr tail (the SDK often only logs the HTTP status
    // to stderr before exiting).
    const budgetMsg =
      gatewayBudgetMessage(err) ??
      gatewayBudgetMessage(stderrTail) ??
      gatewayModelUnavailableMessage(err) ??
      gatewayModelUnavailableMessage(stderrTail);
    const errorMsg = budgetMsg ?? (err instanceof Error ? err.message : String(err));
    // Build a diagnostic envelope. When the CLI exits without writing to
    // stderr (silent fail — observed when Claude returns a structured
    // error on stdout instead), fall back to: latest result event,
    // assistant text-so-far, and last tool call. Without one of these the
    // operator has zero context on what the agent was doing when it died.
    const lastAssistantTail = assistantParts.length
      ? assistantParts[assistantParts.length - 1]?.slice(0, 500)
      : undefined;
    const lastToolCall = toolCallTrail[toolCallTrail.length - 1];
    logCatch(turnLogger, aborted ? "agent.turn.aborted" : "agent.turn.failed", err, {
      aborted,
      stderrTail: stderrTail || undefined,
      stderrEmpty: !stderrTail,
      // Surface the SDK's structured error if it landed before the subprocess died.
      lastResultSubtype: lastResultEvent?.subtype,
      lastResultIsError: lastResultEvent?.is_error,
      lastResultErrors: lastResultEvent?.errors,
      lastAssistantTail,
      lastToolCall: lastToolCall
        ? { name: lastToolCall.name, summary: lastToolCall.summary, ts: lastToolCall.ts }
        : undefined,
      assistantPartsCount: assistantParts.length,
      toolCallCount: toolCallTrail.length,
    });
    // Still emit a final snapshot so callers can see what got done
    // before the abort/failure landed.
    onProgress?.({
      assistantText: assistantParts.join("\n"),
      toolCallTrail: toolCallTrail.slice(),
    });
    if (ephemeralHome) cleanupEphemeralHome(home);
    // Drop any in-flight ask_user_question — the turn that registered
    // it is gone, so the Promise has no path to resolve cleanly.
    cancelPendingQuestion(sessionKey, aborted ? "turn aborted" : "turn failed");
    return {
      reply: assistantParts.join("\n").trim(),
      error: aborted ? "aborted" : errorMsg,
      turnId,
      aborted,
    };
  }

  const reply = assistantParts.join("\n").trim();
  turnLogger.info(
    { event: "agent.turn.done", chars: reply.length, finalSessionId, isBackground: !!isBackground },
    "turn done",
  );

  if (ephemeralHome) cleanupEphemeralHome(home);
  // No-op when nothing is pending; covers the rare case where a model
  // wraps up the turn without waiting for an answer it asked for.
  cancelPendingQuestion(sessionKey, "turn ended");
  return { reply, sessionId: finalSessionId, turnId };
  } catch (err) {
    // Setup-phase failure (pre-tracedQuery). Examples: loadWorkspaceConfig
    // throwing subscription-expired, claude-token file missing, platform
    // API unreachable during member/workspace fetch. The inner catch
    // handles query-phase failures and returns, so it never reaches here.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logCatch(turnLogger, "agent.turn.setup_failed", err, {});
    return { reply: "", error: errorMsg, turnId };
  }
}

/**
 * Run a creator turn. Invoked from runAgentTurnImpl when the session key
 * is `creator/agent/{agentId}`.
 *
 * Differs from the regular path in every meaningful way:
 *   - cwd = /data/agents/{agentId}/def (the directory the creator edits)
 *   - HOME = /data/agents/{agentId}/.creator-home (per-agent Claude CLI
 *     transcript store; not under def/ so it isn't shipped with the agent).
 *   - System prompt = SYSTEM.md + TOOLS.md + CREATOR_AGENT.md
 *     (universal guidelines + runtime tool catalog + agent-engineer
 *     persona and ingestion rules).
 *   - MCP set = just `agent_platform`, with CREATOR_AGENT_ID set so the
 *     save_agent_metadata tool becomes visible inside the MCP (it's gated
 *     on that env var and not registered in any other session).
 *   - No workspace members, no browser session, no Google / Notion / chat
 *     / telegram / context MCPs. None of them are relevant here — the
 *     creator is only writing files under def/.
 */
async function runCreatorTurnImpl(
  opts: TurnOptions,
  agentId: string,
): Promise<TurnResult> {
  const { sessionKey, prompt, callerId = "", onEvent, abortController } = opts;

  const paths = agentPaths(agentId);
  // Scaffold: both def/ and workdir/ live on EFS from the first creator
  // turn onward. workdir/ is created here (even though the creator won't
  // touch it) so the runtime / test-chat paths never have to scaffold
  // concurrently later.
  mkdirSync(paths.defDir, { recursive: true });
  mkdirSync(paths.defDraftDir, { recursive: true });
  mkdirSync(paths.workdir, { recursive: true });
  mkdirSync(paths.creatorHome, { recursive: true });

  // Seed the draft from the live def on first creator turn for an
  // agent that already has a deployed copy. Without this, a user who
  // clicks Edit on an existing agent would see an empty draft and
  // think their work is gone. The check is "draft empty AND def
  // non-empty" — if the user has previously edited (draft has files)
  // we never overwrite their in-progress work.
  try {
    const draftEntries = readdirSync(paths.defDraftDir);
    if (draftEntries.length === 0) {
      const liveEntries = readdirSync(paths.defDir);
      if (liveEntries.length > 0) {
        cpSync(paths.defDir, paths.defDraftDir, { recursive: true });
        rootLogger.info(
          {
            event: "agent.creator.draft_seeded",
            agentId,
            files: liveEntries.length,
          },
          "seeded def-draft from live def on first creator turn",
        );
      }
    }
  } catch (err) {
    logCatch(rootLogger, "agent.creator.draft_seed_failed", err, { agentId });
  }

  // Claude CLI creds: same setup token the rest of the workspace uses — unless
  // gateway mode, where the CLI authenticates to the LLM gateway with the
  // workspace key (set in queryEnv below) and the OAuth file is skipped.
  const turnProvider = resolveTurnProvider();
  if (!turnProvider.skipCredsSetup) {
    const claudeToken = loadClaudeToken();
    if (!claudeToken) {
      rootLogger.warn(
        { event: "agent.creator.claude_token.missing", sessionKey, agentId },
        "no claude-token found in /config/secrets/",
      );
      throw new Error(
        "Agent credentials are missing. Set them in the admin dashboard.",
      );
    }
    setupClaudeCredentials(claudeToken, paths.creatorHome);
  }

  // System prompt composed from SYSTEM.md + TOOLS.md + CREATOR_AGENT.md
  // with agentId substitution. Keep the template read at turn-start
  // rather than import-time so edits don't require a container restart
  // to land.
  let template: string;
  try {
    const system = readFileSync(CREATOR_SYSTEM_PATH, "utf-8");
    const tools = readFileSync(CREATOR_TOOLS_PATH, "utf-8");
    const creator = readFileSync(CREATOR_AGENT_PATH, "utf-8");
    template = `${system}\n\n${tools}\n\n${creator}`;
  } catch (err) {
    throw new Error(
      `Creator prompt fragments missing under ${SYSTEM_PROMPT_DIR}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const systemPrompt = template.replace(/\{\{agentId\}\}/g, agentId);

  // MCP set: agent_platform only. CREATOR_AGENT_ID is the gate — when
  // it's set, agent_platform_mcp.py registers the save_agent_metadata
  // tool; when it isn't (every other session), the tool is never
  // exposed at all. Defense-in-depth: the MCP tool itself re-checks the
  // env matches the passed agent_id.
  const mcpServers: Record<string, McpStdioServerConfig> = {
    agent_platform: {
      type: "stdio",
      alwaysLoad: true, // core server — see telegram note
      command: "python3",
      args: [join(MCP_DIR, "agent_platform_mcp.py")],
      env: {
        AGENT_PLATFORM_API_URL: process.env.AGENT_PLATFORM_API_URL ?? "",
        AGENT_PLATFORM_KEY_PATH:
          process.env.AGENT_PLATFORM_KEY_PATH ?? "/config/secrets/agent-platform-key",
        // Turn-routing envs the regular path sets are irrelevant for the
        // creator (it never sends messages), so leave them empty.
        TURN_ADAPTER: "",
        TURN_THREAD_ID: "",
        SESSION_KEY: sessionKey,
        // THE gate. Only set in creator sessions.
        CREATOR_AGENT_ID: agentId,
        PATH: process.env.PATH ?? "",
        HOME: paths.creatorHome,
      },
    },
  };

  const queryEnv = {
    PATH:
      process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    HOME: paths.creatorHome,
    SESSION_KEY: sessionKey,
    // LD_PRELOAD bash sandbox roots here so confined-bash denies writes
    // outside the creator's agent directory (belt-and-braces around the
    // SDK's canUseTool).
    SANDBOX_SESSION_ROOT: paths.defDraftDir,
    // 10-min foreground Bash window — see BASH_TIMEOUT_ENV.
    ...BASH_TIMEOUT_ENV,
    // Gateway mode env (no-op object in anthropic-direct mode).
    ...turnProvider.extraEnv,
  };

  const turnId = randomUUID();
  const turnLogger = rootLogger.child({
    sessionKey,
    source: "creator",
    userId: callerId,
    turnId,
    agentId,
  });
  turnLogger.info(
    { event: "agent.creator.turn_start", cwd: paths.defDraftDir },
    "creator turn start",
  );

  const stderrSink = createStderrSink();

  const queryOpts = {
    prompt,
    options: {
      systemPrompt,
      cwd: paths.defDraftDir,
      // Same model resolution as the regular turn — anthropic-direct constant
      // or the workspace's gateway model. See the other queryOpts callsite.
      model: turnProvider.model,
      // Creator conversations are stateful — the user iterates across
      // turns. Same resume behavior as normal chat.
      continue: true,
      permissionMode: "default",
      // SDK isolation: do NOT auto-load filesystem settings (settings.json,
      // CLAUDE.md, slash commands) from the session cwd/home. As of agent-sdk
      // 0.3.x, omitting settingSources loads all sources (CLI default) — but
      // the sandbox cwd is user-controllable, so auto-loading a planted
      // CLAUDE.md would be a prompt-injection vector and a behavior change vs
      // the prior SDK. Subagents are supplied explicitly via `agents`, so []
      // loses nothing.
      settingSources: [],
      env: queryEnv,
      canUseTool: buildCanUseTool(paths.defDraftDir),
      mcpServers,
      // Deny run_in_background Bash here too (background shells die at
      // turn end). PreToolUse is the effective layer — canUseTool is
      // bypassed for backgrounded Bash. See buildBashBackgroundPreToolUseHook.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              buildBashBackgroundPreToolUseHook(turnLogger, {
                cwd: paths.defDraftDir,
              }),
            ],
          },
        ],
      },
      // The SDK ships an `AskUserQuestion` built-in that only works
      // when the host implements the answer-return contract. Our
      // chat-server doesn't (it just streams events through), so any
      // AskUserQuestion call stalls the turn waiting for a tool_result
      // that never comes. Disallow it; CREATOR_AGENT.md already instructs
      // the creator to ask in plain text instead.
      disallowedTools: ["AskUserQuestion"],
      // No maxTurns cap — see runAgentTurnImpl. Creator turns iterate
      // freely; the SDK omits --max-turns when this is unset.
      stderr: stderrSink.capture,
      ...(abortController ? { abortController } : {}),
    } satisfies Options,
  };

  const assistantParts: string[] = [];
  let finalSessionId: string | undefined;

  try {
    for await (const event of tracedQuery(
      {
        sessionKey,
        source: "creator" as unknown as TurnSource,
        adapterName: "",
        threadId: "",
        userId: callerId,
        turnId,
        input: prompt,
        providerMode: turnProvider.mode,
        model: turnProvider.model,
        abortSignal: abortController?.signal,
      },
      queryOpts,
    )) {
      onEvent?.(event);
      const msg = event as Record<string, unknown>;
      if (msg.type === "system" && msg.subtype === "init") {
        const tools = (msg as Record<string, unknown>).tools;
        if (Array.isArray(tools)) {
          const perTool = tools.map((t) => {
            const name =
              typeof t === "string"
                ? t
                : ((t as Record<string, unknown>)?.name as string) ?? "?";
            return { name, bytes: JSON.stringify(t).length };
          });
          const buckets: Record<string, { count: number; bytes: number }> = {};
          for (const x of perTool) {
            const parts = x.name.split("__");
            const bucket =
              parts.length >= 3 && parts[0] === "mcp" ? `mcp__${parts[1]}` : "builtin";
            const b = (buckets[bucket] ??= { count: 0, bytes: 0 });
            b.count += 1;
            b.bytes += x.bytes;
          }
          const totalToolBytes = perTool.reduce((s, x) => s + x.bytes, 0);
          turnLogger.info(
            {
              event: "agent.context.tool_catalog",
              toolCount: perTool.length,
              totalToolBytes,
              systemPromptBytes: systemPrompt.length,
              buckets,
              topTools: [...perTool].sort((a, b) => b.bytes - a.bytes).slice(0, 20),
            },
            "tool catalog size at turn start",
          );
        }
      }
      if (msg.type === "assistant" && msg.message) {
        const content = (msg.message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            if ("text" in block && typeof block.text === "string") {
              assistantParts.push(block.text);
            }
          }
        }
      }
      if (msg.session_id && typeof msg.session_id === "string") {
        finalSessionId = msg.session_id;
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const aborted = abortController?.signal.aborted === true;
    logCatch(
      turnLogger,
      aborted ? "agent.creator.turn_aborted" : "agent.creator.turn_failed",
      err,
      { aborted, stderrTail: stderrSink.buffer() || undefined },
    );
    return {
      reply: assistantParts.join("\n").trim(),
      error: aborted ? "aborted" : errorMsg,
      turnId,
      aborted,
    };
  }

  const reply = assistantParts.join("\n").trim();
  turnLogger.info(
    { event: "agent.creator.turn_done", chars: reply.length, finalSessionId },
    "creator turn done",
  );
  return { reply, sessionId: finalSessionId, turnId };
}


/** Summarize an MCP tool-use `input` dict down to a one-line string that
 * never includes full payloads. Keeps the bg snapshot's tool-call trail
 * usefully compact. */
function summarizeToolInput(input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const keys = Object.keys(input as Record<string, unknown>);
  const parts: string[] = [];
  for (const k of keys.slice(0, 3)) {
    const v = (input as Record<string, unknown>)[k];
    let sv: string;
    if (typeof v === "string") sv = v.length > 40 ? v.slice(0, 40) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean") sv = String(v);
    else sv = Array.isArray(v) ? `[${v.length}]` : "{…}";
    parts.push(`${k}=${sv}`);
  }
  return parts.join(" ");
}

/** rm -rf the ephemeral HOME for a background task. Best-effort: log but
 * don't throw — leaking /tmp/bg-home/* between tasks is harmless (tmpfs
 * gets cleared on container restart). */
function cleanupEphemeralHome(home: string): void {
  try {
    if (!home.startsWith("/tmp/bg-home/")) return;
    rmSync(home, { recursive: true, force: true });
  } catch (err) {
    logCatch(rootLogger, "agent.bg.home_cleanup_failed", err, { home, expected: true });
  }
}

/**
 * Run a background turn. Bypasses the mainQueue — bgRegistry is the
 * admission gate (fixed at 3 concurrent in index.ts). Shares the parent's
 * session dir via `parentSessionKey`, runs with a fresh ephemeral HOME,
 * and wires the caller-supplied AbortController into the SDK so the
 * parent's next turn can cancel it.
 */
export function runBackgroundTurn(opts: TurnOptions): Promise<TurnResult> {
  return runAgentTurnImpl({ ...opts, isBackground: true, ephemeralHome: true });
}

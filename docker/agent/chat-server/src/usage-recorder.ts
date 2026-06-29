/**
 * usage-recorder.ts — per-turn token usage accounting.
 *
 * One TurnUsageCollector is created per tracedQuery() invocation
 * (instrumented-query.ts), fed every SDK event, and finalized when the
 * event stream closes. The finalized record is POSTed fire-and-forget to
 * the Agent Platform API (`POST /usage/turns`), which persists it to the
 * per-workspace llm-usage DynamoDB table. Recording must never affect the
 * turn: all failures are logged and swallowed.
 *
 * Token sources, in order of preference:
 *   1. The SDK `result` event's `modelUsage` map — authoritative; covers
 *      every API call in the turn including subagents and the small/fast
 *      background model.
 *   2. Per-assistant-message `usage` sums — fallback when the turn dies
 *      before a result event lands. Deduped by API message id (the CLI
 *      can emit several SDKAssistantMessages for one API response, one
 *      per content block, all sharing the same usage).
 *
 * The SDK exposes no per-source token split (system prompt vs MCP schemas
 * vs conversation), so `context` carries byte-derived estimates instead:
 * exact system-prompt / tool-schema bytes from the init event, est. tokens
 * at ~4 bytes/token, plus the first message's cache-creation/read counts.
 * Read-side analysis can then derive the conversation/tool-result share as
 *   firstMsgInput + cacheCreation + cacheRead − (estSystemPrompt + estTools).
 */

import { createHash } from "node:crypto";
import { rootLogger, logCatch } from "./logger.js";
import { platformClient } from "./platform-client.js";

export type ProviderPath = "anthropic-direct" | "gateway";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ModelTokenTotals extends TokenTotals {
  estCostUsd?: number;
}

export interface TurnContextStats {
  hash: string;
  systemPromptBytes: number;
  totalToolBytes: number;
  toolCount: number;
  estSystemPromptTokens: number;
  estToolTokens: number;
  firstCacheCreationTokens: number;
  firstCacheReadTokens: number;
}

export interface TurnUsageRecord extends TokenTotals {
  ts: string;
  turnId: string;
  sessionKey: string;
  source: string;
  adapterName?: string;
  threadId?: string;
  userId?: string;
  path: ProviderPath;
  model: string;
  apiCalls: number;
  models: Record<string, ModelTokenTotals>;
  subagentUsage?: TokenTotals;
  /** SDK total_cost_usd — nominal API pricing, NOT what's billed. */
  estCostUsd?: number;
  error?: boolean;
  aborted?: boolean;
  context?: TurnContextStats;
  /** Sent only on first sighting of a context hash per process. */
  contextSnapshot?: {
    buckets: Record<string, { count: number; bytes: number }>;
  };
}

export interface CollectorMeta {
  sessionKey: string;
  source: string;
  adapterName?: string;
  threadId?: string;
  userId?: string;
  turnId: string;
  path: ProviderPath;
  model: string;
  /** The turn's system prompt; hashed + measured for the context stats. */
  systemPrompt: string;
}

/** ~4 bytes per token is the standard rough heuristic for English/code. */
function estTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function addUsage(into: TokenTotals, usage: Record<string, unknown>): void {
  into.inputTokens += Number(usage.input_tokens) || 0;
  into.outputTokens += Number(usage.output_tokens) || 0;
  into.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0;
  into.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0;
}

/** Context hashes whose CTX# snapshot has already been posted this process. */
const postedContextHashes = new Set<string>();

export class TurnUsageCollector {
  private readonly meta: CollectorMeta;
  private readonly seenMessageIds = new Set<string>();
  private readonly messageSums = emptyTotals();
  private readonly subagentSums = emptyTotals();
  private sawSubagentUsage = false;
  private apiCalls = 0;
  private resultModelUsage: Record<string, ModelTokenTotals> | null = null;
  private resultTotals: TokenTotals | null = null;
  private estCostUsd: number | undefined;
  private contextHash: string | null = null;
  private toolStats: {
    totalToolBytes: number;
    toolCount: number;
    buckets: Record<string, { count: number; bytes: number }>;
  } | null = null;
  private firstCacheCreationTokens = 0;
  private firstCacheReadTokens = 0;
  private sawFirstUsage = false;

  constructor(meta: CollectorMeta) {
    this.meta = meta;
  }

  /** Route one SDK event. Safe on any event shape; never throws. */
  onEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    try {
      const msg = event as Record<string, unknown>;
      if (msg.type === "system" && msg.subtype === "init") {
        this.onInit(msg);
      } else if (msg.type === "assistant" && msg.message) {
        this.onAssistantMessage(msg);
      } else if (msg.type === "result") {
        this.onResult(msg);
      }
    } catch (err) {
      logCatch(rootLogger, "usage.collect_failed", err, { turnId: this.meta.turnId });
    }
  }

  private onInit(msg: Record<string, unknown>): void {
    const tools = msg.tools;
    if (!Array.isArray(tools)) return;
    const buckets: Record<string, { count: number; bytes: number }> = {};
    let totalToolBytes = 0;
    const names: string[] = [];
    for (const t of tools) {
      const name =
        typeof t === "string" ? t : (((t as Record<string, unknown>)?.name as string) ?? "?");
      const bytes = JSON.stringify(t).length;
      names.push(name);
      totalToolBytes += bytes;
      // MCP tool names follow `mcp__<server>__<tool>`; server names cannot
      // contain `__` (same bucketing as agent.context.tool_catalog).
      const parts = name.split("__");
      const bucket = parts.length >= 3 && parts[0] === "mcp" ? `mcp__${parts[1]}` : "builtin";
      const b = (buckets[bucket] ??= { count: 0, bytes: 0 });
      b.count += 1;
      b.bytes += bytes;
    }
    const systemPromptHash = createHash("sha256")
      .update(this.meta.systemPrompt)
      .digest("hex")
      .slice(0, 16);
    const toolNamesHash = createHash("sha256")
      .update(names.sort().join(","))
      .digest("hex")
      .slice(0, 16);
    this.contextHash = `${systemPromptHash}-${toolNamesHash}`;
    this.toolStats = { totalToolBytes, toolCount: tools.length, buckets };
  }

  private onAssistantMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown>;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const id = typeof message.id === "string" ? message.id : "";
    if (id) {
      if (this.seenMessageIds.has(id)) return;
      this.seenMessageIds.add(id);
    }
    this.apiCalls += 1;
    addUsage(this.messageSums, usage);
    if (msg.parent_tool_use_id != null) {
      this.sawSubagentUsage = true;
      addUsage(this.subagentSums, usage);
    }
    if (!this.sawFirstUsage) {
      this.sawFirstUsage = true;
      this.firstCacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
      this.firstCacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
    }
  }

  private onResult(msg: Record<string, unknown>): void {
    if (typeof msg.total_cost_usd === "number") this.estCostUsd = msg.total_cost_usd;
    const modelUsage = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;
    if (!modelUsage || typeof modelUsage !== "object") return;
    const models: Record<string, ModelTokenTotals> = {};
    const totals = emptyTotals();
    for (const [model, u] of Object.entries(modelUsage)) {
      const m: ModelTokenTotals = {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheCreationInputTokens: Number(u.cacheCreationInputTokens) || 0,
        cacheReadInputTokens: Number(u.cacheReadInputTokens) || 0,
      };
      if (typeof u.costUSD === "number") m.estCostUsd = u.costUSD;
      models[model] = m;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cacheCreationInputTokens += m.cacheCreationInputTokens;
      totals.cacheReadInputTokens += m.cacheReadInputTokens;
    }
    this.resultModelUsage = models;
    this.resultTotals = totals;
  }

  finalize(outcome: { error?: boolean; aborted?: boolean }): TurnUsageRecord {
    // Prefer the result event's modelUsage (covers background/small-fast
    // calls the per-message stream misses); fall back to message sums.
    const totals = this.resultTotals ?? this.messageSums;
    if (this.resultTotals) {
      const a = this.resultTotals.outputTokens;
      const b = this.messageSums.outputTokens;
      if (b > 0 && Math.abs(a - b) / Math.max(a, b, 1) > 0.1) {
        rootLogger.warn(
          {
            event: "usage.totals_diverged",
            turnId: this.meta.turnId,
            resultOutputTokens: a,
            messageSumOutputTokens: b,
          },
          "result modelUsage diverges >10% from per-message sums",
        );
      }
    }

    const record: TurnUsageRecord = {
      ts: new Date().toISOString(),
      turnId: this.meta.turnId,
      sessionKey: this.meta.sessionKey,
      source: this.meta.source,
      adapterName: this.meta.adapterName || undefined,
      threadId: this.meta.threadId || undefined,
      userId: this.meta.userId || undefined,
      path: this.meta.path,
      model: this.meta.model,
      ...totals,
      apiCalls: this.apiCalls,
      models: this.resultModelUsage ?? (this.meta.model ? { [this.meta.model]: { ...this.messageSums } } : {}),
      estCostUsd: this.estCostUsd,
    };
    if (this.sawSubagentUsage) record.subagentUsage = { ...this.subagentSums };
    if (outcome.error) record.error = true;
    if (outcome.aborted) record.aborted = true;

    if (this.contextHash && this.toolStats) {
      record.context = {
        hash: this.contextHash,
        systemPromptBytes: this.meta.systemPrompt.length,
        totalToolBytes: this.toolStats.totalToolBytes,
        toolCount: this.toolStats.toolCount,
        estSystemPromptTokens: estTokens(this.meta.systemPrompt.length),
        estToolTokens: estTokens(this.toolStats.totalToolBytes),
        firstCacheCreationTokens: this.firstCacheCreationTokens,
        firstCacheReadTokens: this.firstCacheReadTokens,
      };
      if (!postedContextHashes.has(this.contextHash)) {
        record.contextSnapshot = { buckets: this.toolStats.buckets };
      }
    }
    return record;
  }
}

/**
 * POST the finalized record to the platform API. Fire-and-forget: one
 * retry after 2s, then give up with a log line. Callers invoke as
 * `void postTurnUsage(record)` — never await on the turn path.
 */
export async function postTurnUsage(
  record: TurnUsageRecord,
  opts: {
    post?: (r: TurnUsageRecord) => Promise<{ recorded: boolean }>;
    retryDelayMs?: number;
  } = {},
): Promise<void> {
  const post = opts.post ?? ((r: TurnUsageRecord) => platformClient.postTurnUsage(r));
  const retryDelayMs = opts.retryDelayMs ?? 2_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await post(record);
      if (record.contextSnapshot && record.context) {
        postedContextHashes.add(record.context.hash);
      }
      return;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      logCatch(rootLogger, "usage.post_failed", err, {
        turnId: record.turnId,
        source: record.source,
      });
    }
  }
}

/** Test-only: reset the process-level posted-hash dedupe set. */
export function _resetPostedContextHashes(): void {
  postedContextHashes.clear();
}

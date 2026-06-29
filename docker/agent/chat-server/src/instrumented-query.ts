/**
 * instrumented-query.ts — Langfuse-wrapped async generator over the TS
 * Agent SDK's `query()`.
 *
 * This is the entire "Langfuse × Claude Agent SDK integration" for this
 * codebase. The SDK's only hook point is the event stream from
 * `for await (const event of query({...}))`; `tracedQuery` wraps that
 * stream, translates each `SDKMessage` into Langfuse trace/span/generation
 * calls, and yields the event through unchanged to the caller.
 *
 * Data model (what Langfuse sees):
 *   one query() call                 → 1 trace   (name "agent.turn")
 *   each assistant message with text → 1 generation (carries model + usage)
 *   each tool_use block              → 1 span    (name "tool.use.<tool>")
 *   matching tool_result block       → closes that span with its output
 *   stream_event                     → dropped (too noisy at token level)
 *
 * The trace is closed in a finally block regardless of whether the loop
 * ran to completion or raised, so abandoned / short-circuited iteration
 * still flushes a terminal state.
 *
 * If no Langfuse client is configured (keys absent), the generator still
 * yields events but skips every Langfuse call — zero overhead on the
 * hot path beyond the null check.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Langfuse, type LangfuseTraceClient } from "langfuse";
import { getLangfuse } from "./langfuse.js";
import { rootLogger, logCatch } from "./logger.js";
import { TurnUsageCollector, postTurnUsage, type ProviderPath } from "./usage-recorder.js";

// Langfuse Cloud caps individual JSON fields at ~1 MB and entire events
// at ~3.5 MB. We cap client-side at 100 KB per field to keep batch
// sizes predictable even when a Bash tool returns a multi-MB stdout
// (think `cat` on a big file, or a long git log). A truncated value is
// replaced with a marker object so the UI signals it clearly rather
// than silently displaying garbled data.
const MAX_FIELD_BYTES = 100_000;

const TRACE_NAME_MAX = 80;

/**
 * Build a human-skimmable trace name from the turn context.
 *
 * Our turn prompts always arrive with `[turn-utc=...]` and per-adapter
 * header lines prepended by chat.ts / submitHttpChat. The user's actual
 * message is the first line that isn't bracket-wrapped. Surfacing that
 * as the trace name (instead of a generic "agent.turn") makes the
 * Langfuse list view skimmable — at a glance you see what each turn
 * was about and can spot unusual/anomalous prompts.
 *
 * Cron turns are special: the prompt starts with
 * `[cron job "jobName" — ...]` and continues with a templated body, so
 * the jobName is the only useful identifier.
 *
 * Source stays as both a tag and a metadata field, so name-based
 * filtering is still possible via the `source` tag.
 */
function makeTraceName(ctx: TracedQueryContext): string {
  if (ctx.source === "cron") {
    const m = ctx.input.match(/^\[cron job "([^"]+)"/);
    return m ? `cron: ${m[1]}` : "agent.turn.cron";
  }
  const realLines = ctx.input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("["));
  const firstLine = realLines[0];
  if (!firstLine) return `agent.turn.${ctx.source}`;
  const snippet = firstLine.slice(0, TRACE_NAME_MAX);
  const ellipsis = firstLine.length > TRACE_NAME_MAX ? "…" : "";
  return `${ctx.source}: ${snippet}${ellipsis}`;
}

function truncateForLangfuse(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= MAX_FIELD_BYTES) return value;
  rootLogger.info(
    {
      event: "langfuse.field.truncated",
      originalBytes: str.length,
      limitBytes: MAX_FIELD_BYTES,
    },
    "truncating oversized langfuse field",
  );
  return {
    _truncated: true,
    _originalBytes: str.length,
    sample: str.slice(0, MAX_FIELD_BYTES - 200),
  };
}

export interface TracedQueryContext {
  /** Session identity for Langfuse `sessionId` — groups turns per chat. */
  sessionKey: string;
  /** "telegram" | "slack" | "http" | "cron" | ... */
  source: string;
  adapterName?: string;
  threadId?: string;
  userId?: string;
  /** UUID per query() invocation — becomes Langfuse trace id. */
  turnId: string;
  /** Trace input (the user prompt). */
  input: string;
  /** Which auth/billing path the turn runs on (resolveTurnProvider). */
  providerMode: ProviderPath;
  /** Primary model for the turn (queryOpts.options.model). */
  model: string;
  /** Caller's abort signal, if any — distinguishes aborted from failed
   * turns in the usage record. */
  abortSignal?: AbortSignal;
}

/**
 * Wrap `query()` in a Langfuse trace. The returned async generator is a
 * drop-in replacement for `query()` itself: iterate with
 * `for await (const event of tracedQuery(ctx, {prompt, options}))`.
 *
 * All Langfuse state is confined to this function. Callers do not need
 * to call finish/fail — trace termination happens automatically in a
 * finally block.
 */
export async function* tracedQuery(
  ctx: TracedQueryContext,
  queryOpts: { prompt: string; options: Options },
): AsyncGenerator<unknown, void, unknown> {
  const lf = getLangfuse();
  let trace: LangfuseTraceClient | null = null;
  if (lf) {
    try {
      trace = lf.trace({
        name: makeTraceName(ctx),
        id: ctx.turnId,
        userId: ctx.userId,
        sessionId: ctx.sessionKey,
        input: ctx.input,
        metadata: {
          source: ctx.source,
          adapterName: ctx.adapterName,
          threadId: ctx.threadId,
        },
        tags: [ctx.source, `workspace:${process.env.WORKSPACE_ID ?? "unknown"}`],
      });
    } catch (err) {
      logCatch(rootLogger, "langfuse.trace.start_failed", err, { turnId: ctx.turnId });
    }
  }

  // Per-turn token accounting. Fed every event below; flushed
  // fire-and-forget in the finally block. Both Anthropic-direct and
  // gateway turns pass through here, so this is the one place the
  // unified counter sees everything.
  const usageCollector = new TurnUsageCollector({
    sessionKey: ctx.sessionKey,
    source: ctx.source,
    adapterName: ctx.adapterName,
    threadId: ctx.threadId,
    userId: ctx.userId,
    turnId: ctx.turnId,
    path: ctx.providerMode,
    model: ctx.model,
    systemPrompt:
      typeof queryOpts.options.systemPrompt === "string" ? queryOpts.options.systemPrompt : "",
  });

  const openToolSpans = new Map<string, ReturnType<LangfuseTraceClient["span"]>>();
  const assistantParts: string[] = [];
  // The first assistant generation of the turn gets the user's prompt
  // as `input` so the Langfuse Session view shows both sides of the
  // conversation for the common single-message case. Subsequent
  // generations (after tool calls in the same turn) deliberately leave
  // input undefined — the tool inputs and outputs live on their own
  // tool.use.* spans in the same trace, which is the right place to
  // look for "what happened between assistant messages". Mirroring that
  // data into generation.input just adds noise.
  const firstGenerationInput: { value: string | undefined } = { value: ctx.input };
  let finalSessionId: string | undefined;
  let threw: unknown = null;

  try {
    for await (const event of query(queryOpts)) {
      usageCollector.onEvent(event);
      dispatch(
        trace,
        openToolSpans,
        assistantParts,
        firstGenerationInput,
        event,
        (id) => {
          finalSessionId = id;
        },
      );
      yield event;
    }
  } catch (err) {
    threw = err;
    throw err;
  } finally {
    // Flush the usage record without blocking the turn — postTurnUsage
    // retries once and swallows failures.
    try {
      const aborted = ctx.abortSignal?.aborted === true;
      void postTurnUsage(
        usageCollector.finalize({ error: threw !== null && !aborted, aborted }),
      );
    } catch (usageErr) {
      logCatch(rootLogger, "usage.finalize_failed", usageErr, { turnId: ctx.turnId });
    }
    if (trace) {
      try {
        // Close any tool spans that never saw a matching result. This
        // happens when a turn ends mid-tool or when the SDK breaks early.
        for (const [id, span] of openToolSpans) {
          span.end({
            output: null,
            metadata: { note: "no_tool_result_seen", toolUseId: id },
          });
        }
        openToolSpans.clear();

        if (threw !== null) {
          const msg = threw instanceof Error ? threw.message : String(threw);
          trace.update({
            output: null,
            metadata: { error: msg },
          });
        } else {
          const reply = assistantParts.join("\n").trim();
          trace.update({
            output: reply,
            metadata: { finalSessionId, chars: reply.length },
          });
        }
      } catch (traceErr) {
        logCatch(rootLogger, "langfuse.trace.finalize_failed", traceErr, {
          turnId: ctx.turnId,
        });
      }
    }
  }
}

/**
 * Translate one SDKMessage into Langfuse events and accumulate the
 * assistant text / session id the caller needs for its own return value.
 *
 * The same traversal serves two purposes on purpose: we already walk the
 * content blocks for Langfuse, doing it once avoids a second pass in the
 * caller.
 */
function dispatch(
  trace: LangfuseTraceClient | null,
  openToolSpans: Map<string, ReturnType<LangfuseTraceClient["span"]>>,
  assistantParts: string[],
  firstGenerationInput: { value: string | undefined },
  event: unknown,
  onSessionId: (id: string) => void,
): void {
  const msg = event as Record<string, unknown>;
  const type = msg.type;

  if (type === "assistant" && msg.message) {
    const message = msg.message as Record<string, unknown>;
    const content = message.content;
    const model = (message.model as string) || undefined;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
          assistantParts.push(b.text);
        } else if (b.type === "tool_use") {
          const id = String(b.id ?? "");
          if (trace) {
            const span = trace.span({
              name: `tool.use.${b.name ?? "unknown"}`,
              input: truncateForLangfuse(b.input),
              metadata: { toolUseId: id },
            });
            if (id) openToolSpans.set(id, span);
          }
        }
      }
      if (trace && textParts.length > 0) {
        // Anthropic's `usage` carries cache-related token counts
        // alongside the vanilla input/output totals. Promote them to the
        // generation's metadata so Langfuse surfaces the cache hit rate
        // in the UI. Cost derivation in Langfuse uses `input`/`output`
        // directly, so we leave those as the pre-cache totals the
        // Messages API reports.
        const input_tokens = (usage?.input_tokens as number) ?? undefined;
        const output_tokens = (usage?.output_tokens as number) ?? undefined;
        const cache_creation_input_tokens =
          (usage?.cache_creation_input_tokens as number) ?? undefined;
        const cache_read_input_tokens =
          (usage?.cache_read_input_tokens as number) ?? undefined;

        // Consume the user's turn prompt for the first generation of
        // the turn; later generations get undefined input (their
        // context lives on tool.use.* spans).
        const genInput = firstGenerationInput.value;
        firstGenerationInput.value = undefined;

        trace.generation({
          name: "assistant",
          model,
          input: genInput ? truncateForLangfuse(genInput) : undefined,
          output: truncateForLangfuse(textParts.join("\n")),
          usage: usage
            ? {
                input: input_tokens,
                output: output_tokens,
                total:
                  (input_tokens ?? 0) + (output_tokens ?? 0),
              }
            : undefined,
          metadata: usage
            ? {
                cacheCreationInputTokens: cache_creation_input_tokens,
                cacheReadInputTokens: cache_read_input_tokens,
              }
            : undefined,
        });
      }
    }
  } else if (type === "user" && msg.message) {
    // Tool results come in as a user-role message with tool_result blocks.
    // We close the matching tool span with the result as its output — the
    // result becomes visible in the UI where it belongs (on the tool
    // span), not mixed into the next assistant generation's input.
    const message = msg.message as Record<string, unknown>;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && trace) {
          const id = String(b.tool_use_id ?? "");
          const span = openToolSpans.get(id);
          if (span) {
            span.end({ output: truncateForLangfuse(b.content) });
            openToolSpans.delete(id);
          }
        }
      }
    }
  }
  // type === "result" / "stream_event" / "system": no Langfuse action.
  // (The final result's fields are captured on trace.update in finally.)

  if (typeof msg.session_id === "string") {
    onSessionId(msg.session_id);
  }
}

// Silence unused-import warning without dropping the type signal.
export type { Langfuse };

/**
 * Unit tests for the per-turn token usage collector + poster.
 *
 *  - TurnUsageCollector: aggregation from synthetic SDK events — per-message
 *    sums with message-id dedupe, subagent split via parent_tool_use_id,
 *    result-event modelUsage preferred over message sums (and used as the
 *    fallback's cross-check), context stats from the init event, error /
 *    aborted flags.
 *  - postTurnUsage: one retry then swallow — recording must never throw
 *    into the turn path.
 *
 * usage-recorder.ts imports platform-client.ts which captures
 * AGENT_PLATFORM_KEY_PATH at module load, hence the env setup first.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_PLATFORM_KEY_PATH = "/nonexistent/agent-platform-key";

const { TurnUsageCollector, postTurnUsage, _resetPostedContextHashes } =
  await import("../src/usage-recorder.ts");

const META = {
  sessionKey: "telegram/123",
  source: "telegram",
  adapterName: "telegram",
  threadId: "123",
  userId: "u1",
  turnId: "turn-1",
  path: "anthropic-direct" as const,
  model: "claude-opus-4-7[1m]",
  systemPrompt: "x".repeat(400), // estSystemPromptTokens = 100
};

function assistantEvent(opts: {
  id: string;
  usage: Record<string, number>;
  parentToolUseId?: string | null;
}) {
  return {
    type: "assistant",
    parent_tool_use_id: opts.parentToolUseId ?? null,
    message: { id: opts.id, usage: opts.usage, content: [] },
  };
}

const USAGE_A = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 2000,
};
const USAGE_B = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3000,
};

function initEvent() {
  return {
    type: "system",
    subtype: "init",
    tools: [
      { name: "Bash", description: "run commands" },
      { name: "mcp__chat__send_message", description: "send" },
      { name: "mcp__chat__react", description: "react" },
    ],
  };
}

describe("TurnUsageCollector", () => {
  beforeEach(() => _resetPostedContextHashes());

  it("sums per-message usage and counts API calls", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    c.onEvent(assistantEvent({ id: "msg_2", usage: USAGE_B }));
    const r = c.finalize({});
    assert.equal(r.inputTokens, 110);
    assert.equal(r.outputTokens, 55);
    assert.equal(r.cacheCreationInputTokens, 1000);
    assert.equal(r.cacheReadInputTokens, 5000);
    assert.equal(r.apiCalls, 2);
    assert.equal(r.path, "anthropic-direct");
    assert.equal(r.model, META.model);
    assert.equal(r.source, "telegram");
    assert.equal(r.error, undefined);
    assert.equal(r.aborted, undefined);
  });

  it("dedupes repeated SDKAssistantMessages sharing one API message id", () => {
    const c = new TurnUsageCollector(META);
    // The CLI can emit one SDKAssistantMessage per content block, all
    // with the same message.id and identical usage.
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    const r = c.finalize({});
    assert.equal(r.inputTokens, 100);
    assert.equal(r.apiCalls, 1);
  });

  it("splits subagent usage via parent_tool_use_id", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    c.onEvent(
      assistantEvent({ id: "msg_2", usage: USAGE_B, parentToolUseId: "tu_1" }),
    );
    const r = c.finalize({});
    assert.deepEqual(r.subagentUsage, {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 3000,
    });
    // Totals still include the subagent's share.
    assert.equal(r.inputTokens, 110);
  });

  it("prefers result-event modelUsage over per-message sums", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    c.onEvent({
      type: "result",
      subtype: "success",
      total_cost_usd: 1.23,
      modelUsage: {
        "claude-opus-4-7[1m]": {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 2000,
          costUSD: 1.2,
        },
        // Background small-fast calls the per-message stream never saw.
        "claude-haiku-4-5": {
          inputTokens: 40,
          outputTokens: 8,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUSD: 0.03,
        },
      },
    });
    const r = c.finalize({});
    assert.equal(r.inputTokens, 140);
    assert.equal(r.outputTokens, 58);
    assert.equal(r.estCostUsd, 1.23);
    assert.deepEqual(Object.keys(r.models).sort(), [
      "claude-haiku-4-5",
      "claude-opus-4-7[1m]",
    ]);
    assert.equal(r.models["claude-haiku-4-5"].estCostUsd, 0.03);
  });

  it("falls back to message sums (keyed by the turn model) without a result event", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    const r = c.finalize({ error: true });
    assert.equal(r.error, true);
    assert.equal(r.inputTokens, 100);
    assert.deepEqual(Object.keys(r.models), [META.model]);
    assert.equal(r.models[META.model].cacheReadInputTokens, 2000);
  });

  it("derives context stats + estimates from the init event", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(initEvent());
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    const r = c.finalize({});
    assert.ok(r.context);
    assert.equal(r.context.systemPromptBytes, 400);
    assert.equal(r.context.estSystemPromptTokens, 100);
    assert.equal(r.context.toolCount, 3);
    assert.ok(r.context.totalToolBytes > 0);
    assert.equal(
      r.context.estToolTokens,
      Math.ceil(r.context.totalToolBytes / 4),
    );
    // First message of the turn pins the cache split for composition math.
    assert.equal(r.context.firstCacheCreationTokens, 1000);
    assert.equal(r.context.firstCacheReadTokens, 2000);
    assert.match(r.context.hash, /^[0-9a-f]{16}-[0-9a-f]{16}$/);
    // First sighting of this hash per process → snapshot attached, with
    // tools bucketed by MCP server.
    assert.ok(r.contextSnapshot);
    assert.deepEqual(Object.keys(r.contextSnapshot.buckets).sort(), [
      "builtin",
      "mcp__chat",
    ]);
    assert.equal(r.contextSnapshot.buckets["mcp__chat"].count, 2);
  });

  it("marks aborted turns", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    const r = c.finalize({ aborted: true });
    assert.equal(r.aborted, true);
    assert.equal(r.error, undefined);
  });

  it("never throws on malformed events", () => {
    const c = new TurnUsageCollector(META);
    c.onEvent(null);
    c.onEvent("garbage");
    c.onEvent({ type: "assistant" }); // no message
    c.onEvent({ type: "result", modelUsage: "not-an-object" });
    c.onEvent({ type: "system", subtype: "init", tools: "nope" });
    const r = c.finalize({});
    assert.equal(r.inputTokens, 0);
    assert.equal(r.apiCalls, 0);
  });
});

describe("postTurnUsage", () => {
  beforeEach(() => _resetPostedContextHashes());

  function record() {
    const c = new TurnUsageCollector(META);
    c.onEvent(initEvent());
    c.onEvent(assistantEvent({ id: "msg_1", usage: USAGE_A }));
    return c.finalize({});
  }

  it("posts once on success and marks the context hash as posted", async () => {
    const posted: unknown[] = [];
    await postTurnUsage(record(), {
      post: async (r) => {
        posted.push(r);
        return { recorded: true };
      },
    });
    assert.equal(posted.length, 1);
    // Next turn with the same context hash omits the snapshot.
    const next = record();
    assert.equal(next.contextSnapshot, undefined);
  });

  it("retries once then swallows the failure", async () => {
    let attempts = 0;
    await postTurnUsage(record(), {
      retryDelayMs: 1,
      post: async () => {
        attempts++;
        throw new Error("api down");
      },
    });
    assert.equal(attempts, 2);
    // Failed post → hash NOT marked, snapshot still attached next time.
    const next = record();
    assert.ok(next.contextSnapshot);
  });
});

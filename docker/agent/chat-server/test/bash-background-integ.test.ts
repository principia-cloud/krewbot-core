/**
 * Integration test: background-Bash containment through the REAL CLI.
 *
 * The unit tests in creator-session.test.ts pin buildCanUseTool's deny
 * decision in isolation. This test drives the whole seam the way
 * runAgentTurnImpl does in production:
 *
 *   query() (agent SDK) → real Claude CLI subprocess → Bash tool
 *        ↑ canUseTool = buildCanUseTool(cwd)   (production callback)
 *        ↑ env spread  = BASH_TIMEOUT_ENV      (production values)
 *
 * The model is scripted: a local HTTP server speaks just enough of the
 * Anthropic Messages API (streaming + non-streaming) to return canned
 * tool_use blocks and read back the CLI's tool_results. No Anthropic
 * credentials, no network — ANTHROPIC_BASE_URL points at 127.0.0.1.
 *
 * What this proves that the unit tests can't:
 *   1. A scripted `Bash {run_in_background: true}` is denied through the
 *      real CLI permission pipeline — the command never executes (the
 *      sentinel file is never created) and the deny message (pointing at
 *      spawn_background_task) round-trips to the model as a tool_result.
 *   2. BASH_TIMEOUT_ENV actually reaches the harness's shell: a scripted
 *      foreground `printenv` reports 600000 back in its tool_result.
 *
 * Run via the `test` package.json script.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  buildCanUseTool,
  buildBashBackgroundPreToolUseHook,
} from "../src/sandbox.ts";
import { BASH_TIMEOUT_ENV } from "../src/agent.ts";
import { rootLogger } from "../src/logger.ts";

/** Model id for the scripted conversation. Requests for any other model
 * (small-fast quota checks, summarizers) get a trivial text reply and
 * don't consume the script. */
const MAIN_MODEL = "integ-main-model";
const SMALL_MODEL = "integ-small-model";

/** The user prompt for every scripted turn. The CLI also fires "Warmup"
 * requests at the main model (with tools attached), so the mock
 * recognizes the real conversation by this marker in the FIRST message —
 * follow-up requests in the same conversation resend the full history,
 * so the marker stays in position 0 throughout. */
const PROMPT_MARKER = "Run the command you were asked to run.";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** One scripted assistant turn = the content blocks to return. */
type ScriptedTurn = ContentBlock[];

interface MockApi {
  baseUrl: string;
  /** Push assistant turns here before running query(). Consumed in order
   * by MAIN_MODEL requests. */
  script: ScriptedTurn[];
  /** Every parsed /v1/messages request body, in arrival order. */
  requests: Array<{ model: string; messages: unknown[] }>;
  close(): Promise<void>;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Render content blocks as a Messages API SSE stream. tool_use input is
 * delivered the way the real API does it: empty input in the start event,
 * full JSON via a single input_json_delta. */
function buildSse(content: ContentBlock[], stopReason: string): string {
  let out = sseEvent("message_start", {
    type: "message_start",
    message: {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      type: "message",
      role: "assistant",
      model: MAIN_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      out += sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      out += sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    out += sseEvent("content_block_stop", { type: "content_block_stop", index });
  });
  out += sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  out += sseEvent("message_stop", { type: "message_stop" });
  return out;
}

function buildJson(content: ContentBlock[], stopReason: string): unknown {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model: MAIN_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** Minimal scripted Anthropic Messages API on 127.0.0.1. */
async function startMockApi(): Promise<MockApi> {
  const script: ScriptedTurn[] = [];
  const requests: MockApi["requests"] = [];

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      // Token counting and any other GET/aux endpoints: cheap stubs.
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found_error", message: path } }));
        return;
      }
      let parsed: { model?: string; messages?: unknown[]; stream?: boolean };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push({ model: parsed.model ?? "", messages: parsed.messages ?? [] });

      // Only real conversation requests consume the script; anything
      // else (Warmup probes, quota checks, small-fast summarizers) gets
      // a trivial end_turn so the CLI never stalls on it.
      const isConversation =
        parsed.model === MAIN_MODEL &&
        JSON.stringify(parsed.messages?.[0] ?? "").includes(PROMPT_MARKER);
      const turn = isConversation ? script.shift() : undefined;
      const content: ContentBlock[] = turn ?? [{ type: "text", text: "ok" }];
      const stopReason = content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : "end_turn";

      if (parsed.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.end(buildSse(content, stopReason));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildJson(content, stopReason)));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    script,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Run one scripted query() turn the way runAgentTurnImpl wires it. */
async function runScriptedTurn(api: MockApi, cwd: string, home: string): Promise<string> {
  const q = query({
    prompt: PROMPT_MARKER,
    options: {
      cwd,
      model: MAIN_MODEL,
      maxTurns: 3,
      permissionMode: "default",
      settingSources: [],
      canUseTool: buildCanUseTool(cwd),
      // The production wiring: PreToolUse hook denies run_in_background
      // Bash (canUseTool is bypassed for backgrounded Bash by the CLI).
      // This test exercises that exact gate through the real CLI.
      hooks: {
        PreToolUse: [
          { hooks: [buildBashBackgroundPreToolUseHook(rootLogger, { cwd })] },
        ],
      },
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        ANTHROPIC_BASE_URL: api.baseUrl,
        ANTHROPIC_API_KEY: "integ-test-key",
        ANTHROPIC_MODEL: MAIN_MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: SMALL_MODEL,
        // Keep the CLI from phoning home (telemetry, update checks) —
        // everything it needs is the mock API.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...BASH_TIMEOUT_ENV,
      },
    },
  });
  let finalText = "";
  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      finalText = msg.result;
    }
  }
  return finalText;
}

/** Flatten every tool_result the CLI sent back to the API into one
 * searchable string. */
function allToolResults(api: MockApi): string {
  return JSON.stringify(
    api.requests
      .filter((r) => r.model === MAIN_MODEL)
      .flatMap((r) => r.messages),
  );
}

describe("background Bash containment (real CLI integration)", () => {
  let api: MockApi;
  let root: string;

  before(async () => {
    api = await startMockApi();
    root = mkdtempSync(join(tmpdir(), "bash-bg-integ-"));
  });
  after(async () => {
    await api.close();
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "denies run_in_background through the real permission pipeline",
    { timeout: 120_000 },
    async () => {
      const cwd = join(root, "deny-cwd");
      const home = join(root, "deny-home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });
      const sentinel = join(cwd, "escaped.txt");

      api.script.length = 0;
      api.requests.length = 0;
      api.script.push(
        [
          {
            type: "tool_use",
            id: "toolu_bg_1",
            name: "Bash",
            input: {
              command: `touch ${sentinel} && sleep 300`,
              run_in_background: true,
            },
          },
        ],
        [{ type: "text", text: "understood, the background call was denied" }],
      );

      const finalText = await runScriptedTurn(api, cwd, home);

      // The denied command must never have executed.
      assert.equal(existsSync(sentinel), false, "denied command ran anyway");
      // The deny message must round-trip to the model as a tool_result,
      // teaching it to use spawn_background_task.
      const results = allToolResults(api);
      assert.match(results, /run_in_background is disabled/);
      assert.match(results, /spawn_background_task/);
      // And the turn still completes normally after the deny.
      assert.match(finalText, /denied/);
    },
  );

  it(
    "plumbs BASH_TIMEOUT_ENV into the harness's foreground shell",
    { timeout: 120_000 },
    async () => {
      const cwd = join(root, "env-cwd");
      const home = join(root, "env-home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(home, { recursive: true });

      api.script.length = 0;
      api.requests.length = 0;
      api.script.push(
        [
          {
            type: "tool_use",
            id: "toolu_env_1",
            name: "Bash",
            input: {
              command:
                'echo "default=$BASH_DEFAULT_TIMEOUT_MS max=$BASH_MAX_TIMEOUT_MS"',
            },
          },
        ],
        [{ type: "text", text: "env reported" }],
      );

      const finalText = await runScriptedTurn(api, cwd, home);

      const results = allToolResults(api);
      assert.match(
        results,
        /default=600000 max=600000/,
        "BASH timeout env vars did not reach the Bash tool's shell",
      );
      assert.match(finalText, /env reported/);
    },
  );
});

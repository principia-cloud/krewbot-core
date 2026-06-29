/**
 * Unit tests for per-workspace LLM provider routing.
 *
 *  - llm-provider-config.ts: file/env/default resolution + the per-turn cache.
 *  - agent.ts resolveTurnProvider(): the gateway-vs-direct env helper. In
 *    gateway mode it must set the ANTHROPIC_* envs, reuse the workspace key as
 *    the bearer, and SKIP the OAuth credentials setup; direct mode must be a
 *    pure no-op so existing workspaces are byte-for-byte unchanged.
 *  - agent.ts gatewayBudgetMessage(): map the gateway's hard-cap rejection to a
 *    user-facing message.
 *
 * AGENT_PLATFORM_KEY_PATH is set before importing agent.ts because
 * platform-client.ts captures the key path at module load.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "llmprov-"));
const KEY_FILE = join(TMP, "agent-platform-key");
const WORKSPACE_KEY = "wsk_testws-01_deadbeef";
writeFileSync(KEY_FILE, `${WORKSPACE_KEY}\n`);
process.env.AGENT_PLATFORM_KEY_PATH = KEY_FILE;

const { resolveLlmProvider, __resetLlmProviderCache, ANTHROPIC_DIRECT_MODEL } =
  await import("../src/llm-provider-config.ts");
const { resolveTurnProvider, gatewayBudgetMessage, gatewayModelUnavailableMessage } =
  await import("../src/agent.ts");

after(() => rmSync(TMP, { recursive: true, force: true }));

function clearEnv(): void {
  delete process.env.LLM_PROVIDER_MODE;
  delete process.env.LLM_PROVIDER_MODEL;
  delete process.env.LLM_PROVIDER_SMALL_FAST_MODEL;
  delete process.env.LLM_GATEWAY_URL;
  __resetLlmProviderCache();
}

describe("resolveLlmProvider", () => {
  beforeEach(clearEnv);

  it("defaults to anthropic-direct with the pinned model", () => {
    const r = resolveLlmProvider();
    assert.equal(r.mode, "anthropic-direct");
    assert.equal(r.model, ANTHROPIC_DIRECT_MODEL);
    assert.equal(r.smallFastModel, undefined);
  });

  it("reads gateway mode from env and defaults smallFastModel to model", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_PROVIDER_MODEL = "bedrock/amazon.nova-pro-v1:0";
    __resetLlmProviderCache();
    const r = resolveLlmProvider();
    assert.equal(r.mode, "gateway");
    assert.equal(r.model, "bedrock/amazon.nova-pro-v1:0");
    assert.equal(r.smallFastModel, "bedrock/amazon.nova-pro-v1:0");
  });

  it("honors an explicit smallFastModel", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_PROVIDER_MODEL = "bedrock/meta.llama3-3-70b-instruct-v1:0";
    process.env.LLM_PROVIDER_SMALL_FAST_MODEL = "bedrock/amazon.nova-micro-v1:0";
    __resetLlmProviderCache();
    assert.equal(resolveLlmProvider().smallFastModel, "bedrock/amazon.nova-micro-v1:0");
  });

  it("falls back to anthropic-direct when gateway mode lacks a model", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    __resetLlmProviderCache();
    const r = resolveLlmProvider();
    assert.equal(r.mode, "anthropic-direct");
    assert.equal(r.model, ANTHROPIC_DIRECT_MODEL);
  });

  it("ignores an unknown mode value (treats as default)", () => {
    process.env.LLM_PROVIDER_MODE = "openai-direct";
    process.env.LLM_PROVIDER_MODEL = "gpt-4o";
    __resetLlmProviderCache();
    assert.equal(resolveLlmProvider().mode, "anthropic-direct");
  });

  it("caches within the TTL and re-resolves after reset", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_PROVIDER_MODEL = "bedrock/a";
    __resetLlmProviderCache();
    assert.equal(resolveLlmProvider().model, "bedrock/a");
    process.env.LLM_PROVIDER_MODEL = "bedrock/b"; // changed, but within TTL
    assert.equal(resolveLlmProvider().model, "bedrock/a"); // served from cache
    __resetLlmProviderCache();
    assert.equal(resolveLlmProvider().model, "bedrock/b"); // fresh after reset
  });
});

describe("resolveTurnProvider", () => {
  beforeEach(clearEnv);

  it("anthropic-direct: no extra env and does NOT skip credential setup", () => {
    const p = resolveTurnProvider();
    assert.equal(p.model, ANTHROPIC_DIRECT_MODEL);
    assert.equal(p.skipCredsSetup, false);
    assert.deepEqual(p.extraEnv, {});
  });

  it("gateway: sets ANTHROPIC_* env, skips creds, reuses the workspace key", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_PROVIDER_MODEL = "bedrock/amazon.nova-pro-v1:0";
    process.env.LLM_GATEWAY_URL = "https://gw.example.com/"; // trailing slash trimmed
    __resetLlmProviderCache();

    const p = resolveTurnProvider();
    assert.equal(p.skipCredsSetup, true);
    assert.equal(p.model, "bedrock/amazon.nova-pro-v1:0");
    assert.equal(p.extraEnv.ANTHROPIC_BASE_URL, "https://gw.example.com");
    assert.equal(p.extraEnv.ANTHROPIC_AUTH_TOKEN, WORKSPACE_KEY);
    assert.equal(p.extraEnv.ANTHROPIC_MODEL, "bedrock/amazon.nova-pro-v1:0");
    assert.equal(p.extraEnv.ANTHROPIC_SMALL_FAST_MODEL, "bedrock/amazon.nova-pro-v1:0");
    assert.equal(p.extraEnv.SKIP_CLAUDE_CREDS_SETUP, "1");
    // Auto-compaction sized to the model's real window (nova-pro = 300k).
    assert.equal(p.extraEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
    assert.equal(p.extraEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "85");
  });

  it("sizes the auto-compact window to the model's real context limit", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_GATEWAY_URL = "https://gw.example.com";
    for (const [model, win] of [
      ["bedrock/deepseek.v3.2", "163840"],
      ["bedrock/amazon.nova-lite-v1:0", "300000"],
      ["bedrock/some-unknown-model", "128000"], // conservative default
    ] as const) {
      process.env.LLM_PROVIDER_MODEL = model;
      __resetLlmProviderCache();
      assert.equal(resolveTurnProvider().extraEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, win);
    }
  });

  it("gateway mode without a configured gateway URL throws explicitly", () => {
    process.env.LLM_PROVIDER_MODE = "gateway";
    process.env.LLM_PROVIDER_MODEL = "bedrock/x";
    // LLM_GATEWAY_URL intentionally unset
    __resetLlmProviderCache();
    assert.throws(() => resolveTurnProvider(), /gateway URL is not set/i);
  });
});

describe("gatewayBudgetMessage", () => {
  it("maps gateway 402/429 budget rejections to a friendly message", () => {
    assert.match(
      gatewayBudgetMessage(new Error("API error 429: monthly budget exceeded")) ?? "",
      /monthly LLM spend limit/,
    );
    assert.match(
      gatewayBudgetMessage("HTTP 402 Payment Required: workspace over budget") ?? "",
      /monthly LLM spend limit/,
    );
  });

  it("returns null for unrelated errors", () => {
    assert.equal(gatewayBudgetMessage(new Error("connect ECONNREFUSED")), null);
    assert.equal(gatewayBudgetMessage(new Error("500 internal server error")), null);
    assert.equal(gatewayBudgetMessage(undefined), null);
  });
});

describe("gatewayModelUnavailableMessage", () => {
  it("maps the gateway's fail-closed model rejection to a friendly message", () => {
    // Current gateway detail wording.
    assert.match(
      gatewayModelUnavailableMessage(
        new Error("API Error: 400 400: The model 'bedrock/x' is not available on this gateway."),
      ) ?? "",
      /isn't available right now/,
    );
    // Pre-fix wording (old gateway image still in flight) — must never
    // leak pricing internals to the user.
    const msg = gatewayModelUnavailableMessage(
      "400: Model not available on this gateway: no authoritative price configured for model 'bedrock/x'",
    );
    assert.match(msg ?? "", /isn't available right now/);
    assert.doesNotMatch(msg ?? "", /price/i);
  });

  it("returns null for unrelated errors", () => {
    assert.equal(gatewayModelUnavailableMessage(new Error("connect ECONNREFUSED")), null);
    assert.equal(gatewayModelUnavailableMessage(undefined), null);
  });
});

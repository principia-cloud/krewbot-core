/**
 * llm-provider-config.ts — per-workspace LLM provider/model selection.
 *
 * Default is unchanged Anthropic-direct: a workspace with no config runs the
 * current model via the subscription OAuth token (~/.claude/.credentials.json).
 * A workspace can opt into "gateway" mode, which routes the Claude CLI's
 * traffic through the central LLM gateway (LiteLLM) to a Bedrock model. The
 * gateway holds the real AWS credentials; the sandbox only ever sends its own
 * `wsk_` workspace token (already present at /config/secrets/agent-platform-key)
 * as the bearer. See lib/llm-gateway-stack.ts.
 *
 * Source: a per-workspace SSM parameter `{ssmPrefix}/{workspaceId}/llm-provider`
 * holding a JSON blob. The sidecar mirrors it to /config/ssm/llm-provider on
 * every sync tick (docker/sidecar/jobs/sync.py). Unlike turn-queue-config.ts
 * (read once at boot), this is resolved PER TURN behind a short TTL cache so an
 * operator can switch a workspace's model without bouncing the sandbox.
 *
 * Resolution order (first present wins):
 *   1. /config/ssm/llm-provider        — operator-set, vended by sidecar
 *   2. process.env.LLM_PROVIDER_*       — escape hatch for local dev / tests
 *   3. default: { mode: "anthropic-direct" }
 *
 * The gateway base URL is platform-wide (the same Function URL for every
 * workspace), so it is NOT in this per-workspace config — it comes from the
 * LLM_GATEWAY_URL container env var set by CDK.
 */

import { readFileSync } from "node:fs";
import { rootLogger, logCatch } from "./logger.js";

const CONFIG_PATH = "/config/ssm/llm-provider";

/** TTL for the per-turn read cache. Short enough that a model switch lands
 * within seconds, long enough that a burst of turns doesn't stat the file
 * repeatedly. */
const CACHE_TTL_MS = 5_000;

/**
 * The model used in anthropic-direct (default) mode. Pinned explicitly so the
 * Claude CLI's bundled default can't drift under us on a CLI bump — same
 * rationale as the original hard-coded `model:` at the query() call sites.
 * The `[1m]` suffix selects the 1M-context variant.
 */
export const ANTHROPIC_DIRECT_MODEL = "claude-opus-4-7[1m]";

export type LlmProviderMode = "anthropic-direct" | "gateway";

/** Shape of the JSON document the sidecar writes (parameter value). */
interface LlmProviderConfigFile {
  mode?: LlmProviderMode;
  /** Model name the gateway maps to a Bedrock model (e.g. "bedrock/amazon.nova-pro-v1:0"). */
  model?: string;
  /** Background/“small fast” model. Defaults to `model` in gateway mode so the
   * CLI's cheap background calls don't hit an unmapped Anthropic default. */
  smallFastModel?: string;
  /** Real context window (tokens) of the gateway model. Overrides the built-in
   * map below. The Claude CLI doesn't recognize gateway model names and assumes
   * a Claude-ish ~200k window, so it compacts too late for smaller models and
   * 400s; we feed it the real value via CLAUDE_CODE_AUTO_COMPACT_WINDOW. */
  contextWindow?: number;
}

/** Real context windows (tokens) by model-id substring, for sizing
 * auto-compaction on gateway models. First match wins; unknown → DEFAULT. */
const MODEL_CONTEXT_WINDOWS: Array<[string, number]> = [
  ["nova-micro", 128_000],
  ["nova-lite", 300_000],
  ["nova-pro", 300_000],
  ["kimi-k2.5", 256_000],
  ["deepseek.v3", 163_840],
  ["deepseek.r1", 131_072],
  ["deepseek", 131_072],
  ["llama", 128_000],
  ["mistral-large", 131_072],
  ["mistral", 131_072],
  ["claude-3-5-sonnet", 200_000],
  ["claude", 200_000],
];
const DEFAULT_CONTEXT_WINDOW = 128_000;

function resolveContextWindow(model: string, override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  const m = (model || "").toLowerCase();
  const hit = MODEL_CONTEXT_WINDOWS.find(([k]) => m.includes(k));
  return hit ? hit[1] : DEFAULT_CONTEXT_WINDOW;
}

export interface ResolvedLlmProvider {
  mode: LlmProviderMode;
  /** The model to pass to query()'s `model` option and ANTHROPIC_MODEL. */
  model: string;
  /** Set as ANTHROPIC_SMALL_FAST_MODEL in gateway mode. Undefined in direct mode. */
  smallFastModel?: string;
  /** Real context window (tokens) for the gateway model. Fed to the CLI as
   * CLAUDE_CODE_AUTO_COMPACT_WINDOW so auto-compaction fires before the model's
   * real limit (the CLI assumes ~200k for unknown gateway models otherwise).
   * Undefined in direct mode (the CLI knows Claude's window). */
  contextWindow?: number;
  /** Where the resolution came from — logged so operators can confirm. */
  source: "file" | "env" | "default";
}

let cached: { value: ResolvedLlmProvider; expiresAt: number } | null = null;

function readConfigFile(): LlmProviderConfigFile | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as LlmProviderConfigFile;
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the common, expected case (workspace never opted in, or
    // pre-sidecar-sync). Anything else is worth flagging.
    if (code !== "ENOENT") {
      logCatch(rootLogger, "llm_provider.config.read_failed", err, { path: CONFIG_PATH });
    }
    return null;
  }
}

function readEnvConfig(): LlmProviderConfigFile | null {
  const mode = process.env.LLM_PROVIDER_MODE;
  if (mode !== "gateway" && mode !== "anthropic-direct") return null;
  return {
    mode,
    model: process.env.LLM_PROVIDER_MODEL,
    smallFastModel: process.env.LLM_PROVIDER_SMALL_FAST_MODEL,
  };
}

function resolveFresh(): ResolvedLlmProvider {
  const fromFile = readConfigFile();
  const raw = fromFile ?? readEnvConfig();
  const source: ResolvedLlmProvider["source"] = fromFile ? "file" : raw ? "env" : "default";

  // Default / malformed → unchanged behavior.
  if (!raw || raw.mode !== "gateway") {
    return { mode: "anthropic-direct", model: ANTHROPIC_DIRECT_MODEL, source };
  }

  // Gateway mode requires a model. If it's missing the config is unusable —
  // fall back to the safe default rather than handing the CLI an empty model.
  if (!raw.model || typeof raw.model !== "string") {
    rootLogger.warn(
      { event: "llm_provider.config.gateway_without_model", path: CONFIG_PATH },
      "llm-provider is gateway mode but has no model; falling back to anthropic-direct",
    );
    return { mode: "anthropic-direct", model: ANTHROPIC_DIRECT_MODEL, source };
  }

  return {
    mode: "gateway",
    model: raw.model,
    // Always have a mapped small/fast model in gateway mode — default to the
    // main model so the CLI's background calls don't 404 at the gateway.
    smallFastModel: raw.smallFastModel || raw.model,
    contextWindow: resolveContextWindow(raw.model, raw.contextWindow),
    source,
  };
}

/**
 * Resolve the active provider for THIS turn. Cached for CACHE_TTL_MS so a burst
 * of turns doesn't re-read the file, while a model switch still lands quickly.
 */
export function resolveLlmProvider(now: number = Date.now()): ResolvedLlmProvider {
  if (cached && cached.expiresAt > now) return cached.value;
  const value = resolveFresh();
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test helper — drop the cache so a test can change env/file between calls. */
export function __resetLlmProviderCache(): void {
  cached = null;
}

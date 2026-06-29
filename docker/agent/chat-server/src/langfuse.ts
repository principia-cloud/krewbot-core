/**
 * langfuse.ts — Langfuse client factory + flush helpers.
 *
 * The event → trace translation lives in `instrumented-query.ts`. This
 * file only handles (1) constructing the client and (2) flushing
 * pending spans at shutdown / after cron turns.
 *
 * The client points at the Agent Platform API's Langfuse proxy route,
 * not at Langfuse Cloud directly. The chat-server never holds a real
 * Langfuse credential — only its per-workspace agent-platform-key,
 * which is already mounted at /config/secrets/agent-platform-key by
 * the sidecar and used by everything else in this process.
 *
 * Wire-level flow (Langfuse SDK → proxy → Langfuse Cloud):
 *   1. SDK sends POST {baseUrl}/api/public/ingestion with header
 *      `Authorization: Basic base64("proxy:<agent-platform-key>")`.
 *   2. The proxy Lambda (lambda/agent-platform-api/index.py:langfuse_ingest)
 *      extracts the secret half, validates it against Secrets Manager,
 *      derives workspaceId from its prefix, stamps that workspaceId into
 *      every event's metadata (overwriting any payload claim), swaps the
 *      Authorization header to the platform Langfuse key, and forwards
 *      to Langfuse Cloud.
 *
 * Security consequence: a compromised chat-server cannot read other
 * workspaces' traces (it has no Langfuse credential at all) and cannot
 * forge a workspaceId tag (the proxy stamps the authenticated identity).
 *
 * If AGENT_PLATFORM_API_URL or the agent-platform-key file is absent —
 * both are standard on every sandbox task — getLangfuse returns null
 * and every callsite no-ops cleanly. Local dev and misconfigured
 * workspaces keep working without traces.
 */

import * as fs from "node:fs";
import { Langfuse } from "langfuse";
import { rootLogger, logCatch } from "./logger.js";

const AGENT_PLATFORM_KEY_PATH =
  process.env.AGENT_PLATFORM_KEY_PATH ?? "/config/secrets/agent-platform-key";

let client: Langfuse | null = null;
let initialized = false;

function readAgentPlatformKey(): string | null {
  try {
    const key = fs.readFileSync(AGENT_PLATFORM_KEY_PATH, "utf-8").trim();
    return key || null;
  } catch (err) {
    // Absent until the sidecar syncs it. Expected on cold boot; surface
    // at info so a persistent miss is still visible.
    logCatch(rootLogger, "langfuse.agent_platform_key.unavailable", err, {
      path: AGENT_PLATFORM_KEY_PATH,
      expected: true,
    });
    return null;
  }
}

/**
 * Lazy-init the Langfuse client the first time it's needed. Returns null
 * if the proxy URL or agent-platform-key isn't available yet; callers
 * should no-op in that case.
 */
export function getLangfuse(): Langfuse | null {
  if (initialized) return client;
  initialized = true;

  const proxyRoot = (process.env.AGENT_PLATFORM_API_URL ?? "").replace(/\/+$/, "");
  if (!proxyRoot) {
    rootLogger.warn(
      { event: "langfuse.proxy_url_missing" },
      "AGENT_PLATFORM_API_URL not set — tracing disabled",
    );
    return null;
  }

  const agentPlatformKey = readAgentPlatformKey();
  if (!agentPlatformKey) return null;

  const baseUrl = `${proxyRoot}/langfuse`;
  client = new Langfuse({
    // publicKey is a placeholder — the proxy ignores it. The agent-
    // platform-key goes in the secret half of Basic auth where the
    // proxy extracts it.
    publicKey: "proxy",
    secretKey: agentPlatformKey,
    baseUrl,
  });
  rootLogger.info(
    { event: "langfuse.initialized", baseUrl },
    "langfuse client pointed at proxy",
  );
  return client;
}

/**
 * Flush pending traces. Safe to call even if the client was never
 * initialized (resolves immediately). Use before process exit and after
 * each cron turn to bound the max-loss window to one turn.
 */
export async function flushLangfuse(): Promise<void> {
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (err) {
    logCatch(rootLogger, "langfuse.flush.failed", err);
  }
}

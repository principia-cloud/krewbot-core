/**
 * platform-client.ts — typed HTTPS client for the Agent Platform API.
 *
 * Replaces direct file reads from /config/* and atomic writes to /control/*
 * for everything except secret materialization. The sidecar still vends
 * the per-workspace API key into /config/secrets/agent-platform-key; this
 * client reads it (mtime-cached) and signs every request with
 * `Authorization: Bearer <key>`.
 *
 * Reads have a short TTL cache so hot loops (e.g. members lookup on every
 * inbound message) don't hammer API Gateway. Writes are uncached and bust
 * the relevant read cache.
 */

import * as fs from "node:fs";
import { rootLogger, logCatch } from "./logger.js";

const API_URL = (process.env.AGENT_PLATFORM_API_URL || "").replace(/\/+$/, "");
const KEY_PATH = process.env.AGENT_PLATFORM_KEY_PATH || "/config/secrets/agent-platform-key";

const READ_TTL_MS = 30_000;

if (!API_URL) {
  rootLogger.warn(
    { event: "platform_client.missing_url" },
    "AGENT_PLATFORM_API_URL is not set — calls will fail",
  );
}

// ---------------------------------------------------------------------------
// API key loader (mtime-cached, like auth.ts:loadJwks)
// ---------------------------------------------------------------------------

let cachedKey = "";
let cachedKeyMtimeMs = 0;

function loadKey(): string {
  try {
    const stat = fs.statSync(KEY_PATH);
    if (cachedKey && stat.mtimeMs === cachedKeyMtimeMs) return cachedKey;
    cachedKey = fs.readFileSync(KEY_PATH, "utf-8").trim();
    cachedKeyMtimeMs = stat.mtimeMs;
    return cachedKey;
  } catch (err) {
    // Fall back to last good copy (might be empty on first call before
    // the sidecar has materialized the file). Log so a persistent miss
    // is visible.
    const expected = cachedKey === "";
    logCatch(rootLogger, "platform_client.key.read_failed", err, {
      path: KEY_PATH,
      fallbackAvailable: cachedKey !== "",
      expected,
    });
    return cachedKey;
  }
}

/**
 * The per-workspace `wsk_` API key (mtime-cached), exposed for reuse as the
 * bearer token when routing the Claude CLI through the LLM gateway in gateway
 * mode. The gateway validates this exact token (same scheme as this API), so
 * the sandbox never needs a separate gateway credential. Returns "" until the
 * sidecar has materialized the file.
 */
export function loadAgentPlatformKey(): string {
  return loadKey();
}

// ---------------------------------------------------------------------------
// TTL read cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const readCache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string): T | null {
  const entry = readCache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    readCache.delete(key);
    return null;
  }
  return entry.value;
}

function cache<T>(key: string, value: T, ttlMs: number = READ_TTL_MS): T {
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function bust(key: string): void {
  readCache.delete(key);
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!API_URL) {
    throw new PlatformApiError("AGENT_PLATFORM_API_URL not set", 0, "");
  }
  const key = loadKey();
  if (!key) {
    throw new PlatformApiError("agent-platform-key not yet available", 0, "");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new PlatformApiError(
      `${method} ${path} → ${resp.status}`,
      resp.status,
      text,
    );
  }
  // 204 No Content / empty body
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Unexpected non-JSON response — surface as an error so callers don't
    // try to interpret garbage. Log before re-throwing so the offending
    // response body is visible even if the caller swallows the error.
    logCatch(rootLogger, "platform_client.invalid_json", err, {
      method,
      path,
      status: resp.status,
      bodySnippet: text.slice(0, 200),
    });
    throw new PlatformApiError(
      `${method} ${path} → invalid JSON response`,
      resp.status,
      text,
    );
  }
}

// ---------------------------------------------------------------------------
// Typed surface
// ---------------------------------------------------------------------------

export interface PlatformMember {
  userId: string;
  role: string;
  telegramUserId?: string;
  telegramUsername?: string;
}

export interface PlatformWorkspace {
  workspaceId?: string;
  name?: string;
  status?: string;
  adminUserId?: string;
  [k: string]: unknown;
}

export interface PlatformCronJob {
  name: string;
  schedule: string;
  message: string;
  enabled: boolean;
}

export interface PlatformCronTarget {
  adapter: string;
  threadId: string;
}

export interface PlatformAgent {
  agentId: string;
  name: string;
  description?: string;
  /** `deletion_pending` rows are in the grace window before DDB TTL
   * removes them; the chat-server sweeper rm's their EFS dir. Neither
   * the supervisor nor the UI should surface them. */
  status: 'draft' | 'deployed' | 'deletion_pending';
  requiredSecrets?: string[];
  [k: string]: unknown;
}

export interface PlatformChatObservation {
  observationId: string;
  workspaceId: string;
  ts: string;
  adapter: string;
  thread: {
    threadId: string;
    chatId: string;
    type: string;
    title: string;
    isDM: boolean;
    adapterData: Record<string, unknown>;
  };
  author:
    | {
        userId: string;
        userName: string;
        fullName: string;
        isBot: boolean;
      }
    | null;
}

export const platformClient = {
  async getWorkspace(): Promise<PlatformWorkspace> {
    const hit = cached<PlatformWorkspace>("workspace");
    if (hit) return hit;
    const value = await request<PlatformWorkspace>("GET", "/workspace");
    return cache("workspace", value);
  },

  async getMembers(): Promise<PlatformMember[]> {
    const hit = cached<PlatformMember[]>("members");
    if (hit) return hit;
    const value = await request<{ members: PlatformMember[] }>("GET", "/members");
    return cache("members", value.members ?? []);
  },

  /** Every non-tombstoned agent in the workspace. Callers that only
   * want deployed agents filter the return themselves — draft rows are
   * surfaced too so debug tooling / future UI can use the same path. */
  async listAgents(): Promise<PlatformAgent[]> {
    const hit = cached<PlatformAgent[]>("workspace-agents");
    if (hit) return hit;
    const value = await request<{ agents: PlatformAgent[] }>(
      "GET",
      "/workspace/agents",
    );
    return cache("workspace-agents", value.agents ?? []);
  },

  /** Flip a single agent's status in DDB. Used by the chat-server's
   * /deploy orchestrator after the secret check + EFS promote. The
   * cached agent list is busted so the next supervisor turn picks up
   * the new status. */
  async setAgentStatus(
    agentId: string,
    status: "deployed" | "draft",
  ): Promise<void> {
    await request<{ agentId: string; status: string }>(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/status`,
      { status },
    );
    bust("workspace-agents");
  },

  async listCronJobs(): Promise<PlatformCronJob[]> {
    const hit = cached<PlatformCronJob[]>("cron-jobs");
    if (hit) return hit;
    const value = await request<{ jobs: PlatformCronJob[] }>("GET", "/cron/jobs");
    return cache("cron-jobs", value.jobs ?? []);
  },

  async createCronJob(req: {
    name: string;
    schedule: string;
    message: string;
    target?: PlatformCronTarget;
  }): Promise<{ ruleName: string; name: string }> {
    const result = await request<{ ruleName: string; name: string }>(
      "POST",
      "/cron/jobs",
      req,
    );
    bust("cron-jobs");
    return result;
  },

  async deleteCronJob(name: string): Promise<void> {
    await request<{ status: string }>(
      "DELETE",
      `/cron/jobs/${encodeURIComponent(name)}`,
    );
    bust("cron-jobs");
  },

  /** Bulk-delete every cron job whose stored agentId matches.
   * Used by the agent-sweeper to clean schedules attached to
   * deleted agents alongside their EFS dirs. */
  async deleteCronJobsByAgent(agentId: string): Promise<{
    deleted: string[];
    skipped: string[];
  }> {
    const result = await request<{ deleted: string[]; skipped: string[] }>(
      "DELETE",
      `/cron/jobs?agentId=${encodeURIComponent(agentId)}`,
    );
    bust("cron-jobs");
    return result;
  },

  async getChats(): Promise<unknown[]> {
    const hit = cached<unknown[]>("chats");
    if (hit) return hit;
    const value = await request<{ chats: unknown[] }>("GET", "/chats");
    return cache("chats", value.chats ?? []);
  },

  async getPeople(): Promise<unknown[]> {
    const hit = cached<unknown[]>("people");
    if (hit) return hit;
    const value = await request<{ people: unknown[] }>("GET", "/people");
    return cache("people", value.people ?? []);
  },

  async postChatObservation(obs: PlatformChatObservation): Promise<void> {
    await request<{ status: string }>(
      "POST",
      "/chat-directory/observations",
      obs,
    );
  },

  /** Per-turn token usage record (see usage-recorder.ts). Uncached;
   * the API answers `recorded: false` for duplicates / when the usage
   * table isn't configured — both are fine, callers don't branch. */
  async postTurnUsage(record: unknown): Promise<{ recorded: boolean }> {
    return request<{ recorded: boolean }>("POST", "/usage/turns", record);
  },

  /** Lifetime token tally for one chat (per-session DDB rollup). Zeros
   * when nothing has been recorded yet; `enabled: false` when the
   * deployment has no usage table. */
  async getSessionUsage(sessionKey: string): Promise<{
    sessionKey: string;
    enabled: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    turns: number;
    apiCalls: number;
    lastTs?: string;
  }> {
    return request(
      "GET",
      `/usage/session?sessionKey=${encodeURIComponent(sessionKey)}`,
    );
  },

  // ---------------------------------------------------------------------------
  // Browser (AgentCore)
  // ---------------------------------------------------------------------------

  async ensureBrowserSession(sessionKey: string): Promise<{
    sessionId: string;
    automationUrl: string;
    cookies: Array<Record<string, unknown>>;
    expiresAt: string;
    reused: boolean;
  }> {
    // Find-or-create. Used by the chat-creation pre-warm, which is
    // the ONLY path that should ever start a new AgentCore session.
    return request("POST", "/browser/sessions", { sessionKey });
  },

  /** Look up an existing browser session by sessionKey. Returns null
   * when no active session exists — callers (e.g. per-turn agent setup)
   * skip Playwright wiring rather than create a new session, since
   * session creation is owned by the chat-creation pre-warm path. */
  async getBrowserSession(sessionKey: string): Promise<{
    sessionId: string;
    automationUrl: string;
    cookies: Array<Record<string, unknown>>;
    expiresAt: string;
  } | null> {
    try {
      return await request(
        "GET",
        `/browser/sessions/current?sessionKey=${encodeURIComponent(sessionKey)}`,
      );
    } catch (err) {
      if (err instanceof PlatformApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  },

  async stopBrowserSession(sessionId: string): Promise<void> {
    await request("DELETE", `/browser/sessions/${encodeURIComponent(sessionId)}`);
  },

  async loadBrowserCookies(): Promise<Array<Record<string, unknown>>> {
    const result = await request<{ cookies: Array<Record<string, unknown>> }>(
      "GET",
      "/browser/cookies",
    );
    return result.cookies ?? [];
  },
};

export { PlatformApiError };

/**
 * agent-def.ts — read per-agent definitions from EFS.
 *
 * The creator session writes `def/prompt.md` + `def/config.json` under
 * /data/agents/{agentId}/def/. Runtime code paths (supervisor subagent
 * map, test-chat session) load these files via this module.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Root directory for all per-workspace agent folders. Defaults to the
 * production EFS mount path; tests set AGENTS_ROOT_OVERRIDE to point at
 * a writable tmp dir (the constant is resolved once at import, so set
 * the env var before importing this module). */
export const AGENTS_ROOT = process.env.AGENTS_ROOT_OVERRIDE ?? "/data/agents";

/** Agent id format. Keep in sync with lambda/workspace-api/index.py's
 * AGENT_ID_RE + lambda/agent-platform-api/index.py's _AGENT_ID_RE +
 * docker/agent/mcp/agent_platform_mcp.py's _AGENT_ID_RE. Every code
 * path that validates or parses an agentId must go through this. */
export const AGENT_ID_RE = /^agt_[0-9a-f]{10}$/;

export interface AgentMcpManifest {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentDef {
  /** The raw prompt text from def/prompt.md — used as the runtime
   * agent's system prompt. */
  systemPrompt: string;
  /** Full parsed config.json with sane defaults. */
  config: AgentConfig;
  /** Absolute path to def/ — pass to canUseTool as a read-only root. */
  defDir: string;
  /** Absolute path to workdir/ — the agent's writable scratch space. */
  workdir: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  requiredSecrets: string[];
  tools: { allow?: string[] };
  customMcps: AgentMcpManifest[];
}

/** Filesystem paths for an agent. No I/O — just path math.
 *
 * `defDir` is the LIVE deployed copy — read by `buildSubagentMap` for
 * production runs. `defDraftDir` is what the creator session edits.
 * Deploy promotes draft → live (see promoteAgentDef). Test sessions
 * read from `defDraftDir` so you exercise what you're editing rather
 * than the last shipped version. */
export function agentPaths(agentId: string): {
  root: string;
  defDir: string;
  defDraftDir: string;
  workdir: string;
  promptFile: string;
  configFile: string;
  draftPromptFile: string;
  draftConfigFile: string;
  creatorHome: string;
} {
  const root = join(AGENTS_ROOT, agentId);
  return {
    root,
    defDir: join(root, "def"),
    defDraftDir: join(root, "def-draft"),
    workdir: join(root, "workdir"),
    promptFile: join(root, "def", "prompt.md"),
    configFile: join(root, "def", "config.json"),
    draftPromptFile: join(root, "def-draft", "prompt.md"),
    draftConfigFile: join(root, "def-draft", "config.json"),
    // Dotfile so `ls` in the creator view doesn't surface it.
    // It sits under /data/agents/{id}/ (NOT under def/) so it isn't
    // part of the agent's shipped definition.
    creatorHome: join(root, ".creator-home"),
  };
}

/** Parse def/config.json, filling in defaults for any missing fields.
 * Returns a fully-populated AgentConfig so downstream code never has
 * to deal with `undefined`. */
function parseConfig(raw: string): AgentConfig {
  const parsed = JSON.parse(raw) as Partial<AgentConfig>;
  return {
    name: typeof parsed.name === "string" ? parsed.name : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
    requiredSecrets: Array.isArray(parsed.requiredSecrets)
      ? parsed.requiredSecrets.filter((s): s is string => typeof s === "string")
      : [],
    tools: parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {},
    customMcps: Array.isArray(parsed.customMcps) ? parsed.customMcps : [],
  };
}

/**
 * Load an agent's definition from EFS.
 *
 * Throws if `prompt.md` is absent — a runtime agent needs a system
 * prompt. `config.json` is optional (empty defaults returned).
 *
 * When `source: "draft"` is passed, reads from `def-draft/` instead of
 * the live `def/` — used by the test-chat path so users can exercise
 * unsaved creator changes without deploying. Default reads from `def/`.
 * The returned `defDir` always points at the source actually read so
 * the supervisor's read-only sandbox scope matches what the agent sees.
 */
export function loadAgentDef(
  agentId: string,
  opts: { source?: "live" | "draft" } = {},
): AgentDef {
  const paths = agentPaths(agentId);
  const useDraft = opts.source === "draft";
  const defDir = useDraft ? paths.defDraftDir : paths.defDir;
  const promptFile = useDraft ? paths.draftPromptFile : paths.promptFile;
  const configFile = useDraft ? paths.draftConfigFile : paths.configFile;
  if (!existsSync(promptFile)) {
    throw new Error(`Agent ${agentId} has no prompt.md at ${promptFile}`);
  }
  const systemPrompt = readFileSync(promptFile, "utf-8");
  const config: AgentConfig = existsSync(configFile)
    ? parseConfig(readFileSync(configFile, "utf-8"))
    : {
        name: "",
        description: "",
        requiredSecrets: [],
        tools: {},
        customMcps: [],
      };
  return { systemPrompt, config, defDir, workdir: paths.workdir };
}

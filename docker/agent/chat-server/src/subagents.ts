/**
 * subagents.ts — build the SDK-native `agents` map for the workspace
 * supervisor session.
 *
 * Every deployed agent in the workspace becomes one entry in the map
 * the Claude Agent SDK uses to populate the Task tool's
 * subagent_type enum. The SDK then routes Task calls to the matching
 * AgentDefinition (its own prompt, tools, MCP set).
 *
 * Flow per supervisor turn:
 *
 *   platformClient.listAgents() → filter status === "deployed"
 *     → for each row, loadAgentDef(agentId) from EFS
 *     → synthesise AgentDefinition with:
 *         prompt       = def/prompt.md + scope appendix
 *         tools        = def/config.json.tools.allow (if set)
 *         mcpServers   = inline configs for custom-tools MCP +
 *                        def/mcps/*.json entries
 *     → assemble into Record<agentId, AgentDefinition>
 *
 * Anything that fails at the per-agent level (missing prompt.md,
 * malformed config.json, unreadable MCP manifest) is logged and that
 * one agent is skipped — the rest of the map still renders. Better to
 * have 4 subagents and a log entry than a supervisor with no subagents
 * because one was broken.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, McpServerConfigForProcessTransport } from
  "@anthropic-ai/claude-agent-sdk";

import { agentPaths, loadAgentDef, type AgentMcpManifest } from "./agent-def.js";
import { platformClient, type PlatformAgent } from "./platform-client.js";
import { rootLogger, logCatch } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** MCP scripts at /app/mcp/. Same constant agent.ts uses. */
const MCP_DIR = join(dirname(__dirname), "mcp");


/** Appended to every subagent's prompt so the model knows the
 * filesystem boundaries the `canUseTool` hook will enforce.
 *
 * `defDir` here is the actual source the agent was loaded from (live
 * `def/` for normal supervisor turns, `def-draft/` for test sessions).
 * Surfacing the correct path keeps the model from poking at the wrong
 * tree when the user is exercising unsaved changes. */
function scopeAppendix(agentId: string, defDir: string): string {
  const { workdir } = agentPaths(agentId);
  return [
    "",
    "## Your filesystem — IMPORTANT",
    "",
    `Your workdir is **${workdir}**.`,
    `Read-only reference files (prompt, scripts, resources, skills) live at **${defDir}**.`,
    "",
    "## Critical: Bash inherits the supervisor's cwd, NOT yours",
    "",
    "When you run Bash tools, `pwd` returns the **supervisor's** working",
    "directory, NOT your workdir. This is a platform quirk you MUST",
    "work around:",
    "",
    `- **NEVER trust \`pwd\`.** Your workdir is \`${workdir}\` regardless of what \`pwd\` says.`,
    "- **NEVER use relative paths** in Bash tool calls. They will resolve under the",
    "  supervisor's directory and you will read/write the wrong files.",
    "- **ALWAYS use absolute paths.** For example:",
    `  - Listing your workdir: \`ls -la "${workdir}"\` (NOT \`ls -la\`)`,
    `  - Reading a file: \`cat "${workdir}/foo.txt"\` (NOT \`cat foo.txt\`)`,
    `  - Writing a file: \`echo hi > "${workdir}/foo.txt"\``,
    `  - Or prefix with cd: \`cd "${workdir}" && <your command>\``,
    "",
    "When asked what's in your folder or where you are, answer using",
    `the workdir path \`${workdir}\` and run \`ls -la "${workdir}"\` to inspect it.`,
    "If a user reports seeing files you didn't write, you are probably",
    "looking at the supervisor's directory — switch to absolute paths.",
    "",
    "Read/Write/Edit tool calls (not Bash) ARE correctly scoped to your",
    "workdir by the platform, so prefer those for file operations when",
    "possible.",
  ].join("\n");
}

/** Turn the agent's `config.json.customMcps` manifest array into the
 * shape the SDK's AgentDefinition.mcpServers expects.
 *
 * Each manifest becomes an inline single-entry stdio server. We don't
 * reference the supervisor's named MCPs here — the creator's custom
 * MCPs are explicitly agent-scoped. */
function buildCustomMcpEntries(
  agentId: string,
  manifests: AgentMcpManifest[],
): Array<Record<string, McpServerConfigForProcessTransport>> {
  const entries: Array<Record<string, McpServerConfigForProcessTransport>> = [];
  for (const m of manifests) {
    if (!m.name || !m.command) {
      rootLogger.warn(
        {
          event: "subagent.custom_mcp.skipped_invalid",
          agentId,
          manifestName: m.name,
        },
        "skipping custom MCP with missing name/command",
      );
      continue;
    }
    // Namespace by agentId so two agents with the same manifest name
    // don't collide at the supervisor's MCP registry level.
    const namespacedName = `agent-${agentId}-${m.name}`;
    entries.push({
      [namespacedName]: {
        type: "stdio",
        command: m.command,
        args: m.args ?? [],
        env: m.env ?? {},
      },
    });
  }
  return entries;
}

/** Build the auto-generated custom-tools MCP entry for one agent. The
 * MCP scans {AGENT_DEF_DIR}/scripts/*.py and registers each as a tool
 * (see docker/agent/mcp/custom_tools_mcp.py).
 *
 * `defDir` is passed in (rather than recomputed) so test sessions can
 * point the MCP at `def-draft/scripts/` and exercise unsaved tool
 * additions without having to deploy. */
function buildCustomToolsMcpEntry(
  agentId: string,
  defDir: string,
): Record<string, McpServerConfigForProcessTransport> {
  return {
    [`agent-${agentId}-tools`]: {
      type: "stdio",
      command: "python3",
      args: [join(MCP_DIR, "custom_tools_mcp.py")],
      env: {
        AGENT_DEF_DIR: defDir,
        PATH: process.env.PATH ?? "",
        // No HOME override — custom tools should not try to persist
        // state in HOME; they write to workdir/ via the permission
        // hook's scope.
      },
    },
  };
}

/** Walk `defDir/mcps/*.json` (if present) and parse each as a
 * manifest. Tolerant of missing/malformed files — problematic manifests
 * are skipped with a warn log rather than failing the whole agent. */
function loadMcpManifests(agentId: string, defDir: string): AgentMcpManifest[] {
  const mcpsDir = join(defDir, "mcps");
  if (!existsSync(mcpsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(mcpsDir);
  } catch (err) {
    logCatch(rootLogger, "subagent.mcps_dir.readdir_failed", err, {
      agentId,
      mcpsDir,
    });
    return [];
  }
  const manifests: AgentMcpManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(mcpsDir, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AgentMcpManifest>;
      if (!parsed.name || !parsed.command) {
        rootLogger.warn(
          {
            event: "subagent.mcp_manifest.missing_fields",
            agentId,
            path,
          },
          "mcp manifest missing name/command",
        );
        continue;
      }
      manifests.push({
        name: parsed.name,
        command: parsed.command,
        args: Array.isArray(parsed.args)
          ? parsed.args.filter((a): a is string => typeof a === "string")
          : undefined,
        env:
          parsed.env && typeof parsed.env === "object"
            ? (parsed.env as Record<string, string>)
            : undefined,
      });
    } catch (err) {
      logCatch(rootLogger, "subagent.mcp_manifest.parse_failed", err, {
        agentId,
        path,
      });
    }
  }
  return manifests;
}

/** Result of `buildSubagentMap` — returned split so the caller can:
 *   - pass `agents` straight into the Agent SDK's query options;
 *   - iterate `deployedIds` when building the system-prompt appendix
 *     that tells the supervisor which subagents exist. */
export interface SubagentMap {
  /** SDK-native map: agentId → AgentDefinition. */
  agents: Record<string, AgentDefinition>;
  /** Parallel DDB rows for the same agentIds (lets callers render
   * name/description in the supervisor prompt without re-fetching). */
  deployed: PlatformAgent[];
}

/**
 * Build the SDK `agents` map for this workspace's supervisor.
 * Returns an empty map (not an error) if the workspace has no
 * deployed agents or the platform API is unreachable — the supervisor
 * should keep working in that case, just without subagent routing.
 *
 * `testAgentId` short-circuits the platform listing: when set, the
 * map contains exactly that one agent loaded from `def-draft/`,
 * regardless of its DDB status. The test-chat path uses this so a
 * user can exercise an in-progress agent without deploying it.
 * `deployed[]` still mirrors the DDB row for that single agent so the
 * supervisor's appendix renders the right name/description.
 */
export async function buildSubagentMap(
  opts: { testAgentId?: string } = {},
): Promise<SubagentMap> {
  let rows: PlatformAgent[];
  try {
    rows = await platformClient.listAgents();
  } catch (err) {
    logCatch(rootLogger, "subagent.list_agents.failed", err);
    return { agents: {}, deployed: [] };
  }
  // Test sessions: shrink the universe to one agent loaded from draft.
  const testing = opts.testAgentId !== undefined;
  const candidates: PlatformAgent[] = testing
    ? rows.filter((r) => r.agentId === opts.testAgentId)
    : rows.filter((r) => r.status === "deployed");
  const agents: Record<string, AgentDefinition> = {};

  for (const row of candidates) {
    const agentId = row.agentId;
    let def;
    try {
      def = loadAgentDef(agentId, { source: testing ? "draft" : "live" });
    } catch (err) {
      // For deployed agents: the creator flipped the agent to
      // `deployed` but the def on EFS is missing or malformed. For
      // test agents: the user clicked Test before saving anything.
      // Either way, skip rather than failing the supervisor turn.
      logCatch(rootLogger, "subagent.load_def.failed", err, { agentId });
      continue;
    }

    const mcpServers: AgentDefinition["mcpServers"] = [
      buildCustomToolsMcpEntry(agentId, def.defDir),
      ...buildCustomMcpEntries(agentId, [
        ...def.config.customMcps,
        ...loadMcpManifests(agentId, def.defDir),
      ]),
    ];

    agents[agentId] = {
      description:
        def.config.description ||
        row.description ||
        `Workspace agent ${def.config.name || row.name || agentId}`,
      prompt: def.systemPrompt + "\n" + scopeAppendix(agentId, def.defDir),
      // `tools: undefined` = SDK inherits the full supervisor toolset.
      // We deliberately ignore `def.config.tools.allow` here even if
      // the creator set it — empirically, having that as a strict
      // allowlist surprised users (a subagent built with one custom
      // tool ended up unable to Read or Bash). If we want a
      // restriction mechanism later, it should be opt-in via a
      // separate field (e.g. `tools.deny` or `tools.exclusive`)
      // rather than a footgun-by-default `allow`.
      tools: undefined,
      mcpServers,
      model: "inherit",
    };
  }

  rootLogger.info(
    {
      event: "subagent.map_built",
      deployedCount: candidates.length,
      registered: Object.keys(agents).length,
      testAgentId: opts.testAgentId,
    },
    "supervisor subagent map built",
  );

  return { agents, deployed: candidates };
}

/**
 * Render a short markdown list of the deployed agents for the
 * supervisor's system prompt. Empty string when there are no agents
 * — the caller should not append anything in that case.
 */
export function renderAgentsAppendix(deployed: PlatformAgent[]): string {
  if (deployed.length === 0) return "";
  const lines = [
    "",
    "## Specialised agents available",
    "",
    "Delegate to one of these via the `Task` tool (pick `subagent_type` = the id):",
    "",
  ];
  for (const row of deployed) {
    const desc = row.description || row.name || "(no description)";
    lines.push(`- \`${row.agentId}\` — **${row.name || row.agentId}**: ${desc}`);
  }
  return lines.join("\n");
}

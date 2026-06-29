/**
 * Unit tests for Phase 6 wiring:
 *   - buildSupervisorCanUseTool: dispatches between supervisor and
 *     per-subagent scopes based on the SDK's `options.agentID`.
 *   - buildSubagentMap: integrates platform-client → loadAgentDef →
 *     SDK AgentDefinition.
 *   - renderAgentsAppendix: deterministic markdown for the supervisor
 *     prompt.
 */

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Point AGENTS_ROOT at a tmp dir BEFORE importing anything that touches
// agent-def / subagents (both capture the constant at import time).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "subagent-test-"));
process.env.AGENTS_ROOT_OVERRIDE = TMP_ROOT;

const { buildSupervisorCanUseTool, buildCanUseTool, createSubagentRegistry } =
  await import("../src/sandbox.ts");
const { agentPaths } = await import("../src/agent-def.ts");
const {
  buildSubagentMap,
  renderAgentsAppendix,
} = await import("../src/subagents.ts");
const { platformClient } = await import("../src/platform-client.ts");

function uniqueAgentId(): string {
  return `agt_${randomBytes(5).toString("hex")}`;
}

/** Seed a full def/ on EFS for an agent. */
function seedAgent(opts: {
  prompt: string;
  config?: Record<string, unknown>;
}) {
  const agentId = uniqueAgentId();
  const paths = agentPaths(agentId);
  mkdirSync(paths.defDir, { recursive: true });
  mkdirSync(paths.workdir, { recursive: true });
  writeFileSync(paths.promptFile, opts.prompt);
  if (opts.config) {
    writeFileSync(paths.configFile, JSON.stringify(opts.config));
  }
  return { agentId, paths };
}

const FAKE_OPTS = {
  signal: new AbortController().signal,
  toolUseID: "tu-1",
};

// -----------------------------------------------------------------------------
// buildSupervisorCanUseTool
// -----------------------------------------------------------------------------

describe("buildSupervisorCanUseTool — routing by agentID", () => {
  const supervisorCwd = mkdtempSync(join(tmpdir(), "sup-scope-"));
  const subagentCwd = mkdtempSync(join(tmpdir(), "sub-scope-"));
  const subagentDef = mkdtempSync(join(tmpdir(), "sub-def-"));
  writeFileSync(join(supervisorCwd, "sup.txt"), "x");
  writeFileSync(join(subagentCwd, "scratch.txt"), "y");
  writeFileSync(join(subagentDef, "prompt.md"), "z");

  const known = "agt_known12345";
  const resolve = (id: string) => {
    if (id !== known) return null;
    return { cwd: subagentCwd, extraRead: [subagentDef] };
  };
  // Per-invocation handle the SDK uses on canUseTool. Distinct from
  // the agents-map key (`known`) — see SubagentRegistry comment in
  // sandbox.ts. Tests pre-populate the registry as if the SubagentStart
  // hook had already fired.
  const knownInvocation = "inv-known";
  const registry = createSubagentRegistry();
  registry.record(knownInvocation, known);
  const canUse = buildSupervisorCanUseTool(
    { cwd: supervisorCwd },
    resolve,
    registry,
  );

  it("uses the supervisor scope when agentID is absent", async () => {
    const r = await canUse(
      "Read",
      { file_path: join(supervisorCwd, "sup.txt") },
      FAKE_OPTS,
    );
    assert.equal(r.behavior, "allow");
  });

  it("denies supervisor reads into a subagent's tree", async () => {
    const r = await canUse(
      "Read",
      { file_path: join(subagentCwd, "scratch.txt") },
      FAKE_OPTS,
    );
    assert.equal(r.behavior, "deny");
  });

  it("swaps to the subagent scope when agentID is set", async () => {
    const r = await canUse(
      "Read",
      { file_path: join(subagentCwd, "scratch.txt") },
      { ...FAKE_OPTS, agentID: knownInvocation },
    );
    assert.equal(r.behavior, "allow");
  });

  it("allows the subagent to read its own def/ (extraRead)", async () => {
    const r = await canUse(
      "Read",
      { file_path: join(subagentDef, "prompt.md") },
      { ...FAKE_OPTS, agentID: knownInvocation },
    );
    assert.equal(r.behavior, "allow");
  });

  it("denies the subagent Write to its own def/ (read-only)", async () => {
    const r = await canUse(
      "Write",
      {
        file_path: join(subagentDef, "hack.md"),
        content: "nope",
      },
      { ...FAKE_OPTS, agentID: knownInvocation },
    );
    assert.equal(r.behavior, "deny");
  });

  it("falls through to allow when the agentID is unmapped", async () => {
    // The SDK uses its own short subagent IDs that don't match our
    // agents-map keys, so we can't reliably reject — workspace-level
    // isolation (gVisor + bash sandbox + EFS chroot) still applies.
    const r = await canUse(
      "Read",
      { file_path: join(subagentCwd, "scratch.txt") },
      { ...FAKE_OPTS, agentID: "agt_ghost00000" },
    );
    assert.equal(r.behavior, "allow");
  });

  it("prevents the subagent from escaping into the supervisor's cwd", async () => {
    const r = await canUse(
      "Read",
      { file_path: join(supervisorCwd, "sup.txt") },
      { ...FAKE_OPTS, agentID: knownInvocation },
    );
    assert.equal(r.behavior, "deny");
  });

  after(() => {
    rmSync(supervisorCwd, { recursive: true, force: true });
    rmSync(subagentCwd, { recursive: true, force: true });
    rmSync(subagentDef, { recursive: true, force: true });
  });
});

// -----------------------------------------------------------------------------
// buildSubagentMap
// -----------------------------------------------------------------------------

describe("buildSubagentMap", () => {
  it("skips draft agents", async () => {
    const seeded = seedAgent({
      prompt: "draft prompt",
      config: { name: "Draft", description: "d" },
    });
    const listMock = mock.method(platformClient, "listAgents", async () => [
      {
        agentId: seeded.agentId,
        name: "Draft",
        description: "d",
        status: "draft" as const,
      },
    ]);
    try {
      const { agents } = await buildSubagentMap();
      assert.equal(Object.keys(agents).length, 0);
    } finally {
      listMock.mock.restore();
    }
  });

  it("registers a deployed agent with the expected AgentDefinition shape", async () => {
    const seeded = seedAgent({
      prompt: "You are an expert at Asana.",
      config: {
        name: "Asana Tracker",
        description: "Tracks Asana tasks.",
        requiredSecrets: ["custom-asana-token"],
        tools: { allow: ["Read", "Bash"] },
      },
    });
    const listMock = mock.method(platformClient, "listAgents", async () => [
      {
        agentId: seeded.agentId,
        name: "Asana Tracker",
        description: "Tracks Asana tasks.",
        status: "deployed" as const,
      },
    ]);
    try {
      const { agents, deployed } = await buildSubagentMap();
      assert.equal(Object.keys(agents).length, 1);
      const def = agents[seeded.agentId];
      // Description carries through.
      assert.equal(def.description, "Tracks Asana tasks.");
      // Prompt = def/prompt.md + scope appendix containing workdir path.
      assert.ok(def.prompt.startsWith("You are an expert at Asana."));
      assert.ok(def.prompt.includes(seeded.paths.workdir));
      // The subagent always inherits the supervisor's full toolset —
      // `tools.allow` in config is ignored deliberately so creators
      // can't accidentally clamp a subagent down to one custom tool.
      // See subagents.ts for rationale.
      assert.equal(def.tools, undefined);
      // A custom-tools MCP is always attached so agent-specific scripts
      // are callable.
      assert.ok(def.mcpServers && def.mcpServers.length >= 1);
      const firstServer = def.mcpServers[0] as Record<string, unknown>;
      assert.ok(
        Object.keys(firstServer).some((k) =>
          k.includes(`agent-${seeded.agentId}-tools`),
        ),
      );
      // deployed array mirrors what listAgents returned.
      assert.equal(deployed.length, 1);
      assert.equal(deployed[0].agentId, seeded.agentId);
    } finally {
      listMock.mock.restore();
    }
  });

  it("skips a deployed agent whose prompt.md is missing", async () => {
    // Claim an agentId that was never scaffolded on EFS.
    const ghostId = uniqueAgentId();
    const listMock = mock.method(platformClient, "listAgents", async () => [
      {
        agentId: ghostId,
        name: "Ghost",
        status: "deployed" as const,
      },
    ]);
    try {
      const { agents } = await buildSubagentMap();
      assert.equal(Object.keys(agents).length, 0);
    } finally {
      listMock.mock.restore();
    }
  });

  it("returns an empty map (not a throw) when platform API fails", async () => {
    const listMock = mock.method(platformClient, "listAgents", async () => {
      throw new Error("platform down");
    });
    try {
      const { agents, deployed } = await buildSubagentMap();
      assert.deepEqual(agents, {});
      assert.deepEqual(deployed, []);
    } finally {
      listMock.mock.restore();
    }
  });
});

// -----------------------------------------------------------------------------
// renderAgentsAppendix
// -----------------------------------------------------------------------------

describe("renderAgentsAppendix", () => {
  it("returns empty string when nothing is deployed", () => {
    assert.equal(renderAgentsAppendix([]), "");
  });

  it("renders a markdown list referencing each agent's id + name + desc", () => {
    const out = renderAgentsAppendix([
      {
        agentId: "agt_aaaaaaaaaa",
        name: "Alpha",
        description: "does alpha things",
        status: "deployed",
      },
      {
        agentId: "agt_bbbbbbbbbb",
        name: "Beta",
        description: "",
        status: "deployed",
      },
    ]);
    assert.ok(out.includes("## Specialised agents"));
    assert.ok(out.includes("`agt_aaaaaaaaaa`"));
    assert.ok(out.includes("Alpha"));
    assert.ok(out.includes("does alpha things"));
    assert.ok(out.includes("`agt_bbbbbbbbbb`"));
  });
});

// Final cleanup for TMP_ROOT (seeded agents land here).
after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

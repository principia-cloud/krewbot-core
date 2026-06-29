/**
 * Unit tests for the agent-def loader (src/agent-def.ts).
 *
 * Points AGENTS_ROOT at a throwaway tmp dir before importing the
 * module under test. AGENTS_ROOT is captured once at module load, so
 * the env override MUST be set in this file before any import of
 * agent-def.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Redirect AGENTS_ROOT to a tmp dir BEFORE importing agent-def.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "agent-def-test-"));
process.env.AGENTS_ROOT_OVERRIDE = TMP_ROOT;

const { loadAgentDef, agentPaths, AGENTS_ROOT } = await import(
  "../src/agent-def.ts"
);

function uniqueAgentId(): string {
  return `agt_${randomBytes(5).toString("hex")}`;
}

/** Create a fake agent on EFS. Returns agentId + cleanup fn. */
function seedAgent(opts: {
  prompt?: string;
  config?: string; // raw JSON string, null for omitted file
  createConfig?: boolean;
}): { agentId: string; cleanup: () => void } {
  const agentId = uniqueAgentId();
  const paths = agentPaths(agentId);
  mkdirSync(paths.defDir, { recursive: true });
  mkdirSync(paths.workdir, { recursive: true });
  if (opts.prompt !== undefined) {
    writeFileSync(paths.promptFile, opts.prompt);
  }
  if (opts.createConfig && opts.config !== undefined) {
    writeFileSync(paths.configFile, opts.config);
  }
  return {
    agentId,
    cleanup: () => rmSync(paths.root, { recursive: true, force: true }),
  };
}

describe("loadAgentDef — happy paths", () => {
  const cleanups: Array<() => void> = [];
  after(() => {
    for (const c of cleanups) c();
  });

  it("returns a full AgentDef when both prompt.md and config.json are present", () => {
    const seeded = seedAgent({
      prompt: "You are an assistant.",
      config: JSON.stringify({
        name: "Test Agent",
        description: "A test.",
        requiredSecrets: ["notion-token"],
        tools: { allow: ["Read", "Bash"] },
        customMcps: [],
      }),
      createConfig: true,
    });
    cleanups.push(seeded.cleanup);

    const def = loadAgentDef(seeded.agentId);
    assert.equal(def.systemPrompt, "You are an assistant.");
    assert.equal(def.config.name, "Test Agent");
    assert.equal(def.config.description, "A test.");
    assert.deepEqual(def.config.requiredSecrets, ["notion-token"]);
    assert.equal(def.defDir, `${AGENTS_ROOT}/${seeded.agentId}/def`);
    assert.equal(def.workdir, `${AGENTS_ROOT}/${seeded.agentId}/workdir`);
  });

  it("defaults config fields when config.json is absent", () => {
    const seeded = seedAgent({
      prompt: "Prompt only.",
      // No config.json at all.
    });
    cleanups.push(seeded.cleanup);

    const def = loadAgentDef(seeded.agentId);
    assert.equal(def.systemPrompt, "Prompt only.");
    assert.equal(def.config.name, "");
    assert.equal(def.config.description, "");
    assert.deepEqual(def.config.requiredSecrets, []);
    assert.deepEqual(def.config.customMcps, []);
  });

  it("coerces junk values in config.json to safe defaults", () => {
    const seeded = seedAgent({
      prompt: "x",
      createConfig: true,
      config: JSON.stringify({
        name: 42, // wrong type
        description: null, // wrong type
        requiredSecrets: ["ok", 123, null, "also-ok"], // mixed; non-strings dropped
        tools: "not a dict",
        customMcps: "not a list",
      }),
    });
    cleanups.push(seeded.cleanup);

    const def = loadAgentDef(seeded.agentId);
    assert.equal(def.config.name, "");
    assert.equal(def.config.description, "");
    // Only strings survive the filter.
    assert.deepEqual(def.config.requiredSecrets, ["ok", "also-ok"]);
    assert.deepEqual(def.config.tools, {});
    assert.deepEqual(def.config.customMcps, []);
  });
});

describe("loadAgentDef — failure modes", () => {
  it("throws when prompt.md is missing", () => {
    const agentId = uniqueAgentId();
    // Don't seed anything.
    assert.throws(() => loadAgentDef(agentId), /no prompt\.md/);
  });

  it("throws when config.json is malformed JSON", () => {
    const seeded = seedAgent({
      prompt: "x",
      createConfig: true,
      config: "{not valid json",
    });
    try {
      assert.throws(() => loadAgentDef(seeded.agentId), SyntaxError);
    } finally {
      seeded.cleanup();
    }
  });
});

describe("agentPaths", () => {
  it("is pure — same input returns identical paths", () => {
    const p1 = agentPaths("agt_1234567890");
    const p2 = agentPaths("agt_1234567890");
    assert.deepEqual(p1, p2);
  });

  it("isolates different agentIds", () => {
    const a = agentPaths("agt_1111111111");
    const b = agentPaths("agt_2222222222");
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.defDir, b.defDir);
    assert.notEqual(a.workdir, b.workdir);
    assert.notEqual(a.creatorHome, b.creatorHome);
  });

  it("roots under AGENTS_ROOT (which points at the tmp dir for tests)", () => {
    const p = agentPaths("agt_abcdef0123");
    assert.ok(p.root.startsWith(AGENTS_ROOT));
  });
});

// Final cleanup of the shared TMP_ROOT happens once, after every
// describe's `after` fixture has run.
after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

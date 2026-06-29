/**
 * Unit tests for the creator-session dispatch bits added for the Agent
 * Creator feature. Scope:
 *   - parseCreatorSessionKey: session-key pattern recognition.
 *   - agentPaths: paths derivable from agentId.
 *   - buildCanUseTool with the new SandboxScope shape: dual-root
 *     read/write confinement.
 *
 * No network or EFS — pure unit tests using tmp-dir fixtures.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCreatorSessionKey } from "../src/agent.ts";
import { agentPaths, AGENTS_ROOT } from "../src/agent-def.ts";
import {
  buildCanUseTool,
  isBackgroundBashCall,
  buildBashBackgroundPreToolUseHook,
  BASH_BG_DENY_MESSAGE,
} from "../src/sandbox.ts";
import { rootLogger } from "../src/logger.ts";

describe("parseCreatorSessionKey", () => {
  it("returns the agentId for a well-formed creator key", () => {
    assert.equal(
      parseCreatorSessionKey("creator/agent/agt_abc1234567"),
      "agt_abc1234567",
    );
  });

  it("returns null for non-creator prefixes", () => {
    assert.equal(parseCreatorSessionKey("http/user123/sess"), null);
    assert.equal(parseCreatorSessionKey("telegram/dm/12345"), null);
    assert.equal(parseCreatorSessionKey("bg/parent/child"), null);
    assert.equal(parseCreatorSessionKey("http/system-cron/daily"), null);
  });

  it("returns null when the agentId is malformed", () => {
    // Wrong prefix
    assert.equal(parseCreatorSessionKey("creator/agent/not-an-agent"), null);
    // Too short / too long
    assert.equal(parseCreatorSessionKey("creator/agent/agt_abc"), null);
    assert.equal(parseCreatorSessionKey("creator/agent/agt_abc12345678"), null);
    // Non-hex
    assert.equal(parseCreatorSessionKey("creator/agent/agt_ZZZZZZZZZZ"), null);
  });

  it("returns null when the shape is wrong (wrong segment count)", () => {
    assert.equal(parseCreatorSessionKey("creator/agent"), null);
    assert.equal(parseCreatorSessionKey("creator/agent/agt_abc1234567/extra"), null);
  });
});

describe("agentPaths", () => {
  it("places def/, workdir/, and .creator-home under /data/agents/{id}/", () => {
    const p = agentPaths("agt_abc1234567");
    assert.equal(p.root, `${AGENTS_ROOT}/agt_abc1234567`);
    assert.equal(p.defDir, `${AGENTS_ROOT}/agt_abc1234567/def`);
    assert.equal(p.workdir, `${AGENTS_ROOT}/agt_abc1234567/workdir`);
    assert.equal(p.promptFile, `${AGENTS_ROOT}/agt_abc1234567/def/prompt.md`);
    assert.equal(p.configFile, `${AGENTS_ROOT}/agt_abc1234567/def/config.json`);
    // creator-home sits alongside def/ (not under it) so it's not part
    // of the agent's shipped definition.
    assert.equal(p.creatorHome, `${AGENTS_ROOT}/agt_abc1234567/.creator-home`);
  });
});

describe("buildCanUseTool — dual-root (runtime-agent scope)", () => {
  // Fake scope: cwd is writable workdir, def is read-only.
  // We seed real tmp dirs so realpath() resolves cleanly.
  const root = mkdtempSync(join(tmpdir(), "sandbox-scope-test-"));
  const cwd = join(root, "workdir");
  const defDir = join(root, "def");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(defDir, { recursive: true });
  writeFileSync(join(cwd, "scratch.txt"), "x");
  writeFileSync(join(defDir, "prompt.md"), "y");

  const canUse = buildCanUseTool({ cwd, extraRead: [defDir] });
  const opts = {
    signal: new AbortController().signal,
    toolUseID: "t1",
  };

  it("allows Read on a file inside the writable workdir", async () => {
    const r = await canUse("Read", { file_path: join(cwd, "scratch.txt") }, opts);
    assert.equal(r.behavior, "allow");
  });

  it("allows Read on a file inside the read-only def/ root", async () => {
    const r = await canUse("Read", { file_path: join(defDir, "prompt.md") }, opts);
    assert.equal(r.behavior, "allow");
  });

  it("denies Write to the read-only def/ root", async () => {
    const r = await canUse(
      "Write",
      { file_path: join(defDir, "forbidden.txt"), content: "no" },
      opts,
    );
    assert.equal(r.behavior, "deny");
  });

  it("allows Write inside the writable workdir", async () => {
    const r = await canUse(
      "Write",
      { file_path: join(cwd, "new.txt"), content: "ok" },
      opts,
    );
    assert.equal(r.behavior, "allow");
  });

  it("denies Read outside both roots", async () => {
    const r = await canUse("Read", { file_path: "/etc/passwd" }, opts);
    assert.equal(r.behavior, "deny");
  });

  it("allows Bash through canUseTool regardless of run_in_background", async () => {
    // run_in_background is denied by the PreToolUse hook, NOT canUseTool —
    // the CLI bypasses canUseTool for backgrounded Bash, so denying here
    // is dead weight. canUseTool only does fs-path confinement.
    const fg = await canUse("Bash", { command: "echo hi" }, opts);
    assert.equal(fg.behavior, "allow");
    const bg = await canUse(
      "Bash",
      { command: "sleep 300", run_in_background: true },
      opts,
    );
    assert.equal(bg.behavior, "allow");
  });

  it("accepts a bare-string scope (backwards-compatible single root)", async () => {
    const bare = buildCanUseTool(cwd);
    const r = await bare("Read", { file_path: join(cwd, "scratch.txt") }, opts);
    assert.equal(r.behavior, "allow");
    const r2 = await bare("Read", { file_path: join(defDir, "prompt.md") }, opts);
    assert.equal(r2.behavior, "deny");
  });

  // Cleanup has to be an `after` hook, not a synchronous call in the
  // describe body — node:test runs the body first to register tests,
  // THEN runs the tests, so a bare rmSync at this point wipes the
  // fixtures before any `it(...)` executes.
  after(() => rmSync(root, { recursive: true, force: true }));
});

describe("buildCanUseTool — creator scope (single root)", () => {
  // Creator confines to def/ only (no extraRead). Read+write both work
  // inside def/; everything else is denied.
  const root = mkdtempSync(join(tmpdir(), "creator-scope-test-"));
  const defDir = join(root, "agt_abc1234567", "def");
  const workdir = join(root, "agt_abc1234567", "workdir");
  mkdirSync(defDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(defDir, "prompt.md"), "creator wrote this");

  const canUse = buildCanUseTool({ cwd: defDir });
  const opts = {
    signal: new AbortController().signal,
    toolUseID: "t1",
  };

  it("allows Read+Write inside def/", async () => {
    assert.equal(
      (await canUse("Read", { file_path: join(defDir, "prompt.md") }, opts)).behavior,
      "allow",
    );
    assert.equal(
      (await canUse("Write", { file_path: join(defDir, "config.json"), content: "{}" }, opts))
        .behavior,
      "allow",
    );
  });

  it("denies access to the sibling workdir/ (not in scope)", async () => {
    assert.equal(
      (await canUse("Read", { file_path: join(workdir, "anything") }, opts)).behavior,
      "deny",
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});

describe("isBackgroundBashCall", () => {
  it("is true only for Bash with run_in_background === true", () => {
    assert.equal(isBackgroundBashCall("Bash", { run_in_background: true }), true);
    assert.equal(isBackgroundBashCall("Bash", { command: "x", run_in_background: true }), true);
  });
  it("is false for foreground Bash and non-Bash tools", () => {
    assert.equal(isBackgroundBashCall("Bash", { command: "x" }), false);
    assert.equal(isBackgroundBashCall("Bash", { run_in_background: false }), false);
    assert.equal(isBackgroundBashCall("Bash", { run_in_background: "true" }), false);
    assert.equal(isBackgroundBashCall("Read", { run_in_background: true }), false);
    assert.equal(isBackgroundBashCall("Bash", null), false);
    assert.equal(isBackgroundBashCall("Bash", undefined), false);
  });
});

describe("buildBashBackgroundPreToolUseHook", () => {
  const hook = buildBashBackgroundPreToolUseHook(rootLogger, { cwd: "/x" });
  const noop = { signal: new AbortController().signal };

  it("denies a backgrounded Bash with the spawn_background_task message", async () => {
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep 30", run_in_background: true },
        tool_use_id: "t1",
      } as never,
      "t1",
      noop as never,
    );
    const o = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    assert.equal(o?.permissionDecision, "deny");
    assert.equal(o?.permissionDecisionReason, BASH_BG_DENY_MESSAGE);
    assert.match(String(o?.permissionDecisionReason), /spawn_background_task/);
  });

  it("is a no-op for foreground Bash and non-PreToolUse events", async () => {
    const fg = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_use_id: "t2",
      } as never,
      "t2",
      noop as never,
    );
    assert.deepEqual(fg, {});
    const other = await hook(
      { hook_event_name: "PostToolUse" } as never,
      undefined,
      noop as never,
    );
    assert.deepEqual(other, {});
  });
});

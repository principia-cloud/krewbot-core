/**
 * L2: the agent-def file routes (readAgentRoot / readAgentDefFile) only
 * checked the path lexically, so a symlink planted inside def-draft/ that
 * points at /config/secrets/* would be followed by readFileSync. The
 * symlinkEscapes() guard realpaths the target and re-checks containment.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { symlinkEscapes } from "../src/routes/files.ts";

const ROOT = mkdtempSync(join(tmpdir(), "adef-"));
const agentDir = join(ROOT, "def-draft");
const outside = join(ROOT, "secrets");
mkdirSync(agentDir, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(agentDir, "prompt.md"), "hi");
writeFileSync(join(outside, "claude-token"), "sk-ant-secret");
// A symlink inside def-draft/ pointing at the outside secret.
symlinkSync(join(outside, "claude-token"), join(agentDir, "leak"));

after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("symlinkEscapes", () => {
  it("allows a real file inside the dir", () => {
    assert.equal(symlinkEscapes(join(agentDir, "prompt.md"), agentDir), false);
  });

  it("blocks a symlink that resolves outside the dir", () => {
    assert.equal(symlinkEscapes(join(agentDir, "leak"), agentDir), true);
  });

  it("treats a nonexistent path as non-escaping (caller 404s)", () => {
    assert.equal(symlinkEscapes(join(agentDir, "nope.md"), agentDir), false);
  });

  it("allows the dir itself", () => {
    assert.equal(symlinkEscapes(agentDir, agentDir), false);
  });
});

/**
 * Unit tests for agent-sweeper.ts.
 *
 * The sweeper calls platformClient.listAgents() then rm's EFS dirs for
 * any row with status=deletion_pending. We mock the platform call and
 * seed fake agent dirs under a tmp AGENTS_ROOT to verify the rules:
 *   - deletion_pending row with an existing dir → removed.
 *   - deletion_pending row with no dir → no-op, no throw.
 *   - deployed / draft rows → untouched.
 *   - platform API failure → skipped, no throw.
 *   - Missing row (EFS dir exists but no DDB entry) → SKIPPED
 *     (we don't rm orphans; that's by design).
 */

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "agent-sweeper-test-"));
process.env.AGENTS_ROOT_OVERRIDE = TMP_ROOT;

const { sweepPendingAgentDeletes } = await import("../src/agent-sweeper.ts");
const { agentPaths } = await import("../src/agent-def.ts");
const { platformClient } = await import("../src/platform-client.ts");

/** Seed an agent dir on disk. Returns the absolute root path. */
function seedDir(agentId: string): string {
  const { root } = agentPaths(agentId);
  mkdirSync(join(root, "def"), { recursive: true });
  writeFileSync(join(root, "def", "prompt.md"), "x");
  return root;
}

describe("sweepPendingAgentDeletes", () => {
  it("removes EFS dirs for deletion_pending rows", async () => {
    const pendingId = "agt_pend111111";
    const aliveId = "agt_live111111";
    const pendingRoot = seedDir(pendingId);
    const aliveRoot = seedDir(aliveId);

    const mockList = mock.method(platformClient, "listAgents", async () => [
      { agentId: pendingId, name: "p", status: "deletion_pending" as const },
      { agentId: aliveId, name: "a", status: "deployed" as const },
    ]);
    try {
      const result = await sweepPendingAgentDeletes();
      assert.equal(result.scanned, 1);
      assert.equal(result.removed, 1);
      assert.equal(result.failed, 0);
      assert.ok(!existsSync(pendingRoot));
      assert.ok(existsSync(aliveRoot));
    } finally {
      mockList.mock.restore();
      rmSync(aliveRoot, { recursive: true, force: true });
    }
  });

  it("no-ops when the dir is already gone (idempotent)", async () => {
    const pendingId = "agt_gone1111aa";
    // Note: NOT seeding a dir — row says delete but no dir on disk.
    const mockList = mock.method(platformClient, "listAgents", async () => [
      { agentId: pendingId, name: "g", status: "deletion_pending" as const },
    ]);
    try {
      const result = await sweepPendingAgentDeletes();
      assert.equal(result.scanned, 1);
      assert.equal(result.removed, 0);
      assert.equal(result.failed, 0);
    } finally {
      mockList.mock.restore();
    }
  });

  it("leaves draft and deployed rows untouched", async () => {
    const draftId = "agt_draft1111b";
    const deployedId = "agt_deploy1111";
    const draftRoot = seedDir(draftId);
    const deployedRoot = seedDir(deployedId);

    const mockList = mock.method(platformClient, "listAgents", async () => [
      { agentId: draftId, name: "d", status: "draft" as const },
      { agentId: deployedId, name: "v", status: "deployed" as const },
    ]);
    try {
      const result = await sweepPendingAgentDeletes();
      assert.equal(result.scanned, 0);
      assert.equal(result.removed, 0);
      assert.ok(existsSync(draftRoot));
      assert.ok(existsSync(deployedRoot));
    } finally {
      mockList.mock.restore();
      rmSync(draftRoot, { recursive: true, force: true });
      rmSync(deployedRoot, { recursive: true, force: true });
    }
  });

  it("does NOT remove orphan dirs (rows missing from DDB)", async () => {
    // Seed a dir that has no DDB row at all — production contract is
    // "only rm when status=deletion_pending", to avoid wiping a
    // legitimately-scaffolded agent whose DDB write races the sweeper.
    const orphanId = "agt_orphan1111";
    const orphanRoot = seedDir(orphanId);
    const mockList = mock.method(platformClient, "listAgents", async () => []);
    try {
      const result = await sweepPendingAgentDeletes();
      assert.equal(result.scanned, 0);
      assert.equal(result.removed, 0);
      // Orphan survives.
      assert.ok(existsSync(orphanRoot));
    } finally {
      mockList.mock.restore();
      rmSync(orphanRoot, { recursive: true, force: true });
    }
  });

  it("doesn't throw when platform API fails", async () => {
    const mockList = mock.method(platformClient, "listAgents", async () => {
      throw new Error("platform down");
    });
    try {
      const result = await sweepPendingAgentDeletes();
      assert.deepEqual(result, { scanned: 0, removed: 0, failed: 0 });
    } finally {
      mockList.mock.restore();
    }
  });
});

after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

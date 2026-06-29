/**
 * Tests for the Tasks route serializers (routes/tasks.ts) — the pure
 * shaping/privacy layer between the in-memory registries and the Tasks
 * UI. Registries themselves are exercised via the deployed e2e flow;
 * these tests pin the wire contract: clamping, ordering, caps, and the
 * foreground privacy gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampSnapshot,
  serializeForeground,
  serializeBgActive,
  serializeBgRecent,
} from "../src/routes/tasks.ts";
import type { BackgroundSnapshot, TurnQueueInspection } from "../src/agent.ts";
import type { BgActiveEntry, BgHistoryEntry } from "../src/bg-types.ts";

const NOW = 1_760_000_000_000;

function snap(text: string, trailNames: string[] = []): BackgroundSnapshot {
  return {
    assistantText: text,
    toolCallTrail: trailNames.map((name, i) => ({ name, summary: `${name} args`, ts: NOW - 1000 + i })),
  };
}

function bgEntry(over: Partial<BgActiveEntry> = {}): BgActiveEntry {
  return {
    taskId: "task-1",
    abort: new AbortController(),
    startedAt: NOW - 60_000,
    prompt: "do the thing",
    parentSessionKey: "http/owner-sub/sess-1",
    parentAdapter: "web",
    parentThreadId: "t-1",
    snapshot: snap("working..."),
    ...over,
  };
}

function historyEntry(over: Partial<BgHistoryEntry> = {}): BgHistoryEntry {
  return {
    taskId: "done-1",
    startedAt: NOW - 120_000,
    endedAt: NOW - 60_000,
    prompt: "finished thing",
    parentSessionKey: "http/owner-sub/sess-1",
    parentAdapter: "telegram",
    parentThreadId: "t-2",
    finalReply: "all done",
    snapshot: snap("done"),
    stoppedBy: { by: "natural", at: NOW - 60_000 },
    ...over,
  };
}

describe("clampSnapshot", () => {
  it("returns short snapshots unchanged", () => {
    const s = snap("short", ["Bash"]);
    assert.equal(clampSnapshot(s), s);
  });

  it("keeps the TAIL of long assistant text", () => {
    const s = snap("x".repeat(5000) + "THE-END");
    const clamped = clampSnapshot(s, 4000);
    assert.equal(clamped.assistantText.length, 4000);
    assert.ok(clamped.assistantText.endsWith("THE-END"));
    assert.equal(clamped.toolCallTrail, s.toolCallTrail);
  });
});

describe("serializeForeground", () => {
  const insp: TurnQueueInspection = {
    active: [
      { id: "a", source: "http", startedAt: NOW - 5000, sessionKey: "http/owner-sub/sess-1", snapshot: snap("mine") },
      { id: "b", source: "http", startedAt: NOW - 6000, sessionKey: "http/other-sub/sess-9", snapshot: snap("theirs") },
      { id: "c", source: "cron", jobName: "daily", startedAt: NOW - 7000, sessionKey: "http/system-cron/daily", snapshot: snap("cron work") },
      { id: "d", source: "webhook", adapterName: "telegram", startedAt: NOW - 8000, sessionKey: "webhook/telegram/123", snapshot: snap("tg work") },
    ],
    waiting: [
      { id: "w1", source: "cron", coalesceKey: "cron:daily", enqueuedAt: NOW - 2000, sessionKey: "http/system-cron/daily" },
    ],
  };

  it("includes snapshot for the owner's own web turn and flags isMine", () => {
    const { active } = serializeForeground(insp, "owner-sub", NOW);
    const mine = active.find((t) => t.id === "a")!;
    assert.equal(mine.isMine, true);
    assert.equal(mine.snapshot?.assistantText, "mine");
    assert.equal(mine.ageMs, 5000);
  });

  it("hides another member's web-chat snapshot", () => {
    const { active } = serializeForeground(insp, "owner-sub", NOW);
    const theirs = active.find((t) => t.id === "b")!;
    assert.equal(theirs.isMine, false);
    assert.equal(theirs.snapshot, undefined);
  });

  it("always includes shared-channel (cron/webhook) snapshots", () => {
    const { active } = serializeForeground(insp, "owner-sub", NOW);
    assert.equal(active.find((t) => t.id === "c")!.snapshot?.assistantText, "cron work");
    assert.equal(active.find((t) => t.id === "c")!.jobName, "daily");
    assert.equal(active.find((t) => t.id === "d")!.snapshot?.assistantText, "tg work");
    assert.equal(active.find((t) => t.id === "d")!.adapterName, "telegram");
  });

  it("does not treat sub prefixes as ownership", () => {
    // "owner-sub" must not own "owner-sub-2"'s session.
    const tricky: TurnQueueInspection = {
      active: [{ id: "x", source: "http", startedAt: NOW, sessionKey: "http/owner-sub-2/sess", snapshot: snap("nope") }],
      waiting: [],
    };
    const { active } = serializeForeground(tricky, "owner-sub", NOW);
    assert.equal(active[0].isMine, false);
    assert.equal(active[0].snapshot, undefined);
  });

  it("computes waitedMs for waiting entries", () => {
    const { waiting } = serializeForeground(insp, "owner-sub", NOW);
    assert.equal(waiting[0].waitedMs, 2000);
    assert.equal(waiting[0].coalesceKey, "cron:daily");
  });
});

describe("serializeBgActive", () => {
  it("clamps promptPreview to 140 chars and computes ageMs", () => {
    const [out] = serializeBgActive([bgEntry({ prompt: "p".repeat(500) })], NOW);
    assert.equal(out.promptPreview.length, 140);
    assert.equal(out.ageMs, 60_000);
    assert.equal(out.parentAdapter, "web");
  });

  it("does not leak abort controller or sessionKey", () => {
    const [out] = serializeBgActive([bgEntry()], NOW);
    assert.equal("abort" in out, false);
    assert.equal("parentSessionKey" in out, false);
  });
});

describe("serializeBgRecent", () => {
  it("orders newest-first and caps at 20", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      historyEntry({ taskId: `t-${i}`, endedAt: NOW - i * 1000 }),
    );
    // Feed in oldest-first to prove sorting happens here.
    const out = serializeBgRecent(entries.slice().reverse());
    assert.equal(out.length, 20);
    assert.equal(out[0].taskId, "t-0");
    assert.equal(out[19].taskId, "t-19");
  });

  it("clamps finalReplyPreview to 500 chars and computes duration", () => {
    const [out] = serializeBgRecent([historyEntry({ finalReply: "r".repeat(2000) })]);
    assert.equal(out.finalReplyPreview.length, 500);
    assert.equal(out.durationMs, 60_000);
    assert.equal(out.stoppedBy.by, "natural");
  });
});

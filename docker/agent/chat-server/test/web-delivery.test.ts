/**
 * Unit tests for web-delivery.ts — out-of-band message delivery to a web
 * (HTTP) session's transcript side-file. This is the sink for both a
 * finished background task's reply AND a mid-task `chat_send` from a
 * web-originated bg task (handleInternalChatSend's adapter==="web"
 * branch). Pins the writer↔reader contract with routes/messages.ts:
 * readBgReplies, and the session-key parsing in webSessionDir.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendWebSessionMessage,
  webSessionDir,
  BG_REPLY_FILE,
} from "../src/web-delivery.ts";
import { readBgReplies } from "../src/routes/messages.ts";

describe("appendWebSessionMessage", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-delivery-test-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a record readBgReplies parses back as an assistant message", () => {
    assert.equal(appendWebSessionMessage(dir, "count: 1"), true);
    const out = readBgReplies(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].type, "text");
    assert.equal(out[0].content, "count: 1");
    assert.ok(out[0].timestamp);
  });

  it("appends incrementally (mid-task chat_sends accumulate in order)", () => {
    appendWebSessionMessage(dir, "count: 2");
    appendWebSessionMessage(dir, "count: 3");
    const out = readBgReplies(dir);
    assert.deepEqual(
      out.map((m) => m.content),
      ["count: 1", "count: 2", "count: 3"],
    );
  });

  it("writes to the documented side-file name", () => {
    assert.ok(fs.existsSync(path.join(dir, BG_REPLY_FILE)));
  });

  it("returns false when the session dir is unwritable", () => {
    // A path whose parent doesn't exist → appendFileSync throws ENOENT.
    const bogus = path.join(dir, "does", "not", "exist");
    assert.equal(appendWebSessionMessage(bogus, "x"), false);
  });
});

describe("webSessionDir", () => {
  it("resolves a well-formed http session key to a dir under that user", () => {
    const d = webSessionDir("http/user-abc/sess-123");
    assert.ok(d, "expected a resolved dir");
    assert.match(d as string, /user-abc[/\\]sess-123$/);
  });

  it("returns null for non-http or malformed keys", () => {
    assert.equal(webSessionDir("telegram/dm/12345"), null);
    assert.equal(webSessionDir("bg/some-task-id"), null);
    assert.equal(webSessionDir("creator/agent/agt_abc1234567"), null);
    assert.equal(webSessionDir("http/only-two"), null);
    assert.equal(webSessionDir("http/a/b/c"), null);
  });

  it("returns null for a traversal session id (per-member boundary)", () => {
    assert.equal(webSessionDir("http/user-abc/../other"), null);
  });
});

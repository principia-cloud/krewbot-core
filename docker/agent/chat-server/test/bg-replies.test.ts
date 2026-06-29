/**
 * Unit tests for the background-task reply side-file reader.
 *
 * The web (HTTP) channel has no chat adapter to postMessage into, so a
 * finished background task's reply is appended to a per-session
 * `.bg-replies.jsonl` by index.ts:deliverWebBgReply and merged back into
 * the transcript by routes/messages.ts:readBgReplies on the next
 * load/poll. These two halves share a JSONL record shape
 * (`{ content, timestamp, taskId }`) defined in two files — this test
 * pins that contract so reader and writer can't silently drift apart.
 *
 * Run via the `test` package.json script.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readBgReplies } from "../src/routes/messages.js";

const BG_REPLY_FILE = ".bg-replies.jsonl";

/** Build a line exactly the way index.ts:deliverWebBgReply writes it, so
 * a change to that record shape breaks this test. */
function writerLine(content: string, timestamp: string, taskId: string): string {
  return JSON.stringify({ content, timestamp, taskId }) + "\n";
}

describe("readBgReplies", () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bg-replies-test-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] when the side-file doesn't exist", () => {
    const dir = path.join(tmp, "none");
    fs.mkdirSync(dir, { recursive: true });
    assert.deepEqual(readBgReplies(dir), []);
  });

  it("parses writer-shaped records into assistant text messages", () => {
    const dir = path.join(tmp, "one");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, BG_REPLY_FILE),
      writerLine("done — here is the result", "2026-05-28T10:00:00.000Z", "abc12345"),
    );

    const out = readBgReplies(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].type, "text");
    assert.equal(out[0].content, "done — here is the result");
    assert.equal(out[0].timestamp, "2026-05-28T10:00:00.000Z");
  });

  it("reads multiple appended records in file order", () => {
    const dir = path.join(tmp, "many");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, BG_REPLY_FILE), writerLine("first", "2026-05-28T10:00:00.000Z", "t1"));
    fs.appendFileSync(path.join(dir, BG_REPLY_FILE), writerLine("second", "2026-05-28T11:00:00.000Z", "t2"));

    const out = readBgReplies(dir);
    assert.deepEqual(
      out.map((m) => m.content),
      ["first", "second"],
    );
  });

  it("skips blank and unparseable lines without throwing", () => {
    const dir = path.join(tmp, "messy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, BG_REPLY_FILE),
      "\n" +
        "{not json\n" +
        writerLine("survivor", "2026-05-28T12:00:00.000Z", "t3") +
        "   \n",
    );

    const out = readBgReplies(dir);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, "survivor");
  });

  it("ignores records missing content or timestamp", () => {
    const dir = path.join(tmp, "partial");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, BG_REPLY_FILE),
      JSON.stringify({ content: "no ts", taskId: "t4" }) + "\n" +
        JSON.stringify({ timestamp: "2026-05-28T13:00:00.000Z", taskId: "t5" }) + "\n",
    );
    assert.deepEqual(readBgReplies(dir), []);
  });
});

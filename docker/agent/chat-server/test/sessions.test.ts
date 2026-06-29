/**
 * Unit tests for the HTTP session cap helpers. Run with:
 *   npm run build && node --test dist-test/test/sessions.test.js
 * or via the `test` package.json script.
 *
 * These don't exercise the full createSession handler (that needs fs +
 * http.ServerResponse fixtures); they cover the pure pieces that decide
 * "do we hit 429 right now". Those are the parts that actually fail in
 * interesting ways — the mkdir/writeFileSync below them is boring.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  countHttpSessions,
  isHttpSessionCapEnforced,
  HTTP_SESSION_CAP,
} from "../src/routes/sessions.js";

describe("countHttpSessions", () => {
  let tmp: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 0 when the root doesn't exist", () => {
    assert.equal(countHttpSessions(path.join(tmp, "nope")), 0);
  });

  it("returns 0 when the root exists but has no users", () => {
    const root = path.join(tmp, "empty");
    fs.mkdirSync(root, { recursive: true });
    assert.equal(countHttpSessions(root), 0);
  });

  it("counts session dirs across multiple users", () => {
    const root = path.join(tmp, "multi");
    fs.mkdirSync(path.join(root, "user-a", "sess-1"), { recursive: true });
    fs.mkdirSync(path.join(root, "user-a", "sess-2"), { recursive: true });
    fs.mkdirSync(path.join(root, "user-b", "sess-3"), { recursive: true });
    assert.equal(countHttpSessions(root), 3);
  });

  it("ignores files at the session level (only dirs count as sessions)", () => {
    const root = path.join(tmp, "files");
    fs.mkdirSync(path.join(root, "user-a"), { recursive: true });
    fs.writeFileSync(path.join(root, "user-a", "stray.txt"), "");
    fs.mkdirSync(path.join(root, "user-a", "real-session"));
    assert.equal(countHttpSessions(root), 1);
  });
});

describe("isHttpSessionCapEnforced", () => {
  // Driven by PLATFORM_ENV so the chat-server doesn't depend on a
  // specific domain string. Test all three branches.
  const originalEnv = process.env.PLATFORM_ENV;
  after(() => {
    if (originalEnv === undefined) delete process.env.PLATFORM_ENV;
    else process.env.PLATFORM_ENV = originalEnv;
  });

  it("is enforced when PLATFORM_ENV is prod", () => {
    process.env.PLATFORM_ENV = "prod";
    assert.equal(isHttpSessionCapEnforced(), true);
  });

  it("is not enforced on beta", () => {
    process.env.PLATFORM_ENV = "beta";
    assert.equal(isHttpSessionCapEnforced(), false);
  });

  it("is not enforced when PLATFORM_ENV is unset", () => {
    delete process.env.PLATFORM_ENV;
    assert.equal(isHttpSessionCapEnforced(), false);
  });
});

describe("HTTP_SESSION_CAP", () => {
  it("is 50 (matches the documented prod quota)", () => {
    assert.equal(HTTP_SESSION_CAP, 50);
  });
});

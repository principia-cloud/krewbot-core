/**
 * Unit tests for confineToSessionDir (src/paths.ts) — the H3 fix that
 * stops chat_send_file from exfiltrating another session/user's files.
 *
 * The endpoint used to only check the shared "/data/sessions/" prefix, so
 * a turn in session A could send session B's transcripts. confineToSessionDir
 * pins the file to the caller's own session dir (derived from the trusted
 * SESSION_CWD = <sessionDir>/workdir).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confineToSessionDir } from "../src/paths.ts";

// Simulate /data/sessions/<...> with two sibling sessions.
const ROOT = mkdtempSync(join(tmpdir(), "csf-"));
const sessA = join(ROOT, "sessA");
const sessB = join(ROOT, "sessB");
const cwdA = join(sessA, "workdir");
mkdirSync(join(sessA, "home"), { recursive: true });
mkdirSync(cwdA, { recursive: true });
mkdirSync(join(sessB, "home"), { recursive: true });

const aHomeFile = join(sessA, "home", "ok.png");
const aWorkFile = join(cwdA, "shot.png");
const bSecret = join(sessB, "home", "secret.jsonl");
writeFileSync(aHomeFile, "A-home");
writeFileSync(aWorkFile, "A-work");
writeFileSync(bSecret, "B-secret");

after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("confineToSessionDir", () => {
  it("allows files in the caller's own session (home + workdir)", () => {
    // Helper returns the realpath (symlinks resolved), so compare against
    // the realpath'd expected paths (/tmp → /private/tmp on macOS).
    assert.equal(confineToSessionDir(aHomeFile, cwdA), realpathSync(aHomeFile));
    assert.equal(confineToSessionDir(aWorkFile, cwdA), realpathSync(aWorkFile));
  });

  it("blocks another session's files (the H3 exfiltration vector)", () => {
    assert.equal(confineToSessionDir(bSecret, cwdA), null);
  });

  it("blocks ../ traversal into a sibling session", () => {
    const traversal = join(cwdA, "..", "..", "sessB", "home", "secret.jsonl");
    assert.equal(confineToSessionDir(traversal, cwdA), null);
  });

  it("blocks a symlink that points outside the session", () => {
    const link = join(cwdA, "escape.jsonl");
    symlinkSync(bSecret, link);
    assert.equal(confineToSessionDir(link, cwdA), null);
  });

  it("rejects a nonexistent file", () => {
    assert.equal(confineToSessionDir(join(cwdA, "nope.png"), cwdA), null);
  });

  it("rejects when sessionCwd is missing", () => {
    assert.equal(confineToSessionDir(aHomeFile, ""), null);
  });

  it("rejects a degenerate sessionCwd that would match everything", () => {
    // sessionCwd "/" -> sessionRoot "/" must not allow arbitrary paths.
    assert.equal(confineToSessionDir(bSecret, "/"), null);
  });
});

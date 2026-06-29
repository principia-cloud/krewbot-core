/**
 * Regression tests for the per-member chat isolation invariant: a
 * workspace member can only see and touch THEIR OWN chat sessions.
 *
 * The invariant is enforced in four layers (storage layout keyed by the
 * caller's Cognito sub, sub-scoped API routes, canUseTool confinement,
 * libsandbox bash confinement). These tests pin the first two — the ones
 * a refactor of session storage or routing could silently break:
 *
 *   - listSessions(A) never returns another member's sessions;
 *   - createSession / createAgentTestSession land under the caller's root;
 *   - resolveSessionPath rejects ids/paths that escape the caller's root,
 *     so delete/rename/files/messages can't reach another member's data.
 *
 * No network or EFS — tmp-dir fixtures only.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as http from "node:http";

// paths.ts captures DATA_DIR at module load — point it at a tmp dir
// BEFORE the dynamic imports below. (node --test runs each file in its
// own process, so this doesn't leak into other test files.)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-isolation-"));
process.env.DATA_DIR = tmp;
// Keep the prod-only session cap out of the way of createSession tests.
delete process.env.PLATFORM_ENV;

const { userSessionsRoot, resolveSessionPath } = await import("../src/paths.ts");
const { listSessions, createSession, deleteSession, renameSession } = await import(
  "../src/routes/sessions.ts"
);
const { createAgentTestSession } = await import("../src/routes/agents.ts");

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const USER_A = "aaaaaaaa-1111-2222-3333-444444444444";
const USER_B = "bbbbbbbb-1111-2222-3333-444444444444";

interface CapturedResponse {
  status: number;
  body: unknown;
}

/** Minimal http.ServerResponse double that captures writeHead/end. */
function mockRes(): { res: http.ServerResponse; out: CapturedResponse } {
  const out: CapturedResponse = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  return { res, out };
}

const req = {} as http.IncomingMessage;

function mkSession(sub: string, id: string): string {
  const dir = path.join(userSessionsRoot(sub), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session-meta.json"),
    JSON.stringify({ name: `chat-${id}`, createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  return dir;
}

function sessionIds(body: unknown): string[] {
  return (body as Array<{ id: string }>).map((s) => s.id).sort();
}

describe("listSessions — per-member scoping", () => {
  it("returns only the caller's sessions when other members have sessions", () => {
    mkSession(USER_A, "sess-a1");
    mkSession(USER_A, "sess-a2");
    mkSession(USER_B, "sess-b1");

    const a = mockRes();
    listSessions(req, a.res, USER_A);
    assert.equal(a.out.status, 200);
    assert.deepEqual(sessionIds(a.out.body), ["sess-a1", "sess-a2"]);

    const b = mockRes();
    listSessions(req, b.res, USER_B);
    assert.equal(b.out.status, 200);
    assert.deepEqual(sessionIds(b.out.body), ["sess-b1"]);
  });

  it("returns [] for a member with no sessions root (not other members' chats)", () => {
    const { res, out } = mockRes();
    listSessions(req, res, "cccccccc-1111-2222-3333-444444444444");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, []);
  });
});

describe("createSession — lands under the caller's own root", () => {
  it("creates the session dir only under the caller's root", () => {
    const { res, out } = mockRes();
    createSession(req, res, USER_A);
    assert.equal(out.status, 201);
    const { id } = out.body as { id: string };

    assert.ok(fs.existsSync(path.join(userSessionsRoot(USER_A), id)));
    assert.ok(!fs.existsSync(path.join(userSessionsRoot(USER_B), id)));
  });

  it("agent test sessions land under the caller's root too", () => {
    const { res, out } = mockRes();
    createAgentTestSession("{}", res, USER_B, "agt_0123456789");
    assert.equal(out.status, 201);
    const { id } = out.body as { id: string };

    assert.ok(fs.existsSync(path.join(userSessionsRoot(USER_B), id)));
    assert.ok(!fs.existsSync(path.join(userSessionsRoot(USER_A), id)));
  });
});

describe("resolveSessionPath — session id confined to the caller's root", () => {
  it("resolves a plain id under the caller's root", () => {
    assert.equal(
      resolveSessionPath(USER_A, "sess-a1"),
      path.join(userSessionsRoot(USER_A), "sess-a1"),
    );
  });

  it("rejects a traversal id targeting another member's session", () => {
    assert.equal(resolveSessionPath(USER_A, `../${USER_B}/sess-b1`), null);
  });

  it("keeps an absolute id confined under the caller's root", () => {
    // path.join treats "/etc" as a plain segment here — it cannot escape.
    assert.equal(
      resolveSessionPath(USER_A, "/etc"),
      path.join(userSessionsRoot(USER_A), "etc"),
    );
  });

  it("rejects empty, dot and nested ids", () => {
    assert.equal(resolveSessionPath(USER_A, ""), null);
    assert.equal(resolveSessionPath(USER_A, "."), null);
    assert.equal(resolveSessionPath(USER_A, ".."), null);
    assert.equal(resolveSessionPath(USER_A, "sess-a1/nested"), null);
  });

  it("rejects a rel path escaping the session dir via ..", () => {
    mkSession(USER_A, "sess-rel");
    assert.equal(
      resolveSessionPath(USER_A, "sess-rel", `../../${USER_B}/sess-b1`),
      null,
    );
  });

  it("rejects a rel path escaping via symlink", () => {
    const bDir = mkSession(USER_B, "sess-b-link-target");
    const aDir = mkSession(USER_A, "sess-a-link");
    fs.symlinkSync(bDir, path.join(aDir, "escape"));
    assert.equal(
      resolveSessionPath(USER_A, "sess-a-link", "escape/session-meta.json"),
      null,
    );
  });
});

describe("delete/rename — cannot touch another member's session", () => {
  it("deleteSession with a traversal id responds 400 and leaves the target intact", () => {
    const bDir = mkSession(USER_B, "sess-b-keep");
    const { res, out } = mockRes();
    deleteSession(req, res, USER_A, `../${USER_B}/sess-b-keep`);
    assert.equal(out.status, 400);
    assert.ok(fs.existsSync(path.join(bDir, "session-meta.json")));
  });

  it("renameSession with a traversal id responds 400 and leaves the target intact", () => {
    const bDir = mkSession(USER_B, "sess-b-name");
    const { res, out } = mockRes();
    renameSession(
      JSON.stringify({ name: "hijacked" }),
      res,
      USER_A,
      `../${USER_B}/sess-b-name`,
    );
    assert.equal(out.status, 400);
    const meta = JSON.parse(
      fs.readFileSync(path.join(bDir, "session-meta.json"), "utf-8"),
    );
    assert.equal(meta.name, "chat-sess-b-name");
  });

  it("deleting another member's session id only ever resolves inside the caller's root", () => {
    const bDir = mkSession(USER_B, "sess-b2");
    const { res } = mockRes();
    // Same bare id as B's session — resolves under A's (empty) root, so
    // the rm is a no-op on B's data.
    deleteSession(req, res, USER_A, "sess-b2");
    assert.ok(fs.existsSync(path.join(bDir, "session-meta.json")));
  });
});

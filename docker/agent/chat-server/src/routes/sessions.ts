import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { userSessionsRoot, resolveSessionPath } from "../paths.js";
import { rootLogger, logCatch } from "../logger.js";
import { platformClient } from "../platform-client.js";

export const HTTP_SESSION_CAP = 50;

/** Absolute path of the directory that holds all workspace HTTP sessions. */
export function httpSessionsRoot(): string {
  return path.join(process.env.DATA_DIR || "/data", "sessions", "http");
}

/**
 * Count all HTTP session directories across every user in this workspace.
 * The cap is workspace-wide, not per-user — a single tenant opening
 * infinite browser tabs would otherwise provision unbounded EFS state.
 */
export function countHttpSessions(root: string = httpSessionsRoot()): number {
  let count = 0;
  let users: string[];
  try {
    users = fs.readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    logCatch(rootLogger, "routes.sessions.count.readdir_failed", err, { root });
    return 0;
  }
  for (const user of users) {
    const userDir = path.join(root, user);
    try {
      for (const entry of fs.readdirSync(userDir)) {
        if (fs.statSync(path.join(userDir, entry)).isDirectory()) count++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logCatch(rootLogger, "routes.sessions.count.user_read_failed", err, {
          userDir,
        });
      }
    }
  }
  return count;
}

/**
 * The cap is enforced in prod only. Other envs (e.g. beta) stay
 * uncapped so internal testing doesn't trip over the limit.
 * Driven by `PLATFORM_ENV` so the chat-server doesn't depend on a
 * specific domain string.
 */
export function isHttpSessionCapEnforced(): boolean {
  return (process.env.PLATFORM_ENV || "") === "prod";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function listSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
): void {
  const root = userSessionsRoot(sub);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    // ENOENT is normal: a user who has never created a session has no
    // root directory. Anything else (EACCES, EIO) is worth surfacing.
    if (isEnoent(err)) {
      rootLogger.info(
        { event: "routes.sessions.list.empty", userId: sub, expected: true },
        "no sessions root yet",
      );
    } else {
      logCatch(rootLogger, "routes.sessions.list.readdir_failed", err, { userId: sub, root });
    }
    return json(res, 200, []);
  }

  const sessions = entries
    .filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch (err) {
        if (!isEnoent(err)) {
          logCatch(rootLogger, "routes.sessions.list.stat_failed", err, {
            userId: sub,
            sessionName: name,
          });
        }
        return false;
      }
    })
    .map((name) => {
      const sessionDir = path.join(root, name);
      const stat = fs.statSync(sessionDir);

      let displayName = name;
      const metaPath = path.join(sessionDir, "session-meta.json");
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.name) displayName = meta.name;
      } catch (err) {
        if (!isEnoent(err)) {
          logCatch(rootLogger, "routes.sessions.list.meta_read_failed", err, {
            userId: sub,
            sessionId: name,
          });
        }
      }

      // Test sessions are tagged with .test-meta.json. Surface the
      // pinned agentId so the UI can reuse one test-session per agent
      // (creator view) and filter them out of the regular sidebar.
      let testAgentId: string | undefined;
      const testMetaPath = path.join(sessionDir, ".test-meta.json");
      try {
        const testMeta = JSON.parse(fs.readFileSync(testMetaPath, "utf-8"));
        if (typeof testMeta.testAgentId === "string") {
          testAgentId = testMeta.testAgentId;
        }
      } catch (err) {
        if (!isEnoent(err)) {
          logCatch(rootLogger, "routes.sessions.list.test_meta_read_failed", err, {
            userId: sub,
            sessionId: name,
          });
        }
      }

      let turnCount = 0;
      try {
        const homeClaude = path.join(sessionDir, "home", ".claude", "projects");
        if (fs.existsSync(homeClaude)) {
          for (const projDir of fs.readdirSync(homeClaude)) {
            const projPath = path.join(homeClaude, projDir);
            const jsonlFiles = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
            for (const jf of jsonlFiles) {
              const content = fs.readFileSync(path.join(projPath, jf), "utf-8");
              turnCount += content.split("\n").filter((l) => l.trim()).length;
            }
          }
        }
      } catch (err) {
        // Best effort — turn count is informational, and transient
        // read failures while claude is mid-write are normal.
        logCatch(rootLogger, "routes.sessions.list.turn_count_failed", err, {
          userId: sub,
          sessionId: name,
          expected: true,
        });
      }

      return {
        id: name,
        name: displayName,
        lastModified: stat.mtime.toISOString(),
        turnCount,
        ...(testAgentId ? { testAgentId } : {}),
      };
    })
    .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

  json(res, 200, sessions);
}

export function createSession(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
): void {
  if (isHttpSessionCapEnforced()) {
    const existing = countHttpSessions();
    if (existing >= HTTP_SESSION_CAP) {
      rootLogger.info(
        {
          event: "routes.sessions.create.cap_hit",
          userId: sub,
          existing,
          cap: HTTP_SESSION_CAP,
        },
        "http session cap reached",
      );
      return json(res, 429, {
        error: "session_limit_reached",
        message: `Workspace session limit reached (${HTTP_SESSION_CAP}). Delete an existing chat session to start a new one.`,
        cap: HTTP_SESSION_CAP,
      });
    }
  }

  const id = crypto.randomUUID().slice(0, 8);
  const sessionDir = path.join(userSessionsRoot(sub), id);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ name: `chat-${id}`, createdAt: new Date().toISOString() }),
    );
    json(res, 201, { id, name: `chat-${id}` });

    // Pre-warm the AgentCore browser session in the background. This
    // is the only path that creates a session — the per-turn agent
    // setup uses getBrowserSession() (lookup-only) and skips Playwright
    // wiring if no session exists. Failures here (no browser configured
    // / AgentCore unavailable) just mean the chat runs without browser
    // tools; we log and move on.
    const sessionKey = `http/${sub}/${id}`;
    void platformClient
      .ensureBrowserSession(sessionKey)
      .then(() => {
        rootLogger.info(
          { event: "routes.sessions.browser_prewarm.ok", userId: sub, sessionId: id },
          "browser session pre-warmed at chat creation",
        );
      })
      .catch((err) => {
        logCatch(rootLogger, "routes.sessions.browser_prewarm.failed", err, {
          userId: sub,
          sessionId: id,
          expected: true,
        });
      });
  } catch (err) {
    logCatch(rootLogger, "routes.sessions.create.failed", err, { userId: sub, sessionId: id });
    json(res, 500, { error: "Failed to create session" });
  }
}

export function deleteSession(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) {
    return json(res, 400, { error: "Invalid session path" });
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    json(res, 200, { deleted: true });
  } catch (err) {
    logCatch(rootLogger, "routes.sessions.delete.failed", err, { userId: sub, sessionId });
    json(res, 500, { error: "Failed to delete session" });
  }
}

export function renameSession(
  body: string,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) {
    return json(res, 400, { error: "Invalid session path" });
  }

  try {
    const { name } = JSON.parse(body);
    if (!name || typeof name !== "string") {
      return json(res, 400, { error: "name is required" });
    }

    const metaPath = path.join(resolved, "session-meta.json");
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch (err) {
      if (!isEnoent(err)) {
        logCatch(rootLogger, "routes.sessions.rename.meta_read_failed", err, {
          userId: sub,
          sessionId,
        });
      }
    }

    meta.name = name;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    json(res, 200, { id: sessionId, name });
  } catch (err) {
    logCatch(rootLogger, "routes.sessions.rename.failed", err, { userId: sub, sessionId });
    json(res, 500, { error: "Failed to rename session" });
  }
}

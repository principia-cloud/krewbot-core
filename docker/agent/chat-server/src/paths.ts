/**
 * paths.ts — path resolution utilities.
 *
 * Direct port of workspace-console/src/paths.ts. Provides safe path
 * resolution with boundary checking for sessions and context files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { rootLogger, logCatch } from "./logger.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const USER_CONTEXT_DIR = path.join(DATA_DIR, "user_context");

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Base directory for a user's http sessions on EFS. */
export function userSessionsRoot(sub: string): string {
  return path.join(DATA_DIR, "sessions", "http", sub);
}

/**
 * Resolve a path under a user's session directory. Returns the resolved
 * absolute path, or null if it escapes the session boundary.
 */
export function resolveSessionPath(
  sub: string,
  sessionId: string,
  rel?: string,
): string | null {
  const userRoot = userSessionsRoot(sub);
  const root = path.join(userRoot, sessionId);
  // The session id must stay a single path component under the caller's
  // own root. path.join collapses ".." segments, so without this check a
  // traversal id ("../{otherUser}/{sessionId}") resolves into another
  // member's session dir — the HTTP router can't produce such an id
  // (:id matches [^/]+ on a dot-segment-normalized pathname), but every
  // caller of this function must hold the per-member boundary on its own.
  const idRel = path.relative(userRoot, root);
  if (!idRel || idRel.startsWith("..") || path.isAbsolute(idRel) || idRel.includes(path.sep)) {
    return null;
  }
  if (!rel) return root;

  const target = path.join(root, rel);
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch (err) {
    // ENOENT is normal when resolving a path that hasn't been created
    // yet (e.g. writing a new file). Fall back to lexical resolution.
    if (!isEnoent(err)) {
      logCatch(rootLogger, "paths.session.realpath_failed", err, {
        userId: sub,
        sessionId,
        rel,
      });
    }
    resolved = path.resolve(target);
  }

  if (!resolved.startsWith(root + "/") && resolved !== root) {
    return null;
  }
  return resolved;
}

/**
 * Confine a chat_send_file path to the CALLING session's own directory.
 *
 * `sessionCwd` is the turn's working dir (`<sessionDir>/workdir`), supplied
 * by chat_mcp from its trusted SESSION_CWD env — the model can't forge it.
 * The session root is its parent (`<sessionDir>`), which contains both
 * `home/` and `workdir/`. We realpath the requested file (resolving
 * symlinks + `..`) and require it to live under that one session dir.
 *
 * Returns the resolved absolute path, or null if `sessionCwd` is missing,
 * the file can't be resolved, or it escapes the session dir. Without this,
 * the endpoint only checked the shared `/data/sessions/` prefix, so a turn
 * in session A could exfiltrate another session/user's files (e.g. their
 * `.claude/projects/**.jsonl` transcripts) in the same workspace.
 */
export function confineToSessionDir(
  filePath: string,
  sessionCwd: string,
): string | null {
  if (!filePath || !sessionCwd) return null;
  const rawRoot = path.dirname(sessionCwd);
  // Guard against a degenerate sessionCwd ("/", "") yielding a root that
  // would match everything.
  if (rawRoot === "/" || rawRoot === "." || rawRoot === "") return null;
  let resolved: string;
  let sessionRoot: string;
  try {
    resolved = fs.realpathSync(filePath);
    // Realpath the root too so a symlinked path prefix (or "/tmp" →
    // "/private/tmp") doesn't cause a spurious mismatch.
    sessionRoot = fs.realpathSync(rawRoot);
  } catch {
    return null;
  }
  if (resolved === sessionRoot || resolved.startsWith(sessionRoot + path.sep)) {
    return resolved;
  }
  return null;
}

/**
 * Resolve a team context file path. Returns the full path or null if
 * the path isn't a .md file or escapes the context directory.
 */
export function resolveContextPath(name: string): string | null {
  if (!name.endsWith(".md")) return null;
  const target = path.join(USER_CONTEXT_DIR, name);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(USER_CONTEXT_DIR + "/")) return null;
  return resolved;
}

/** Recursively list all .md context files that exist on disk. */
export function listContextFiles(): Array<{ name: string; size: number }> {
  const results: Array<{ name: string; size: number }> = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!isEnoent(err)) {
        logCatch(rootLogger, "paths.context.readdir_failed", err, { dir });
      }
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = path.relative(USER_CONTEXT_DIR, full);
        try {
          const stat = fs.statSync(full);
          results.push({ name: rel, size: stat.size });
        } catch (err) {
          logCatch(rootLogger, "paths.context.stat_failed", err, {
            path: full,
            expected: isEnoent(err),
          });
        }
      }
    }
  }

  walk(USER_CONTEXT_DIR);
  return results;
}

export { USER_CONTEXT_DIR };

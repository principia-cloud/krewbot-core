import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { resolveSessionPath } from "../paths.js";
import { agentPaths, AGENT_ID_RE } from "../agent-def.js";
import { rootLogger, logCatch } from "../logger.js";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Pipe a binary file to the response with a defensive error handler.
 *
 * Why this exists: Node's `createReadStream(...).pipe(res)` emits
 * 'error' on the ReadStream when the underlying open/read fails
 * (EACCES on a pyc, ENOENT after stat raced with a delete, etc).
 * Without a listener, Node's "Unhandled 'error' event" rule throws
 * — which crashes the entire chat-server container, which is then
 * restarted by ECS. We saw this in prod when a user's Explore click
 * landed on an unreadable .pyc.
 *
 * We can't always send a clean error JSON because the headers may
 * already be flushed by the time the stream errors. Best we can do
 * is log + close the connection — the browser surfaces it as a
 * truncated download, which is the sane failure mode.
 */
function pipeBinaryFile(
  res: http.ServerResponse,
  target: string,
  size: number,
  logEvent: string,
  context: Record<string, unknown>,
): void {
  const fileName = path.basename(target);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": size,
  });
  const stream = fs.createReadStream(target);
  stream.on("error", (err) => {
    logCatch(rootLogger, `${logEvent}.stream_failed`, err, context);
    // End the response — headers are already sent so no clean error
    // body is possible. destroy() also frees the file descriptor.
    if (!res.writableEnded) res.destroy(err);
    stream.destroy();
  });
  stream.pipe(res);
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx", ".py", ".sh",
  ".yml", ".yaml", ".toml", ".cfg", ".ini", ".html", ".css", ".xml",
  ".csv", ".log", ".env", ".gitignore", ".dockerfile", ".sql", ".rs",
  ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".swift",
]);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
  children?: FileEntry[];
}

function buildTree(dirPath: string, basePath: string): FileEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.files.readdir_failed", err, { dirPath });
    }
    return [];
  }

  return entries
    .filter((name) => !name.startsWith(".") && name !== "__pycache__")
    .map((name) => {
      const fullPath = path.join(dirPath, name);
      const relPath = path.join(basePath, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          return {
            name,
            path: relPath,
            type: "directory" as const,
            children: buildTree(fullPath, relPath),
          };
        }
        return {
          name,
          path: relPath,
          type: "file" as const,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      } catch (err) {
        logCatch(rootLogger, "routes.files.stat_failed", err, {
          path: fullPath,
          expected: isEnoent(err),
        });
        return null;
      }
    })
    .filter(Boolean) as FileEntry[];
}

export function listFiles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const workdir = resolveSessionPath(sub, sessionId, "workdir");
  if (!workdir) {
    return json(res, 400, { error: "Invalid session" });
  }

  try {
    const tree = buildTree(workdir, "");
    json(res, 200, tree);
  } catch (err) {
    logCatch(rootLogger, "routes.files.list_failed", err, {
      userId: sub,
      sessionId,
      workdir,
    });
    json(res, 200, []);
  }
}

export function readFile(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  filePath: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId, path.join("workdir", filePath));
  if (!resolved) {
    return json(res, 400, { error: "Invalid file path" });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.files.read.stat_failed", err, {
        userId: sub,
        sessionId,
        filePath,
      });
    }
    return json(res, 404, { error: "File not found" });
  }

  if (!stat.isFile()) {
    return json(res, 400, { error: "Not a file" });
  }

  if (stat.size > MAX_FILE_SIZE) {
    return json(res, 413, { error: "File too large (max 10 MB)" });
  }

  const ext = path.extname(resolved).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext) || ext === "";

  if (isText) {
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      json(res, 200, {
        name: path.basename(resolved),
        path: filePath,
        content,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      logCatch(rootLogger, "routes.files.read.failed", err, {
        userId: sub,
        sessionId,
        filePath,
      });
      json(res, 500, { error: "Failed to read file" });
    }
  } else {
    pipeBinaryFile(res, resolved, stat.size, "routes.files.read", {
      userId: sub,
      sessionId,
      filePath,
    });
  }
}

/**
 * PUT /api/sessions/:id/files/* — create or overwrite a text file in
 * the session's workdir. Parents are mkdir-p'd. Body: `{ content }`.
 * Same 10 MB cap + text-extension allowlist as the read path; binary
 * extensions are refused so users can't smuggle in opaque blobs the
 * UI can't preview anyway.
 */
export function writeFile(
  body: string,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  filePath: string,
): void {
  if (!filePath || filePath.trim() === "") {
    return json(res, 400, { error: "Path is required" });
  }
  const resolved = resolveSessionPath(sub, sessionId, path.join("workdir", filePath));
  if (!resolved) {
    return json(res, 400, { error: "Invalid file path" });
  }

  let parsed: { content?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }
  if (typeof parsed.content !== "string") {
    return json(res, 400, { error: "content must be a string" });
  }
  const content = parsed.content;
  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
    return json(res, 413, { error: "File too large (max 10 MB)" });
  }

  const ext = path.extname(resolved).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext) || ext === "";
  if (!isText) {
    return json(res, 415, { error: "Binary files cannot be edited" });
  }

  // Existing-target check: must be a file if present (don't let writes
  // clobber a directory).
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return json(res, 400, { error: "Path exists and is not a file" });
    }
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.files.write.stat_failed", err, {
        userId: sub,
        sessionId,
        filePath,
      });
      return json(res, 500, { error: "Failed to stat file" });
    }
    // ENOENT — creating a new file. Make sure the parent directory
    // exists; mkdir -p is bounded to the (already path-confined)
    // session root.
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    } catch (mkErr) {
      logCatch(rootLogger, "routes.files.write.mkdir_failed", mkErr, {
        userId: sub,
        sessionId,
        filePath,
      });
      return json(res, 500, { error: "Failed to create parent directory" });
    }
  }

  try {
    fs.writeFileSync(resolved, content, "utf-8");
    const updated = fs.statSync(resolved);
    json(res, 200, {
      name: path.basename(resolved),
      path: filePath,
      content,
      size: updated.size,
      mtime: updated.mtime.toISOString(),
    });
  } catch (err) {
    logCatch(rootLogger, "routes.files.write.failed", err, {
      userId: sub,
      sessionId,
      filePath,
    });
    json(res, 500, { error: "Failed to write file" });
  }
}

/**
 * DELETE /api/sessions/:id/files/* — remove a file or directory in
 * the session's workdir. Directories are removed recursively; the
 * session root itself is refused. Path-traversal check enforced by
 * `resolveSessionPath`.
 */
export function deleteFile(
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  filePath: string,
): void {
  if (!filePath || filePath.trim() === "") {
    return json(res, 400, { error: "Path is required" });
  }
  const resolved = resolveSessionPath(sub, sessionId, path.join("workdir", filePath));
  if (!resolved) {
    return json(res, 400, { error: "Invalid file path" });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (isEnoent(err)) {
      return json(res, 404, { error: "File not found" });
    }
    logCatch(rootLogger, "routes.files.delete.stat_failed", err, {
      userId: sub,
      sessionId,
      filePath,
    });
    return json(res, 500, { error: "Failed to stat file" });
  }

  try {
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }
    json(res, 200, { deleted: true, path: filePath });
  } catch (err) {
    logCatch(rootLogger, "routes.files.delete.failed", err, {
      userId: sub,
      sessionId,
      filePath,
    });
    json(res, 500, { error: "Failed to delete" });
  }
}

/**
 * PATCH /api/sessions/:id/files/* — rename / move a file or
 * directory. Body: `{ newPath }`. Both old and new paths are confined
 * to the session's workdir. Refuses if the destination already exists
 * (rename should never silently overwrite).
 */
export function renameFile(
  body: string,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  filePath: string,
): void {
  if (!filePath || filePath.trim() === "") {
    return json(res, 400, { error: "Path is required" });
  }

  let parsed: { newPath?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }
  if (typeof parsed.newPath !== "string" || parsed.newPath.trim() === "") {
    return json(res, 400, { error: "newPath is required" });
  }
  const newPath = parsed.newPath;

  const fromResolved = resolveSessionPath(sub, sessionId, path.join("workdir", filePath));
  const toResolved = resolveSessionPath(sub, sessionId, path.join("workdir", newPath));
  if (!fromResolved || !toResolved) {
    return json(res, 400, { error: "Invalid path" });
  }
  if (fromResolved === toResolved) {
    return json(res, 400, { error: "Source and destination are the same" });
  }

  try {
    fs.statSync(fromResolved);
  } catch (err) {
    if (isEnoent(err)) {
      return json(res, 404, { error: "Source not found" });
    }
    logCatch(rootLogger, "routes.files.rename.stat_failed", err, {
      userId: sub,
      sessionId,
      filePath,
    });
    return json(res, 500, { error: "Failed to stat source" });
  }

  // Don't silently clobber.
  try {
    fs.statSync(toResolved);
    return json(res, 409, { error: "Destination already exists" });
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.files.rename.dest_stat_failed", err, {
        userId: sub,
        sessionId,
        filePath,
        newPath,
      });
      return json(res, 500, { error: "Failed to check destination" });
    }
  }

  // Make sure the destination's parent exists.
  try {
    fs.mkdirSync(path.dirname(toResolved), { recursive: true });
  } catch (err) {
    logCatch(rootLogger, "routes.files.rename.mkdir_failed", err, {
      userId: sub,
      sessionId,
      filePath,
      newPath,
    });
    return json(res, 500, { error: "Failed to create parent directory" });
  }

  try {
    fs.renameSync(fromResolved, toResolved);
    json(res, 200, { from: filePath, to: newPath });
  } catch (err) {
    logCatch(rootLogger, "routes.files.rename.failed", err, {
      userId: sub,
      sessionId,
      filePath,
      newPath,
    });
    json(res, 500, { error: "Failed to rename" });
  }
}

/**
 * Read-tree helper for any rooted, path-confined directory under
 * `/data/agents/{agentId}/`. Used by the def-draft/ + def/ + workdir/
 * file-browser endpoints. Each endpoint passes the root it owns and
 * the request gets the same path-traversal check + text/binary
 * branch as the workspace-session reader.
 */
function listAgentRoot(
  res: http.ServerResponse,
  agentId: string,
  root: string,
  logEvent: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  try {
    const tree = buildTree(root, "");
    json(res, 200, tree);
  } catch (err) {
    logCatch(rootLogger, logEvent, err, { agentId, root });
    json(res, 200, []);
  }
}

/**
 * True if `target`, after resolving symlinks, escapes `root`. The lexical
 * `path.resolve` + `startsWith` check only catches `..`; a symlink planted
 * inside the dir (e.g. by the creator agent writing under def-draft/) can
 * point at /config/secrets/* and would be followed by readFileSync. We
 * realpath both and re-check containment. Returns false when the target
 * doesn't exist yet — the caller's statSync then yields a normal 404.
 */
export function symlinkEscapes(target: string, root: string): boolean {
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    return real !== realRoot && !real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

function readAgentRoot(
  res: http.ServerResponse,
  agentId: string,
  root: string,
  filePath: string,
  logEvent: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  const target = path.resolve(root, filePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return json(res, 400, { error: "Invalid file path" });
  }
  if (symlinkEscapes(target, root)) {
    return json(res, 400, { error: "Invalid file path" });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, `${logEvent}.stat_failed`, err, { agentId, filePath });
    }
    return json(res, 404, { error: "File not found" });
  }
  if (!stat.isFile()) return json(res, 400, { error: "Not a file" });
  if (stat.size > MAX_FILE_SIZE) {
    return json(res, 413, { error: "File too large (max 10 MB)" });
  }
  const ext = path.extname(target).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext) || ext === "";
  if (isText) {
    try {
      const content = fs.readFileSync(target, "utf-8");
      json(res, 200, {
        name: path.basename(target),
        path: filePath,
        content,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      logCatch(rootLogger, `${logEvent}.read_failed`, err, { agentId, filePath });
      json(res, 500, { error: "Failed to read file" });
    }
  } else {
    pipeBinaryFile(res, target, stat.size, logEvent, { agentId, filePath });
  }
}

/**
 * GET /api/agents/:agentId/def/files — tree of files under
 * `def-draft/` for this agent. The creator writes to `def-draft/`;
 * `def/` is the live deployed snapshot promoted by Deploy. Showing
 * the draft tree means the user sees their in-progress edits as the
 * creator writes them, not the last-deployed version.
 */
export function listAgentDefFiles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  const { defDraftDir } = agentPaths(agentId);
  try {
    const tree = buildTree(defDraftDir, "");
    json(res, 200, tree);
  } catch (err) {
    logCatch(rootLogger, "routes.files.agent_def.list_failed", err, {
      agentId,
      defDraftDir,
    });
    json(res, 200, []);
  }
}

/**
 * GET /api/agents/:agentId/def/files/* — contents of a file under
 * `def-draft/`. Wildcard `*` is the relative path inside def-draft/.
 *
 * Path-confined: re-resolves the target and refuses anything that
 * escapes `/data/agents/{id}/def-draft/`. Same MAX_FILE_SIZE + text-
 * vs-binary split as the workspace-session read path.
 */
export function readAgentDefFile(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
  filePath: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  const { defDraftDir } = agentPaths(agentId);
  const target = path.resolve(defDraftDir, filePath);
  // Refuse path traversal — `..` resolves OUTSIDE defDraftDir, which
  // `startsWith(defDraftDir + "/")` cleanly rejects.
  if (target !== defDraftDir && !target.startsWith(defDraftDir + path.sep)) {
    return json(res, 400, { error: "Invalid file path" });
  }
  // ...and refuse a symlink that resolves outside def-draft/ (the creator
  // can write symlinks there; readFileSync would otherwise follow them).
  if (symlinkEscapes(target, defDraftDir)) {
    return json(res, 400, { error: "Invalid file path" });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.files.agent_def.stat_failed", err, {
        agentId,
        filePath,
      });
    }
    return json(res, 404, { error: "File not found" });
  }
  if (!stat.isFile()) return json(res, 400, { error: "Not a file" });
  if (stat.size > MAX_FILE_SIZE) {
    return json(res, 413, { error: "File too large (max 10 MB)" });
  }

  const ext = path.extname(target).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext) || ext === "";

  if (isText) {
    try {
      const content = fs.readFileSync(target, "utf-8");
      json(res, 200, {
        name: path.basename(target),
        path: filePath,
        content,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      logCatch(rootLogger, "routes.files.agent_def.read_failed", err, {
        agentId,
        filePath,
      });
      json(res, 500, { error: "Failed to read file" });
    }
  } else {
    pipeBinaryFile(res, target, stat.size, "routes.files.agent_def", {
      agentId,
      filePath,
    });
  }
}

/**
 * GET /api/agents/:agentId/live-def/files — tree under the live
 * `def/` snapshot (the deployed version). Read-only — promote
 * happens through the deploy endpoint. Used by the Agents-page
 * Explore panel so users can inspect what's actually being routed
 * to without seeing the creator's in-progress edits.
 */
export function listAgentLiveDefFiles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return json(res, 400, { error: "Invalid agentId" });
  const { defDir } = agentPaths(agentId);
  listAgentRoot(res, agentId, defDir, "routes.files.agent_live_def.list_failed");
}

export function readAgentLiveDefFile(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
  filePath: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return json(res, 400, { error: "Invalid agentId" });
  const { defDir } = agentPaths(agentId);
  readAgentRoot(res, agentId, defDir, filePath, "routes.files.agent_live_def");
}

/**
 * GET /api/agents/:agentId/workdir/files — tree under the agent's
 * runtime workdir/. Lets users inspect scratch state, generated
 * artefacts, and persisted runtime data without ECS-exec'ing into
 * the container. Read-only from the UI; the agent itself writes to
 * this dir at runtime.
 */
export function listAgentWorkdirFiles(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return json(res, 400, { error: "Invalid agentId" });
  const { workdir } = agentPaths(agentId);
  listAgentRoot(res, agentId, workdir, "routes.files.agent_workdir.list_failed");
}

export function readAgentWorkdirFile(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
  filePath: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return json(res, 400, { error: "Invalid agentId" });
  const { workdir } = agentPaths(agentId);
  readAgentRoot(res, agentId, workdir, filePath, "routes.files.agent_workdir");
}

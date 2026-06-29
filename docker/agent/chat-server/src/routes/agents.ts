/**
 * routes/agents.ts — agent lifecycle endpoints that don't fit the
 * chat / file-browser modules.
 *
 *   POST /api/agents/:agentId/deploy        — secret check + promote
 *                                             def-draft → def + flip
 *                                             DDB status (one shot).
 *   POST /api/agents/:agentId/test-session  — create a chat session
 *                                             pinned to test this one
 *                                             agent (loaded from
 *                                             def-draft/, not the
 *                                             deployed snapshot).
 *
 * Both run inside the chat-server (not Lambda) because the source of
 * truth for def/ is EFS, which Lambda doesn't mount.
 *
 * Why deploy lives here, not in workspace-api: workspace-api has no
 * EFS mount, so any deploy variant in Lambda would have to leave the
 * promote step to a separate service and orchestrate it. Putting the
 * whole flow in the chat-server collapses that into one round-trip
 * from the frontend's perspective. The chat-server already speaks
 * the Agent Platform API for DDB state changes (workspace-key
 * authed, no JWT-forwarding glue needed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import AdmZip from "adm-zip";
import { agentPaths, AGENT_ID_RE, type AgentConfig } from "../agent-def.js";
import { userSessionsRoot } from "../paths.js";
import {
  HTTP_SESSION_CAP,
  countHttpSessions,
  isHttpSessionCapEnforced,
} from "./sessions.js";
import { platformClient } from "../platform-client.js";
import { rootLogger, logCatch } from "../logger.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Where the sidecar mounts the workspace's synced secrets. The
 * directory listing is the source of truth for which secrets exist
 * (the sidecar removes stale entries on its sync loop). Used by the
 * deploy soft-block to compute the missing list. */
const SECRETS_DIR = process.env.SECRETS_DIR || "/config/secrets";
/** Custom-secret name prefix on disk and in Secrets Manager. Mirrors
 * Management API's CUSTOM_SECRET_PREFIX. */
const CUSTOM_PREFIX = "custom-";

function normalizeCustomName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/** Names of secrets currently materialized at /config/secrets/. */
function listAvailableSecrets(): Set<string> {
  try {
    return new Set(fs.readdirSync(SECRETS_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logCatch(rootLogger, "routes.agents.deploy.secrets_readdir_failed", err, {
        secretsDir: SECRETS_DIR,
      });
    }
    return new Set();
  }
}

/** Compute the set of `requiredSecrets` not satisfied by anything in
 * `available`. A required name `X` is satisfied iff:
 *   - `X` exists as a typed integration (e.g. `claude-token`), OR
 *   - `custom-{normalize(X)}` exists.
 * Mirrors the workspace-api logic so deploy semantics match exactly. */
function computeMissingSecrets(
  required: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  const customSet = new Set<string>();
  for (const name of available) {
    if (name.startsWith(CUSTOM_PREFIX)) {
      customSet.add(name.slice(CUSTOM_PREFIX.length));
    }
  }
  return required.filter((n) => !available.has(n) && !customSet.has(normalizeCustomName(n)));
}

/** Read def-draft/config.json. Tolerant: a missing file or malformed
 * JSON yields a config with empty requiredSecrets so deploy still
 * succeeds (the contract is "draft is allowed to be sparse"). */
function readDraftConfig(agentId: string): AgentConfig {
  const { draftConfigFile } = agentPaths(agentId);
  let raw: string;
  try {
    raw = fs.readFileSync(draftConfigFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logCatch(rootLogger, "routes.agents.deploy.config_read_failed", err, {
        agentId,
      });
    }
    return { name: "", description: "", requiredSecrets: [], tools: {}, customMcps: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      requiredSecrets: Array.isArray(parsed.requiredSecrets)
        ? parsed.requiredSecrets.filter((s): s is string => typeof s === "string")
        : [],
      tools: parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {},
      customMcps: Array.isArray(parsed.customMcps) ? parsed.customMcps : [],
    };
  } catch (err) {
    logCatch(rootLogger, "routes.agents.deploy.config_parse_failed", err, {
      agentId,
    });
    return { name: "", description: "", requiredSecrets: [], tools: {}, customMcps: [] };
  }
}

/**
 * Atomically promote `def-draft/` to `def/`. Internal helper to the
 * deploy orchestrator — there's no standalone /promote endpoint
 * because users would never want to publish file changes WITHOUT
 * making the agent visible to the supervisor.
 *
 * Atomicity: copy draft → sibling stage dir, then two renames so the
 * old def/ is displaced and the new content takes its place. A crash
 * between the two renames leaves either the old def/ in place or a
 * dangling `def.old-{ts}/`; neither is observable as missing-def.
 *
 * Throws on filesystem failure so the caller surfaces a 500 instead
 * of mistakenly flipping DDB status without updating EFS.
 */
/**
 * Recursive copy that produces readable files on EFS.
 *
 * `fs.cpSync(..., { recursive: true })` empirically lands destination
 * files with mode 0o200 (--w-------) when writing through our EFS
 * access point, and a follow-up `chmodSync(..., 0o644)` silently
 * fails to fix it (no error thrown, mode unchanged). The cause is
 * somewhere in the interaction between Node's libuv copy_file path
 * and NFSv4 / EFS access-point semantics — we couldn't pin it
 * exactly. The shell's `cp` works fine, and so does an explicit
 * read-then-write loop, because the destination file is created by
 * `open(O_CREAT)` with mode masked by the normal umask (0022) — it
 * never enters the broken state where chmod won't apply.
 *
 * So: recurse manually, mkdir → walk → copy file via readFileSync +
 * writeFileSync with explicit `mode: 0o644`.  No chmod call needed.
 */
function copyRecursiveReadable(src: string, dest: string): number {
  let fileCount = 0;
  fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcChild = path.join(src, entry.name);
    const destChild = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fileCount += copyRecursiveReadable(srcChild, destChild);
    } else if (entry.isFile()) {
      const data = fs.readFileSync(srcChild);
      fs.writeFileSync(destChild, data, { mode: 0o644 });
      fileCount += 1;
    }
    // Symlinks / special files: skipped silently. Agent def/ should
    // never have those — if it does, surface as a missing-file at
    // load time rather than failing the deploy.
  }
  return fileCount;
}

function promoteDraftToLive(agentId: string): { files: number } {
  const paths = agentPaths(agentId);
  if (!fs.existsSync(paths.defDraftDir)) {
    throw new Error("No draft to promote");
  }
  const draftEntries = fs.readdirSync(paths.defDraftDir);
  if (draftEntries.length === 0) {
    throw new Error("Draft is empty; nothing to promote");
  }

  const stageDir = `${paths.defDir}.stage-${Date.now()}`;
  const oldDir = `${paths.defDir}.old-${Date.now()}`;

  try {
    copyRecursiveReadable(paths.defDraftDir, stageDir);
    if (fs.existsSync(paths.defDir)) {
      fs.renameSync(paths.defDir, oldDir);
    }
    fs.renameSync(stageDir, paths.defDir);
    if (fs.existsSync(oldDir)) {
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  } catch (err) {
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* swallow cleanup failure */
    }
    throw err;
  }

  return { files: draftEntries.length };
}

/**
 * Single-shot deploy: secret soft-block check → promote def-draft →
 * flip DDB status. Replaces the frontend orchestrating
 * promote-then-deploy with two API calls.
 *
 * Order matters: we check secrets BEFORE promoting so a missing-
 * secret response leaves both EFS and DDB untouched. Otherwise a
 * blocked deploy attempt could silently push new draft content into
 * a previously-deployed agent's def/ and have the supervisor pick
 * it up via the unchanged `deployed` status.
 *
 * Query: `?override=true` skips the secret check (matches the
 * existing UI's "Deploy anyway" button).
 *
 * Returns:
 *   200 {agentId, status: "missing_secrets", missing}     soft-block
 *   200 {agentId, status: "deployed", missing, files}     ok
 */
export async function deployAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): Promise<void> {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  // Tolerant query parsing: override is the only flag we read.
  const url = new URL(req.url || "/", "http://x");
  const override = url.searchParams.get("override") === "true";

  const config = readDraftConfig(agentId);
  const required = config.requiredSecrets;
  const missing = required.length
    ? computeMissingSecrets(required, listAvailableSecrets())
    : [];

  if (missing.length && !override) {
    rootLogger.info(
      {
        event: "routes.agents.deploy.blocked_missing_secrets",
        agentId,
        missingCount: missing.length,
      },
      "deploy blocked on missing secrets",
    );
    return json(res, 200, {
      agentId,
      status: "missing_secrets",
      missing,
    });
  }

  // Promote first (EFS), then flip status (DDB). If the flip fails
  // after the promote succeeds we end up with new def/ but stale
  // status; the user retries deploy and the second attempt's
  // promote is a no-op + the flip retries. No corrupt state either way.
  let promoted: { files: number };
  try {
    promoted = promoteDraftToLive(agentId);
  } catch (err) {
    logCatch(rootLogger, "routes.agents.deploy.promote_failed", err, {
      agentId,
    });
    const message = err instanceof Error ? err.message : "Promote failed";
    return json(res, 500, { error: message });
  }

  try {
    await platformClient.setAgentStatus(agentId, "deployed");
  } catch (err) {
    logCatch(rootLogger, "routes.agents.deploy.status_flip_failed", err, {
      agentId,
    });
    return json(res, 502, {
      error: "Promote succeeded but status flip failed; retry deploy",
    });
  }

  rootLogger.info(
    {
      event: "routes.agents.deploy.ok",
      agentId,
      override,
      missingCount: missing.length,
      files: promoted.files,
    },
    "agent deployed",
  );
  json(res, 200, {
    agentId,
    status: "deployed",
    missing: override ? missing : [],
    files: promoted.files,
  });
}

/**
 * Create a chat session that pins one specific agent in for-test mode.
 * The session looks like any other workspace HTTP session, plus a
 * `.test-meta.json` marker that runAgentTurnImpl reads on every turn
 * to:
 *   - load that one agent's def from `def-draft/` (not live `def/`);
 *   - register only that agent in the supervisor's `agents` map;
 *   - prepend a system note so the model knows to delegate via Task.
 *
 * Unlike `/api/sessions` (regular workspace chat), the returned
 * session is named `Test: {agent.name}` for findability in the
 * sidebar. Otherwise it's an ordinary session — the user can keep
 * using it as scratch even after the test is done.
 */
export function createAgentTestSession(
  body: string,
  res: http.ServerResponse,
  sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  if (isHttpSessionCapEnforced()) {
    const existing = countHttpSessions();
    if (existing >= HTTP_SESSION_CAP) {
      return json(res, 429, {
        error: "session_limit_reached",
        message: `Workspace session limit reached (${HTTP_SESSION_CAP}). Delete an existing chat session to start a new one.`,
        cap: HTTP_SESSION_CAP,
      });
    }
  }

  let parsed: { agentName?: string } = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      logCatch(rootLogger, "routes.agents.test_session.body_parse_failed", err, {
        userId: sub,
        agentId,
        expected: true,
      });
    }
  }
  const label = `Test: ${(parsed.agentName || agentId).slice(0, 48)}`;

  const id = crypto.randomUUID().slice(0, 8);
  const sessionDir = path.join(userSessionsRoot(sub), id);

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session-meta.json"),
      JSON.stringify({ name: label, createdAt: new Date().toISOString() }),
    );
    // Test marker: read by runAgentTurnImpl on every turn. Plain JSON
    // (not env / query-string) so it survives the SSE reconnect path
    // — the marker is a property of the session, not the in-flight
    // request.
    fs.writeFileSync(
      path.join(sessionDir, ".test-meta.json"),
      JSON.stringify({ testAgentId: agentId, createdAt: new Date().toISOString() }),
    );
    rootLogger.info(
      {
        event: "routes.agents.test_session.created",
        userId: sub,
        sessionId: id,
        agentId,
      },
      "agent test session created",
    );
    json(res, 201, { id, name: label });
  } catch (err) {
    logCatch(rootLogger, "routes.agents.test_session.failed", err, {
      userId: sub,
      sessionId: id,
      agentId,
    });
    json(res, 500, { error: "Failed to create test session" });
  }
}

/**
 * Result the upload route returns to the caller. The frontend uses
 * `summary` to build a synthetic user-facing chat message ("uploaded
 * X.zip → wrote N files: ...") that's then fed back through the
 * normal turn submit path so the creator AI sees it as conversation.
 */
export interface ZipUploadResult {
  files: string[];
  bytes: number;
  summary: string;
}

/**
 * POST /api/agents/:agentId/uploads/zip
 *
 * Body: raw zip bytes (no multipart wrapper — keeps the server side
 * trivial; the frontend reads the dropped File as ArrayBuffer and
 * sends it as the request body).
 *
 * Optional `?name=originalfile.zip` so we can quote the file name in
 * the synthetic chat message; defaults to "upload.zip" if absent.
 *
 * Behaviour: extract every entry into `def-draft/`, mkdir-p as
 * needed, set readable mode, skip directories that the zip contains
 * implicitly. Path-traversal entries (anything resolving outside
 * defDraftDir) and symlinks are skipped — never written. Returns
 * the list of files actually written.
 *
 * Limits:
 *   - Compressed body ≤ MAX_ZIP_BYTES (caller-enforced via readBodyBuffer)
 *   - Each entry uncompressed ≤ MAX_FILE_BYTES
 *   - Total uncompressed ≤ MAX_TOTAL_BYTES
 *
 * The user's message is the next turn the frontend submits — this
 * route just lays files on disk and returns a description.
 */
/** Caps sized to comfortably accept reference-agent ingestion bundles
 * (e.g. monogram-agent.zip at ~37 MB compressed / ~115 MB extracted).
 * The chat-server task has 3.5 GB of memory; even at the upper bound
 * a single upload uses < 10% of that. We still want a ceiling so a
 * pathological upload can't OOM the container. */
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** Hard cap on how many files we'll extract from a single zip. Agent
 * definitions are tens of files at most; anything over this is
 * almost certainly an accidental venv / node_modules upload. We
 * surface a 413 with a hint to clean up the zip before retrying. */
const MAX_FILES = 100;

/** Path components we never extract: package caches, version-control
 * metadata, OS scratch files. Users zipping a project folder almost
 * always include these by accident — extracting them bloats def-draft/
 * with thousands of useless files and (worse) blocks the event loop
 * long enough for ALB health checks to time out the chat-server. */
const SKIP_PATH_SEGMENTS = new Set([
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  ".next",
  ".cache",
  "__MACOSX",
]);

function shouldSkipEntry(entryName: string): boolean {
  // Reject if any path component is in the skip set, OR the basename
  // is a Python bytecode / common editor temp file.
  for (const segment of entryName.split("/")) {
    if (SKIP_PATH_SEGMENTS.has(segment)) return true;
  }
  const base = entryName.split("/").pop() || "";
  if (base.endsWith(".pyc") || base.endsWith(".pyo")) return true;
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  return false;
}

/** Yield to the event loop. Called periodically during big zip
 * extractions so Node can service ALB health-check pings — without
 * this a multi-thousand-file extract blocks long enough that ALB
 * marks the target unhealthy and ECS kills the task mid-write. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function uploadDraftZip(
  buf: Buffer,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
  origName: string,
): Promise<void> {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  const paths = agentPaths(agentId);
  fs.mkdirSync(paths.defDraftDir, { recursive: true, mode: 0o755 });

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch (err) {
    logCatch(rootLogger, "routes.agents.upload.parse_failed", err, {
      agentId,
      bytes: buf.length,
    });
    return json(res, 400, { error: "Not a valid zip file" });
  }

  const written: string[] = [];
  let totalBytes = 0;
  let skippedTraversal = 0;
  let skippedSymlink = 0;
  let skippedJunk = 0;

  // Pre-pass: count what we'd actually write after junk-filtering, so
  // a venv'd-up zip fails up front with a clear error instead of
  // half-extracting before tripping the cap. Scanning the central
  // directory is cheap (no decompression).
  let plannedWrites = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (shouldSkipEntry(entry.entryName)) continue;
    plannedWrites += 1;
  }
  if (plannedWrites > MAX_FILES) {
    return json(res, 413, {
      error:
        `Zip contains ${plannedWrites} files (after filtering caches/__pycache__/etc). ` +
        `The upload limit is ${MAX_FILES} files — agent definitions should be small. ` +
        `Trim the zip to just prompt.md, scripts/, resources/, etc. and retry.`,
    });
  }

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    // Drop common junk paths (venv, __pycache__, .git, etc.) before
    // anything else so they don't even count toward limits.
    if (shouldSkipEntry(entry.entryName)) {
      skippedJunk += 1;
      continue;
    }

    // Reject path traversal — both literal `..` segments and absolute
    // entry names. resolve() would normalise `../../etc/passwd` to
    // outside defDraftDir, so the startsWith check catches it.
    const rel = entry.entryName;
    if (rel.includes("..") || path.isAbsolute(rel)) {
      skippedTraversal += 1;
      continue;
    }
    const target = path.resolve(paths.defDraftDir, rel);
    if (!target.startsWith(paths.defDraftDir + path.sep)) {
      skippedTraversal += 1;
      continue;
    }

    // adm-zip surfaces unix attrs in the high byte of `attr`. Type
    // bits 0o120000 = symlink; we never write those — they're a
    // common bypass vector and the agent has no use for them.
    const mode = (entry.header as { attr?: number }).attr
      ? (((entry.header as { attr: number }).attr >>> 16) & 0o170000)
      : 0;
    if (mode === 0o120000) {
      skippedSymlink += 1;
      continue;
    }

    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) {
      logCatch(
        rootLogger,
        "routes.agents.upload.file_too_large",
        new Error(`entry ${rel} exceeds ${MAX_FILE_BYTES} bytes`),
        { agentId, entry: rel, bytes: data.length },
      );
      return json(res, 413, {
        error: `File "${rel}" exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit`,
      });
    }
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json(res, 413, {
        error: `Zip uncompressed size exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)} MB`,
      });
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, data, { mode: 0o644 });
    written.push(rel);

    // Yield to the event loop every 25 files so concurrent requests
    // (notably ALB's 30s health check) don't time out while we're
    // grinding through a large extract. The cost is a microtask
    // tick per 25 files — negligible.
    if (written.length % 25 === 0) {
      await yieldEventLoop();
    }
  }

  const summaryLines: string[] = [
    `Uploaded \`${origName}\` → wrote ${written.length} files into \`def-draft/\` (${totalBytes} bytes total).`,
    "",
    "Files:",
    ...written.slice(0, 50).map((f) => `- \`${f}\``),
  ];
  if (written.length > 50) {
    summaryLines.push(`- … and ${written.length - 50} more`);
  }
  if (skippedJunk || skippedTraversal || skippedSymlink) {
    summaryLines.push("");
    const parts: string[] = [];
    if (skippedJunk)
      parts.push(`${skippedJunk} cache/build files (venv, __pycache__, .git, etc.)`);
    if (skippedTraversal)
      parts.push(`${skippedTraversal} path-traversal entries`);
    if (skippedSymlink) parts.push(`${skippedSymlink} symlinks`);
    summaryLines.push(`Skipped: ${parts.join(", ")}.`);
  }
  summaryLines.push(
    "",
    "Please review what was uploaded and incorporate it into the agent definition.",
  );

  rootLogger.info(
    {
      event: "routes.agents.upload.ok",
      agentId,
      files: written.length,
      bytes: totalBytes,
      skippedJunk,
      skippedTraversal,
      skippedSymlink,
    },
    "zip uploaded into def-draft",
  );
  const result: ZipUploadResult = {
    files: written,
    bytes: totalBytes,
    summary: summaryLines.join("\n"),
  };
  json(res, 200, result);
}

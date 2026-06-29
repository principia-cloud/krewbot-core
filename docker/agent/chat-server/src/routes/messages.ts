import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { resolveSessionPath } from "../paths.js";
import { agentPaths, AGENT_ID_RE } from "../agent-def.js";
import { rootLogger, logCatch } from "../logger.js";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Count parseable user/assistant/tool_result entries in a Claude CLI
 * transcript file. Used only as a tie-breaker by findSessionJsonl — the
 * full parse happens separately in parseJsonlMessages. */
function countParseableEntries(filePath: string): number {
  let count = 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (
          entry?.type === "user" ||
          entry?.type === "assistant" ||
          entry?.type === "tool_result"
        ) {
          count++;
        }
      } catch {
        // Unparseable line — skip. Matches parseJsonlMessages' tolerance.
      }
    }
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.count_failed", err, { filePath });
    }
  }
  return count;
}

/** Returns the Claude CLI transcript file with the most parseable messages
 * for this session, tie-broken by most recent mtime. The "most recent by
 * mtime" heuristic alone is broken: the CLI spins up a new .jsonl every
 * turn (a fresh session UUID), and if a turn is aborted during the thinking
 * phase the freshest file is empty/near-empty — picking it would hide all
 * prior completed turns. Because every turn's file replays the full history
 * up to that point, the file with the most messages is always the
 * authoritative one; mtime only matters when two files are equally
 * complete (the most recent wins so a just-completed resumed turn
 * supersedes an older file of equal length — which won't happen in
 * practice but keeps the tie-break deterministic). */
/** Pick the "best" transcript file in a `.claude/projects/<enc>/` tree.
 * Shared between the regular-session and creator-session routes —
 * both have a HOME dir with the same CLI-managed layout, just rooted
 * differently on EFS. */
function findBestJsonlIn(projectsDir: string): string | null {
  try {
    const projDirs = fs.readdirSync(projectsDir);
    for (const dir of projDirs) {
      const dirPath = path.join(projectsDir, dir);
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) continue;

      const scored = files.map((f) => {
        const fullPath = path.join(dirPath, f);
        return {
          path: fullPath,
          mtime: fs.statSync(fullPath).mtime.getTime(),
          count: countParseableEntries(fullPath),
        };
      });
      scored.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.mtime - a.mtime;
      });
      return scored[0].path;
    }
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.projects_read_failed", err, {
        projectsDir,
      });
    }
  }
  return null;
}

function findSessionJsonl(sub: string, sessionId: string): string | null {
  const sessionDir = resolveSessionPath(sub, sessionId);
  if (!sessionDir) return null;
  return findBestJsonlIn(path.join(sessionDir, "home", ".claude", "projects"));
}

interface ParsedMessage {
  role: "user" | "assistant";
  type: "text" | "tool_use" | "tool_result" | "stopped";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  timestamp?: string;
}

/** Mirror of the marker file name in routes/chat.ts. Kept local here to
 * avoid a cross-module import cycle. */
const STOP_MARKER_FILE = ".stopped-turns.jsonl";
const USER_SUBMISSIONS_FILE = ".user-submissions.jsonl";
/** Side-file where finished background-task replies land for web (HTTP)
 * sessions — the web channel has no adapter to push into, so index.ts
 * appends each bg reply here and we merge them into history by timestamp.
 * Mirror of the name in index.ts (kept local to avoid an import cycle). */
const BG_REPLY_FILE = ".bg-replies.jsonl";

/** Window (ms) used to dedupe a recovered side-file user message against
 * a transcript user message with the same content. Wider than strictly
 * needed — the CLI typically stamps its record within seconds of the
 * submission, but we allow generous slack so clock skew on the EFS host
 * can't produce duplicates. */
const USER_DEDUPE_WINDOW_MS = 5 * 60_000;

function readUserSubmissions(sessionDir: string): ParsedMessage[] {
  const filePath = path.join(sessionDir, USER_SUBMISSIONS_FILE);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.user_submissions_read_failed", err, {
        filePath,
      });
    }
    return [];
  }

  const out: ParsedMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry.content === "string" && typeof entry.timestamp === "string") {
        out.push({
          role: "user",
          type: "text",
          content: entry.content,
          timestamp: entry.timestamp,
        });
      }
    } catch (err) {
      rootLogger.info(
        {
          event: "routes.messages.user_submissions_bad_line",
          filePath,
          expected: true,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "unparseable user-submission line",
      );
    }
  }
  return out;
}

/** Keep only side-file user messages that the CLI transcript is missing.
 * Match = same content AND timestamps within USER_DEDUPE_WINDOW_MS. This
 * is intentionally lenient on time because we don't control the CLI's
 * clock precision and don't want to accidentally show duplicates. */
function dedupeAgainstTranscript(
  submissions: ParsedMessage[],
  transcript: ParsedMessage[],
): ParsedMessage[] {
  const transcriptUsers = transcript.filter((m) => m.role === "user" && m.type === "text");
  return submissions.filter((sub) => {
    const subTs = sub.timestamp ? Date.parse(sub.timestamp) : NaN;
    return !transcriptUsers.some((t) => {
      if (t.content !== sub.content) return false;
      if (!t.timestamp || isNaN(subTs)) return true; // can't compare → treat as match
      const tt = Date.parse(t.timestamp);
      if (isNaN(tt)) return true;
      return Math.abs(tt - subTs) <= USER_DEDUPE_WINDOW_MS;
    });
  });
}

function readStopMarkers(sessionDir: string): ParsedMessage[] {
  const filePath = path.join(sessionDir, STOP_MARKER_FILE);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.stop_markers_read_failed", err, {
        filePath,
      });
    }
    return [];
  }

  const out: ParsedMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const stoppedAt =
        typeof entry.stoppedAt === "string" ? entry.stoppedAt : undefined;
      if (!stoppedAt) continue;
      out.push({
        role: "assistant",
        type: "stopped",
        content: "Stopped by user",
        timestamp: stoppedAt,
      });
    } catch (err) {
      rootLogger.info(
        {
          event: "routes.messages.stop_markers_bad_line",
          filePath,
          expected: true,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "unparseable stop-marker line",
      );
    }
  }
  return out;
}

/** Read finished background-task replies for a web session. Each record
 * is an assistant text message; bg replies originate in a separate
 * `bg/<taskId>` session, so they never appear in this session's CLI
 * transcript and need no dedupe — just a timestamped merge. */
export function readBgReplies(sessionDir: string): ParsedMessage[] {
  const filePath = path.join(sessionDir, BG_REPLY_FILE);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.bg_replies_read_failed", err, {
        filePath,
      });
    }
    return [];
  }

  const out: ParsedMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry.content === "string" && typeof entry.timestamp === "string") {
        out.push({
          role: "assistant",
          type: "text",
          content: entry.content,
          timestamp: entry.timestamp,
        });
      }
    } catch (err) {
      rootLogger.info(
        {
          event: "routes.messages.bg_replies_bad_line",
          filePath,
          expected: true,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        "unparseable bg-reply line",
      );
    }
  }
  return out;
}

function parseJsonlMessages(filePath: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === "user") {
          if (entry.isMeta) continue;
          const msg = entry.message;
          if (!msg) continue;

          const text =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter((b: { type: string }) => b.type === "text")
                    .map((b: { text: string }) => b.text)
                    .join("")
                : "";

          // Strip the source-tag prefix that submitTurnCore prepends to
          // every user turn (currently `http` for workspace chat,
          // `creator` for the agent creator). The model needs the
          // tag at runtime; the UI doesn't, so it's removed on
          // history replay rather than being kept as a turn-1 surprise.
          const cleaned = text.replace(/^\[(?:http|creator) caller_id=[^\]]*\]\n?/, "");
          if (cleaned) {
            messages.push({
              role: "user",
              type: "text",
              content: cleaned,
              timestamp: entry.timestamp,
            });
          }
        } else if (entry.type === "assistant") {
          const blocks = entry.message?.content;
          if (!Array.isArray(blocks)) continue;

          for (const block of blocks) {
            if (block.type === "text") {
              messages.push({
                role: "assistant",
                type: "text",
                content: block.text,
                timestamp: entry.timestamp,
              });
            } else if (block.type === "tool_use") {
              messages.push({
                role: "assistant",
                type: "tool_use",
                content: `Tool: ${block.name}`,
                toolName: block.name,
                toolInput: block.input,
                timestamp: entry.timestamp,
              });
            }
          }
        } else if (entry.type === "tool_result") {
          const resultContent = entry.content;
          const text =
            typeof resultContent === "string"
              ? resultContent
              : Array.isArray(resultContent)
                ? resultContent
                    .filter((b: { type: string }) => b.type === "text")
                    .map((b: { text: string }) => b.text)
                    .join("")
                : JSON.stringify(resultContent);
          messages.push({
            role: "assistant",
            type: "tool_result",
            content: text,
            toolName: entry.tool_use_id,
            timestamp: entry.timestamp,
          });
        }
      } catch (err) {
        // Unparseable lines are expected for in-progress writes. Log
        // at debug so a sustained rate of bad lines is still visible.
        rootLogger.info(
          {
            event: "routes.messages.bad_jsonl_line",
            filePath,
            expected: true,
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "unparseable jsonl line",
        );
      }
    }
  } catch (err) {
    if (!isEnoent(err)) {
      logCatch(rootLogger, "routes.messages.transcript_read_failed", err, { filePath });
    }
  }

  return messages;
}

export function handleMessages(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) {
    return json(res, 400, { error: "Invalid session" });
  }

  const jsonlPath = findSessionJsonl(sub, sessionId);
  if (jsonlPath && !jsonlPath.startsWith(resolved)) {
    return json(res, 400, { error: "Invalid transcript path" });
  }

  const transcript = jsonlPath ? parseJsonlMessages(jsonlPath) : [];
  const stopMarkers = readStopMarkers(resolved);
  const recoveredUsers = dedupeAgainstTranscript(readUserSubmissions(resolved), transcript);
  const bgReplies = readBgReplies(resolved);

  // Stable merge by timestamp: undefined timestamps stay in their original
  // relative order at the end. Stop markers and bg replies always have
  // timestamps.
  const indexed = [...transcript, ...stopMarkers, ...recoveredUsers, ...bgReplies].map((m, i) => ({ m, i }));
  indexed.sort((a, b) => {
    const ta = a.m.timestamp ?? "";
    const tb = b.m.timestamp ?? "";
    if (ta === tb) return a.i - b.i;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta < tb ? -1 : 1;
  });
  const messages = indexed.map(({ m }) => m);

  json(res, 200, { messages });
}

/**
 * GET /api/agents/:agentId/creator/messages — transcript for a creator
 * session. The creator's Claude CLI HOME lives at
 * /data/agents/{agentId}/.creator-home (NOT under the regular
 * /data/sessions/http tree), so we point findBestJsonlIn at that
 * path and skip the regular session's stop-marker / user-submission
 * side files — creator sessions don't maintain those.
 */
export function handleCreatorMessages(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) {
    return json(res, 400, { error: "Invalid agentId" });
  }
  const projectsDir = path.join(
    agentPaths(agentId).creatorHome,
    ".claude",
    "projects",
  );
  const jsonlPath = findBestJsonlIn(projectsDir);
  const messages = jsonlPath ? parseJsonlMessages(jsonlPath) : [];
  json(res, 200, { messages });
}

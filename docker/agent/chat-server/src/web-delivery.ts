/**
 * web-delivery.ts — out-of-band message delivery to a web (HTTP) session.
 *
 * The web chat UI is not a Chat SDK adapter, so messages that don't ride
 * the turn's own SSE stream (a finished background task's reply, OR a
 * mid-task `chat_send` from a web-originated bg task) are delivered by
 * appending to the session's durable transcript side-file. The browser
 * merges these into the displayed history on its next load/poll (nudged
 * immediately by a `publishInbox(sessionKey, "bg_reply")` from the
 * caller), so they appear incrementally as the task produces them — the
 * closest web equivalent to a live `chat_send`.
 *
 * Reader side: routes/messages.ts:readBgReplies parses the same JSONL
 * record shape ({ content, timestamp, taskId }) — keep them in sync.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionPath } from "./paths.js";
import { rootLogger, logCatch } from "./logger.js";

/** Side-file under the session dir holding out-of-band web messages. */
export const BG_REPLY_FILE = ".bg-replies.jsonl";

/**
 * Resolve a web session key (`http/<sub>/<sessionId>`) to its on-disk
 * session directory. Returns null if the key isn't a well-formed http
 * session key or the dir can't be resolved (e.g. traversal id rejected
 * by resolveSessionPath's per-member boundary check).
 */
export function webSessionDir(sessionKey: string): string | null {
  const parts = sessionKey.split("/");
  if (parts.length !== 3 || parts[0] !== "http") return null;
  const [, sub, sessionId] = parts;
  return resolveSessionPath(sub, sessionId);
}

/**
 * Append one assistant-message record to a web session's transcript
 * side-file. Returns true on success. Pure fs — the caller resolves the
 * dir (via webSessionDir). `taskId` is recorded but only used for
 * tracing; the reader keys messages by content + timestamp.
 */
export function appendWebSessionMessage(
  sessionDir: string,
  content: string,
  taskId = "chat_send",
): boolean {
  try {
    appendFileSync(
      join(sessionDir, BG_REPLY_FILE),
      JSON.stringify({ content, timestamp: new Date().toISOString(), taskId }) + "\n",
    );
    return true;
  } catch (err) {
    logCatch(rootLogger, "web_delivery.append_failed", err, { sessionDir });
    return false;
  }
}

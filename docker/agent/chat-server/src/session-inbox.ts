/**
 * session-inbox.ts — per-session out-of-band push channel.
 *
 * The per-turn SSE stream (routes/chat.ts) only exists while a turn is
 * running, keyed by requestId. But some updates land *between* turns —
 * most importantly a background task's reply, which finalizes long after
 * the spawning turn's stream has closed, plus any files that task wrote.
 *
 * The inbox is a single long-lived SSE connection the browser opens for
 * the whole time a session view is mounted (keyed by sessionKey, not
 * requestId). The server holds the open connections per session and
 * `publishInbox` fans an event out to them, so the UI can react instantly
 * instead of polling. Events carry no payload the client needs to trust —
 * they're just a nudge to refetch (loadHistory / loadTree).
 *
 * This works as a plain in-memory map because one chat-server process
 * serves a whole workspace (all its sessions); there's no horizontal fan
 * to bridge with a shared pub/sub.
 */

import * as http from "node:http";
import { openSse, type SseConnection } from "./sse.js";
import { rootLogger } from "./logger.js";

/** sessionKey -> open inbox connections for that session. */
const inboxes = new Map<string, Set<SseConnection>>();

/**
 * Open an SSE inbox for `sessionKey` and keep it registered until the
 * client disconnects. Caller is responsible for auth (the route is under
 * the JWT-authenticated /api layer and derives sessionKey from the
 * authenticated `sub`).
 */
export function subscribeInbox(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionKey: string,
): void {
  const conn = openSse(req, res);
  let set = inboxes.get(sessionKey);
  if (!set) {
    set = new Set();
    inboxes.set(sessionKey, set);
  }
  set.add(conn);
  // A comment line both flushes headers and gives the client a signal it
  // can ignore (it isn't an `event:`/`data:` line).
  conn.comment("inbox open");

  req.on("close", () => {
    const s = inboxes.get(sessionKey);
    if (!s) return;
    s.delete(conn);
    if (s.size === 0) inboxes.delete(sessionKey);
  });

  rootLogger.info(
    { event: "inbox.subscribe", sessionKey, subscribers: set.size },
    "session inbox subscribed",
  );
}

/**
 * Push an event to every open inbox for `sessionKey`. No-op when nothing
 * is listening (the common case — nobody has the session open). Dead
 * connections are skipped by openSse's own alive guard.
 */
export function publishInbox(sessionKey: string, event: string, data: unknown = {}): void {
  const set = inboxes.get(sessionKey);
  if (!set || set.size === 0) return;
  for (const conn of set) conn.send(event, data);
  rootLogger.info(
    { event: "inbox.publish", sessionKey, name: event, subscribers: set.size },
    "session inbox published",
  );
}

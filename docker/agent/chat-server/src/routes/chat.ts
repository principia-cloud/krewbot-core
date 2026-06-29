/**
 * chat.ts — HTTP chat route handlers.
 *
 * Delegates to Chat SDK's submitHttpChat() for agent turns.
 * SSE streaming uses an EventEmitter bridge: intermediate Agent SDK
 * events (text chunks, tool calls, tool results) are forwarded as
 * "message" SSE events, and the final result as a "done" event.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import { resolveSessionPath } from "../paths.js";
import { submitHttpChat } from "../chat.js";
import { openSse } from "../sse.js";
import { publishInbox } from "../session-inbox.js";
import { rootLogger, logCatch } from "../logger.js";
import { runAgentTurn, AT_CAPACITY, renderAtCapacityReply } from "../agent.js";
import { AGENT_ID_RE } from "../agent-def.js";

/** Per-session file where cancelChat appends stop-marker records.
 * Each line is a JSON object with at least { stoppedAt: ISO8601 }. Read by
 * routes/messages.ts and merged into the transcript by timestamp so the
 * "— Stopped by user —" marker persists across page reloads. */
const STOP_MARKER_FILE = ".stopped-turns.jsonl";

/** Per-session file where every inbound user message is recorded
 * eagerly — BEFORE the Claude CLI subprocess even starts. Safety net for
 * turns aborted during the "thinking" phase: the CLI's own transcript
 * JSONL may not have been flushed when SIGKILL lands, so without this
 * we'd lose the user's message on refresh. handleMessages merges these
 * records into the displayed history, dedup'd against any transcript
 * user message that survived (same content, timestamps close together). */
const USER_SUBMISSIONS_FILE = ".user-submissions.jsonl";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

interface TurnEntry {
  emitter: EventEmitter;
  /** Buffered intermediate events — filled before the SSE client connects. */
  bufferedMessages: unknown[];
  /** Buffered final result — set when the turn completes before SSE connects. */
  result?: unknown;
  /** Fired by cancelChat to interrupt the in-flight Agent SDK query. */
  abortController: AbortController;
}

/** In-memory tracking of active turns for SSE streaming. */
const activeTurns = new Map<string, TurnEntry>();

/** Index of resolved-session-path → requestId for the turn currently
 * running in that session. Lets a reloaded web client discover the
 * in-flight turn (its requestId lived only in the old page's memory) and
 * reconnect to the live stream. Set when a turn starts, cleared when it
 * finishes — so it only ever points at a still-running turn. */
const activeBySession = new Map<string, string>();

/** Clean up a turn after a delay, giving the SSE client time to connect. */
function scheduleTurnCleanup(requestId: string, delayMs = 30_000): void {
  setTimeout(() => activeTurns.delete(requestId), delayMs);
}

/** Clear the session→requestId index iff it still points at this turn.
 * Guards against a newer turn in the same session being clobbered by an
 * older turn's late completion. */
function clearActiveBySession(resolvedPath: string, requestId: string): void {
  if (activeBySession.get(resolvedPath) === requestId) {
    activeBySession.delete(resolvedPath);
  }
}

/**
 * Convert a raw Agent SDK event into one or more compact SSE payloads.
 * Returns an array of events to stream (empty if the event is not relevant).
 */
function toStreamEvents(raw: unknown): unknown[] {
  const evt = raw as Record<string, unknown>;
  const results: unknown[] = [];

  // Assistant messages contain content blocks: text chunks and/or tool_use.
  // Each block becomes its own SSE event so the frontend can render them
  // incrementally (text appended, tool calls appearing one by one).
  if (evt.type === "assistant" && evt.message) {
    const content = (evt.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          results.push({ type: "text", content: block.text });
        } else if (block?.type === "tool_use") {
          results.push({
            type: "tool_use",
            name: block.name,
            input: block.input,
          });
        }
      }
    }
    return results;
  }

  // Tool results — truncated to 2 KB to keep the SSE payload reasonable.
  if (evt.type === "result") {
    const content = (evt as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const textParts = (content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string);
      if (textParts.length > 0) {
        results.push({
          type: "tool_result",
          content: textParts.join("\n").slice(0, 2000),
          tool_use_id: (evt as Record<string, unknown>).tool_use_id,
        });
      }
    }
    return results;
  }

  return results;
}

/**
 * POST /api/sessions/:id/chat — submit a user turn.
 * Returns a requestId for SSE streaming.
 */
export function submitChat(
  body: string,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  email?: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) return json(res, 400, { error: "Invalid session" });

  let parsed: { message: string };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    logCatch(rootLogger, "routes.chat.submit.bad_json", err, { sessionId, userId: sub });
    return json(res, 400, { error: "Invalid JSON body" });
  }

  if (!parsed.message || typeof parsed.message !== "string")
    return json(res, 400, { error: "message field is required" });

  const requestId = crypto.randomUUID();
  try {
    fs.appendFileSync(
      path.join(resolved, USER_SUBMISSIONS_FILE),
      JSON.stringify({
        content: parsed.message,
        timestamp: new Date().toISOString(),
        requestId,
      }) + "\n",
    );
  } catch (err) {
    logCatch(rootLogger, "routes.chat.submit.submission_write_failed", err, {
      sessionId,
      userId: sub,
      requestId,
    });
  }
  const abortController = new AbortController();
  const entry: TurnEntry = {
    emitter: new EventEmitter(),
    bufferedMessages: [],
    abortController,
  };
  activeTurns.set(requestId, entry);
  activeBySession.set(resolved, requestId);

  // Forward intermediate Agent SDK events to the SSE client.
  const onEvent = (rawEvent: unknown) => {
    const streamEvents = toStreamEvents(rawEvent);
    for (const streamEvt of streamEvents) {
      entry.bufferedMessages.push(streamEvt);
      entry.emitter.emit("message", streamEvt);
    }
  };

  submitHttpChat({ sub, sessionId, message: parsed.message, email, onEvent, abortController })
    .then((result) => {
      entry.result = result;
      entry.emitter.emit("done", result);
      // The chat itself updated live over this turn's SSE stream; nudge the
      // inbox so the file tree refetches any files the turn wrote.
      publishInbox(`http/${sub}/${sessionId}`, "files_changed", {});
      clearActiveBySession(resolved, requestId);
      scheduleTurnCleanup(requestId);
    })
    .catch((err) => {
      logCatch(rootLogger, "routes.chat.submit.turn_failed", err, {
        sessionId,
        userId: sub,
        requestId,
      });
      const errorResult = { reply: "", error: String(err) };
      entry.result = errorResult;
      entry.emitter.emit("done", errorResult);
      clearActiveBySession(resolved, requestId);
      scheduleTurnCleanup(requestId);
    });

  json(res, 202, { requestId });
}

/**
 * GET /api/sessions/:id/chat/stream?requestId=... — SSE endpoint.
 */
export function streamChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) return json(res, 400, { error: "Invalid session" });

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requestId = url.searchParams.get("requestId");
  if (!requestId) return json(res, 400, { error: "requestId query parameter is required" });
  // replay=false: a reconnecting client (e.g. after a page refresh) that has
  // already loaded the persisted transcript only wants events from here on —
  // replaying the full buffer would duplicate what history already shows.
  const replay = url.searchParams.get("replay") !== "false";

  const entry = activeTurns.get(requestId);
  if (!entry) return json(res, 404, { error: "No active turn for this requestId" });

  const sse = openSse(req, res);

  // Replay any intermediate events that arrived before the SSE client connected.
  if (replay) {
    for (const buffered of entry.bufferedMessages) {
      sse.send("message", buffered);
    }
  }

  // If the turn already completed, send the result and close.
  if (entry.result !== undefined) {
    sse.send("done", entry.result);
    sse.close();
    activeTurns.delete(requestId);
    return;
  }

  // Live-forward intermediate events.
  const onMessage = (data: unknown) => {
    if (!sse.alive) return;
    sse.send("message", data);
  };

  const onDone = (result: unknown) => {
    if (!sse.alive) return;
    sse.send("done", result);
    sse.close();
  };

  entry.emitter.on("message", onMessage);
  entry.emitter.on("done", onDone);
  req.on("close", () => {
    entry.emitter.off("message", onMessage);
    entry.emitter.off("done", onDone);
  });
}

/**
 * GET /api/sessions/:id/chat/active — report the requestId of the turn
 * currently running in this session, or null. A web client that reloaded
 * mid-turn calls this to rediscover the in-flight turn and reconnect to its
 * live stream (with replay=false, since it already has the transcript).
 * Only returns a requestId while the turn is still running — a finished
 * turn lingering in activeTurns (30s cleanup grace) reports null so the
 * client just relies on the loaded transcript.
 */
export function getActiveTurn(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) return json(res, 400, { error: "Invalid session" });

  const requestId = activeBySession.get(resolved);
  const entry = requestId ? activeTurns.get(requestId) : undefined;
  // Running iff we have an entry that hasn't produced its final result yet.
  if (requestId && entry && entry.result === undefined) {
    return json(res, 200, { requestId });
  }
  return json(res, 200, { requestId: null });
}

/**
 * DELETE /api/sessions/:id/chat/:requestId — cancel an in-flight turn.
 * Fires the AbortController threaded into the Agent SDK's query(). The
 * turn resolves through the normal `done` path with `aborted: true`,
 * so the SSE client receives a terminal event and closes cleanly.
 */
export function cancelChat(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  sessionId: string,
  requestId: string,
): void {
  const resolved = resolveSessionPath(sub, sessionId);
  if (!resolved) return json(res, 400, { error: "Invalid session" });

  const entry = activeTurns.get(requestId);
  if (!entry) {
    // Already finished or never existed. Idempotent from the client's POV.
    return json(res, 404, { error: "No active turn for this requestId" });
  }

  if (entry.abortController.signal.aborted) {
    return json(res, 200, { cancelled: true, alreadyAborted: true });
  }

  entry.abortController.abort();
  try {
    const stoppedAt = new Date().toISOString();
    fs.appendFileSync(
      path.join(resolved, STOP_MARKER_FILE),
      JSON.stringify({ stoppedAt }) + "\n",
    );
  } catch (err) {
    logCatch(rootLogger, "routes.chat.cancel.marker_write_failed", err, {
      userId: sub,
      sessionId,
      requestId,
    });
  }
  rootLogger.info(
    { event: "routes.chat.cancel", userId: sub, sessionId, requestId },
    "turn cancelled by user",
  );
  json(res, 200, { cancelled: true });
}

// ---------------------------------------------------------------------------
// Agent-scoped HTTP chat (creator + test) — thin variants of the normal
// submit/stream/cancel triplet that target sessionKey flavours the SDK
// routes into special-case turn handlers (runCreatorTurnImpl,
// runTestTurnImpl). No user-session-tree writes, no stop-marker /
// submission logs — these conversations are short-lived and scoped to
// one agent.
//
// The three route kinds share one implementation core
// (`submitTurnCore` + `streamTurnCore` + `cancelTurnCore`) and vary
// only in the sessionKey they build and the prompt preamble tag.
// ---------------------------------------------------------------------------

function invalidAgentId(res: http.ServerResponse): void {
  json(res, 400, { error: "Invalid agentId" });
}

interface AgentTurnCoreOpts {
  sessionKey: string;
  /** Short tag woven into the caller-id prompt preamble, e.g.
   * "creator" / "test". Also used as the logEvent namespace. */
  sourceTag: string;
  /** Structured-log fields added to the submit/turn_failed events. */
  logContext: Record<string, unknown>;
  sub: string;
  email?: string;
  message: string;
}

function submitTurnCore(
  res: http.ServerResponse,
  opts: AgentTurnCoreOpts,
): void {
  const requestId = crypto.randomUUID();
  const abortController = new AbortController();
  const entry: TurnEntry = {
    emitter: new EventEmitter(),
    bufferedMessages: [],
    abortController,
  };
  activeTurns.set(requestId, entry);

  const onEvent = (rawEvent: unknown) => {
    const streamEvents = toStreamEvents(rawEvent);
    for (const streamEvt of streamEvents) {
      entry.bufferedMessages.push(streamEvt);
      entry.emitter.emit("message", streamEvt);
    }
  };

  const prompt = `[${opts.sourceTag} caller_id=${opts.sub}${
    opts.email ? ` email=${opts.email}` : ""
  }]\n${opts.message}`;

  rootLogger.info(
    {
      event: `routes.${opts.sourceTag}.submit`,
      sessionKey: opts.sessionKey,
      userId: opts.sub,
      requestId,
      ...opts.logContext,
    },
    `${opts.sourceTag} turn submit`,
  );

  runAgentTurn({
    sessionKey: opts.sessionKey,
    prompt,
    callerId: opts.sub,
    callerEmail: opts.email,
    source: "http",
    onEvent,
    abortController,
  })
    .then((result) => {
      if (result.error === AT_CAPACITY) {
        rootLogger.warn(
          {
            event: `routes.${opts.sourceTag}.at_capacity`,
            sessionKey: opts.sessionKey,
            userId: opts.sub,
            requestId,
            capacity: result.capacity,
            ...opts.logContext,
          },
          "turn rejected by TurnQueue (at capacity)",
        );
        const friendly = { reply: renderAtCapacityReply(result.capacity) };
        entry.result = friendly;
        entry.emitter.emit("done", friendly);
        scheduleTurnCleanup(requestId);
        return;
      }
      entry.result = result;
      entry.emitter.emit("done", result);
      scheduleTurnCleanup(requestId);
    })
    .catch((err) => {
      logCatch(
        rootLogger,
        `routes.${opts.sourceTag}.submit.turn_failed`,
        err,
        {
          userId: opts.sub,
          requestId,
          ...opts.logContext,
        },
      );
      const errorResult = { reply: "", error: String(err) };
      entry.result = errorResult;
      entry.emitter.emit("done", errorResult);
      scheduleTurnCleanup(requestId);
    });

  json(res, 202, { requestId });
}

function streamTurnCore(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requestId = url.searchParams.get("requestId");
  if (!requestId) {
    return json(res, 400, { error: "requestId query parameter is required" });
  }

  const entry = activeTurns.get(requestId);
  if (!entry) {
    return json(res, 404, { error: "No active turn for this requestId" });
  }

  const sse = openSse(req, res);

  for (const buffered of entry.bufferedMessages) {
    sse.send("message", buffered);
  }
  if (entry.result !== undefined) {
    sse.send("done", entry.result);
    sse.close();
    activeTurns.delete(requestId);
    return;
  }

  const onMessage = (data: unknown) => {
    if (!sse.alive) return;
    sse.send("message", data);
  };
  const onDone = (result: unknown) => {
    if (!sse.alive) return;
    sse.send("done", result);
    sse.close();
  };
  entry.emitter.on("message", onMessage);
  entry.emitter.on("done", onDone);
  req.on("close", () => {
    entry.emitter.off("message", onMessage);
    entry.emitter.off("done", onDone);
  });
}

function cancelTurnCore(
  res: http.ServerResponse,
  requestId: string,
  logEvent: string,
  logContext: Record<string, unknown>,
): void {
  const entry = activeTurns.get(requestId);
  if (!entry) return json(res, 404, { error: "No active turn for this requestId" });
  if (entry.abortController.signal.aborted) {
    return json(res, 200, { cancelled: true, alreadyAborted: true });
  }
  entry.abortController.abort();
  rootLogger.info(
    { event: logEvent, requestId, ...logContext },
    "turn cancelled by user",
  );
  json(res, 200, { cancelled: true });
}

// ---------------------------------------------------------------------------
// Creator chat — sessionKey `creator/agent/{agentId}`
// ---------------------------------------------------------------------------

export function submitCreatorChat(
  body: string,
  res: http.ServerResponse,
  sub: string,
  agentId: string,
  email?: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return invalidAgentId(res);

  let parsed: { message: string };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    logCatch(rootLogger, "routes.creator.submit.bad_json", err, {
      agentId,
      userId: sub,
    });
    return json(res, 400, { error: "Invalid JSON body" });
  }
  if (!parsed.message || typeof parsed.message !== "string") {
    return json(res, 400, { error: "message field is required" });
  }

  submitTurnCore(res, {
    sessionKey: `creator/agent/${agentId}`,
    sourceTag: "creator",
    logContext: { agentId },
    sub,
    email,
    message: parsed.message,
  });
}

export function streamCreatorChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _sub: string,
  agentId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return invalidAgentId(res);
  streamTurnCore(req, res);
}

export function cancelCreatorChat(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  sub: string,
  agentId: string,
  requestId: string,
): void {
  if (!AGENT_ID_RE.test(agentId)) return invalidAgentId(res);
  cancelTurnCore(res, requestId, "routes.creator.cancel", {
    agentId,
    userId: sub,
  });
}

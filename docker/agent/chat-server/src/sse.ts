/**
 * sse.ts — Server-Sent Events connection management.
 *
 * Direct port of workspace-console/src/sse.ts.
 */

import * as http from "node:http";
import { rootLogger } from "./logger.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

// Every SSE write can hit EPIPE/ECONNRESET when the client disconnects
// mid-send. We log at debug with expected=true — these are high-volume
// events that aren't failures, but we also don't want silent catches.
function logSseWriteFailure(where: string, err: unknown): void {
  rootLogger.info(
    {
      event: "sse.write_failed",
      where,
      errMessage: err instanceof Error ? err.message : String(err),
      expected: true,
    },
    "sse write failed (client likely disconnected)",
  );
}

export interface SseConnection {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly alive: boolean;
}

export function openSse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): SseConnection {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let alive = true;

  const heartbeat = setInterval(() => {
    if (!alive) return;
    try {
      res.write(": heartbeat\n\n");
    } catch (err) {
      logSseWriteFailure("heartbeat", err);
      alive = false;
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    alive = false;
    clearInterval(heartbeat);
  });

  return {
    send(event: string, data: unknown) {
      if (!alive) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        logSseWriteFailure("send", err);
        alive = false;
      }
    },
    comment(text: string) {
      if (!alive) return;
      try {
        res.write(`: ${text}\n\n`);
      } catch (err) {
        logSseWriteFailure("comment", err);
        alive = false;
      }
    },
    close() {
      alive = false;
      clearInterval(heartbeat);
      try {
        res.end();
      } catch (err) {
        logSseWriteFailure("close", err);
      }
    },
    get alive() {
      return alive;
    },
  };
}

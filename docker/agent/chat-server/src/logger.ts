/**
 * logger.ts — Structured JSON logging for chat-server.
 *
 * Shared schema (every line):
 *   { ts, level, service, env, workspaceId?, sessionKey?, source?,
 *     adapterName?, threadId?, userId?, turnId?, event, msg, err?, ...extra }
 *
 * - One JSON object per line on stdout; CloudWatch Logs Insights parses natively.
 * - `event` is a short dotted identifier ("turn.start", "auth.jwt.invalid", ...)
 *   so CW Insights `stats count() by event` gives a clean dashboard.
 * - LOG_LEVEL env (trace|debug|info|warn|error|fatal) gates output. Default info.
 * - Errors are serialized via pino's built-in err serializer; pass them under `err`.
 */

import pino, { type Logger } from "pino";

const LEVEL = process.env.LOG_LEVEL ?? "info";
const ENV = process.env.PLATFORM_ENV ?? "unknown";
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "unknown";

export const rootLogger: Logger = pino({
  level: LEVEL,
  base: {
    service: "chat-server",
    env: ENV,
    workspaceId: WORKSPACE_ID,
    pid: process.pid,
  },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export type LogContext = {
  sessionKey?: string;
  source?: string;
  adapterName?: string;
  threadId?: string;
  userId?: string;
  turnId?: string;
  [k: string]: unknown;
};

export function withContext(logger: Logger, ctx: LogContext): Logger {
  return logger.child(ctx);
}

/**
 * Log a caught error with a consistent shape. Does not re-throw.
 * Use at every catch block so no exception goes silent.
 */
export function logCatch(
  logger: Logger,
  event: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.warn({ event, err: e, ...extra }, `${event}: ${e.message}`);
}

import * as http from "node:http";
import type { AuthResult } from "../auth.js";

export function handleMe(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  auth: Extract<AuthResult, { ok: true }>,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      userId: auth.sub,
      email: (auth.claims as Record<string, unknown>).email || null,
    }),
  );
}

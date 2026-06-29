/**
 * mcp-introspect.ts — measure how much context each stdio MCP server's
 * tool schemas occupy.
 *
 * The bundled Claude CLI's `system/init` event only carries tool *names*,
 * but the tools array sent to the API includes full descriptions + JSON
 * input schemas. Steady-state context for a fresh turn is ~110k tokens
 * with no work done; the bulk of those tokens lives in those schemas.
 *
 * This helper opens a short-lived stdio JSON-RPC handshake against each
 * server, requests `tools/list`, and returns per-tool byte sizes (exact)
 * + a per-server total. Pair the bytes with `cacheCreationInputTokens`
 * from a real turn (visible in Langfuse) to derive accurate token costs.
 */
import { spawn } from "node:child_process";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface ToolSchemaSize {
  name: string;
  bytes: number;
}

export interface ServerSchemaSizes {
  server: string;
  toolCount: number;
  totalBytes: number;
  tools: ToolSchemaSize[];
  /** When measurement failed (timeout / spawn error / non-stdio config). */
  error?: string;
}

/**
 * Measure tool-schema bytes for every stdio server in the map. Runs
 * each measurement in parallel; one server's failure doesn't block the
 * others. Caller is expected to cache the result per process — schemas
 * are deterministic given the env, so re-measuring on every turn is
 * wasted spawn cost.
 */
export async function measureMcpSchemas(
  servers: Record<string, McpStdioServerConfig>,
  timeoutMs = 30000,
): Promise<ServerSchemaSizes[]> {
  const entries = Object.entries(servers);
  const results = await Promise.all(
    entries.map(async ([name, cfg]) => {
      try {
        return await measureOne(name, cfg, timeoutMs);
      } catch (err) {
        return {
          server: name,
          toolCount: 0,
          totalBytes: 0,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        } satisfies ServerSchemaSizes;
      }
    }),
  );
  return results;
}

/** One MCP: spawn → initialize → tools/list → kill. */
function measureOne(
  name: string,
  cfg: McpStdioServerConfig,
  timeoutMs: number,
): Promise<ServerSchemaSizes> {
  return new Promise((resolve, reject) => {
    // Some MCP configs (e.g. telegram) intentionally pass a minimal env
    // — no PATH, no HOME — and rely on the SDK's CLI subprocess to
    // inherit those from its own parent. When we spawn directly, we must
    // backfill PATH / HOME or python3 fails to even start. Explicit
    // values in cfg.env win.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      ...((cfg.env ?? {}) as NodeJS.ProcessEnv),
    };
    const proc = spawn(cfg.command, cfg.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore — process already gone.
      }
      reject(new Error(`tools/list timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (r: ServerSchemaSizes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore.
      }
      resolve(r);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore.
      }
      reject(err);
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // Line-delimited JSON-RPC.
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          msg.id === 2 &&
          typeof msg.result === "object" &&
          msg.result !== null &&
          Array.isArray((msg.result as { tools?: unknown[] }).tools)
        ) {
          const tools = (msg.result as { tools: unknown[] }).tools.map((t) => {
            const o = t as Record<string, unknown>;
            const tname = typeof o.name === "string" ? o.name : "?";
            return { name: tname, bytes: JSON.stringify(t).length };
          });
          finish({
            server: name,
            toolCount: tools.length,
            totalBytes: tools.reduce((s, x) => s + x.bytes, 0),
            tools,
          });
        }
      }
    });

    // Cap stderr capture — broken MCPs sometimes emit unbounded errors.
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 4096) stderrBuf += chunk.toString("utf8");
    });

    proc.on("error", (err) => fail(err));
    proc.on("exit", (code, signal) => {
      if (settled) return;
      const tail = stderrBuf.trim().slice(-512);
      fail(
        new Error(
          `mcp ${name} exited before tools/list (code=${code} signal=${signal})${
            tail ? ` stderr: ${tail}` : ""
          }`,
        ),
      );
    });

    const send = (msg: object) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    };

    // JSON-RPC handshake: initialize, notifications/initialized, tools/list.
    // Most MCP servers refuse tool calls before initialize completes.
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "example-introspect", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

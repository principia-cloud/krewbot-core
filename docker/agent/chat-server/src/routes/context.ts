import * as fs from "node:fs";
import * as http from "node:http";
import { resolveContextPath, listContextFiles } from "../paths.js";
import { buildWikiGraph, parseFrontmatter } from "../wiki.js";
import { rootLogger, logCatch } from "../logger.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function handleListContext(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  json(res, 200, listContextFiles());
}

/**
 * Knowledge graph: every KB page as a node, every `[[wikilink]]` as an edge,
 * plus frontier nodes for linked-but-missing pages. Powers the graph view.
 */
export function handleContextGraph(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  try {
    json(res, 200, buildWikiGraph());
  } catch (err) {
    logCatch(rootLogger, "routes.context.graph.failed", err);
    json(res, 500, { error: "Failed to build knowledge graph" });
  }
}

export function handleReadContext(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  name: string,
): void {
  const resolved = resolveContextPath(name);
  if (!resolved) {
    return json(res, 400, { error: "Invalid context file name" });
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const stat = fs.statSync(resolved);
    const { data } = parseFrontmatter(content);
    json(res, 200, {
      name,
      content,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      frontmatter: data,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      rootLogger.info(
        { event: "routes.context.read.missing", name, expected: true },
        "context file not found",
      );
    } else {
      logCatch(rootLogger, "routes.context.read.failed", err, { name, code });
    }
    json(res, 404, { error: "Context file not found" });
  }
}

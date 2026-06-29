/**
 * Unit tests for the knowledge-wiki parser + graph builder (src/wiki.ts).
 *
 * parseFrontmatter / extractWikiLinks are pure and tested directly.
 * buildWikiGraph reads USER_CONTEXT_DIR (derived from DATA_DIR at module load
 * in paths.ts), so DATA_DIR is set and a temp KB is materialized BEFORE the
 * dynamic import.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "wiki-"));
const KB = join(TMP, "user_context");
mkdirSync(join(KB, "streams"), { recursive: true });

// index.md links to two real pages + one missing (frontier).
writeFileSync(
  join(KB, "index.md"),
  `---\ntitle: Index\ntype: index\n---\n\nSee [[Acme]] and [[streams/widgets]] and [[Nonexistent Page]].\n`,
);
writeFileSync(
  join(KB, "acme.md"),
  `---\ntitle: Acme\ntype: entity\ntags: [customer, enterprise]\nconfidence: high\nmaturity: mature\n---\n\nAcme relates to [[streams/widgets|the widgets stream]].\n`,
);
writeFileSync(
  join(KB, "streams", "widgets.md"),
  `---\ntitle: Widgets\ntype: concept\nmaturity: draft\n---\n\nBacklink to [[Acme#history]] here.\n`,
);

process.env.DATA_DIR = TMP;

const { parseFrontmatter, extractWikiLinks, buildWikiGraph } = await import("../src/wiki.ts");

after(() => rmSync(TMP, { recursive: true, force: true }));

describe("parseFrontmatter", () => {
  it("parses scalars, inline arrays, and a body", () => {
    const { data, body } = parseFrontmatter(
      `---\ntitle: Acme\ntype: entity\ntags: [a, b]\n---\n\nHello [[X]].`,
    );
    assert.equal(data.title, "Acme");
    assert.equal(data.type, "entity");
    assert.deepEqual(data.tags, ["a", "b"]);
    assert.equal(body.trim(), "Hello [[X]].");
  });

  it("parses block-list arrays", () => {
    const { data } = parseFrontmatter(`---\ntags:\n  - one\n  - two\n---\nbody`);
    assert.deepEqual(data.tags, ["one", "two"]);
  });

  it("returns empty data when no frontmatter", () => {
    const { data, body } = parseFrontmatter("just text [[Y]]");
    assert.deepEqual(data, {});
    assert.equal(body, "just text [[Y]]");
  });
});

describe("extractWikiLinks", () => {
  it("dedups and strips alias + anchor", () => {
    const links = extractWikiLinks("[[Acme]] [[Acme|alias]] [[Widgets#history]] [[Acme]]");
    assert.deepEqual(links.sort(), ["Acme", "Widgets"]);
  });
});

describe("buildWikiGraph", () => {
  it("builds nodes from real pages only, resolves links by basename/path, counts inbound", () => {
    const g = buildWikiGraph();

    // Only real pages are nodes — links to missing pages are dropped entirely.
    const ids = g.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ["acme.md", "index.md", "streams/widgets.md"]);

    // No node or edge for the missing "[[Nonexistent Page]]" link.
    assert.ok(!g.nodes.some((n) => n.title === "Nonexistent Page"));
    assert.ok(!g.edges.some((e) => e.target.toLowerCase().includes("nonexistent")));

    // Acme is linked from index.md and streams/widgets.md → inbound 2.
    const acme = g.nodes.find((n) => n.id === "acme.md")!;
    assert.equal(acme.inbound, 2);
    assert.equal(acme.type, "entity");
    assert.equal(acme.maturity, "mature");
    assert.deepEqual(acme.tags, ["customer", "enterprise"]);

    // widgets resolved by full relative path ([[streams/widgets]]) AND basename
    // ([[streams/widgets|...]] from acme) — both land on the same node.
    const widgets = g.nodes.find((n) => n.id === "streams/widgets.md")!;
    assert.equal(widgets.inbound, 2);

    // Edge from index.md → acme.md exists; no self-loops.
    assert.ok(g.edges.some((e) => e.source === "index.md" && e.target === "acme.md"));
    assert.ok(!g.edges.some((e) => e.source === e.target));
  });
});

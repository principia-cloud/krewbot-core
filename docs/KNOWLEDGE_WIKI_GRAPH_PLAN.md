# Knowledge Wiki + Graph View — Implementation Plan

Goal: replace the rigid 4-file context KB with a Karpathy-style LLM wiki, and add an
Obsidian-style **graph view** (default) alongside a **list view**, as the way to
manage "knowledge" in krewbot.

Decisions (from owner):
1. Build in **core** (`krewbot-self-hosted`) so downstream overlays inherit it.
2. **Evolve** the existing git-backed KB — drop the fixed 4-file schema, adopt
   free-form nested wiki pages. Add a **Graph ⇄ List toggle**, graph default.
3. Graph lib: pick best/most modern → **react-force-graph-2d** (d3-force, canvas),
   custom node painting for a modern look. (Sigma.js/WebGL is the fallback if scale demands.)
4. Knowledge only — no people/chats edges for now.
5. Adopt the full Karpathy maintenance workflow in the agent.

## Current state (verified)
- KB repo: git-backed on EFS at `/data/user_context` (local commits = audit log).
- `context_mcp.py`: already allows arbitrary nested `.md` paths; only the docstring
  says "flat four-file". Tools: read/list/write/push_context.
- Route (`routes/context.ts` + `paths.ts`): `GET /api/context` (recursive list) +
  `GET /api/context/*` (read one). Read-only from web; agent writes via MCP.
- `web/src/pages/workspace/knowledge-view.tsx`: rigid `categorize()` → Rules/Memory/
  Context tabs keyed off the old filenames. **This is the rigid part to replace.**
- `GENERAL_AGENT.md`: already a hierarchical stream + index model with "compound
  knowledge" — partway to Karpathy; lacks `[[wikilinks]]`, frontmatter, lint.

## A. Conventions (Karpathy-style)
- Free-form nested `.md` pages under the KB repo.
- YAML frontmatter per page: `title`, `type` (entity|concept|summary|synthesis|
  comparison|index|overview), `tags[]`, `confidence` (high|medium|low),
  `maturity` (stub|draft|substantial|mature), `created`, `updated`, `sources[]`.
- `[[wikilink]]` cross-references → graph edges.
- Special pages: `index.md` (catalog) + `log.md` (chronological ingest/query/lint).

## B. Backend (chat-server)
- New `GET /api/context/graph` → parse all KB `.md`: extract frontmatter + `[[links]]`.
  Returns `{ nodes: [{id, title, type, tags, confidence, maturity, inbound, frontier}],
  edges: [{source, target}] }`. Frontier = linked-but-missing pages (gaps).
- Extend read to optionally return parsed frontmatter.
- Tiny frontmatter + wikilink parser util (gray-matter or ~30-line regex; no heavy dep).

## C. Frontend (core `web/`)
- Add `react-force-graph-2d` + `d3-force`.
- Rework `knowledge-view.tsx`: header **Graph | List** toggle (graph default).
- Graph: global force-directed; node size ∝ inbound links; color by type (or maturity);
  hover dims non-neighbors; click → side panel renders the page markdown; depth-limited
  local graph from a focused node; frontier nodes hollow.
- List: searchable flat list, frontmatter badges (type/maturity/confidence), click → markdown.
- Modern styling consistent with shadcn/ui; graceful empty state.

## D. Agent prompt + MCP
- `GENERAL_AGENT.md`: define page types, `[[wikilinks]]`, frontmatter, index.md/log.md;
  ingestion workflow (source → summary → update entities/concepts → cross-refs → log);
  lint workflow (orphans, broken links, frontier gaps, contradictions, stale claims).
- `context_mcp.py`: refresh docstring; add `lint_wiki()` (orphans/broken/frontier report);
  keep existing verbs; ensure write tolerates frontmatter.

## E. Docs (repo rule)
- Update `CLAUDE.md` gotchas + `docs/SANDBOX_PLATFORM.md` decision log.

## F. Downstream overlay
- Core ships the new view; the overlay inherits via `npm update @krewbot/platform-core`
  + `prebuild:web` merge. Confirm no overlay override of knowledge-view; router redirect stays.

## Out of scope (v1)
- `raw/` source-upload/ingest pipeline (agent ingests from chat). People/chat edges.

## Branch
- `feature/knowledge-wiki-graph` in `krewbot-self-hosted`.

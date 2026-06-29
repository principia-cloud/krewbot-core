"""Context MCP — read/write/commit the team's interlinked knowledge wiki.

The knowledge base is an LLM-maintained wiki: a directory of markdown pages on
EFS at USER_CONTEXT_DIR (default /data/user_context), cross-linked with
``[[wikilinks]]`` and decorated with YAML frontmatter (type / tags / confidence
/ maturity). `push_context` commits against a **local git repo on EFS** — there
is no remote, no GitHub token, no network. Every push is a real commit; git log
shows the audit trail of every modification with per-caller author attribution.

There is **no fixed filename schema** — any ``.md`` path inside the wiki dir is
allowed (nested folders welcome). Page conventions (frontmatter, wikilinks,
index.md / log.md, the lint workflow) are described in the agent's system prompt
and enforced by convention, not by this MCP. `lint_wiki` reports health issues
(orphans, broken/frontier links, missing index entries).

Authorization: any workspace member can modify the wiki. Non-members are
refused. Identity is matched by telegramUserId (Telegram turns) or
userId / Cognito sub (HTTP turns).

Env vars (set by chat-server's agent.ts:buildMcpServers per turn):
  USER_CONTEXT_DIR      path to the local git repo on EFS
  CONTEXT_COMMIT_AUTHOR git --author string for this turn's commits
  SESSION_CALLER_ID     Telegram user_id or Cognito sub
  INBOUND_SOURCE        adapter name ("telegram", "slack", "whatsapp",
                        "teams", "web", "http", "cron")
  MEMBERS_JSON          serialized {"members":[...]} fetched from the
                        Agent Platform API at turn start
"""

import os
import re
import subprocess
import sys
from pathlib import Path

# Make colocated log.py importable under every load mode (see telegram_mcp.py).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.fastmcp import FastMCP

from platform_log import init_logger, log_catch

logger = init_logger("mcp-context")

USER_CONTEXT_DIR = os.environ.get("USER_CONTEXT_DIR", "/data/user_context")
COMMIT_AUTHOR = os.environ.get("CONTEXT_COMMIT_AUTHOR", "platform-agent <agent@localhost>")
SESSION_CALLER_ID = os.environ.get("SESSION_CALLER_ID", "")
INBOUND_SOURCE = os.environ.get("INBOUND_SOURCE", "")
MEMBERS_JSON = os.environ.get("MEMBERS_JSON", '{"members":[]}')

mcp = FastMCP("context")


def _validate_context_path(filename: str) -> Path | None:
    """Validate that filename resolves inside USER_CONTEXT_DIR and is a .md file.

    Returns the resolved Path if valid, None otherwise.  Blocks path traversal
    (``..``, symlinks escaping the root) and non-markdown files.
    """
    if not filename or not filename.endswith(".md"):
        return None
    candidate = Path(USER_CONTEXT_DIR) / filename
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, ValueError) as exc:
        log_catch(
            logger,
            "mcp.context.resolve_failed",
            exc,
            filename=filename,
        )
        return None
    context_root = Path(USER_CONTEXT_DIR).resolve(strict=False)
    if resolved == context_root or not str(resolved).startswith(str(context_root) + os.sep):
        logger.warning(
            "rejecting context path outside root",
            extra={
                "event": "mcp.context.path_escape_rejected",
                "filename": filename,
                "resolved": str(resolved),
            },
        )
        return None
    return resolved


def _load_members() -> list[dict]:
    try:
        return __import__("json").loads(MEMBERS_JSON).get("members", [])
    except Exception as exc:
        log_catch(
            logger,
            "mcp.context.members_parse_failed",
            exc,
            # Don't log the JSON blob itself — could contain PII.
            membersJsonLength=len(MEMBERS_JSON),
        )
        return []


def _find_caller(members: list[dict]) -> dict | None:
    """Find the unified member row matching the current session's caller.

    For Telegram turns: match by telegramUserId.
    For HTTP turns: match by userId (Cognito sub).
    """
    for m in members:
        if INBOUND_SOURCE == "telegram":
            if m.get("telegramUserId") == SESSION_CALLER_ID:
                return m
        else:
            if m.get("userId") == SESSION_CALLER_ID:
                return m
    return None


def _is_member() -> bool:
    return _find_caller(_load_members()) is not None


def _authorized_to_modify() -> tuple[bool, str]:
    """Gate write_context and push_context on workspace membership.

    Any listed member (admin or regular member) can modify context.
    Non-members are refused.
    """
    if _is_member():
        return True, ""
    return False, "Only team members can modify context."


def _run_git(*args: str) -> tuple[int, str, str]:
    """Run a git command inside USER_CONTEXT_DIR and return (rc, stdout, stderr)."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=USER_CONTEXT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            logger.warning(
                "git command returned non-zero",
                extra={
                    "event": "mcp.context.git.nonzero",
                    "args": list(args),
                    "returncode": proc.returncode,
                    "stderr": proc.stderr[:500],
                },
            )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError as exc:
        log_catch(
            logger,
            "mcp.context.git.binary_missing",
            exc,
            args=list(args),
        )
        return 127, "", "git binary not found in PATH"


@mcp.tool()
def read_context(filename: str) -> str:
    """Read a context file from the local user_context git repo.

    Supports paths like ``context.md``, ``streams/marketing/context.md``, etc.
    All paths must be ``.md`` files inside the context directory.
    """
    path = _validate_context_path(filename)
    if path is None:
        return f"Invalid path: {filename}. Must be a .md file inside the context directory."
    if not path.is_file():
        return f"File not found: {filename}"
    return path.read_text()


@mcp.tool()
def list_context_files() -> str:
    """List all context files and their sizes (recursive)."""
    base = Path(USER_CONTEXT_DIR)
    if not base.is_dir():
        return "user_context directory not found."

    lines = []
    for p in sorted(base.rglob("*.md")):
        rel = p.relative_to(base)
        # Skip .git internals
        if ".git" in rel.parts:
            continue
        lines.append(f"  {rel} ({p.stat().st_size} bytes)")
    if not lines:
        return "No context files found."
    return "Context files:\n" + "\n".join(lines)


@mcp.tool()
def write_context(filename: str, content: str) -> str:
    """Write/update a context file in the local user_context working tree.

    Supports paths like ``context.md``, ``streams/marketing/context.md``, etc.
    Parent directories are created automatically.
    Call push_context afterwards to commit the change to the local git repo.
    """
    path = _validate_context_path(filename)
    if path is None:
        return f"Invalid path: {filename}. Must be a .md file inside the context directory."

    ok, reason = _authorized_to_modify()
    if not ok:
        return reason

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return f"Updated {filename} locally. Call push_context to commit the change."


@mcp.tool()
def push_context(commit_message: str) -> str:
    """Commit all pending context file changes to the local git repo on EFS.

    This is a **local** commit — there is no remote in v1. The commit is the
    audit log: git log --oneline in /data/user_context shows every change.
    Author attribution comes from the CONTEXT_COMMIT_AUTHOR env var set by
    the dispatcher for this turn.

    Subject to context-mode authorization (Stage 4 — currently allow-all).
    """
    ok, reason = _authorized_to_modify()
    if not ok:
        return reason

    if not Path(USER_CONTEXT_DIR, ".git").is_dir():
        return f"user_context repo not initialized at {USER_CONTEXT_DIR}"

    rc, _, err = _run_git("add", "-A")
    if rc != 0:
        return f"git add failed: {err.strip()}"

    # If nothing changed, short-circuit with a friendly message instead of a
    # confusing "nothing to commit" error.
    rc_diff, out_diff, _ = _run_git("status", "--porcelain")
    if rc_diff == 0 and not out_diff.strip():
        return "No changes to commit."

    rc, _, err = _run_git(
        "commit",
        f"--author={COMMIT_AUTHOR}",
        "-m",
        commit_message,
    )
    if rc != 0:
        return f"git commit failed: {err.strip()}"

    rc, out_log, _ = _run_git("log", "-1", "--oneline")
    latest = out_log.strip() if rc == 0 else ""
    return f"Committed: {latest}"


_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def _wiki_links(body: str) -> set[str]:
    """Extract `[[wikilink]]` targets, stripping ``|alias`` and ``#anchor``."""
    out: set[str] = set()
    for m in _WIKILINK_RE.finditer(body):
        target = m.group(1).split("|")[0].split("#")[0].strip()
        if target:
            out.add(target)
    return out


def _norm(s: str) -> str:
    return s[:-3].strip().lower() if s.lower().endswith(".md") else s.strip().lower()


@mcp.tool()
def lint_wiki() -> str:
    """Report knowledge-wiki health issues so they can be fixed.

    Checks for: orphan pages (no inbound links), broken/frontier links
    (``[[links]]`` to pages that don't exist yet), and pages missing from
    index.md. Read-only — fix issues with write_context + push_context.
    """
    base = Path(USER_CONTEXT_DIR)
    if not base.is_dir():
        return "user_context directory not found."

    pages: dict[str, str] = {}  # rel path -> body
    for p in sorted(base.rglob("*.md")):
        rel = p.relative_to(base)
        if ".git" in rel.parts:
            continue
        try:
            pages[str(rel)] = p.read_text()
        except OSError:
            continue

    if not pages:
        return "Wiki is empty — no pages yet."

    # Lookup: normalized basename and full rel path -> canonical rel path.
    by_key: dict[str, str] = {}
    for rel in pages:
        by_key[_norm(rel)] = rel
        by_key[_norm(Path(rel).name)] = rel

    inbound: dict[str, int] = {rel: 0 for rel in pages}
    broken: set[str] = set()
    for rel, body in pages.items():
        for link in _wiki_links(body):
            target = by_key.get(_norm(link))
            if target is None:
                broken.add(link)
            elif target != rel:
                inbound[target] += 1

    special = {"index.md", "log.md"}
    orphans = sorted(
        rel for rel, n in inbound.items() if n == 0 and rel not in special
    )

    missing_index: list[str] = []
    index_body = pages.get("index.md")
    if index_body is not None:
        linked = {by_key.get(_norm(l)) for l in _wiki_links(index_body)}
        missing_index = sorted(
            rel for rel in pages if rel not in special and rel not in linked
        )

    lines = [f"Wiki lint — {len(pages)} pages."]
    if not index_body:
        lines.append("\n⚠ No index.md — create a catalog page linking all pages.")
    if not pages.get("log.md"):
        lines.append("⚠ No log.md — create a chronological ingest/query log.")
    lines.append(
        f"\nOrphans (no inbound links) [{len(orphans)}]:\n"
        + ("\n".join(f"  - {o}" for o in orphans) if orphans else "  (none)")
    )
    lines.append(
        f"\nBroken / frontier links (referenced page missing) [{len(broken)}]:\n"
        + ("\n".join(f"  - [[{b}]]" for b in sorted(broken)) if broken else "  (none)")
    )
    if index_body is not None:
        lines.append(
            f"\nPages missing from index.md [{len(missing_index)}]:\n"
            + (
                "\n".join(f"  - {m}" for m in missing_index)
                if missing_index
                else "  (none)"
            )
        )
    return "\n".join(lines)


_HEADING_RE = re.compile(r"^#+\s+(.*)$", re.MULTILINE)


def _load_pages() -> dict[str, str]:
    """Map of {relative_path: text} for every wiki page (skips .git)."""
    base = Path(USER_CONTEXT_DIR)
    out: dict[str, str] = {}
    if not base.is_dir():
        return out
    for p in sorted(base.rglob("*.md")):
        rel = p.relative_to(base)
        if ".git" in rel.parts:
            continue
        try:
            out[str(rel)] = p.read_text()
        except OSError:
            continue
    return out


def _split_front(text: str) -> tuple[str, str]:
    """Split a leading ``---`` frontmatter block from the body."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[3:end], text[end + 4 :]
    return "", text


def _front_title(front: str) -> str:
    m = re.search(r"^title:\s*(.+)$", front, re.MULTILINE)
    return m.group(1).strip().strip("\"'") if m else ""


def _front_field(front: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*(.+)$", front, re.MULTILINE)
    return m.group(1).strip().strip("\"'") if m else ""


def _front_tags(front: str) -> list[str]:
    raw = _front_field(front, "tags")
    if raw.startswith("[") and raw.endswith("]"):
        return [t.strip().strip("\"'") for t in raw[1:-1].split(",") if t.strip()]
    # Block-list form.
    m = re.search(r"^tags:\s*$", front, re.MULTILINE)
    tags: list[str] = []
    if m:
        for line in front[m.end():].splitlines():
            lm = re.match(r"\s*-\s+(.*)$", line)
            if lm:
                tags.append(lm.group(1).strip().strip("\"'"))
            elif line.strip():
                break
    return tags


def _page_title(rel: str, front: str) -> str:
    return _front_title(front) or Path(rel).stem


def _terms(query: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", query.lower()) if len(t) >= 2]


def _snippet(body: str, terms: list[str], width: int = 200) -> str:
    body = body.strip()
    low = body.lower()
    for line in body.splitlines():
        ll = line.strip().lower()
        if ll and any(t in ll for t in terms):
            s = line.strip()
            return s[:width] + ("…" if len(s) > width else "")
    # Fallback: first non-empty paragraph.
    for line in body.splitlines():
        if line.strip():
            return line.strip()[:width] + ("…" if len(line.strip()) > width else "")
    return ""


@mcp.tool()
def search_wiki(query: str, limit: int = 8) -> str:
    """Find the most relevant wiki pages for a query — use this BEFORE reading.

    Ranks pages by title / tag / heading / path / body matches (and a small
    boost for well-linked pages) so you read only the few pages that matter
    instead of the whole wiki. Returns each hit's path, title, type, tags, a
    snippet, and its outbound ``[[links]]`` so you can expand with
    wiki_neighbors. Lexical (no embeddings): match the user's wording or try a
    couple of phrasings.
    """
    terms = _terms(query)
    if not terms:
        return "Provide a non-empty query (2+ character terms)."
    pages = _load_pages()
    if not pages:
        return "Wiki is empty — no pages yet."

    # Precompute inbound counts for a light importance boost.
    by_key: dict[str, str] = {}
    for rel in pages:
        by_key[_norm(rel)] = rel
        by_key[_norm(Path(rel).name)] = rel
    inbound: dict[str, int] = {rel: 0 for rel in pages}
    for rel, text in pages.items():
        _, body = _split_front(text)
        for link in _wiki_links(body):
            tgt = by_key.get(_norm(link))
            if tgt and tgt != rel:
                inbound[tgt] += 1

    scored: list[tuple[float, str, str, str]] = []  # (score, rel, title, snippet)
    for rel, text in pages.items():
        front, body = _split_front(text)
        title = _page_title(rel, front)
        tags = [t.lower() for t in _front_tags(front)]
        headings = " \n ".join(_HEADING_RE.findall(body)).lower()
        title_l, path_l, body_l = title.lower(), rel.lower(), body.lower()
        score = 0.0
        for t in terms:
            if t in title_l:
                score += 5
            if any(t in tag for tag in tags):
                score += 4
            if t in path_l:
                score += 3
            if t in headings:
                score += 2
            c = body_l.count(t)
            if c:
                score += min(c, 6) * 0.5
        if score <= 0:
            continue
        score += min(inbound[rel], 5) * 0.3
        scored.append((score, rel, title, _snippet(body, terms)))

    if not scored:
        return f"No pages matched '{query}'. Try different wording, or list_context_files() to browse."

    scored.sort(key=lambda x: (-x[0], x[1]))
    out_lines = [f"Top {min(limit, len(scored))} of {len(scored)} matches for '{query}':\n"]
    for score, rel, title, snip in scored[:limit]:
        front, body = _split_front(pages[rel])
        ptype = _front_field(front, "type")
        tags = _front_tags(front)
        links = sorted(_wiki_links(body))
        meta = " | ".join(
            filter(None, [f"type={ptype}" if ptype else "", f"tags={tags}" if tags else ""])
        )
        out_lines.append(f"- {rel}  —  {title}" + (f"  ({meta})" if meta else ""))
        if snip:
            out_lines.append(f"    {snip}")
        if links:
            out_lines.append(f"    links: {', '.join(f'[[{l}]]' for l in links[:10])}")
    out_lines.append("\nRead the relevant ones with read_context, or expand with wiki_neighbors.")
    return "\n".join(out_lines)


@mcp.tool()
def wiki_neighbors(page: str, depth: int = 1) -> str:
    """Return the local subgraph around a page — its linked neighbors up to `depth`.

    Lets you expand context along ``[[links]]`` (both pages this one links to
    and pages that link to it) without loading the whole wiki. Each neighbor
    comes with its title + a snippet. `page` may be a path or a page name.
    """
    pages = _load_pages()
    if not pages:
        return "Wiki is empty — no pages yet."

    by_key: dict[str, str] = {}
    for rel in pages:
        by_key[_norm(rel)] = rel
        by_key[_norm(Path(rel).name)] = rel

    start = by_key.get(_norm(page))
    if start is None:
        return f"Page not found: {page}. Use search_wiki or list_context_files to find it."

    # Build undirected adjacency over resolved links.
    adj: dict[str, set[str]] = {rel: set() for rel in pages}
    for rel, text in pages.items():
        _, body = _split_front(text)
        for link in _wiki_links(body):
            tgt = by_key.get(_norm(link))
            if tgt and tgt != rel:
                adj[rel].add(tgt)
                adj[tgt].add(rel)

    depth = max(1, min(depth, 3))
    seen = {start}
    frontier = {start}
    levels: list[set[str]] = []
    for _ in range(depth):
        nxt: set[str] = set()
        for n in frontier:
            nxt |= adj[n] - seen
        if not nxt:
            break
        levels.append(nxt)
        seen |= nxt
        frontier = nxt

    front0, body0 = _split_front(pages[start])
    lines = [f"Neighborhood of {start} — {_page_title(start, front0)} (depth {depth}):"]
    if not levels:
        lines.append("  (no linked neighbors yet — this page is isolated)")
    for i, lvl in enumerate(levels, 1):
        lines.append(f"\n  hop {i}:")
        for rel in sorted(lvl):
            front, body = _split_front(pages[rel])
            lines.append(f"  - {rel}  —  {_page_title(rel, front)}")
            snip = _snippet(body, [])
            if snip:
                lines.append(f"      {snip}")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()

/**
 * agent-def-files.tsx — read-only file browser for an agent's def/
 * directory, rendered as a side panel on the creator view so the user
 * can see what the creator has built without asking it to paste
 * contents back into chat.
 *
 * Tree comes from `GET /api/agents/:id/def/files`; file contents from
 * `GET /api/agents/:id/def/files/{path}`. Polled every 3 s while the
 * panel is open so edits the creator makes mid-turn surface quickly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, File, Folder, RefreshCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getToken } from '@/auth/cognito';
import { WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
  children?: FileEntry[];
}

interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  mtime: string;
}

function workspaceBaseUrl(workspaceId: string): string {
  return `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}`;
}

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
  });
}

function extFromPath(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot + 1).toLowerCase();
}

/** Map file extension to a react-syntax-highlighter language. Kept
 * narrow on purpose — anything not in the map renders as plain text. */
function highlightLang(ext: string): string | null {
  const map: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    json: 'json',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    html: 'html',
    css: 'css',
  };
  return map[ext] ?? null;
}

function FileNode({
  node,
  depth,
  onClick,
  selectedPath,
}: {
  node: FileEntry;
  depth: number;
  onClick: (path: string) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(depth === 0);
  const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };
  if (node.type === 'directory') {
    return (
      <>
        <button
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-zinc-100"
          style={indent}
          onClick={() => setOpen(!open)}
        >
          <Folder className="h-3 w-3" />
          <span>{node.name}</span>
        </button>
        {open &&
          (node.children ?? []).map((child) => (
            <FileNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onClick={onClick}
              selectedPath={selectedPath}
            />
          ))}
      </>
    );
  }
  const selected = selectedPath === node.path;
  return (
    <button
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-zinc-100',
        selected ? 'bg-violet-50 text-violet-900' : 'text-foreground',
      )}
      style={indent}
      onClick={() => onClick(node.path)}
    >
      <File className="h-3 w-3" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/**
 * Two-pane file browser (tree + preview) over an agent's filesystem.
 *
 * `apiSegment` selects which root the chat-server exposes:
 *   - "def"      → /data/agents/{id}/def-draft/   (creator's working copy)
 *   - "live-def" → /data/agents/{id}/def/         (deployed snapshot)
 *   - "workdir"  → /data/agents/{id}/workdir/     (runtime scratch)
 *
 * The component is the same UI in all three cases — only the URL
 * segment + header label change. Header label defaults to
 * `{apiSegment}/` so callers can leave it implicit; the Explore page
 * passes explicit "def/" / "workdir/" labels.
 */
export function AgentDefFiles({
  workspaceId,
  agentId,
  onClose,
  apiSegment = 'def',
  label,
  emptyMessage,
  hideHeader = false,
}: {
  workspaceId: string;
  agentId: string;
  onClose?: () => void;
  apiSegment?: 'def' | 'live-def' | 'workdir';
  label?: string;
  emptyMessage?: string;
  /** Hide the panel's internal title row (label + refresh + close). The
   * creator view sets this because the surrounding page already shows
   * the agent name + a Files toggle in its top bar — duplicating that
   * inside the panel reads like a stray half-opened chat header. */
  hideHeader?: boolean;
}) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const baseUrl = useMemo(
    () => workspaceBaseUrl(workspaceId),
    [workspaceId],
  );

  const refreshTree = useCallback(async () => {
    try {
      const res = await authedFetch(
        `${baseUrl}/api/agents/${agentId}/${apiSegment}/files`,
      );
      if (!res.ok) throw new Error(`List failed: ${res.status}`);
      setTree((await res.json()) as FileEntry[]);
    } catch {
      // Leave the previous tree in place on failure — avoids a
      // flicker-to-empty if the poll fires during a transient network
      // blip.
    } finally {
      setLoadingTree(false);
    }
  }, [baseUrl, agentId, apiSegment]);

  useEffect(() => {
    refreshTree();
    // Poll at a gentle cadence so the creator writing a file shows up
    // in the browser within a few seconds without hammering the
    // sandbox. 3 s is arbitrary but feels snappy enough.
    const timer = setInterval(refreshTree, 3000);
    return () => clearInterval(timer);
  }, [refreshTree]);

  const openFile = useCallback(
    async (relPath: string) => {
      setSelected(relPath);
      setLoadingContent(true);
      setContentError(null);
      setContent(null);
      try {
        const res = await authedFetch(
          `${baseUrl}/api/agents/${agentId}/${apiSegment}/files/${relPath
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Read failed: ${res.status}`);
        }
        const ct = res.headers.get('content-type') || '';
        if (!ct.startsWith('application/json')) {
          setContentError('Binary file — download via the creator.');
          return;
        }
        setContent((await res.json()) as FileContent);
      } catch (err) {
        setContentError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingContent(false);
      }
    },
    [baseUrl, agentId, apiSegment],
  );

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-border bg-white">
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label ?? `${apiSegment}/`}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground"
              onClick={refreshTree}
              title="Refresh"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
            </button>
            {onClose && (
              <button
                className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground"
                onClick={onClose}
                title="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        {/* Tree */}
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border px-1 py-2">
          {loadingTree && tree.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : tree.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">
              {emptyMessage ?? "Empty. The creator hasn't written anything yet."}
            </p>
          ) : (
            tree.map((node) => (
              <FileNode
                key={node.path}
                node={node}
                depth={0}
                onClick={openFile}
                selectedPath={selected}
              />
            ))
          )}
        </div>
        {/* Preview */}
        <div className="flex-1 overflow-auto px-4 py-3">
          {!selected && (
            <p className="text-xs text-muted-foreground">
              Select a file to preview.
            </p>
          )}
          {loadingContent && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          )}
          {contentError && (
            <p className="text-xs text-red-600">{contentError}</p>
          )}
          {content && !loadingContent && !contentError && (
            <FilePreview content={content} />
          )}
        </div>
      </div>
    </div>
  );
}

function FilePreview({ content }: { content: FileContent }) {
  const ext = extFromPath(content.path);
  const lang = highlightLang(ext);
  if (ext === 'md') {
    return (
      <div className="prose prose-sm max-w-none break-words">
        <ReactMarkdown>{content.content}</ReactMarkdown>
      </div>
    );
  }
  if (lang) {
    return (
      <div className="text-xs">
        <SyntaxHighlighter
          style={oneLight}
          language={lang}
          customStyle={{
            margin: 0,
            borderRadius: '0.375rem',
            fontSize: '0.75rem',
          }}
        >
          {content.content}
        </SyntaxHighlighter>
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words text-xs text-foreground">
      {content.content}
    </pre>
  );
}

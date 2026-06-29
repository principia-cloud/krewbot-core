import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import {
  BookOpen,
  Loader2,
  Info,
  Network,
  List as ListIcon,
  Search,
  X,
  FileText,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useWorkspace } from './workspace-context';
import type { WikiGraph, WikiNode } from '@/api/workspace-client';

// Force-graph + d3 are heavy; load them only when the Knowledge page opens.
const KnowledgeGraph = lazy(() =>
  import('./knowledge-graph').then((m) => ({ default: m.KnowledgeGraph })),
);

type ViewMode = 'graph' | 'list';

const MATURITY_VARIANTS: Record<string, string> = {
  mature: 'bg-emerald-100 text-emerald-700',
  substantial: 'bg-blue-100 text-blue-700',
  draft: 'bg-amber-100 text-amber-700',
  stub: 'bg-zinc-100 text-zinc-600',
};

const CONFIDENCE_VARIANTS: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-red-100 text-red-700',
};

function MetaBadges({ node }: { node: WikiNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {node.type && (
        <Badge variant="default" className="text-[10px] capitalize">
          {node.type}
        </Badge>
      )}
      {node.maturity && (
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
            MATURITY_VARIANTS[node.maturity.toLowerCase()] || 'bg-zinc-100 text-zinc-600',
          )}
        >
          {node.maturity}
        </span>
      )}
      {node.confidence && (
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            CONFIDENCE_VARIANTS[node.confidence.toLowerCase()] || 'bg-zinc-100 text-zinc-600',
          )}
        >
          {node.confidence} conf.
        </span>
      )}
    </div>
  );
}

/** Right-hand detail panel: renders the selected page's markdown. */
function DetailPanel({ node, onClose }: { node: WikiNode; onClose: () => void }) {
  const { client } = useWorkspace();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setContent(null);
    client.context
      .read(node.id)
      .then((r) => setContent(r.content))
      .catch(() => setContent('Failed to load page.'))
      .finally(() => setLoading(false));
  }, [client, node]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-white">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold">{node.title}</h2>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{node.id}</p>
          <div className="mt-2">
            <MetaBadges node={node} />
          </div>
        </div>
        <button
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading...</span>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ListView({
  nodes,
  search,
  selectedId,
  onSelect,
}: {
  nodes: WikiNode[];
  search: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matched = q
      ? nodes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      : nodes;
    // Most-linked pages first, then alphabetical.
    return [...matched].sort((a, b) => b.inbound - a.inbound || a.title.localeCompare(b.title));
  }, [nodes, q]);

  if (filtered.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-16 text-muted-foreground">
        <BookOpen className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm">{q ? 'No pages match your search' : 'No knowledge pages yet'}</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full flex-1">
      {filtered.map((node) => (
        <button
          key={node.id}
          className={cn(
            'flex w-full items-center gap-3 border-b border-border px-6 py-3 text-left transition-colors hover:bg-zinc-50',
            selectedId === node.id && 'bg-zinc-50',
          )}
          onClick={() => onSelect(node.id)}
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{node.title}</div>
            <div className="truncate text-[11px] text-muted-foreground">{node.id}</div>
          </div>
          <MetaBadges node={node} />
          {node.inbound > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {node.inbound} link{node.inbound === 1 ? '' : 's'}
            </span>
          )}
        </button>
      ))}
    </ScrollArea>
  );
}

export function KnowledgeView() {
  const { client } = useWorkspace();
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('graph');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    client.context
      .graph()
      .then(setGraph)
      .catch(() => setGraph({ nodes: [], edges: [] }))
      .finally(() => setLoading(false));
  }, [client]);

  const nodeById = useMemo(() => {
    const m = new Map<string, WikiNode>();
    for (const n of graph?.nodes || []) m.set(n.id, n);
    return m;
  }, [graph]);

  const selectedNode = selectedId ? nodeById.get(selectedId) || null : null;
  const handleSelect = useCallback((id: string | null) => setSelectedId(id), []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const g = graph || { nodes: [], edges: [] };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-6 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Knowledge</h1>
          {/* Graph | List segmented toggle */}
          <div className="flex items-center rounded-[10px] border border-border p-0.5">
            <button
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
                view === 'graph' ? 'bg-[#0c1d36] text-white' : 'text-muted-foreground hover:bg-muted',
              )}
              onClick={() => setView('graph')}
            >
              <Network className="h-3.5 w-3.5" />
              Graph
            </button>
            <button
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
                view === 'list' ? 'bg-[#0c1d36] text-white' : 'text-muted-foreground hover:bg-muted',
              )}
              onClick={() => setView('list')}
            >
              <ListIcon className="h-3.5 w-3.5" />
              List
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Managed by the agent — ask in chat to edit</span>
          </div>
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages..."
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      {/* Body: main view + optional detail panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'graph' ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <KnowledgeGraph graph={g} selectedId={selectedId} search={search} onSelect={handleSelect} />
            </Suspense>
          ) : (
            <ListView nodes={g.nodes} search={search} selectedId={selectedId} onSelect={handleSelect} />
          )}
        </div>
        {selectedNode && <DetailPanel node={selectedNode} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}

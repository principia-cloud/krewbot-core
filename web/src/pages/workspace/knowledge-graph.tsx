import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
// react-force-graph-2d ships its own types; the ref methods are loosely typed.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no bundled types for the 2d entrypoint in some versions
import ForceGraph2D from 'react-force-graph-2d';
import type { WikiGraph, WikiNode } from '@/api/workspace-client';

/**
 * Obsidian-style force-directed knowledge graph. Pages are nodes, [[wikilinks]]
 * are edges. Node size grows with inbound links; color encodes page type.
 * Hover or search dims everything except the focused node and its neighbors.
 */

// Modern categorical palette keyed by page type.
const TYPE_COLORS: Record<string, string> = {
  entity: '#6366f1', // indigo
  concept: '#0ea5e9', // sky
  summary: '#10b981', // emerald
  synthesis: '#f59e0b', // amber
  comparison: '#ec4899', // pink
  index: '#8b5cf6', // violet
  overview: '#14b8a6', // teal
};
const DEFAULT_COLOR = '#64748b'; // slate

function nodeColor(n: WikiNode): string {
  return (n.type && TYPE_COLORS[n.type.toLowerCase()]) || DEFAULT_COLOR;
}

function nodeRadius(n: WikiNode): number {
  // 4px base, +~0.9px per inbound link, capped so hubs stay readable.
  return Math.min(14, 4 + Math.sqrt(n.inbound) * 1.8);
}

interface GraphNode extends WikiNode {
  x?: number;
  y?: number;
}

export function KnowledgeGraph({
  graph,
  selectedId,
  search,
  onSelect,
}: {
  graph: WikiGraph;
  selectedId: string | null;
  search: string;
  onSelect: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Measure container so the canvas fills its flex parent.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stable graph data; clone so the lib can attach x/y without surprising React.
  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
    }),
    [graph],
  );

  // Adjacency for hover/selection highlight.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set());
      m.get(a)!.add(b);
    };
    for (const e of graph.edges) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return m;
  }, [graph]);

  const focusId = hoverId ?? selectedId;
  const searchLc = search.trim().toLowerCase();

  const isDimmed = useCallback(
    (n: GraphNode): boolean => {
      if (searchLc) {
        return !(n.title.toLowerCase().includes(searchLc) || n.id.toLowerCase().includes(searchLc));
      }
      if (!focusId) return false;
      if (n.id === focusId) return false;
      return !neighbors.get(focusId)?.has(n.id);
    },
    [focusId, neighbors, searchLc],
  );

  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r = nodeRadius(node);
      const dim = isDimmed(node);
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.globalAlpha = dim ? 0.12 : 1;

      const color = nodeColor(node);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Selection ring.
      if (node.id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Labels appear once zoomed in, or always for hubs / the focused node.
      const showLabel = globalScale > 1.2 || node.inbound >= 3 || node.id === focusId;
      if (showLabel && !dim) {
        const label = node.title;
        const fontSize = Math.max(10 / globalScale, 2.5);
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#334155';
        ctx.fillText(label, x, y + r + 1);
      }
      ctx.globalAlpha = 1;
    },
    [isDimmed, selectedId, focusId],
  );

  const paintPointerArea = useCallback(
    (node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
      const r = nodeRadius(node) + 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  if (graph.nodes.length === 0) {
    return (
      <div ref={containerRef} className="flex h-full w-full items-center justify-center text-muted-foreground">
        <p className="text-sm">No knowledge pages yet — ask the agent in chat to start the wiki.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {dims.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={dims.width}
          height={dims.height}
          graphData={data}
          backgroundColor="#fafbfd"
          nodeId="id"
          nodeRelSize={1}
          nodeLabel={(n: GraphNode) => n.title}
          linkColor={() => '#e2e8f0'}
          linkWidth={(l: any) => {
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return focusId && (s === focusId || t === focusId) ? 1.5 : 0.6;
          }}
          linkDirectionalParticles={0}
          cooldownTicks={120}
          d3VelocityDecay={0.3}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          onNodeHover={(n: GraphNode | null) => setHoverId(n?.id ?? null)}
          onNodeClick={(n: GraphNode) => onSelect(n.id)}
          onBackgroundClick={() => onSelect(null)}
        />
      )}
    </div>
  );
}

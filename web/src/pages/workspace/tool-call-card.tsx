import { useState } from 'react';
import { ChevronRight, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  toolName: string;
  input?: unknown;
  result?: string;
  status?: 'running' | 'success' | 'error';
}

export function ToolCallCard({ toolName, input, result, status = 'success' }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const StatusIcon = status === 'running'
    ? Loader2
    : status === 'error'
      ? X
      : Check;

  return (
    <div className="my-1 rounded-md border border-border bg-zinc-50">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', expanded && 'rotate-90')}
        />
        <span className="font-mono text-xs text-muted-foreground">{toolName}</span>
        <StatusIcon
          className={cn(
            'ml-auto h-3.5 w-3.5',
            status === 'running' && 'animate-spin text-accent',
            status === 'success' && 'text-emerald-500',
            status === 'error' && 'text-red-600',
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 text-xs">
          {input != null && (
            <div className="mb-2">
              <p className="mb-1 font-medium text-muted-foreground">Input</p>
              <pre className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-zinc-600">
                {typeof input === 'string' ? input : JSON.stringify(input as object, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="mb-1 font-medium text-muted-foreground">Result</p>
              <pre className="overflow-x-auto rounded bg-zinc-100 p-2 font-mono text-zinc-600 max-h-48">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

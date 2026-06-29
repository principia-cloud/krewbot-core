import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getWorkspaceUsage, type UsageBlock, type WorkspaceUsage } from '@/api/usage';
import { useWorkspace } from './workspace-context';

/** "12,345" under 100k, then compact: "1.2M", "987k". Token counts get
 * large fast; full digits past ~6 figures stop being readable. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString();
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** All input-side tokens the model actually processed, cached or not. */
function totalInputSide(b: UsageBlock): number {
  return b.inputTokens + b.cacheCreationInputTokens + b.cacheReadInputTokens;
}

function totalTokens(b: UsageBlock): number {
  return totalInputSide(b) + b.outputTokens;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[14px] border border-border bg-white p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

/** A breakdown section: one row per dimension value with a proportional
 * bar (share of the section's total tokens) and in/out counts. */
function BreakdownSection({
  title,
  rows,
  labelFor,
}: {
  title: string;
  rows: Record<string, UsageBlock>;
  labelFor?: (key: string) => string;
}) {
  const entries = Object.entries(rows).sort(
    (a, b) => totalTokens(b[1]) - totalTokens(a[1]),
  );
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, b]) => totalTokens(b)), 1);
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      <div className="rounded-[14px] border border-border bg-white shadow-sm">
        {entries.map(([key, block], i) => (
          <div
            key={key}
            className={
              i < entries.length - 1
                ? 'border-b border-border px-4 py-3'
                : 'px-4 py-3'
            }
          >
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{labelFor ? labelFor(key) : key}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {fmt(totalInputSide(block))} in · {fmt(block.outputTokens)} out
                {block.turns > 0 && ` · ${fmt(block.turns)} turns`}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-[#2563eb]/70"
                style={{ width: `${Math.max((totalTokens(block) / max) * 100, 2)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const PATH_LABELS: Record<string, string> = {
  'anthropic-direct': 'Subscription (Anthropic)',
  gateway: 'LLM Gateway',
};

export function UsageView() {
  const { workspaceId } = useWorkspace();
  const [month, setMonth] = useState(currentMonth());
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWorkspaceUsage(workspaceId, month)
      .then((res) => {
        if (!cancelled) setUsage(res);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, month]);

  const totals = usage?.totals;
  const inputSide = totals ? totalInputSide(totals) : 0;
  // Share of input-side tokens served from the prompt cache (cheaper +
  // faster than uncached input).
  const cachePct = inputSide > 0 ? (totals!.cacheReadInputTokens / inputSide) * 100 : 0;
  const hasAnyUsage = totals ? totalTokens(totals) > 0 || totals.turns > 0 : false;
  const gateway = usage?.gateway;
  const showGateway =
    !!gateway && (gateway.requests > 0 || gateway.costUsd > 0 || gateway.budgetUsd > 0);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-2xl space-y-8 px-6 py-6">
        {/* Header + month picker */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Token Usage</h2>
          <div className="flex items-center gap-1">
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-32 text-center text-sm tabular-nums">
              {monthLabel(month)}
            </span>
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors disabled:opacity-30"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={month >= currentMonth()}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && usage && usage.enabled === false && (
          <div className="rounded-[14px] border border-border bg-white p-8 text-center shadow-sm">
            <Activity className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">
              Usage tracking is not enabled on this deployment.
            </p>
          </div>
        )}

        {!loading && !error && usage && usage.enabled !== false && !hasAnyUsage && (
          <div className="rounded-[14px] border border-border bg-white p-8 text-center shadow-sm">
            <Activity className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">
              No usage recorded for {monthLabel(month)}.
            </p>
          </div>
        )}

        {!loading && !error && usage && usage.enabled !== false && hasAnyUsage && totals && (
          <>
            {/* Totals */}
            <div>
              <h3 className="mb-3 text-sm font-medium">Totals</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatCard label="Input tokens" value={fmt(totals.inputTokens)} hint="uncached" />
                <StatCard label="Output tokens" value={fmt(totals.outputTokens)} />
                <StatCard
                  label="Cache reads"
                  value={fmt(totals.cacheReadInputTokens)}
                  hint="tokens served from cache"
                />
                <StatCard
                  label="Cache writes"
                  value={fmt(totals.cacheCreationInputTokens)}
                  hint="tokens written to cache"
                />
                <StatCard label="Turns" value={fmt(totals.turns)} />
                <StatCard label="API calls" value={fmt(totals.apiCalls)} />
              </div>
            </div>

            {/* Cache efficiency */}
            {inputSide > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-medium">Cache Efficiency</h3>
                <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Input served from cache
                    </span>
                    <span className="text-sm font-medium tabular-nums">
                      {cachePct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-emerald-500/80"
                      style={{ width: `${Math.min(cachePct, 100)}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground/70">
                    {fmt(totals.cacheReadInputTokens)} of {fmt(inputSide)} input-side
                    tokens were cache hits.
                  </p>
                </div>
              </div>
            )}

            <BreakdownSection
              title="By Provider Path"
              rows={usage.byPath}
              labelFor={(k) => PATH_LABELS[k] ?? k}
            />
            <BreakdownSection title="By Model" rows={usage.byModel} />
            <BreakdownSection title="By Source" rows={usage.bySource} />

            {/* Gateway spend vs budget */}
            {showGateway && gateway && (
              <div>
                <h3 className="mb-3 text-sm font-medium">Gateway Spend</h3>
                <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {gateway.requests > 0
                        ? `${fmt(gateway.requests)} gateway requests`
                        : 'No gateway requests'}
                    </span>
                    <span className="text-sm font-medium tabular-nums">
                      ${Number(gateway.costUsd).toFixed(2)}
                      {gateway.budgetUsd > 0 &&
                        ` / $${Number(gateway.budgetUsd).toFixed(2)}`}
                    </span>
                  </div>
                  {gateway.budgetUsd > 0 && (
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="h-full rounded-full bg-[#2563eb]/80"
                        style={{
                          width: `${Math.min(
                            (Number(gateway.costUsd) / Number(gateway.budgetUsd)) * 100,
                            100,
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

import { useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Globe,
  Loader2,
  MessageSquare,
  Moon,
  OctagonX,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { usePoll } from '@/hooks/use-poll';
import { useWorkspace } from './workspace-context';
import type {
  BgRecentTask,
  BgStopAttribution,
  BgTask,
  FgTurn,
  TaskSnapshot,
} from '@/api/workspace-client';

const POLL_MS = 2500;

/** "12s", "5m 30s", "2h 15m" — live ages tick every poll, so keep them
 * compact and second-precise below an hour. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeFgTurn(t: FgTurn): string {
  if (t.source === 'cron') return t.jobName ? `Scheduled task "${t.jobName}"` : 'Scheduled task';
  if (t.source === 'http') return t.isMine ? 'Web chat (you)' : "Another member's web chat";
  return t.adapterName ? `${t.adapterName} message` : `${t.source} message`;
}

function FgTurnIcon({ t }: { t: FgTurn }) {
  if (t.source === 'cron') return <Zap className="h-4 w-4 text-amber-500" />;
  if (t.source === 'http') return <Globe className="h-4 w-4 text-[#2563eb]" />;
  return <MessageSquare className="h-4 w-4 text-emerald-600" />;
}

const STOP_BADGES: Record<BgStopAttribution['by'], { label: string; variant: 'success' | 'default' | 'destructive' | 'warning' }> = {
  natural: { label: 'Completed', variant: 'success' },
  model: { label: 'Stopped by agent', variant: 'default' },
  user: { label: 'Stopped by member', variant: 'default' },
  timeout: { label: 'Timed out', variant: 'destructive' },
  container_shutdown: { label: 'Interrupted', variant: 'warning' },
  error: { label: 'Error', variant: 'destructive' },
};

/** The live "what is it doing" feed: recent tool calls as timeline rows,
 * then the tail of the assistant's text. Re-renders on every poll, so it
 * updates live while a task runs. */
function ActivityFeed({ snapshot }: { snapshot: TaskSnapshot }) {
  const hasTools = snapshot.toolCallTrail.length > 0;
  const hasText = snapshot.assistantText.trim().length > 0;
  if (!hasTools && !hasText) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">No activity captured yet.</p>;
  }
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      {hasTools && (
        <div className="space-y-1">
          {snapshot.toolCallTrail.map((call, i) => (
            <div key={`${call.ts}-${i}`} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatClock(call.ts)}</span>
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700">
                {call.name}
              </span>
              <span className="min-w-0 truncate text-muted-foreground" title={call.summary}>
                {call.summary}
              </span>
            </div>
          ))}
        </div>
      )}
      {hasText && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-700">
          {snapshot.assistantText}
        </pre>
      )}
    </div>
  );
}

function ExpandChevron({ open }: { open: boolean }) {
  return open
    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function StatCard({ label, used, max, accent }: { label: string; used: number; max: number; accent: boolean }) {
  return (
    <div className="rounded-[14px] border border-border bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {accent && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">
        {used}
        <span className="text-sm font-normal text-muted-foreground"> / {max}</span>
      </div>
    </div>
  );
}

function BgTaskCard({ task, onStop, stopping }: { task: BgTask; onStop: () => void; stopping: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <ExpandChevron open={open} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{task.promptPreview || 'Background task'}</h3>
              <Badge variant="success" className="text-[10px]">Running</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatAge(task.ageMs)} elapsed · from {task.parentAdapter}
            </p>
          </div>
        </button>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700"
          onClick={onStop}
          disabled={stopping}
        >
          {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <OctagonX className="h-3.5 w-3.5" />}
          Stop
        </Button>
      </div>
      {open && <ActivityFeed snapshot={task.snapshot} />}
    </div>
  );
}

function FgTurnRow({ turn }: { turn: FgTurn }) {
  const [open, setOpen] = useState(false);
  const expandable = !!turn.snapshot;
  return (
    <div className="rounded-[14px] border border-border bg-white px-4 py-3 shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 text-left"
        onClick={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
      >
        {expandable ? <ExpandChevron open={open} /> : <span className="w-4" />}
        <FgTurnIcon t={turn} />
        <span className="min-w-0 flex-1 truncate text-sm">{describeFgTurn(turn)}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAge(turn.ageMs)}</span>
      </button>
      {open && turn.snapshot && <ActivityFeed snapshot={turn.snapshot} />}
    </div>
  );
}

function RecentRow({ task }: { task: BgRecentTask }) {
  const [open, setOpen] = useState(false);
  const badge = STOP_BADGES[task.stoppedBy.by] ?? { label: task.stoppedBy.by, variant: 'default' as const };
  return (
    <div className="rounded-[14px] border border-border bg-white px-4 py-3 shadow-sm">
      <button type="button" className="flex w-full items-center gap-2.5 text-left" onClick={() => setOpen((o) => !o)}>
        <ExpandChevron open={open} />
        <span className="min-w-0 flex-1 truncate text-sm">{task.promptPreview || 'Background task'}</span>
        <Badge variant={badge.variant} className="shrink-0 text-[10px]">{badge.label}</Badge>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAge(task.durationMs)}</span>
      </button>
      {open && (
        <div className="mt-1">
          {task.finalReplyPreview.trim() && (
            <p className="mt-2 rounded-md bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
              {task.finalReplyPreview}
            </p>
          )}
          <ActivityFeed snapshot={task.snapshot} />
        </div>
      )}
    </div>
  );
}

export function TasksView() {
  const { client } = useWorkspace();
  const { data, error, loading, refetch } = usePoll(() => client.tasks.list(), POLL_MS);

  const [confirmStop, setConfirmStop] = useState<BgTask | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  const doStop = async (task: BgTask) => {
    setConfirmStop(null);
    setStoppingId(task.taskId);
    setStopError(null);
    try {
      await client.tasks.stopBackground(task.taskId);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Failed to stop task');
    } finally {
      setStoppingId(null);
      refetch();
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">Couldn't load running tasks.</p>
        {error && <p className="max-w-sm text-center text-xs text-muted-foreground">{error.message}</p>}
        <Button size="sm" variant="outline" onClick={refetch}>Retry</Button>
      </div>
    );
  }

  const { foreground, background } = data;
  const nothingRunning =
    foreground.active.length === 0 &&
    foreground.waiting.length === 0 &&
    background.active.length === 0;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Tasks</h1>
          {error && (
            <span className="text-xs text-amber-600" title={error.message}>
              Live updates interrupted — retrying
            </span>
          )}
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Everything the agent is working on right now — chat turns, scheduled runs, and background tasks.
        </p>

        <div className="mb-6 grid grid-cols-3 gap-3">
          <StatCard
            label="Chat slots"
            used={foreground.active.length}
            max={foreground.limits.maxConcurrent}
            accent={foreground.active.length > 0}
          />
          <StatCard
            label="Queued"
            used={foreground.waiting.length}
            max={foreground.limits.maxQueue}
            accent={foreground.waiting.length > 0}
          />
          <StatCard
            label="Background slots"
            used={background.active.length}
            max={background.limits.maxConcurrent}
            accent={background.active.length > 0}
          />
        </div>

        {stopError && (
          <div className="mb-4 rounded-[10px] bg-red-50 px-3 py-2 text-xs text-red-700">{stopError}</div>
        )}

        {nothingRunning ? (
          <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-border py-16">
            <Moon className="mb-3 h-10 w-10 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">Nothing running right now</p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              Active chat turns, scheduled runs, and background tasks the agent spawns will show up here live.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {background.active.length > 0 && (
              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Background tasks</h2>
                <div className="space-y-3">
                  {background.active.map((task) => (
                    <BgTaskCard
                      key={task.taskId}
                      task={task}
                      stopping={stoppingId === task.taskId}
                      onStop={() => setConfirmStop(task)}
                    />
                  ))}
                </div>
              </section>
            )}

            {(foreground.active.length > 0 || foreground.waiting.length > 0) && (
              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Chat & scheduled turns</h2>
                <div className="space-y-2">
                  {foreground.active.map((turn) => (
                    <FgTurnRow key={turn.id} turn={turn} />
                  ))}
                  {foreground.waiting.map((w, i) => (
                    <div
                      key={w.id}
                      className="flex items-center gap-2.5 rounded-[14px] border border-dashed border-border bg-zinc-50/50 px-4 py-2.5"
                    >
                      <span className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        {w.coalesceKey?.startsWith('cron:')
                          ? `Scheduled task "${w.coalesceKey.slice(5)}"`
                          : w.adapterName
                            ? `${w.adapterName} message`
                            : `${w.source} message`}
                        {' '}waiting for a slot
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatAge(w.waitedMs)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {background.recent.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Recently finished</h2>
            <div className="space-y-2">
              {background.recent.map((task) => (
                <RecentRow key={task.taskId} task={task} />
              ))}
            </div>
          </section>
        )}

        <Dialog open={!!confirmStop} onOpenChange={(open) => !open && setConfirmStop(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Stop this background task?</DialogTitle>
              <DialogDescription>
                {confirmStop?.promptPreview && (
                  <span className="mb-2 block truncate font-medium text-foreground">
                    "{confirmStop.promptPreview}"
                  </span>
                )}
                The task will be aborted where it is. Partial work it already saved is kept, and the
                agent will see that you stopped it.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button size="sm" variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                size="sm"
                className="bg-red-600 text-white hover:bg-red-700"
                onClick={() => confirmStop && doStop(confirmStop)}
              >
                Stop task
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}

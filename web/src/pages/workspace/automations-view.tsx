import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Clock,
  Loader2,
  Zap,
  CalendarClock,
  MessageSquare,
  Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { listCronJobs } from '@/api/cron';
import { listAgents, type Agent } from '@/api/agents';
import { useWorkspace } from './workspace-context';
import type { CronJob } from '@/api/workspace-client';

function humanSchedule(schedule: string): string {
  const rateMatch = schedule.match(/^rate\((\d+)\s+(\w+)\)$/);
  if (rateMatch) {
    const [, n, unit] = rateMatch;
    if (n === '1') return `Every ${unit.replace(/s$/, '')}`;
    return `Every ${n} ${unit}`;
  }
  const PRESETS: Record<string, string> = {
    'cron(0 9 * * ? *)': 'Every day at 9 AM',
    'cron(0 9 ? * MON-FRI *)': 'Every weekday at 9 AM',
    'cron(0 9 ? * MON *)': 'Every Monday at 9 AM',
    'cron(0 9 1 * ? *)': 'Every 1st of the month',
  };
  return PRESETS[schedule] || schedule;
}

function JobCard({
  job,
  agent,
  onAgentClick,
}: {
  job: CronJob;
  agent: Agent | undefined;
  onAgentClick?: (agentId: string) => void;
}) {
  return (
    <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
            <Zap className="h-5 w-5 text-[#2563eb]" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{job.name}</h3>
              <Badge variant={job.enabled ? 'success' : 'default'} className="text-[10px]">
                {job.enabled ? 'Active' : 'Disabled'}
              </Badge>
              {job.agentId && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-default disabled:opacity-70"
                  onClick={() => job.agentId && onAgentClick?.(job.agentId)}
                  disabled={!onAgentClick || !agent}
                  title={
                    agent
                      ? `Open ${agent.name}`
                      : 'Linked agent has been deleted'
                  }
                >
                  <Bot className="h-3 w-3" />
                  {agent ? agent.name : 'Unknown agent'}
                </button>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {humanSchedule(job.schedule)}
            </div>
          </div>
        </div>
      </div>

      {job.message && (
        <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
          {job.message}
        </p>
      )}
    </div>
  );
}

export function AutomationsView() {
  const { workspaceId, setChatOpen } = useWorkspace();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fire both calls together — the page needs the agent name so we
    // can render the badge, but we don't want to block job rendering
    // on it. allSettled lets either side fail without nuking the view.
    Promise.allSettled([
      listCronJobs(workspaceId),
      listAgents(workspaceId),
    ])
      .then(([cronRes, agentRes]) => {
        setJobs(cronRes.status === 'fulfilled' ? cronRes.value.jobs || [] : []);
        setAgents(
          agentRes.status === 'fulfilled' ? agentRes.value.agents || [] : [],
        );
      })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const agentById = new Map(agents.map((a) => [a.agentId, a]));

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-1">
          <h1 className="text-lg font-semibold">Schedules</h1>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Scheduled tasks that the agent runs automatically. Manage schedules through chat.
        </p>

        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-border py-16">
            <CalendarClock className="mb-3 h-10 w-10 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">No schedules yet</p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              Ask the agent in chat to create a schedule. For example: "Run a daily standup summary every weekday at 9 AM."
            </p>
            <Button
              size="sm"
              className="mt-4 gap-1.5"
              onClick={() => setChatOpen(true)}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Open chat to create one
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2 rounded-[10px] bg-blue-50 px-3 py-2">
              <MessageSquare className="h-3.5 w-3.5 text-[#2563eb]" />
              <span className="text-xs text-[#2563eb]">
                To create or modify schedules, ask the agent in chat.
              </span>
            </div>

            <div className="space-y-3">
              {jobs.map((job) => (
                <JobCard
                  key={job.name}
                  job={job}
                  agent={job.agentId ? agentById.get(job.agentId) : undefined}
                  onAgentClick={(agentId) =>
                    navigate(`/workspaces/${workspaceId}/agents/${agentId}`)
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Loader2,
  Plus,
  Bot,
  Trash2,
  Pencil,
  Play,
  CheckCircle2,
  Circle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from './workspace-context';
import {
  listAgents,
  createAgent,
  deleteAgent,
  type Agent,
} from '@/api/agents';
import { listCronJobs } from '@/api/cron';

function AgentCard({
  agent,
  onEdit,
  onRun,
  onDelete,
}: {
  agent: Agent;
  onEdit: () => void;
  onRun: () => void;
  onDelete: () => void;
}) {
  const deployed = agent.status === 'deployed';
  return (
    <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm transition-all hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-violet-50">
            <Bot className="h-5 w-5 text-violet-600" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">{agent.name}</h3>
              <Badge
                variant={deployed ? 'success' : 'default'}
                className="text-[10px] flex items-center gap-1"
              >
                {deployed ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <Circle className="h-3 w-3" />
                )}
                {deployed ? 'Deployed' : 'Draft'}
              </Badge>
            </div>
            {agent.description && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {agent.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onEdit}
            title="Open the creator chat to edit this agent"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={onRun}
            title={
              deployed
                ? 'Open a chat with the supervisor pre-prompted to delegate to this agent.'
                : 'Open the test session for this draft (loads from def-draft/).'
            }
          >
            <Play className="h-3.5 w-3.5" />
            {deployed ? 'Run' : 'Test'}
          </Button>
          <button
            className="rounded-md p-1.5 text-muted-foreground hover:bg-zinc-50 hover:text-red-600"
            onClick={onDelete}
            aria-label="Delete agent"
            title="Delete agent"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agentId: string) => void;
  workspaceId: string;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setDescription('');
    setError(null);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await createAgent(workspaceId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      reset();
      onOpenChange(false);
      onCreated(res.agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              placeholder="Monogram checker"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Description (optional)
            </label>
            <textarea
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="One sentence — what does this agent do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={512}
              rows={3}
            />
          </div>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentsView() {
  const {
    workspaceId,
    activeSessionId,
    createSession,
    setChatOpen,
  } = useWorkspace();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const handleRun = async (agent: Agent) => {
    if (agent.status === 'deployed') {
      // Production-like flow: open the user's regular workspace chat
      // pre-prompted to delegate to this agent. The supervisor's Task
      // tool routes to it via the SDK subagent map.
      if (!activeSessionId) {
        await createSession();
      }
      setChatOpen(true);
      const prefill = `Use the "${agent.name}" agent to `;
      navigate(
        `/workspaces/${workspaceId}?prefill=${encodeURIComponent(prefill)}`,
      );
    } else {
      // Drafts: jump straight into the creator's Test tab. The Test
      // tab loads the agent from def-draft/ via .test-meta.json so
      // the user can exercise unsaved changes.
      navigate(
        `/workspaces/${workspaceId}/agents/${agent.agentId}?tab=test`,
      );
    }
  };

  const load = () => {
    setLoading(true);
    listAgents(workspaceId)
      .then((res) => setAgents(res.agents || []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [workspaceId]);

  const handleCreated = (agentId: string) => {
    navigate(`/workspaces/${workspaceId}/agents/${agentId}`);
  };

  // Delete-agent dialog state. We pre-fetch the count of schedules
  // attached to the agent so the user knows what's about to be
  // cascade-deleted alongside it.
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<Agent | null>(
    null,
  );
  const [deleteScheduleCount, setDeleteScheduleCount] = useState<number | null>(
    null,
  );
  const [deleteAgentSaving, setDeleteAgentSaving] = useState(false);
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null);

  const handleDelete = (agent: Agent) => {
    setDeleteAgentTarget(agent);
    setDeleteAgentError(null);
    setDeleteScheduleCount(null);
    // Best-effort: load attached schedules so we can warn the user.
    // If APA is slow/down, we fall back to "schedules will also be
    // deleted" without a count.
    listCronJobs(workspaceId)
      .then((res) => {
        const count = (res.jobs || []).filter(
          (j) => j.agentId === agent.agentId,
        ).length;
        setDeleteScheduleCount(count);
      })
      .catch(() => setDeleteScheduleCount(null));
  };

  const submitDeleteAgent = async () => {
    if (!deleteAgentTarget || deleteAgentSaving) return;
    setDeleteAgentSaving(true);
    setDeleteAgentError(null);
    try {
      await deleteAgent(workspaceId, deleteAgentTarget.agentId);
      setAgents((prev) =>
        prev.filter((a) => a.agentId !== deleteAgentTarget.agentId),
      );
      setDeleteAgentTarget(null);
    } catch (err) {
      setDeleteAgentError(
        err instanceof Error ? err.message : 'Failed to delete agent',
      );
    } finally {
      setDeleteAgentSaving(false);
    }
  };

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
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Agents</h1>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New agent
          </Button>
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          Custom agents your supervisor can delegate to. Edit one in the
          creator to define its prompt, tools, and required secrets.
        </p>

        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-border py-16">
            <Bot className="mb-3 h-10 w-10 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">
              No agents yet
            </p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              Create a specialized agent to handle a specific workflow —
              daily standups, monogram analysis, whatever.
            </p>
            <Button
              size="sm"
              className="mt-4 gap-1.5"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New agent
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.agentId}
                agent={agent}
                onEdit={() =>
                  navigate(
                    `/workspaces/${workspaceId}/agents/${agent.agentId}`,
                  )
                }
                onRun={() => handleRun(agent)}
                onDelete={() => handleDelete(agent)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        workspaceId={workspaceId}
      />

      {/* Delete-agent confirmation. Surfaces the cascade so the user
          isn't surprised when their schedules vanish too. */}
      <Dialog
        open={deleteAgentTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteAgentSaving) {
            setDeleteAgentTarget(null);
            setDeleteAgentError(null);
            setDeleteScheduleCount(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{deleteAgentTarget?.name}</span> will
              be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteScheduleCount !== null && deleteScheduleCount > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {deleteScheduleCount === 1
                ? '1 schedule attached to this agent will also be deleted.'
                : `${deleteScheduleCount} schedules attached to this agent will also be deleted.`}
            </div>
          )}
          {deleteAgentError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {deleteAgentError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteAgentTarget(null)}
              disabled={deleteAgentSaving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitDeleteAgent}
              disabled={deleteAgentSaving}
            >
              {deleteAgentSaving && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}

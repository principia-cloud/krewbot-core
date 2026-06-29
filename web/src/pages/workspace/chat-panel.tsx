import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import { Activity, FolderOpen, PanelRightClose } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import { useWorkspace } from './workspace-context';
import { AgentChat, type AskUserAnswer, type ChatTransport } from './agent-chat';
import { getToken } from '@/auth/cognito';
import type { SessionUsage, WorkspaceClient } from '@/api/workspace-client';

const EXAMPLE_PROMPTS = [
  'Summarize the latest context files',
  'What decisions have been made so far?',
  'Update the project status in context',
];

/** Tally refresh cadence. Usage rows land fire-and-forget after each turn,
 * so the chip is inherently a-beat-behind; polling keeps it honest without
 * wiring into the streaming pipeline. */
const USAGE_POLL_MS = 20_000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** Compact lifetime token tally for the active chat. Hidden until the
 * chat has recorded usage (and entirely when tracking is disabled). */
function SessionUsageChip({
  client,
  sessionId,
}: {
  client: WorkspaceClient;
  sessionId: string;
}) {
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      client.sessions
        .usage(sessionId)
        .then((u) => {
          if (!cancelled) setUsage(u);
        })
        .catch(() => {
          /* best-effort — the chip just stays hidden */
        });
    load();
    const timer = setInterval(load, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, sessionId]);

  if (!usage || usage.enabled === false || usage.turns === 0) return null;
  // "in" = everything the model processed as input, cached or not.
  const inputSide =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  const detail =
    `${fmtTokens(usage.inputTokens)} uncached in · ` +
    `${fmtTokens(usage.cacheReadInputTokens)} cache reads · ` +
    `${fmtTokens(usage.cacheCreationInputTokens)} cache writes · ` +
    `${fmtTokens(usage.outputTokens)} out · ` +
    `${usage.turns} turns`;
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
      title={detail}
    >
      <Activity className="h-3 w-3" />
      {fmtTokens(inputSide)} in · {fmtTokens(usage.outputTokens)} out
    </span>
  );
}

export function ChatPanel() {
  const { client, activeSessionId, chatOpen, setChatOpen, sessions, refreshSessions } =
    useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const posthog = usePostHog();
  const navigate = useNavigate();
  const location = useLocation();
  const { id: workspaceId } = useParams<{ id: string }>();

  const filesPath = workspaceId ? `/workspaces/${workspaceId}/files` : null;
  const filesActive = filesPath !== null && location.pathname === filesPath;
  const toggleFiles = () => {
    if (!filesPath) return;
    if (filesActive) {
      // Already on the files page — bounce back to Agents (the default
      // workspace surface). Gives the icon a real toggle feel.
      navigate(`/workspaces/${workspaceId}/agents`);
    } else {
      navigate(filesPath);
    }
  };

  // Track which session IDs we've already auto-titled so we don't try
  // again on every send. Stored in a ref so the transport memo doesn't
  // need `sessions` as a dep (re-creating transport mid-stream would
  // tear down the SSE connection).
  const titledRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setChatOpen(!chatOpen);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setChatOpen, chatOpen]);

  // Inline rename in the header. Mirrors the sidebar pattern so users
  // can discover renaming without hunting for the pencil icon.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const isPlaceholder = !!activeSession && (
    activeSession.name === `chat-${activeSession.id}` || !activeSession.name
  );
  const displayTitle = !activeSession
    ? 'Chat'
    : isPlaceholder
      ? 'New chat'
      : activeSession.name;

  const startTitleEdit = () => {
    if (!activeSession) return;
    setTitleDraft(isPlaceholder ? '' : activeSession.name);
    setEditingTitle(true);
  };

  const cancelTitleEdit = () => {
    setEditingTitle(false);
    setTitleDraft('');
  };

  const commitTitleEdit = async () => {
    if (!activeSession) {
      cancelTitleEdit();
      return;
    }
    const next = titleDraft.trim().slice(0, 60);
    setEditingTitle(false);
    setTitleDraft('');
    if (!next || next === activeSession.name) return;
    try {
      await client.sessions.rename(activeSession.id, next);
      await refreshSessions();
    } catch {
      /* best-effort */
    }
  };

  // Read ?prefill=... once per navigation, then clear from the URL so
  // a refresh doesn't re-stage the same prompt. Captured into local
  // state so the AgentChat sees a stable initialInput across renders.
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);
  useEffect(() => {
    const prefill = searchParams.get('prefill');
    if (prefill) {
      setPendingPrefill(prefill);
      const next = new URLSearchParams(searchParams);
      next.delete('prefill');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const transport = useMemo<ChatTransport | null>(() => {
    if (!activeSessionId) return null;
    return {
      baseUrl: client.baseUrl,
      sessionKey: activeSessionId,
      // PostHog `chat_message_sent` fires on every workspace-chat send
       // — the canonical retention metric. Wrapped here so creator chat
       // doesn't double-count.
      send: async (msg) => {
        try {
          posthog?.capture('chat_message_sent', {
            session_id: activeSessionId,
          });
        } catch {
          /* PostHog should never break sends */
        }
        let result;
        try {
          result = await client.chat.send(activeSessionId, msg);
        } catch (err) {
          posthog?.captureException(err);
          throw err;
        }
        // Auto-title the session from the first user message — the
        // server creates new sessions with a placeholder `chat-{id}`
        // name. Read latest session state via a ref so we don't bake
        // a stale name into the memo and don't churn the transport.
        if (!titledRef.current.has(activeSessionId)) {
          titledRef.current.add(activeSessionId);
          const session = sessionsRef.current.find(
            (s) => s.id === activeSessionId,
          );
          if (session && session.name === `chat-${activeSessionId}`) {
            const title = msg.replace(/\s+/g, ' ').trim().slice(0, 60);
            if (title) {
              client.sessions
                .rename(activeSessionId, title)
                .then(() => refreshSessions())
                .catch(() => {
                  /* best-effort — sidebar will keep showing "New chat" */
                });
            }
          }
        }
        return result;
      },
      cancel: (reqId) =>
        client.chat.cancel(activeSessionId, reqId).then(() => {}),
      getActiveRequestId: () =>
        client.chat.active(activeSessionId).then((r) => r.requestId),
      loadHistory: () =>
        client.sessions.messages(activeSessionId).then((r) => r.messages),
      inboxStreamPath: (id) => `/api/sessions/${id}/inbox/stream`,
      // Default stream path (`/api/sessions/{id}/chat/stream`) is what
      // useSSE falls back to when buildStreamPath is omitted.
      answerQuestion: async (answer: AskUserAnswer) => {
        const token = getToken();
        if (!token) throw new Error('Not authenticated');
        const res = await fetch(
          `${client.baseUrl}/api/sessions/${activeSessionId}/answer-question`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(answer),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ||
              `Failed to send answer (${res.status})`,
          );
        }
      },
    };
  }, [client, activeSessionId, refreshSessions, posthog]);

  if (!activeSessionId || !transport) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select or create a session
        </p>
      </div>
    );
  }

  return (
    <AgentChat
      // Key on the session so switching chats is a clean remount (fresh
      // useSSE + refs), not a prop swap on a reused instance. Without this,
      // stale streaming state from the previous chat leaks across the
      // switch and the on-mount reconnect-to-in-flight-turn doesn't re-run
      // — refresh-resume then only worked on full page reload, not on
      // selecting another chat.
      key={transport.sessionKey}
      transport={transport}
      examplePrompts={EXAMPLE_PROMPTS}
      initialInput={pendingPrefill ?? undefined}
      header={
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitTitleEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelTitleEdit();
                }
              }}
              placeholder="Chat name"
              maxLength={60}
              className="min-w-0 flex-1 rounded border border-border bg-white px-1.5 py-0.5 text-sm font-medium text-foreground focus:border-accent focus:outline-none"
            />
          ) : (
            <button
              className={cn(
                'min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm font-medium hover:bg-zinc-100 transition-colors',
                isPlaceholder && 'italic text-muted-foreground',
              )}
              onClick={startTitleEdit}
              title={activeSession ? 'Rename chat' : undefined}
              disabled={!activeSession}
            >
              {displayTitle}
            </button>
          )}
          <SessionUsageChip client={client} sessionId={activeSessionId} />
          <button
            className={cn(
              'rounded-md p-1 transition-colors',
              filesActive
                ? 'bg-zinc-100 text-foreground'
                : 'text-muted-foreground hover:bg-zinc-100 hover:text-foreground',
            )}
            onClick={toggleFiles}
            disabled={!activeSession}
            title={
              activeSession
                ? `Files in this chat${filesActive ? ' (open)' : ''}`
                : 'Open a chat to see its files'
            }
          >
            <FolderOpen className="h-4 w-4" />
          </button>
          <button
            className="rounded-md p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
            onClick={() => setChatOpen(false)}
            title="Close panel (⌘K)"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
      }
    />
  );
}

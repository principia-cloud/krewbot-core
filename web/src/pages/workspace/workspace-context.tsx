import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import {
  createWorkspaceClient,
  WorkspaceApiError,
  type WorkspaceClient,
  type Session,
} from '@/api/workspace-client';
import { getWorkspace } from '@/api/workspaces';
import { listMyWorkspaces } from '@/api/workspaces';
import type { Workspace, MyWorkspaceMembership } from '@/api/types';

interface WorkspaceState {
  workspaceId: string;
  workspace: Workspace | null;
  client: WorkspaceClient;
  sessions: Session[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  createSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  allWorkspaces: MyWorkspaceMembership[];
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  loading: boolean;
  error: string | null;
  /** Last user-visible session-creation error, e.g. the 429 cap message. */
  sessionCreateError: string | null;
  clearSessionCreateError: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const client = useMemo(() => createWorkspaceClient(workspaceId), [workspaceId]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [allWorkspaces, setAllWorkspaces] = useState<MyWorkspaceMembership[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null);

  // Load workspace details + workspace list on mount; poll while PROVISIONING.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setSessions([]);
    setActiveSessionId(null);

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      pollTimer = setTimeout(loadOnce, 5000);
    };

    const loadOnce = async () => {
      const [ws, allWs] = await Promise.all([
        getWorkspace(workspaceId).catch(() => null),
        listMyWorkspaces().then((r) => r.workspaces || []).catch(() => []),
      ]);
      if (cancelled) return;
      if (ws) setWorkspace(ws);
      if (allWs.length > 0) setAllWorkspaces(allWs);
      setLoading(false);

      // Only hit the workspace API endpoints once the workspace is RUNNING —
      // before that the ALB target group has no healthy targets.
      if (ws?.status === 'RUNNING') {
        const sess = await client.sessions.list().catch(() => [] as Session[]);
        if (cancelled) return;
        setSessions(sess);
        // Default to the most recent regular session; test sessions are
        // owned by the agent creator view and shouldn't be the workspace's
        // default chat target.
        const firstRegular = sess.find((s) => !s.testAgentId);
        if (firstRegular) setActiveSessionId(firstRegular.id);
        return;
      }

      // Keep polling in all other cases: PROVISIONING, RECOVERING, or a
      // transient null (API hiccup, token refresh). Terminal states
      // (FAILED / DELETING) stop the loop.
      if (ws?.status === 'FAILED' || ws?.status === 'DELETING') return;
      scheduleNext();
    };

    loadOnce().catch((err) => {
      if (!cancelled) {
        setError((err as Error).message);
        setLoading(false);
        scheduleNext();
      }
    });

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [workspaceId, client]);

  const refreshSessions = useCallback(async () => {
    try {
      const sess = await client.sessions.list();
      setSessions(sess);
    } catch {
      // Silently fail — existing list stays
    }
  }, [client]);

  const createSession = useCallback(async () => {
    setSessionCreateError(null);
    try {
      const { id } = await client.sessions.create();
      await refreshSessions();
      setActiveSessionId(id);
    } catch (err) {
      if (err instanceof WorkspaceApiError && err.code === 'session_limit_reached') {
        setSessionCreateError(err.message);
        return;
      }
      throw err;
    }
  }, [client, refreshSessions]);

  const clearSessionCreateError = useCallback(() => setSessionCreateError(null), []);

  const deleteSession = useCallback(
    async (id: string) => {
      await client.sessions.delete(id);
      await refreshSessions();
      if (activeSessionId === id) {
        setSessions((prev) => {
          const remaining = prev.filter((s) => s.id !== id);
          const nextRegular = remaining.find((s) => !s.testAgentId);
          setActiveSessionId(nextRegular?.id || null);
          return remaining;
        });
      }
    },
    [client, refreshSessions, activeSessionId],
  );

  return (
    <WorkspaceContext.Provider
      value={{
        workspaceId,
        workspace,
        client,
        sessions,
        activeSessionId,
        setActiveSessionId,
        createSession,
        deleteSession,
        refreshSessions,
        allWorkspaces,
        chatOpen,
        setChatOpen,
        loading,
        error,
        sessionCreateError,
        clearSessionCreateError,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}

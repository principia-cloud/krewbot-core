import { getToken, isTokenExpired, refreshToken, clearTokens } from '@/auth/cognito';
import { WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';

/**
 * Error thrown when the workspace API returns a structured failure with
 * a machine-readable `error` code. UI code can `instanceof` check this
 * to distinguish expected product errors (e.g. session_limit_reached)
 * from transport/network failures.
 */
export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }
}

// ---------------------------------------------------------------------------
// Types (from workspace http-server API)
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  name: string;
  lastModified: string;
  turnCount: number;
  /** Set on sessions created via /api/agents/:id/test-session — pins the
   * supervisor's subagent map to that one agent loaded from def-draft/.
   * The sidebar hides these (they live inside the agent creator view's
   * Test tab); the creator view uses it to find/reuse a test session. */
  testAgentId?: string;
}

export interface SessionUsage {
  sessionKey: string;
  /** false when the deployment has no usage table (tally unavailable). */
  enabled: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
  apiCalls: number;
  lastTs?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'tool_use' | 'tool_result' | 'stopped';
  content: string;
  toolName?: string;
  toolInput?: unknown;
  timestamp?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
  children?: FileEntry[];
}

export interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  mtime: string;
}

export interface ContextFile {
  name: string;
  size: number;
}

export interface WikiFrontmatter {
  title?: string;
  type?: string;
  tags?: string[];
  confidence?: string;
  maturity?: string;
  sources?: string[];
  created?: string;
  updated?: string;
}

export interface ContextContent {
  name: string;
  content: string;
  size: number;
  mtime: string;
  frontmatter?: WikiFrontmatter;
}

export interface WikiNode {
  id: string;
  title: string;
  type?: string;
  tags: string[];
  confidence?: string;
  maturity?: string;
  inbound: number;
}

export interface WikiEdge {
  source: string;
  target: string;
}

export interface WikiGraph {
  nodes: WikiNode[];
  edges: WikiEdge[];
}

export interface CronJob {
  name: string;
  schedule: string;
  message: string;
  enabled: boolean;
  /** Set when the schedule was created on behalf of a deployed agent.
   * The Schedules view shows it as a badge; agent deletion cascades to
   * delete every cron with a matching agentId. */
  agentId?: string;
}

// --- Tasks (running work: foreground turn queue + background registry) ----

export interface ToolCallEntry {
  name: string;
  summary: string;
  ts: number;
}

export interface TaskSnapshot {
  assistantText: string;
  toolCallTrail: ToolCallEntry[];
}

export type TurnSource = 'http' | 'webhook' | 'cron' | string;

export interface FgTurn {
  id: string;
  source: TurnSource;
  jobName?: string;
  adapterName?: string;
  startedAt: number;
  ageMs: number;
  /** True when this is the requesting member's own web chat. */
  isMine: boolean;
  /** Absent for other members' web chats (privacy gate on the server). */
  snapshot?: TaskSnapshot;
}

export interface FgWaiting {
  id: string;
  source: TurnSource;
  adapterName?: string;
  coalesceKey?: string;
  enqueuedAt: number;
  waitedMs: number;
}

export interface BgStopAttribution {
  by: 'natural' | 'model' | 'user' | 'timeout' | 'container_shutdown' | 'error';
  turnId?: string;
  userId?: string;
  reason?: string;
  at: number;
}

export interface BgTask {
  taskId: string;
  startedAt: number;
  ageMs: number;
  promptPreview: string;
  parentAdapter: string;
  snapshot: TaskSnapshot;
}

export interface BgRecentTask {
  taskId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  promptPreview: string;
  parentAdapter: string;
  stoppedBy: BgStopAttribution;
  finalReplyPreview: string;
  snapshot: TaskSnapshot;
}

export interface TasksState {
  now: number;
  foreground: {
    limits: { maxConcurrent: number; maxQueue: number; maxWaitMs: number };
    active: FgTurn[];
    waiting: FgWaiting[];
  };
  background: {
    limits: { maxConcurrent: number; wallMs: number; historyTtlMs: number };
    active: BgTask[];
    recent: BgRecentTask[];
  };
}

export interface BgStopResult {
  ok: boolean;
  taskId: string;
  aborted?: boolean;
  alreadyFinished?: boolean;
  stoppedBy?: BgStopAttribution;
  finalReplyPreview?: string;
  snapshot?: TaskSnapshot;
}

// ---------------------------------------------------------------------------
// Fetch helper (uses the same Cognito JWT as the management API)
// ---------------------------------------------------------------------------

async function getValidToken(): Promise<string> {
  let token = getToken();
  if (!token) throw new Error('Not authenticated');

  if (isTokenExpired(token)) {
    const ok = await refreshToken();
    if (!ok) {
      clearTokens();
      throw new Error('Session expired');
    }
    token = getToken();
    if (!token) throw new Error('Session expired');
  }

  return token;
}

async function wsFetch<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getValidToken();

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    const ok = await refreshToken();
    if (ok) {
      const newToken = getToken();
      if (newToken) {
        const retry = await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${newToken}`,
            ...options?.headers,
          },
        });
        if (retry.ok) {
          if (retry.status === 204) return undefined as T;
          return retry.json();
        }
      }
    }
    clearTokens();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body: { error?: string; message?: string } = await res
      .json()
      .catch(() => ({ error: res.statusText }));
    const code = body.error || `http_${res.status}`;
    const message = body.message || body.error || `Request failed: ${res.status}`;
    throw new WorkspaceApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---------------------------------------------------------------------------
// Workspace API client factory
// ---------------------------------------------------------------------------

export function createWorkspaceClient(workspaceId: string) {
  const baseUrl = `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}`;

  return {
    baseUrl,

    me: () => wsFetch<{ userId: string; email: string | null }>(baseUrl, '/api/me'),

    sessions: {
      list: () => wsFetch<Session[]>(baseUrl, '/api/sessions'),
      create: () => wsFetch<{ id: string; name: string }>(baseUrl, '/api/sessions', { method: 'POST' }),
      delete: (id: string) => wsFetch<{ deleted: boolean }>(baseUrl, `/api/sessions/${id}`, { method: 'DELETE' }),
      rename: (id: string, name: string) =>
        wsFetch<{ id: string; name: string }>(baseUrl, `/api/sessions/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        }),
      messages: (id: string) => wsFetch<{ messages: ChatMessage[] }>(baseUrl, `/api/sessions/${id}/messages`),
      /** Lifetime token tally for this chat. Updated fire-and-forget after
       * each turn, so it can trail the latest turn by a beat. */
      usage: (id: string) => wsFetch<SessionUsage>(baseUrl, `/api/sessions/${id}/usage`),
    },

    chat: {
      send: (sessionId: string, message: string) =>
        wsFetch<{ requestId: string }>(baseUrl, `/api/sessions/${sessionId}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        }),
      cancel: (sessionId: string, requestId: string) =>
        wsFetch<{ cancelled: boolean; alreadyAborted?: boolean }>(
          baseUrl,
          `/api/sessions/${sessionId}/chat/${requestId}`,
          { method: 'DELETE' },
        ),
      // requestId of the turn currently running in this session (or null) —
      // used to reconnect to an in-flight turn's stream after a page refresh.
      active: (sessionId: string) =>
        wsFetch<{ requestId: string | null }>(
          baseUrl,
          `/api/sessions/${sessionId}/chat/active`,
        ),
    },

    files: {
      list: (sessionId: string) => wsFetch<FileEntry[]>(baseUrl, `/api/sessions/${sessionId}/files`),
      read: (sessionId: string, filePath: string) =>
        wsFetch<FileContent>(baseUrl, `/api/sessions/${sessionId}/files/${filePath}`),
      /** Create-or-overwrite. Server mkdir-p's parent dirs. */
      write: (sessionId: string, filePath: string, content: string) =>
        wsFetch<FileContent>(
          baseUrl,
          `/api/sessions/${sessionId}/files/${filePath}`,
          { method: 'PUT', body: JSON.stringify({ content }) },
        ),
      rename: (sessionId: string, filePath: string, newPath: string) =>
        wsFetch<{ from: string; to: string }>(
          baseUrl,
          `/api/sessions/${sessionId}/files/${filePath}`,
          { method: 'PATCH', body: JSON.stringify({ newPath }) },
        ),
      delete: (sessionId: string, filePath: string) =>
        wsFetch<{ deleted: boolean; path: string }>(
          baseUrl,
          `/api/sessions/${sessionId}/files/${filePath}`,
          { method: 'DELETE' },
        ),
    },

    context: {
      list: () => wsFetch<ContextFile[]>(baseUrl, '/api/context'),
      read: (name: string) => wsFetch<ContextContent>(baseUrl, `/api/context/${name}`),
      graph: () => wsFetch<WikiGraph>(baseUrl, '/api/context/graph'),
    },

    tasks: {
      list: () => wsFetch<TasksState>(baseUrl, '/api/tasks'),
      stopBackground: (taskId: string) =>
        wsFetch<BgStopResult>(baseUrl, `/api/tasks/background/${taskId}/stop`, { method: 'POST' }),
    },

  };
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;

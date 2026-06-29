import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router';
import {
  Loader2,
  ArrowLeft,
  Bot,
  Rocket,
  AlertTriangle,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { getToken } from '@/auth/cognito';
import { WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';
import {
  getAgent,
  deployAgent,
  createAgentTestSession,
  type Agent,
  type DeployResult,
} from '@/api/agents';
import { useWorkspace } from './workspace-context';
import { AgentChat, type ChatTransport } from './agent-chat';
import { AgentDefFiles } from './agent-def-files';

function workspaceBaseUrl(workspaceId: string): string {
  return `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}`;
}

const FILES_WIDTH_KEY = 'platform:agent-files-panel-width';
const FILES_WIDTH_DEFAULT = 420;
const FILES_WIDTH_MIN = 280;
const FILES_WIDTH_MAX_RATIO = 0.6; // up to 60% of viewport

function readStoredFilesWidth(): number {
  if (typeof window === 'undefined') return FILES_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(FILES_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return FILES_WIDTH_DEFAULT;
  return n;
}

/** POST/DELETE helpers bound to the creator chat endpoint shape. The
 * chat-server routes these to `runCreatorTurnImpl` via the
 * `creator/agent/{id}` session-key prefix. */
async function submitCreatorMessage(
  workspaceId: string,
  agentId: string,
  message: string,
): Promise<{ requestId: string }> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(
    `${workspaceBaseUrl(workspaceId)}/api/agents/${agentId}/creator/chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Submit failed: ${res.status}`);
  }
  return res.json();
}

/** POST a dropped .zip file as raw bytes to the chat-server's
 * upload endpoint, which extracts it into def-draft/. */
async function uploadCreatorZip(
  workspaceId: string,
  agentId: string,
  file: File,
): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const url = `${workspaceBaseUrl(workspaceId)}/api/agents/${agentId}/uploads/zip?name=${encodeURIComponent(file.name)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      Authorization: `Bearer ${token}`,
    },
    body: file,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }
  const { summary } = (await res.json()) as { summary: string };
  return summary;
}

async function cancelCreatorMessage(
  workspaceId: string,
  agentId: string,
  requestId: string,
): Promise<void> {
  const token = getToken();
  if (!token) return;
  await fetch(
    `${workspaceBaseUrl(workspaceId)}/api/agents/${agentId}/creator/chat/${requestId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  ).catch(() => {
    /* best-effort */
  });
}

type CreatorTab = 'build' | 'test' | 'inspect';
const VALID_TABS: readonly CreatorTab[] = ['build', 'test', 'inspect'];

export function AgentCreatorView() {
  const { workspaceId, client, sessions, refreshSessions } = useWorkspace();
  const { agentId = '' } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deployPending, setDeployPending] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);

  // Initial tab honours `?tab=test|build|inspect` so the agents-list
  // Run/Test buttons can deep-link straight into the Test tab.
  const initialTab: CreatorTab = (() => {
    const q = searchParams.get('tab');
    return (VALID_TABS as readonly string[]).includes(q || '')
      ? (q as CreatorTab)
      : 'build';
  })();
  const [activeTab, setActiveTab] = useState<CreatorTab>(initialTab);
  const [testSessionId, setTestSessionId] = useState<string | null>(null);
  const [testSessionPending, setTestSessionPending] = useState(false);
  const [testSessionError, setTestSessionError] = useState<string | null>(null);

  const [filesWidth, setFilesWidth] = useState<number>(readStoredFilesWidth);
  const draggingRef = useRef(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      window.localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth));
    }, 200);
    return () => window.clearTimeout(id);
  }, [filesWidth]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // Files panel sits flush against the right edge of the page in
      // creator view (workspace right-rail chat is hidden), so the
      // panel's width equals viewport-x distance from the cursor.
      const next = window.innerWidth - e.clientX;
      const max = Math.floor(window.innerWidth * FILES_WIDTH_MAX_RATIO);
      setFilesWidth(Math.max(FILES_WIDTH_MIN, Math.min(max, next)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    setLoading(true);
    getAgent(workspaceId, agentId)
      .then((a) => setAgent(a))
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [workspaceId, agentId]);

  const deployed = agent?.status === 'deployed';

  // Reuse an existing test session for this agent if one exists. The
  // sessions list arrives via the workspace context; the server tags
  // test sessions with `testAgentId` so we can match without naming
  // conventions.
  useEffect(() => {
    if (testSessionId) return;
    const existing = sessions.find((s) => s.testAgentId === agentId);
    if (existing) setTestSessionId(existing.id);
  }, [sessions, agentId, testSessionId]);

  const ensureTestSession = useCallback(async () => {
    if (testSessionId || !agent || testSessionPending) return;
    setTestSessionPending(true);
    setTestSessionError(null);
    try {
      const session = await createAgentTestSession(
        workspaceId,
        agentId,
        agent.name,
      );
      await refreshSessions();
      setTestSessionId(session.id);
    } catch (err) {
      setTestSessionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestSessionPending(false);
    }
  }, [
    testSessionId,
    agent,
    testSessionPending,
    workspaceId,
    agentId,
    refreshSessions,
  ]);

  const handleTabChange = (next: string) => {
    if (!(VALID_TABS as readonly string[]).includes(next)) return;
    setActiveTab(next as CreatorTab);
    if (next === 'test') void ensureTestSession();
  };

  // Strip ?tab=... after applying it on mount so a refresh doesn't
  // override the user's later tab choice. Also kick off the test
  // session prepare when the deep-link landed on Test.
  useEffect(() => {
    if (!searchParams.has('tab')) return;
    if (initialTab === 'test') void ensureTestSession();
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
    // initialTab is captured at first render; we only run this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inspect is hidden for drafts. If the user deep-linked or somehow
  // landed there on a draft, demote to Build so the empty <Tabs>
  // surface doesn't render with no active panel.
  useEffect(() => {
    if (activeTab === 'inspect' && agent && !deployed) {
      setActiveTab('build');
    }
  }, [activeTab, agent, deployed]);

  const runDeploy = useCallback(
    async (override: boolean) => {
      if (!agent || deployPending) return;
      setDeployPending(true);
      setDeployError(null);
      try {
        const result = await deployAgent(workspaceId, agentId, { override });
        if (result.status === 'deployed') {
          setDeployResult(null);
          const fresh = await getAgent(workspaceId, agentId);
          setAgent(fresh);
          // Once the agent is live, jump straight into the Test tab —
          // the user's natural next step. Lazy-creates the test
          // session if one doesn't exist yet.
          setActiveTab('test');
          void ensureTestSession();
        } else {
          setDeployResult(result);
        }
      } catch (err) {
        setDeployError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeployPending(false);
      }
    },
    [agent, agentId, deployPending, workspaceId, ensureTestSession],
  );

  const creatorTransport = useMemo<ChatTransport | null>(() => {
    if (!agentId) return null;
    return {
      baseUrl: workspaceBaseUrl(workspaceId),
      sessionKey: agentId,
      send: (msg) => submitCreatorMessage(workspaceId, agentId, msg),
      cancel: (reqId) => cancelCreatorMessage(workspaceId, agentId, reqId),
      buildStreamPath: (_id, requestId) =>
        `/api/agents/${agentId}/creator/chat/stream?requestId=${requestId}`,
      loadHistory: async () => {
        const token = getToken();
        if (!token) return [];
        const res = await fetch(
          `${workspaceBaseUrl(workspaceId)}/api/agents/${agentId}/creator/messages`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return [];
        const body = (await res.json()) as { messages?: unknown };
        return Array.isArray(body.messages)
          ? (body.messages as Awaited<ReturnType<NonNullable<ChatTransport['loadHistory']>>>)
          : [];
      },
    };
  }, [workspaceId, agentId]);

  const testTransport = useMemo<ChatTransport | null>(() => {
    if (!testSessionId) return null;
    return {
      baseUrl: client.baseUrl,
      sessionKey: testSessionId,
      send: (msg) => client.chat.send(testSessionId, msg),
      cancel: (reqId) =>
        client.chat.cancel(testSessionId, reqId).then(() => {}),
      loadHistory: () =>
        client.sessions.messages(testSessionId).then((r) => r.messages),
    };
  }, [client, testSessionId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadError || !agent || !creatorTransport) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{loadError || 'Agent not found'}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/workspaces/${workspaceId}/agents`}>Back to agents</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Deploy banners live above the header so they're always visible. */}
      {deployResult?.status === 'missing_secrets' && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
            <div className="flex-1 text-sm text-amber-900">
              <p className="font-medium">
                Deploy blocked — missing workspace secrets
              </p>
              <p className="mt-1">
                Add these in the Integrations page, then deploy again:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {deployResult.missing.map((name) => (
                  <li key={name}>
                    <code className="rounded bg-amber-100 px-1">{name}</code>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  className="gap-1.5 border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                >
                  <Link to={`/workspaces/${workspaceId}/integrations`}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    Go to Integrations
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
                  onClick={() => runDeploy(true)}
                  disabled={deployPending}
                >
                  {deployPending && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  Deploy anyway
                </Button>
                <button
                  className="text-xs text-amber-700 underline hover:text-amber-900"
                  onClick={() => setDeployResult(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {deployError && (
        <div className="flex items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{deployError}</span>
          </div>
          <button
            className="shrink-0 text-xs underline hover:no-underline"
            onClick={() => setDeployError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top bar — back, agent name, status, deploy. Tabs sit just below. */}
      <div className="flex items-center justify-between border-b border-border bg-white/60 px-4 py-2.5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <button
            className="rounded-md p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground"
            onClick={() => navigate(`/workspaces/${workspaceId}/agents`)}
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="h-4 w-4 text-violet-600" />
            <span className="truncate text-sm font-medium">{agent.name}</span>
            <Badge
              variant={deployed ? 'success' : 'default'}
              className="text-[10px]"
            >
              {deployed ? 'Deployed' : 'Draft'}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'build' && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setFilesOpen(!filesOpen)}
              title={filesOpen ? 'Hide files panel' : 'Show files panel'}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Files
            </Button>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => runDeploy(false)}
            disabled={deployPending}
          >
            {deployPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            {deployed ? 'Redeploy' : 'Deploy'}
          </Button>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex flex-1 min-h-0 flex-col"
      >
        <div className="border-b border-border bg-white/60 px-4 py-2 backdrop-blur">
          <TabsList>
            <TabsTrigger value="build">Build</TabsTrigger>
            <TabsTrigger
              value="test"
              title={
                deployed
                  ? 'Test the deployed agent end-to-end via the supervisor.'
                  : 'Test the draft — the supervisor will load this agent from def-draft/, not the deployed snapshot.'
              }
            >
              Test
            </TabsTrigger>
            {/* Inspect is only meaningful for deployed agents — both
                def/ (deployed) and workdir/ (runtime) are empty by
                definition for a draft. We hide rather than disable
                the tab so it doesn't read as a permanent dead end. */}
            {deployed && (
              <TabsTrigger
                value="inspect"
                title="Read-only view of the deployed snapshot and runtime workdir."
              >
                Inspect
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent
          value="build"
          forceMount
          className="mt-0 flex flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden"
        >
          <div className="flex flex-1 min-w-0">
            <AgentChat
              transport={creatorTransport}
              onZipDrop={(file) => uploadCreatorZip(workspaceId, agentId, file)}
              placeholder={`Tell the creator what "${agent.name}" should do…`}
              emptyState={
                <div className="max-w-md rounded-[14px] border border-dashed border-border p-6 text-sm text-muted-foreground">
                  <p className="mb-2 font-medium text-foreground">
                    Starting from scratch?
                  </p>
                  <p className="mb-3">
                    Describe what you want the agent to do. The creator will
                    ask follow-up questions and start building <code>def/</code>.
                  </p>
                  <p className="mb-2 font-medium text-foreground">
                    Migrating an existing project?
                  </p>
                  <p>
                    Paste or describe the contents of a folder (CLAUDE.md,
                    scripts, data/…) and the creator will propose a mapping
                    onto the platform's layout.
                  </p>
                </div>
              }
            />
          </div>
          {filesOpen && (
            <>
              <div
                onPointerDown={startResize}
                className="group hidden h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-transparent hover:bg-zinc-100 md:flex"
                aria-label="Resize files panel"
                role="separator"
              >
                <div className="h-12 w-[2px] rounded-full bg-zinc-300 transition-all group-hover:h-16 group-hover:w-[3px] group-hover:bg-[#2563eb]" />
              </div>
              <div
                className="shrink-0"
                style={{ width: `${filesWidth}px` }}
              >
                <AgentDefFiles
                  workspaceId={workspaceId}
                  agentId={agentId}
                  hideHeader
                />
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent
          value="test"
          forceMount
          className="mt-0 flex flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden"
        >
          {testSessionError ? (
            <div className="flex h-full w-full items-center justify-center p-6 text-sm text-red-700">
              <div className="max-w-md text-center">
                <p className="mb-2 font-medium">
                  Couldn't start a test session
                </p>
                <p className="mb-3">{testSessionError}</p>
                <Button size="sm" variant="outline" onClick={ensureTestSession}>
                  Retry
                </Button>
              </div>
            </div>
          ) : !testTransport || testSessionPending ? (
            <div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Preparing test session…
            </div>
          ) : (
            <div className="flex flex-1 min-w-0">
              <AgentChat
                transport={testTransport}
                placeholder={`Ask the supervisor to delegate to "${agent.name}"…`}
                emptyState={
                  <div className="max-w-md rounded-[14px] border border-dashed border-border p-6 text-sm text-muted-foreground">
                    <p className="mb-2 font-medium text-foreground">
                      Test session
                    </p>
                    <p>
                      This session is pinned to <code>{agent.name}</code> loaded
                      from <code>def-draft/</code>. Ask anything that should
                      route through the agent — the supervisor will delegate
                      via the Task tool.
                    </p>
                  </div>
                }
              />
            </div>
          )}
        </TabsContent>

        {deployed && (
          <TabsContent
            value="inspect"
            className="mt-0 flex flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <div className="flex flex-1 min-w-0 border-r border-border">
              <AgentDefFiles
                workspaceId={workspaceId}
                agentId={agentId}
                apiSegment="live-def"
                label="def/ (deployed)"
                emptyMessage="No files in the deployed snapshot."
              />
            </div>
            <div className="flex flex-1 min-w-0">
              <AgentDefFiles
                workspaceId={workspaceId}
                agentId={agentId}
                apiSegment="workdir"
                label="workdir/ (runtime)"
                emptyMessage="Empty. The agent will write scratch state here at runtime."
              />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useMatch, useParams, useSearchParams } from 'react-router';
import { Loader2, MessageSquare, Menu, X } from 'lucide-react';
import { Outlet } from 'react-router';
import { WorkspaceProvider, useWorkspace } from './workspace-context';
import { Sidebar } from './sidebar';
import { ChatPanel } from './chat-panel';
import { ProvisioningTutorial } from './provisioning-tutorial';
import { SubscriptionGate } from '@/extensions/subscription-gate';
import { ClaudeTokenSetupModal } from './claude-token-setup-modal';
import { MarketingBanner } from '@/extensions/marketing-banner';
import { listIntegrations } from '@/api/integrations';
import { APP_NAME } from '@/lib/constants';

const CHAT_WIDTH_KEY = 'platform:chat-panel-width';
const CHAT_WIDTH_DEFAULT = 480;
const CHAT_WIDTH_MIN = 320;
const CHAT_WIDTH_MAX_RATIO = 0.6; // up to 60% of viewport

function readStoredWidth(): number {
  if (typeof window === 'undefined') return CHAT_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(CHAT_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return CHAT_WIDTH_DEFAULT;
  return n;
}

function WorkspaceShell() {
  const { loading, error, chatOpen, setChatOpen, workspace, workspaceId } = useWorkspace();
  const inCreatorView = !!useMatch('/workspaces/:id/agents/:agentId');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showTutorial, setShowTutorial] = useState(searchParams.get('tutorial') === '1');
  // Claude-token modal state. `null` = haven't checked yet (don't
  // show); `true` = no integration → show; `false` = configured or
  // user dismissed → don't show this session.
  const [needsClaudeToken, setNeedsClaudeToken] = useState<boolean | null>(null);
  const [chatWidth, setChatWidth] = useState<number>(readStoredWidth);
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  const draggingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Persist chat panel width on change (debounced via the latest value).
  useEffect(() => {
    const id = window.setTimeout(() => {
      window.localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
    }, 200);
    return () => window.clearTimeout(id);
  }, [chatWidth]);

  // Drag-to-resize the chat panel. The handle on the panel's left edge
  // captures pointer events; movement is converted into a panel width by
  // measuring distance from the right edge of the viewport.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const next = window.innerWidth - e.clientX;
      const max = Math.floor(window.innerWidth * CHAT_WIDTH_MAX_RATIO);
      setChatWidth(Math.max(CHAT_WIDTH_MIN, Math.min(max, next)));
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

  // Open the tutorial automatically whenever the workspace is still
  // provisioning, even without the explicit ?tutorial=1 flag (e.g. user
  // refreshed mid-provision).
  useEffect(() => {
    if (workspace?.status === 'PROVISIONING' || workspace?.status === 'RECOVERING') {
      setShowTutorial(true);
    }
  }, [workspace?.status]);

  // Once the workspace is RUNNING, check whether the Claude token
  // integration is configured. If not, surface the modal — onboarding
  // no longer collects this token, so most fresh workspaces will hit
  // this on first load post-provisioning. Failure to fetch leaves
  // needsClaudeToken=null (no modal), so a transient API blip never
  // pops a misleading prompt.
  useEffect(() => {
    if (workspace?.status !== 'RUNNING') return;
    if (needsClaudeToken !== null) return;
    let cancelled = false;
    listIntegrations(workspaceId)
      .then((res) => {
        if (cancelled) return;
        const hasClaude = res.integrations.includes('claude');
        setNeedsClaudeToken(!hasClaude);
      })
      .catch(() => {
        if (cancelled) return;
        setNeedsClaudeToken(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.status, workspaceId, needsClaudeToken]);

  const closeTutorial = () => {
    setShowTutorial(false);
    if (searchParams.has('tutorial')) {
      searchParams.delete('tutorial');
      setSearchParams(searchParams, { replace: true });
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  // While provisioning, don't mount the workspace API-dependent UI — just
  // show a placeholder behind the tutorial overlay so requests don't 503.
  const isProvisioning = workspace?.status === 'PROVISIONING' || workspace?.status === 'RECOVERING';
  if (isProvisioning) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f5f7fa]">
        <div className="text-center">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-[#2563eb]" />
          <p className="text-sm font-medium text-foreground">
            {workspace?.name || 'Your workspace'} is provisioning…
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            We'll drop you in as soon as it's ready.
          </p>
        </div>
        {showTutorial && <ProvisioningTutorial onClose={closeTutorial} />}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Marketing banner — stays as the very top row of the layout
          so the existing horizontal split below sees a smaller
          available height instead of overlapping. Hidden once the
          user dismisses it (localStorage). */}
      <MarketingBanner />
      <div className="relative flex flex-1 overflow-hidden">
      {/* Mobile header — was fixed-to-viewport before the banner
          existed; now absolute-to-the-inner-row so it sits flush
          below the banner without z-index battles. */}
      <div className="absolute top-0 left-0 right-0 z-40 flex h-12 items-center justify-between border-b border-border bg-white px-3 md:hidden">
        <button
          className="rounded-md p-2 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-bold">{APP_NAME}</span>
        {!inCreatorView ? (
          <button
            className="rounded-md p-2 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
            onClick={() => setChatOpen(true)}
          >
            <MessageSquare className="h-5 w-5" />
          </button>
        ) : (
          <span className="w-9" />
        )}
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 w-[280px] flex flex-col bg-[#f5f7fa] shadow-xl md:hidden">
            <div className="flex h-12 items-center justify-between border-b border-border px-3">
              <span className="text-sm font-bold">{APP_NAME}</span>
              <button
                className="rounded-md p-2 text-muted-foreground hover:bg-zinc-100"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Sidebar />
            </div>
          </div>
        </>
      )}

      {/* Desktop sidebar */}
      <div className="hidden md:flex w-[220px] shrink-0 flex-col border-r border-border bg-[#f5f7fa]">
        <Sidebar />
      </div>

      {/* Center content */}
      <div className="flex flex-1 flex-col overflow-hidden pt-12 md:pt-0">
        <SubscriptionGate>
          <Outlet />
        </SubscriptionGate>
      </div>

      {/* Resize handle — sits between main content and chat panel.
          Desktop only; mobile chat panel is fullscreen. */}
      {chatOpen && !inCreatorView && (
        <div
          onPointerDown={startResize}
          className="group hidden h-full w-2 shrink-0 cursor-col-resize items-center justify-center bg-[#f5f7fa] md:flex"
          aria-label="Resize chat panel"
          role="separator"
        >
          <div className="h-14 w-[3px] rounded-full bg-zinc-400 transition-all group-hover:h-20 group-hover:w-[4px] group-hover:bg-[#2563eb]" />
        </div>
      )}

      {/* Right chat panel — collapsible, resizable on desktop.
          Hidden entirely in the creator view: agent creation is a focused,
          full-width mode that owns its own chat surface (Build/Test tabs). */}
      {!inCreatorView && (chatOpen ? (
        <div
          className="fixed inset-0 z-50 flex w-full flex-col bg-white md:relative md:z-auto md:shrink-0 md:border-l md:border-border"
          style={isDesktop ? { width: `${chatWidth}px` } : undefined}
        >
          <ChatPanel />
        </div>
      ) : (
        <div className="hidden md:flex w-[40px] shrink-0 flex-col items-center border-l border-border bg-[#f5f7fa] pt-3">
          <button
            className="rounded-md p-2 text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
            onClick={() => setChatOpen(true)}
            title="Open chat (⌘K)"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        </div>
      ))}

      {/* Provisioning tutorial overlay */}
      {showTutorial && <ProvisioningTutorial onClose={closeTutorial} />}

      {/* Post-provisioning Claude-token prompt. Suppress while the
          tutorial is open so the two overlays don't stack.
          Dismissible — closing it without saving lets the user
          explore the rest of the UI; chat will still fail until
          a token is pasted via Settings → Integrations. The
          prompt re-appears on the next workspace load while the
          integration is still missing. */}
      {needsClaudeToken && !showTutorial && (
        <ClaudeTokenSetupModal
          workspaceId={workspaceId}
          onSaved={() => setNeedsClaudeToken(false)}
          onDismiss={() => setNeedsClaudeToken(false)}
        />
      )}
      </div>
    </div>
  );
}

export function WorkspaceLayout() {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">No workspace selected</p>
      </div>
    );
  }

  return (
    <WorkspaceProvider workspaceId={id}>
      <WorkspaceShell />
    </WorkspaceProvider>
  );
}

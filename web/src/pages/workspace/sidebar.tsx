import { useNavigate, useLocation } from 'react-router';
import {
  Activity,
  BookOpen,
  Zap,
  Puzzle,
  Settings,
  Plus,
  Trash2,
  ChevronDown,
  ListTodo,
  LogOut,
  Check,
  Bot,
  Loader2,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAuth } from '@/auth/auth-context';
import { useWorkspace } from './workspace-context';
import { WORKSPACE_CREATION_ENABLED } from '@/extensions/workspace-creation';
import { CommunityLink } from '@/extensions/community-link';
import { useState } from 'react';

const NAV_ITEMS = [
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { path: '/automations', label: 'Schedules', icon: Zap },
  { path: '/tasks', label: 'Tasks', icon: ListTodo },
  { path: '/integrations', label: 'Integrations', icon: Puzzle },
  { path: '/usage', label: 'Usage', icon: Activity },
] as const;

/** "5 min ago", "3h ago", "Yesterday", "Apr 12". Coarse on purpose —
 * the chat list doesn't need second-level precision. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'now';
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Sessions are created server-side with a placeholder `chat-{id}`
 * name; we treat that as "untitled" and show "New chat" until the
 * user's first message triggers an auto-rename. */
function isPlaceholderName(session: { id: string; name: string }): boolean {
  return session.name === `chat-${session.id}` || !session.name;
}

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAuth();
  const {
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
    sessionCreateError,
    clearSessionCreateError,
    setChatOpen,
  } = useWorkspace();

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEditing = (id: string, currentName: string) => {
    setEditingId(id);
    // If the row still has the placeholder name, give the user a blank
    // canvas instead of pre-filling "chat-1234abcd".
    const placeholder = currentName === `chat-${id}` || !currentName;
    setEditValue(placeholder ? '' : currentName);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditValue('');
  };

  const commitEditing = async () => {
    if (!editingId) return;
    const id = editingId;
    const next = editValue.trim().slice(0, 60);
    setEditingId(null);
    setEditValue('');
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    if (!next || next === session.name) return;
    try {
      await client.sessions.rename(id, next);
      await refreshSessions();
    } catch {
      /* best-effort */
    }
  };

  const basePath = `/workspaces/${workspaceId}`;

  const isActive = (suffix: string) => {
    if (suffix === '') {
      return location.pathname === basePath || location.pathname === basePath + '/';
    }
    const full = basePath + suffix;
    // Match the nav entry itself AND any deeper route under it (e.g.
    // /agents/{id} should keep the "Agents" entry highlighted).
    return location.pathname === full || location.pathname.startsWith(full + '/');
  };

  const handleCreateSession = async () => {
    setCreatingSession(true);
    try {
      await createSession();
      // Land the user in the per-session Files view alongside the
      // chat. Files is bound to the active session; a fresh session
      // shows an empty tree which is the right starting point for
      // attaching context to a new conversation. Also avoids
      // stranding the user in the agent creator (or any other deep
      // route) with the right-rail chat hidden.
      navigate(basePath + '/files');
      setChatOpen(true);
    } finally {
      setCreatingSession(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Workspace switcher */}
      <div className="relative border-b border-border">
        <button
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-100 transition-colors"
          onClick={() => setShowSwitcher(!showSwitcher)}
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {workspace?.name || workspaceId}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Badge variant="success" className="text-[10px] px-1 py-0">
                {workspace?.status || 'RUNNING'}
              </Badge>
            </div>
          </div>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showSwitcher && 'rotate-180')} />
        </button>

        {showSwitcher && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowSwitcher(false)} />
            <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-[10px] border border-border bg-white py-1 shadow-[0_8px_32px_rgba(12,29,54,0.12)]">
              <p className="px-3 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Switch Workspace
              </p>

              {allWorkspaces.map((ws) => (
                <button
                  key={ws.workspaceId}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors',
                    ws.workspaceId === workspaceId && 'bg-zinc-50',
                  )}
                  onClick={() => {
                    setShowSwitcher(false);
                    navigate(`/workspaces/${ws.workspaceId}`);
                  }}
                >
                  <span className="truncate flex-1">{ws.workspaceId}</span>
                  {ws.workspaceId === workspaceId && (
                    <Check className="h-4 w-4 text-emerald-500" />
                  )}
                </button>
              ))}

              <Separator className="my-1" />

              {WORKSPACE_CREATION_ENABLED && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-zinc-50 hover:text-foreground transition-colors"
                  onClick={() => {
                    setShowSwitcher(false);
                    navigate('/onboarding');
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Create Workspace
                </button>
              )}

              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-zinc-50 hover:text-foreground transition-colors"
                onClick={logout}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          </>
        )}
      </div>

      {/* New chat — primary action, parked at the top of the sidebar
          (right under the workspace switcher) so it's the first thing
          the user reaches for. */}
      <div className="px-2 pt-2 pb-1">
        <Button
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleCreateSession}
          disabled={creatingSession}
        >
          {creatingSession ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          New chat
        </Button>
      </div>

      {/* Navigation — single flat list */}
      <nav className="space-y-0.5 px-2 py-2">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
          <button
            key={path}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              isActive(path)
                ? 'bg-white text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-white/70 hover:text-foreground',
            )}
            onClick={() => navigate(basePath + path)}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </nav>

      {sessionCreateError && (
        <div className="mx-3 my-1 flex items-start justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
          <span className="flex-1">{sessionCreateError}</span>
          <button
            className="text-amber-900/70 hover:text-amber-900"
            onClick={clearSessionCreateError}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <ScrollArea className="flex-1 px-2">
        <div className="border-t border-border pt-2">
          <p className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Recent
          </p>
          <div className="space-y-0.5 pb-2">
            {sessions
              .filter((s) => !s.testAgentId)
              .map((session) => {
                const isActive = activeSessionId === session.id;
                const isEditing = editingId === session.id;
                const displayName = isPlaceholderName(session)
                  ? 'New chat'
                  : session.name;
                return (
                  <div
                    key={session.id}
                    className={cn(
                      'group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors cursor-pointer',
                      isActive
                        ? 'bg-white text-foreground shadow-sm'
                        : 'text-muted-foreground/80 hover:bg-white/70 hover:text-foreground',
                    )}
                    onClick={() => !isEditing && setActiveSessionId(session.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEditing(session.id, session.name);
                    }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={commitEditing}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void commitEditing();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEditing();
                          }
                        }}
                        placeholder="Chat name"
                        maxLength={60}
                        className="flex-1 min-w-0 rounded border border-border bg-white px-1.5 py-0.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
                      />
                    ) : (
                      <>
                        <span
                          className={cn(
                            // min-w-0 lets `truncate` actually clip
                            // (flex items default to min-width:auto =
                            // content size, defeating overflow:hidden).
                            'min-w-0 flex-1 truncate',
                            isPlaceholderName(session) && 'italic opacity-70',
                          )}
                        >
                          {displayName}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60 group-hover:hidden">
                          {formatRelativeTime(session.lastModified)}
                        </span>
                        <button
                          className="hidden group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditing(session.id, session.name);
                          }}
                          title="Rename"
                        >
                          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </button>
                        <button
                          className="hidden group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(session.id);
                          }}
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-red-600" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            {sessions.filter((s) => !s.testAgentId).length === 0 && (
              <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                No chats yet
              </p>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Footer — account-level actions */}
      <div className="space-y-0.5 border-t border-border px-3 py-2">
        <CommunityLink />
        <button
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            isActive('/settings')
              ? 'bg-white text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-zinc-100 hover:text-foreground',
          )}
          onClick={() => navigate(basePath + '/settings')}
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-zinc-100 hover:text-foreground transition-colors"
          onClick={logout}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}

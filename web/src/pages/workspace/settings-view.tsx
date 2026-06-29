import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Loader2,
  AlertTriangle,
  Sparkles,
  Eye,
  EyeOff,
  Check,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { deleteWorkspace, updateWorkspace } from '@/api/workspaces';
import { listIntegrations, setIntegration } from '@/api/integrations';
import { BillingSection } from '@/extensions/billing-section';
import { useWorkspace } from './workspace-context';
import { usePostHog } from '@posthog/react';

const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat';

export function SettingsView() {
  const navigate = useNavigate();
  const { workspace, workspaceId } = useWorkspace();
  const posthog = usePostHog();
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Claude Code token state
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [claudeLoading, setClaudeLoading] = useState(true);
  const [claudeToken, setClaudeToken] = useState('');
  const [showClaudeToken, setShowClaudeToken] = useState(false);
  const [savingClaude, setSavingClaude] = useState(false);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [editingClaude, setEditingClaude] = useState(false);

  // Diagnostics opt-out state. Mirrors the workspace row's
  // `diagnosticsOptOut` boolean; toggling PATCHes the workspace and
  // updates local state on success.
  const [optOut, setOptOut] = useState<boolean>(!!workspace?.diagnosticsOptOut);
  const [savingOptOut, setSavingOptOut] = useState(false);
  const [optOutError, setOptOutError] = useState<string | null>(null);

  useEffect(() => {
    setOptOut(!!workspace?.diagnosticsOptOut);
  }, [workspace?.diagnosticsOptOut]);

  const handleToggleOptOut = async () => {
    const next = !optOut;
    setSavingOptOut(true);
    setOptOutError(null);
    // Optimistic: flip immediately so the toggle feels responsive.
    // Roll back on error.
    setOptOut(next);
    try {
      await updateWorkspace(workspaceId, { diagnosticsOptOut: next });
      posthog?.capture('workspace_diagnostics_optout_toggled', {
        workspace_id: workspaceId,
        opted_out: next,
      });
    } catch (err) {
      posthog?.captureException(err);
      setOptOut(!next);
      setOptOutError((err as Error).message);
    } finally {
      setSavingOptOut(false);
    }
  };

  useEffect(() => {
    listIntegrations(workspaceId)
      .then((res) => setClaudeConnected(res.integrations.includes('claude')))
      .catch(() => setClaudeConnected(false))
      .finally(() => setClaudeLoading(false));
  }, [workspaceId]);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(workspaceId);
      posthog?.capture('workspace_deleted', { workspace_id: workspaceId });
      navigate('/');
    } catch (err) {
      posthog?.captureException(err);
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  const isValidClaudeToken =
    claudeToken.startsWith(CLAUDE_TOKEN_PREFIX) && claudeToken.length >= 90;
  const claudeInputInvalid = claudeToken.length > 0 && !isValidClaudeToken;

  const handleSaveClaude = async () => {
    if (!isValidClaudeToken) return;
    setSavingClaude(true);
    setClaudeError(null);
    try {
      await setIntegration(workspaceId, 'claude', { token: claudeToken.trim() });
      posthog?.capture('claude_token_saved', {
        workspace_id: workspaceId,
        is_update: claudeConnected,
      });
      setClaudeConnected(true);
      setClaudeToken('');
      setEditingClaude(false);
    } catch (err) {
      posthog?.captureException(err);
      setClaudeError((err as Error).message);
    } finally {
      setSavingClaude(false);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-2xl space-y-8 px-6 py-6">
        {/* Info */}
        <div>
          <h3 className="mb-3 text-sm font-medium">Workspace Info</h3>
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="text-sm">{workspace?.name || workspaceId}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm text-muted-foreground">Workspace ID</span>
              <span className="font-mono text-sm">{workspaceId}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">Created</span>
              <span className="text-sm">
                {workspace?.createdAt ? new Date(workspace.createdAt).toLocaleDateString() : '-'}
              </span>
            </div>
          </div>
        </div>

        {/* Billing */}
        <BillingSection />

        {/* Claude Code token */}
        <div>
          <h3 className="mb-3 text-sm font-medium">Claude Code</h3>
          <div className="rounded-[14px] border border-border bg-white p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50">
                <Sparkles className="h-5 w-5 text-[#2563eb]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-medium">Anthropic setup token</h4>
                  {claudeConnected && (
                    <Badge variant="success" className="text-[10px]">Connected</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  The agent uses a Claude Code setup token to call Claude on your behalf.
                  Setup tokens never expire and are stored encrypted — they're only
                  read by your workspace agent.
                </p>

                {/* How to get a token */}
                {(editingClaude || !claudeConnected) && !claudeLoading && (
                  <div className="mt-4 rounded-[10px] border border-border bg-zinc-50 p-3">
                    <p className="mb-2 text-xs font-medium text-foreground">How to get a token</p>
                    <ol className="space-y-1.5 text-xs text-muted-foreground">
                      <li>
                        1. Install Claude Code from{' '}
                        <a
                          href="https://docs.anthropic.com/en/docs/claude-code"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-[#2563eb] hover:underline"
                        >
                          docs.anthropic.com
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </li>
                      <li>
                        2. In your terminal, run{' '}
                        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px]">
                          claude setup-token
                        </code>
                      </li>
                      <li>
                        3. Sign in with your Anthropic account when prompted
                      </li>
                      <li>
                        4. Copy the token starting with{' '}
                        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px]">
                          sk-ant-oat
                        </code>{' '}
                        and paste it below
                      </li>
                    </ol>
                  </div>
                )}

                {claudeLoading ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </div>
                ) : editingClaude || !claudeConnected ? (
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="claude-token" className="text-xs">
                      Setup Token
                    </Label>
                    <div className="relative">
                      <Input
                        id="claude-token"
                        type={showClaudeToken ? 'text' : 'password'}
                        placeholder="sk-ant-oat..."
                        value={claudeToken}
                        onChange={(e) => setClaudeToken(e.target.value.replace(/\s+/g, ''))}
                        disabled={savingClaude}
                        className="pr-16 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setShowClaudeToken(!showClaudeToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showClaudeToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {claudeInputInvalid && (
                      <p className="text-[11px] text-red-600">
                        Token must start with <code>sk-ant-oat</code> and be at least 90 characters.
                      </p>
                    )}
                    {isValidClaudeToken && (
                      <p className="text-[11px] text-emerald-600 inline-flex items-center gap-1">
                        <Check className="h-3 w-3" />
                        Token looks valid
                      </p>
                    )}
                    {claudeError && (
                      <p className="text-[11px] text-red-600">{claudeError}</p>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        className="h-8"
                        onClick={handleSaveClaude}
                        disabled={!isValidClaudeToken || savingClaude}
                      >
                        {savingClaude && <Loader2 className="h-3 w-3 animate-spin" />}
                        Save token
                      </Button>
                      {editingClaude && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => {
                            setEditingClaude(false);
                            setClaudeToken('');
                            setClaudeError(null);
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => setEditingClaude(true)}
                    >
                      Update token
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Danger zone */}
        <div>
          <h3 className="mb-3 text-sm font-medium text-red-600">Danger Zone</h3>

          <div className="mb-3 rounded-lg border border-red-200 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="flex-1">
                <p className="text-sm font-medium">Delete this workspace</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This will permanently delete the workspace, all its resources, and remove
                  all members. This action cannot be undone.
                </p>

                {!showConfirm ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="mt-3"
                    onClick={() => setShowConfirm(true)}
                  >
                    Delete workspace
                  </Button>
                ) : (
                  <div className="mt-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      Type <span className="font-mono font-medium text-foreground">{workspaceId}</span> to confirm:
                    </p>
                    <Input
                      placeholder={workspaceId}
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      disabled={deleting}
                      className="mb-2"
                    />
                    {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={confirmText !== workspaceId || deleting}
                        onClick={handleDelete}
                      >
                        {deleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          'Permanently delete'
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setShowConfirm(false); setConfirmText(''); setError(null); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-red-200 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Opt out of diagnostics</p>
                  {optOut && (
                    <Badge variant="success" className="text-[10px]">On</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Not recommended — disables our ability to debug issues you report.
                </p>
                {optOutError && (
                  <p className="mt-2 text-xs text-red-600">{optOutError}</p>
                )}
                <Button
                  variant={optOut ? 'outline' : 'destructive'}
                  size="sm"
                  className="mt-3"
                  disabled={savingOptOut}
                  onClick={handleToggleOptOut}
                >
                  {savingOptOut && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {optOut ? 'Re-enable diagnostics' : 'Opt out of diagnostics'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

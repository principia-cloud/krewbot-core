import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setIntegration } from '@/api/integrations';
import { APP_TITLE } from '@/lib/constants';

interface Props {
  workspaceId: string;
  /** Called after a successful save so the parent can refresh the
   * integrations list and dismiss this modal. */
  onSaved: () => void;
  /** Dismiss without saving — the user can still explore the rest
   * of the workspace UI; chat will fail until they configure the
   * token from Settings → Integrations. The prompt re-appears on
   * the next workspace load while the integration is missing. */
  onDismiss: () => void;
}

/** Post-provisioning Claude setup modal.
 *
 * Mounts on top of the workspace shell when status=RUNNING and the
 * workspace doesn't yet have a `claude` integration. Replaces the
 * old onboarding step — getting the token requires running
 * `claude setup-token` locally, which most people can't do during
 * the signup flow (they're on a phone, in a meeting, etc.).
 * Pushing it to post-provisioning means signup never blocks on
 * machine setup. */
export function ClaudeTokenSetupModal({ workspaceId, onSaved, onDismiss }: Props) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = token.startsWith('sk-ant-oat') && token.length >= 90;
  const hasInput = token.length > 0;
  const isInvalid = hasInput && !isValid;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      await setIntegration(workspaceId, 'claude', { token });
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Could not save the token. Try again.');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Set up Claude token"
    >
      <div className="w-full max-w-lg rounded-[12px] border border-border bg-white p-6 shadow-[0_24px_64px_rgba(12,29,54,0.18)]">
        <h2 className="mb-1 text-lg font-semibold">One last step</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Your workspace is ready. Paste a Claude setup token so the agent
          can start replying.
        </p>

        <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
          Right now, the best way to power your {APP_TITLE} is with a Claude Code
          subscription — it gives you the most value per token while we're in
          beta. We're actively working on API support so you'll have more
          flexibility soon. Thanks for being part of the early journey with us!
        </p>

        <div className="mb-5 rounded-lg border border-border bg-zinc-50 p-4">
          <h3 className="mb-2 text-sm font-medium">How to get a token</h3>
          <ol className="space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. Install Claude Code if you haven't:{' '}
              <a
                href="https://docs.anthropic.com/en/docs/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                docs <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>
              2. Open a terminal and run:{' '}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">
                claude setup-token
              </code>
            </li>
            <li>
              3. Copy the token that starts with{' '}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono">
                sk-ant-oat
              </code>
            </li>
            <li>4. Paste it below</li>
          </ol>
        </div>

        <div>
          <Label htmlFor="claude-token-modal">Setup Token</Label>
          <div className="relative mt-1.5">
            <Input
              id="claude-token-modal"
              type={showToken ? 'text' : 'password'}
              placeholder="sk-ant-oat..."
              value={token}
              onChange={(e) => setToken(e.target.value.replace(/\s+/g, ''))}
              className="pr-16 font-mono text-xs"
              disabled={saving}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          {isInvalid && (
            <p className="mt-1 text-xs text-red-600">
              Token must start with <code>sk-ant-oat</code> and be at least 90
              characters.
            </p>
          )}
          {isValid && !error && (
            <p className="mt-1 text-xs text-emerald-600">Token looks valid.</p>
          )}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={onDismiss}
            disabled={saving}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            I'll do this later
          </button>
          <Button onClick={handleSave} disabled={!isValid || saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save and start'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

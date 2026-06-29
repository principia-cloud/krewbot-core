import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setIntegration } from '@/api/integrations';
import { APP_NAME, WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';

/**
 * 3-step guided Slack setup. Takes over the entire Connect-dialog body
 * (see integrations-view.tsx — when `config.setupHelper` is set, the
 * legacy field/save layout is suppressed).
 *
 * Step 1 — Create the Slack app via a manifest deep-link. The manifest
 *   intentionally omits `event_subscriptions.request_url` so Slack does
 *   NOT URL-verify at app-creation time. Verification happens in step 3
 *   when the user enables Event Subscriptions, by which point creds are
 *   already in Secrets Manager and the chat-server's Slack adapter has
 *   reloaded.
 *
 * Step 2 — Install to workspace + collect Bot Token and Signing Secret.
 *   On "Save & Continue" we call PUT /integrations/slack synchronously,
 *   so by the time the user starts step 3 the sidecar has already begun
 *   propagating the secrets onto /config/secrets/. The parent's
 *   onSaved() fires so the card flips to Connected immediately — even
 *   if the user dismisses the dialog before finishing step 3.
 *
 * Step 3 — Display the workspace-specific webhook URL + the exact
 *   bot_events list to subscribe to. The user pastes the URL into
 *   Slack's Event Subscriptions panel; URL verification succeeds once
 *   the chat-server's `maybeReloadChatSdk` poll has materialised the
 *   adapter (typically <60s after step 2).
 */

const BOT_SCOPES = [
  'chat:write',
  'app_mentions:read',
  'im:history',
  'im:read',
  'im:write',
];

const BOT_EVENTS = ['app_mention', 'message.im'];

function buildManifestUrl(displayName: string): string {
  const manifest = {
    display_information: { name: displayName },
    features: {
      bot_user: {
        display_name: displayName,
        always_online: true,
      },
      // Enable the Messages tab on the app's home so users can DM the
      // bot directly from Slack's sidebar. Without `messages_tab_enabled`
      // there is no UI surface to start a DM with the bot, and inbound
      // `message.im` events have no way to be triggered.
      // `read_only_enabled: false` lets users actually type in that tab.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(manifest));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encoded}`;
}

export interface SlackSetupHelperProps {
  workspaceId: string;
  /** Fired once credentials have been persisted (after step 2). The
   * parent uses this to flip the card to "Connected" immediately so
   * the user sees progress even if they close the dialog before
   * finishing step 3. */
  onSaved: () => void;
  /** Fired when the user clicks Done on the final step. The parent
   * closes the dialog. */
  onClose: () => void;
}

type Step = 1 | 2 | 3;

export function SlackSetupHelper({ workspaceId, onSaved, onClose }: SlackSetupHelperProps) {
  const [step, setStep] = useState<Step>(1);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [showBotToken, setShowBotToken] = useState(false);
  const [showSigningSecret, setShowSigningSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const webhookUrl = `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}/webhooks/slack`;
  const manifestUrl = buildManifestUrl(APP_NAME);

  const handleSaveCredentials = async () => {
    const trimmed = {
      botToken: botToken.trim(),
      signingSecret: signingSecret.trim(),
    };
    if (!trimmed.botToken || !trimmed.signingSecret) {
      setError('Both Bot Token and Signing Secret are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setIntegration(workspaceId, 'slack', { credentials: trimmed });
      onSaved();
      setStep(3);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const el = document.getElementById('slack-webhook-url') as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div>
      {/* Step indicator */}
      <div className="mb-5 flex items-center">
        {([1, 2, 3] as const).map((n, i) => (
          <div key={n} className="flex items-center">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
                n < step
                  ? 'bg-zinc-700 text-white'
                  : n === step
                    ? 'bg-foreground text-background'
                    : 'bg-zinc-200 text-zinc-500'
              }`}
            >
              {n < step ? <Check className="h-3 w-3" /> : n}
            </div>
            {i < 2 && (
              <div
                className={`mx-2 h-px w-8 ${n < step ? 'bg-zinc-700' : 'bg-zinc-200'}`}
              />
            )}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div>
          <h4 className="text-sm font-semibold">Create the Slack app</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Opens api.slack.com with a pre-filled manifest (name, bot user, and the
            minimum scopes the bot needs). Review the config, then click{' '}
            <em>Create</em> in Slack.
          </p>
          <Button asChild size="sm" className="mt-3">
            <a href={manifestUrl} target="_blank" rel="noopener noreferrer">
              Create Slack app
              <ExternalLink className="ml-1.5 h-3 w-3" />
            </a>
          </Button>

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setStep(2)}>
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <h4 className="text-sm font-semibold">Install and copy credentials</h4>
          <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
            <li>
              1. In Slack&apos;s OAuth &amp; Permissions page, click{' '}
              <em>Install to {'<'}your workspace name{'>'}</em> and approve.
            </li>
            <li>
              2. Copy the <em>Bot User OAuth Token</em> (starts with{' '}
              <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[10px]">
                xoxb-
              </code>
              ).
            </li>
            <li>
              3. Go to <em>Basic Information → App Credentials</em>, click{' '}
              <em>Show</em> next to Signing Secret, and copy it.
            </li>
          </ol>

          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="slack-bot-token">Bot Token</Label>
              <div className="relative mt-1">
                <Input
                  id="slack-bot-token"
                  type={showBotToken ? 'text' : 'password'}
                  placeholder="xoxb-..."
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  disabled={saving}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowBotToken((v) => !v)}
                  tabIndex={-1}
                >
                  {showBotToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <Label htmlFor="slack-signing-secret">Signing Secret</Label>
              <div className="relative mt-1">
                <Input
                  id="slack-signing-secret"
                  type={showSigningSecret ? 'text' : 'password'}
                  placeholder="e.g. a1b2c3d4e5f6..."
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  disabled={saving}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSigningSecret((v) => !v)}
                  tabIndex={-1}
                >
                  {showSigningSecret ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

          <div className="mt-5 flex justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(1)}
              disabled={saving}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
            <Button
              size="sm"
              onClick={handleSaveCredentials}
              disabled={saving || !botToken.trim() || !signingSecret.trim()}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save &amp; Continue
              {!saving && <ArrowRight className="ml-1 h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <h4 className="text-sm font-semibold">Enable Event Subscriptions</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Credentials saved. They take about a minute to propagate to your
            workspace — finish the steps below and Slack&apos;s URL verification
            should pass on the first try.
          </p>

          <ol className="mt-3 space-y-1 text-xs text-muted-foreground">
            <li>1. In your Slack app, go to <em>Event Subscriptions</em>.</li>
            <li>2. Toggle <em>Enable Events</em> on.</li>
            <li>3. Paste the Request URL below.</li>
            <li>
              4. Under <em>Subscribe to bot events</em>, add:
              {BOT_EVENTS.map((e) => (
                <code
                  key={e}
                  className="mx-1 rounded bg-zinc-200 px-1 py-px font-mono text-[10px]"
                >
                  {e}
                </code>
              ))}
            </li>
            <li>
              5. Click <em>Save Changes</em>. If verification fails, wait ~30s and
              click <em>Retry</em>.
            </li>
            <li>
              6. Reinstall the app if Slack prompts you (scopes haven&apos;t
              changed, but adding events can trigger a reinstall banner).
            </li>
          </ol>

          <div className="mt-3">
            <Label htmlFor="slack-webhook-url" className="text-[11px]">
              Request URL
            </Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="slack-webhook-url"
                readOnly
                value={webhookUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="cursor-text font-mono text-[11px]"
              />
              <Button size="sm" variant="outline" onClick={copyWebhook} type="button">
                {copied ? (
                  <>
                    <Check className="mr-1 h-3 w-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" /> Copy
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="mt-5 flex justify-end">
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

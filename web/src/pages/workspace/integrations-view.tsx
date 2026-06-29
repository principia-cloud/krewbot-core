import { useState } from 'react';
import {
  MessageCircle,
  BookOpen,
  Github,
  Hash,
  KeyRound,
  LayoutGrid,
  Loader2,
  Eye,
  EyeOff,
  Pencil,
  Phone,
  Plus,
  Shield,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useEffect } from 'react';
import {
  listIntegrations,
  setIntegration,
  removeIntegration,
  setCustomIntegration,
  removeCustomIntegration,
  getGoogleAuthUrl,
  getMicrosoftAuthUrl,
  type CustomIntegrationEntry,
} from '@/api/integrations';
import { linkMyTelegram } from '@/api/members';
import { useWorkspace } from './workspace-context';
import type { IntegrationName } from '@/api/types';
import type { LucideIcon } from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { SlackSetupHelper } from './slack-setup-helper';
import { WhatsAppSetupHelper } from './whatsapp-setup-helper';

interface PlatformField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  /** When true, this field is saved via the per-user endpoint, not the
   * workspace integration endpoint. Used for personal account links like
   * the user's own Telegram ID. */
  userScope?: boolean;
  /** Validation regex pattern for user input */
  pattern?: RegExp;
  patternError?: string;
  helperText?: string;
}

interface PlatformConfig {
  name: IntegrationName;
  label: string;
  description: string;
  icon: LucideIcon;
  section: 'messaging' | 'productivity';
  fields: Array<PlatformField>;
  bodyKey: string;
  instructions?: string[];
  /** Optional component that REPLACES the default field+save layout
   * inside the Connect dialog. Used by integrations that need a guided
   * multi-step setup (Slack: manifest deep-link → install + tokens →
   * Event Subscriptions). When set, the helper owns its own state,
   * calls the integrations API directly, and signals back via
   * `onSaved` (credentials persisted — flip the card to Connected) and
   * `onClose` (wizard finished — close the dialog). */
  setupHelper?: React.ComponentType<{
    workspaceId: string;
    onSaved: () => void;
    onClose: () => void;
  }>;
  comingSoon?: boolean;
  /** When set, the card uses a custom auth flow instead of the field
   * dialog. 'google' and 'microsoft' open an OAuth consent popup. */
  authFlow?: 'google' | 'microsoft';
}

const PLATFORMS: PlatformConfig[] = [
  // Messaging Platforms
  {
    name: 'telegram',
    label: 'Telegram',
    description: 'Messaging platform. Connect your bot for chat access.',
    icon: MessageCircle,
    section: 'messaging',
    fields: [
      {
        key: 'token',
        label: 'Bot Token',
        placeholder: '123456789:ABCdefGHI...',
        type: 'password',
      },
      {
        key: 'adminTelegramId',
        label: 'Your Telegram User ID',
        placeholder: 'e.g. 123456789',
        type: 'text',
        userScope: true,
        pattern: /^[0-9]{4,20}$/,
        patternError: 'Must be a numeric ID (4–20 digits).',
        helperText: 'Find yours by messaging @userinfobot on Telegram.',
      },
    ],
    bodyKey: 'token',
    instructions: [
      'Message @BotFather on Telegram and send /newbot',
      'Copy the API token and paste it in the Bot Token field',
      'Get your personal Telegram user ID from @userinfobot',
    ],
  },
  {
    name: 'slack',
    label: 'Slack',
    description: 'Team communication and messaging platform.',
    icon: Hash,
    section: 'messaging',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password' },
      { key: 'signingSecret', label: 'Signing Secret', placeholder: 'e.g. a1b2c3d4e5f6...', type: 'password' },
    ],
    bodyKey: 'credentials',
    setupHelper: SlackSetupHelper,
  },
  {
    name: 'whatsapp',
    label: 'WhatsApp',
    description: 'Business messaging via WhatsApp Business API.',
    icon: Phone,
    section: 'messaging',
    fields: [
      { key: 'apiToken', label: 'Business API Token', placeholder: 'EAAx...', type: 'password' },
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'e.g. 123456789012345', type: 'text' },
      { key: 'appSecret', label: 'App Secret', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'password' },
    ],
    bodyKey: 'credentials',
    setupHelper: WhatsAppSetupHelper,
  },
  {
    name: 'teams',
    label: 'Microsoft Teams',
    description: 'Enterprise communication and collaboration.',
    icon: Shield,
    section: 'messaging',
    comingSoon: true,
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', type: 'text' },
      { key: 'appPassword', label: 'App Password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'password' },
    ],
    bodyKey: 'credentials',
    instructions: [
      'Register a bot in the Azure Bot Framework portal',
      'Copy the Microsoft App ID from the bot registration',
      'Generate and copy the App Password (client secret)',
    ],
  },
  // Productivity
  {
    name: 'notion',
    label: 'Notion',
    description: 'Knowledge base and documentation workspace.',
    icon: BookOpen,
    section: 'productivity',
    fields: [{ key: 'token', label: 'Integration Token', placeholder: 'ntn_...', type: 'password' }],
    bodyKey: 'token',
  },
  {
    name: 'google',
    label: 'Google',
    description: 'Google Workspace integration for Docs, Sheets, and Drive.',
    icon: LayoutGrid,
    section: 'productivity',
    fields: [],
    bodyKey: 'credentials',
    authFlow: 'google',
  },
  {
    name: 'microsoft',
    label: 'Microsoft 365',
    description: 'Outlook, Calendar, OneDrive/SharePoint, Teams, and Office (Excel, OneNote).',
    icon: LayoutGrid,
    section: 'productivity',
    fields: [],
    bodyKey: 'credentials',
    authFlow: 'microsoft',
  },
  {
    name: 'github',
    label: 'GitHub',
    description: 'Code repositories and version control.',
    icon: Github,
    section: 'productivity',
    fields: [{ key: 'token', label: 'Access Token', placeholder: 'ghp_...', type: 'password' }],
    bodyKey: 'token',
    comingSoon: true,
  },
  {
    name: 'linear',
    label: 'Linear',
    description: 'Project management and issue tracking.',
    icon: LayoutGrid,
    section: 'productivity',
    fields: [{ key: 'token', label: 'API Key', placeholder: 'lin_api_...', type: 'password' }],
    bodyKey: 'token',
    comingSoon: true,
  },
];

const SECTIONS: Array<{ key: PlatformConfig['section']; label: string }> = [
  { key: 'messaging', label: 'Messaging Platforms' },
  { key: 'productivity', label: 'Productivity' },
];

function PlatformCardItem({
  config,
  workspaceId,
  initiallyConnected,
  onConnectedChange,
}: {
  config: PlatformConfig;
  workspaceId: string;
  initiallyConnected: boolean;
  onConnectedChange: (name: IntegrationName, connected: boolean) => void;
}) {
  const posthog = usePostHog();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [connected, setConnected] = useState(initiallyConnected);
  const [error, setError] = useState<string | null>(null);

  // Sync the local state if the parent's authoritative list changes (e.g.
  // after another card connects/disconnects and triggers a refresh).
  useEffect(() => {
    setConnected(initiallyConnected);
  }, [initiallyConnected]);

  const Icon = config.icon;

  const workspaceFields = config.fields.filter((f) => !f.userScope);
  const userFields = config.fields.filter((f) => f.userScope);

  const allFieldsFilled = config.fields.every((f) => (fieldValues[f.key] || '').trim() !== '');
  const fieldErrors = config.fields
    .filter((f) => f.pattern && (fieldValues[f.key] || '').trim() !== '')
    .filter((f) => !f.pattern!.test((fieldValues[f.key] || '').trim()));
  const allFieldsValid = allFieldsFilled && fieldErrors.length === 0;

  const handleSave = async () => {
    if (!allFieldsValid) return;
    setSaving(true);
    setError(null);
    try {
      // 1) Save workspace-level fields via the integrations endpoint
      if (workspaceFields.length > 0) {
        let body: Record<string, unknown>;
        if (config.bodyKey === 'credentials') {
          const credentials: Record<string, string> = {};
          for (const field of workspaceFields) {
            credentials[field.key] = (fieldValues[field.key] || '').trim();
          }
          body = { credentials };
        } else {
          body = { [config.bodyKey]: (fieldValues[workspaceFields[0].key] || '').trim() };
        }
        await setIntegration(workspaceId, config.name, body);
      }

      // 2) Save user-scoped fields via the per-user endpoint(s).
      // Currently only Telegram has a user-scoped field, so we hardcode the
      // mapping here. If we add more, this can become a small registry.
      for (const field of userFields) {
        if (config.name === 'telegram' && field.key === 'adminTelegramId') {
          await linkMyTelegram(workspaceId, (fieldValues[field.key] || '').trim());
        }
      }

      posthog?.capture('integration_connected', {
        workspace_id: workspaceId,
        integration: config.name,
        section: config.section,
      });
      setConnected(true);
      setDialogOpen(false);
      setFieldValues({});
      onConnectedChange(config.name, true);
    } catch (err) {
      posthog?.captureException(err);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setRemoving(true);
    setError(null);
    try {
      await removeIntegration(workspaceId, config.name);
      posthog?.capture('integration_disconnected', {
        workspace_id: workspaceId,
        integration: config.name,
        section: config.section,
      });
      setConnected(false);
      onConnectedChange(config.name, false);
    } catch (err) {
      posthog?.captureException(err);
      setError((err as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  // Google OAuth flow: fetch the auth URL, open it in a popup, listen for
  // the callback message, then submit the auth_code to PUT /integrations/google.
  const handleConnectGoogle = async () => {
    setSaving(true);
    setError(null);
    const redirectUri = `${window.location.origin}/oauth/google/callback`;

    let popup: Window | null = null;
    try {
      const { url } = await getGoogleAuthUrl(workspaceId, redirectUri);
      // Open popup centered. Some browsers require this to happen
      // synchronously inside the user gesture, but our await pushes it
      // outside — modern Chromium still allows it because it's the
      // direct result of an async operation triggered by a click.
      const w = 520;
      const h = 640;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      popup = window.open(
        url,
        'google-oauth',
        `width=${w},height=${h},left=${left},top=${top}`,
      );
      if (!popup) {
        throw new Error('Popup blocked. Please allow popups for this site and try again.');
      }
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
      return;
    }

    // Two delivery channels (postMessage and BroadcastChannel) — see
    // google-callback.tsx for the rationale. Whichever fires first wins;
    // teardown closes both before they can double-fire.
    type CallbackPayload = { code?: string; state?: string | null; error?: string };
    let settled = false;
    const teardown = () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      bc?.close();
      window.clearInterval(closedTimer);
    };
    const handleCallback = async (data: CallbackPayload) => {
      if (settled) return;
      settled = true;
      teardown();

      if (data.error || !data.code) {
        setSaving(false);
        setError(data.error || 'Google sign-in was cancelled.');
        return;
      }

      try {
        await setIntegration(workspaceId, 'google', {
          credentials: {
            auth_code: data.code,
            redirect_uri: redirectUri,
          },
        });
        posthog?.capture('integration_connected', {
          workspace_id: workspaceId,
          integration: 'google',
          section: 'productivity',
        });
        setConnected(true);
        onConnectedChange(config.name, true);
      } catch (err) {
        posthog?.captureException(err);
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as ({ type?: string } & CallbackPayload) | undefined;
      if (!data || data.type !== 'google-oauth-callback') return;
      console.log('[oauth-google] parent: received via postMessage', { hasCode: !!data.code, hasError: !!data.error });
      handleCallback(data);
    };
    window.addEventListener('message', onMessage);

    // storage event: the COOP-proof channel — fires on any same-origin
    // window when localStorage changes. Works across browsing context
    // groups, so it survives the popup→opener severance COOP causes.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'oauth-callback-google' || !event.newValue) return;
      try {
        const data = JSON.parse(event.newValue) as ({ type?: string } & CallbackPayload);
        if (data.type !== 'google-oauth-callback') return;
        console.log('[oauth-google] parent: received via localStorage', { hasCode: !!data.code, hasError: !!data.error });
        handleCallback(data);
      } catch {
        // Malformed payload — ignore.
      }
    };
    window.addEventListener('storage', onStorage);
    console.log('[oauth-google] parent: listeners armed', { redirectUri });

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('google-oauth-callback');
      bc.onmessage = (e: MessageEvent) => {
        const data = e.data as ({ type?: string } & CallbackPayload) | undefined;
        if (!data || data.type !== 'google-oauth-callback') return;
        console.log('[oauth-google] parent: received via BroadcastChannel', { hasCode: !!data.code, hasError: !!data.error });
        handleCallback(data);
      };
    } catch (err) {
      console.warn('[oauth-google] parent: BroadcastChannel unsupported', err);
    }

    // Detect manual popup close — clear listeners so the user can retry.
    const closedTimer = window.setInterval(() => {
      if (popup && popup.closed) {
        if (settled) return;
        teardown();
        setSaving((current) => {
          if (current) {
            setError('Google sign-in window was closed before completing.');
            return false;
          }
          return current;
        });
      }
    }, 800);
  };

  // Microsoft OAuth flow: mirror of handleConnectGoogle. Differs only in the
  // auth URL endpoint and the postMessage type discriminator.
  const handleConnectMicrosoft = async () => {
    setSaving(true);
    setError(null);
    const redirectUri = `${window.location.origin}/oauth/microsoft/callback`;

    let popup: Window | null = null;
    try {
      const { url } = await getMicrosoftAuthUrl(workspaceId, redirectUri);
      const w = 520;
      const h = 640;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      popup = window.open(
        url,
        'microsoft-oauth',
        `width=${w},height=${h},left=${left},top=${top}`,
      );
      if (!popup) {
        throw new Error('Popup blocked. Please allow popups for this site and try again.');
      }
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
      return;
    }

    // Two delivery channels — see microsoft-callback.tsx.
    type CallbackPayload = { code?: string; state?: string | null; error?: string };
    let settled = false;
    const teardown = () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      bc?.close();
      window.clearInterval(closedTimer);
    };
    const handleCallback = async (data: CallbackPayload) => {
      if (settled) return;
      settled = true;
      teardown();

      if (data.error || !data.code) {
        setSaving(false);
        setError(data.error || 'Microsoft sign-in was cancelled.');
        return;
      }

      try {
        await setIntegration(workspaceId, 'microsoft', {
          credentials: {
            auth_code: data.code,
            redirect_uri: redirectUri,
          },
        });
        posthog?.capture('integration_connected', {
          workspace_id: workspaceId,
          integration: 'microsoft',
          section: 'productivity',
        });
        setConnected(true);
        onConnectedChange(config.name, true);
      } catch (err) {
        posthog?.captureException(err);
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as ({ type?: string } & CallbackPayload) | undefined;
      if (!data || data.type !== 'microsoft-oauth-callback') return;
      console.log('[oauth-ms] parent: received via postMessage', { hasCode: !!data.code, hasError: !!data.error });
      handleCallback(data);
    };
    window.addEventListener('message', onMessage);

    // storage event: fires across same-origin windows regardless of
    // browsing context group — the COOP-proof channel.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'oauth-callback-microsoft' || !event.newValue) return;
      try {
        const data = JSON.parse(event.newValue) as ({ type?: string } & CallbackPayload);
        if (data.type !== 'microsoft-oauth-callback') return;
        console.log('[oauth-ms] parent: received via localStorage', { hasCode: !!data.code, hasError: !!data.error });
        handleCallback(data);
      } catch {
        // Malformed payload — ignore.
      }
    };
    window.addEventListener('storage', onStorage);
    console.log('[oauth-ms] parent: listeners armed', { redirectUri });

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('microsoft-oauth-callback');
      bc.onmessage = (e: MessageEvent) => {
        const data = e.data as ({ type?: string } & CallbackPayload) | undefined;
        if (!data || data.type !== 'microsoft-oauth-callback') return;
        console.log('[oauth-ms] parent: received via BroadcastChannel', { hasCode: !!data.code, hasError: !!data.error });
        handleCallback(data);
      };
    } catch (err) {
      console.warn('[oauth-ms] parent: BroadcastChannel unsupported', err);
    }

    const closedTimer = window.setInterval(() => {
      if (popup && popup.closed) {
        if (settled) return;
        teardown();
        setSaving((current) => {
          if (current) {
            setError('Microsoft sign-in window was closed before completing.');
            return false;
          }
          return current;
        });
      }
    }, 800);
  };

  const toggleShowValue = (key: string) => {
    setShowValues((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <>
      <div
        className={`rounded-lg border border-border p-5 flex flex-col gap-3 ${config.comingSoon ? 'opacity-50' : ''
          }`}
      >
        <div className="flex items-start justify-between">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          {config.comingSoon ? (
            <Badge variant="default" className="text-[10px]">Coming Soon</Badge>
          ) : connected ? (
            <Badge variant="success" className="text-[10px]">Connected</Badge>
          ) : null}
        </div>

        <div>
          <h3 className="text-sm font-medium">{config.label}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{config.description}</p>
        </div>

        {!config.comingSoon && (
          <div className="mt-auto pt-1">
            {connected ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleDisconnect}
                disabled={removing}
              >
                {removing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  if (config.authFlow === 'google') return handleConnectGoogle();
                  if (config.authFlow === 'microsoft') return handleConnectMicrosoft();
                  setDialogOpen(true);
                }}
                disabled={!!config.authFlow && saving}
              >
                {config.authFlow && saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Connect
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Connect dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {config.label}</DialogTitle>
            <DialogDescription>{config.description}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {config.setupHelper ? (
              <config.setupHelper
                workspaceId={workspaceId}
                onSaved={() => {
                  posthog?.capture('integration_connected', {
                    workspace_id: workspaceId,
                    integration: config.name,
                    section: config.section,
                  });
                  setConnected(true);
                  onConnectedChange(config.name, true);
                }}
                onClose={() => {
                  setDialogOpen(false);
                  setError(null);
                }}
              />
            ) : (<>

            {config.instructions && (
              <div className="rounded-lg border border-border bg-zinc-50 p-3">
                <ol className="space-y-1 text-xs text-muted-foreground">
                  {config.instructions.map((instr, i) => (
                    <li key={i}>{i + 1}. {instr}</li>
                  ))}
                </ol>
              </div>
            )}

            {config.fields.map((field) => {
              const value = (fieldValues[field.key] || '').trim();
              const hasInvalidPattern = !!field.pattern && value !== '' && !field.pattern.test(value);
              return (
                <div key={field.key}>
                  <Label htmlFor={`${config.name}-${field.key}`}>{field.label}</Label>
                  <div className="relative mt-1">
                    <Input
                      id={`${config.name}-${field.key}`}
                      type={field.type === 'password' && !showValues[field.key] ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={fieldValues[field.key] || ''}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      disabled={saving}
                    />
                    {field.type === 'password' && (
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => toggleShowValue(field.key)}
                      >
                        {showValues[field.key] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                  {hasInvalidPattern && field.patternError && (
                    <p className="mt-1 text-[11px] text-red-600">{field.patternError}</p>
                  )}
                  {!hasInvalidPattern && field.helperText && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{field.helperText}</p>
                  )}
                </div>
              );
            })}

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDialogOpen(false);
                  setFieldValues({});
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!allFieldsValid || saving}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
            </>)}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const CUSTOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const CUSTOM_VALUE_MAX_BYTES = 8192;

/** Mirror of lambda/workspace-api/index.py:_normalize_custom_name. */
function normalizeCustomName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-');
}

type CustomDialogMode =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'rotate'; name: string; displayName: string }
  | { kind: 'delete'; name: string; displayName: string };

function CustomSecretsSection({
  workspaceId,
  secrets,
  onOptimisticUpdate,
}: {
  workspaceId: string;
  secrets: CustomIntegrationEntry[];
  /** Directly mutate the parent's list. Used after a successful create /
   * delete because Secrets Manager's ListSecrets is eventually consistent —
   * an immediate refetch usually returns stale data. */
  onOptimisticUpdate: (next: CustomIntegrationEntry[]) => void;
}) {
  const posthog = usePostHog();
  const [mode, setMode] = useState<CustomDialogMode>({ kind: 'none' });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode({ kind: 'none' });
    setName('');
    setValue('');
    setShowValue(false);
    setError(null);
    setBusy(false);
  };

  const nameInvalid =
    mode.kind === 'create' && name.length > 0 && !CUSTOM_NAME_RE.test(name);
  // Collision is on the NORMALISED key — the backend would overwrite
  // a secret with the same normalised name regardless of casing.
  const normalizedName =
    mode.kind === 'create' && CUSTOM_NAME_RE.test(name)
      ? normalizeCustomName(name)
      : null;
  const nameCollision =
    normalizedName !== null && secrets.some((s) => s.name === normalizedName);
  const valueBytes = new TextEncoder().encode(value).length;
  const valueTooLong = valueBytes > CUSTOM_VALUE_MAX_BYTES;

  const canSubmitCreate =
    mode.kind === 'create' &&
    CUSTOM_NAME_RE.test(name) &&
    !nameCollision &&
    value.length > 0 &&
    !valueTooLong;

  const canSubmitRotate =
    mode.kind === 'rotate' && value.length > 0 && !valueTooLong;

  const handleSave = async () => {
    // On create, send the admin's friendly name as-is — the backend
    // normalises for storage and returns both keys. On rotate, re-use
    // the stored normalised name so we don't need to re-normalise.
    const targetName =
      mode.kind === 'create' ? name : mode.kind === 'rotate' ? mode.name : '';
    if (!targetName) return;
    setBusy(true);
    setError(null);
    try {
      const res = await setCustomIntegration(workspaceId, targetName, value);
      // Rotate doesn't change the name set; only create inserts. Sort kept
      // in sync with the backend's sorted listing so order is stable.
      if (mode.kind === 'create') {
        posthog?.capture('custom_secret_created', {
          workspace_id: workspaceId,
          secret_name: res.integration,
        });
        onOptimisticUpdate(
          [
            ...secrets,
            { name: res.integration, displayName: res.displayName },
          ].sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
      reset();
    } catch (err) {
      posthog?.captureException(err);
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (mode.kind !== 'delete') return;
    setBusy(true);
    setError(null);
    try {
      await removeCustomIntegration(workspaceId, mode.name);
      posthog?.capture('custom_secret_deleted', {
        workspace_id: workspaceId,
        secret_name: mode.name,
      });
      onOptimisticUpdate(secrets.filter((s) => s.name !== mode.name));
      reset();
    } catch (err) {
      posthog?.captureException(err);
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Custom Secrets</h2>
        <Button size="sm" onClick={() => setMode({ kind: 'create' })} className="h-7 gap-1.5 text-xs">
          <Plus className="h-3.5 w-3.5" />
          Add secret
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Bring-your-own credentials the agent can read at turn time. Values are
        write-only — to change a value, use Edit.
      </p>

      {secrets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          No custom secrets configured.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {secrets.map((entry) => (
            <li key={entry.name} className="flex items-center gap-2 px-3 py-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 font-mono text-sm truncate">
                {entry.displayName}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                onClick={() => {
                  setValue('');
                  setError(null);
                  setMode({
                    kind: 'rotate',
                    name: entry.name,
                    displayName: entry.displayName,
                  });
                }}
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs text-red-600 hover:text-red-700"
                onClick={() => {
                  setError(null);
                  setMode({
                    kind: 'delete',
                    name: entry.name,
                    displayName: entry.displayName,
                  });
                }}
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={mode.kind === 'create' || mode.kind === 'rotate'}
        onOpenChange={(open) => { if (!open) reset(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode.kind === 'rotate'
                ? `Edit ${mode.displayName}`
                : 'Add custom secret'}
            </DialogTitle>
            <DialogDescription>
              {mode.kind === 'rotate'
                ? 'Replace the stored value. The old value is overwritten immediately.'
                : 'Store a named credential the agent can read at turn time.'}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {mode.kind === 'create' && (
              <div>
                <Label htmlFor="custom-secret-name">Name</Label>
                <Input
                  id="custom-secret-name"
                  placeholder="e.g. OpenAI_API_Key"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  className="mt-1"
                  autoFocus
                />
                {nameInvalid && (
                  <p className="mt-1 text-[11px] text-red-600">
                    Must match [A-Za-z0-9][A-Za-z0-9_-]{'{0,62}'}
                  </p>
                )}
                {nameCollision && (
                  <p className="mt-1 text-[11px] text-red-600">
                    A secret with this name already exists. Use Edit to replace its value.
                  </p>
                )}
                {!nameInvalid && !nameCollision && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Letters, digits, dashes, and underscores. Max 63 characters.
                  </p>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="custom-secret-value">Value</Label>
              <div className="relative mt-1">
                <Input
                  id="custom-secret-value"
                  type={showValue ? 'text' : 'password'}
                  placeholder="Paste the secret value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={busy}
                  autoFocus={mode.kind === 'rotate'}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowValue((v) => !v)}
                >
                  {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p
                className={`mt-1 text-[11px] ${valueTooLong ? 'text-red-600' : 'text-muted-foreground'}`}
              >
                {valueBytes.toLocaleString()} / {CUSTOM_VALUE_MAX_BYTES.toLocaleString()} bytes
                {valueTooLong ? ' — too large' : ''}
              </p>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>Cancel</Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={busy || (mode.kind === 'create' ? !canSubmitCreate : !canSubmitRotate)}
              >
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={mode.kind === 'delete'}
        onOpenChange={(open) => { if (!open) reset(); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {mode.kind === 'delete' ? mode.displayName : ''}?</DialogTitle>
            <DialogDescription>
              The agent can no longer read this secret. This can't be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>Cancel</Button>
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 hover:text-red-700"
                onClick={handleDelete}
                disabled={busy}
              >
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function IntegrationsView() {
  const { workspaceId } = useWorkspace();
  const [connectedSet, setConnectedSet] = useState<Set<IntegrationName>>(new Set());
  const [customSecrets, setCustomSecrets] = useState<CustomIntegrationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    listIntegrations(workspaceId)
      .then((res) => {
        setConnectedSet(new Set(res.integrations));
        setCustomSecrets(res.custom ?? []);
      })
      .catch(() => {
        setConnectedSet(new Set());
        setCustomSecrets([]);
      })
      .finally(() => setLoading(false));
  };

  // Optimistically reflect a connect/disconnect instead of refetching.
  // Secrets Manager's ListSecrets is eventually consistent, so an immediate
  // listIntegrations() after a write usually returns stale data — which would
  // flip a just-connected card back to "not connected" until a manual refresh.
  // We trust the awaited write instead (same rationale as the custom-secrets
  // optimistic path above). The authoritative list is reconciled on next mount.
  const applyConnected = (name: IntegrationName, connected: boolean) => {
    setConnectedSet((prev) => {
      const next = new Set(prev);
      if (connected) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <h1 className="text-lg font-semibold mb-1">Integrations</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Connect third-party services to your workspace.
        </p>

        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {SECTIONS.map((section) => {
              const sectionPlatforms = PLATFORMS.filter((p) => p.section === section.key);
              if (sectionPlatforms.length === 0) return null;
              return (
                <div key={section.key} className="mb-8">
                  <h2 className="text-sm font-medium text-muted-foreground mb-3">{section.label}</h2>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {sectionPlatforms.map((config) => (
                      <PlatformCardItem
                        key={config.name}
                        config={config}
                        workspaceId={workspaceId}
                        initiallyConnected={connectedSet.has(config.name)}
                        onConnectedChange={applyConnected}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

            <CustomSecretsSection
              workspaceId={workspaceId}
              secrets={customSecrets}
              onOptimisticUpdate={setCustomSecrets}
            />
          </>
        )}
      </div>
    </ScrollArea>
  );
}

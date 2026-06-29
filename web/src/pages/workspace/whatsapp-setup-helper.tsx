import { useEffect, useState } from 'react';
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
import { WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';

/**
 * 6-step guided WhatsApp Cloud API (BYO) setup. Mirrors slack-setup-helper.tsx's
 * parent-dialog integration contract (onSaved / onClose) but uses a longer
 * step sequence because Meta's onboarding has more screens than Slack's.
 *
 * Step sequence was validated against the live Meta UI on 2026-05-27. The
 * customer journey:
 *   1. Create the Meta App (Business type, name + email).
 *   2. Add the WhatsApp product from the "Add products" page that Meta
 *      shows post-creation. Optionally collect the App ID so the next
 *      steps can deep-link straight into the right Meta pages.
 *   3. Accept the WhatsApp Business + Cloud-API hosting ToS and pick a
 *      Business Portfolio (Meta gates the API Setup page on this).
 *   4. On the API Configuration page, click "Generate access token",
 *      select the WABA, and copy the Access Token + Phone Number ID.
 *   5. From App Settings → Basic, reveal and copy the App Secret. Save
 *      the three credentials — calls PUT /integrations/whatsapp.
 *   6. Configure the webhook: paste the Callback URL + auto-derived
 *      Verify token into Meta, click Verify and save, then subscribe
 *      the webhook to the `messages` field.
 *
 * The verify token is DERIVED from the access token (sha256(token).slice(0,32))
 * to match docker/agent/chat-server/src/chat.ts, so the user never has to
 * invent one and the two sides always agree.
 */

const META_APP_CREATE = 'https://developers.facebook.com/apps/create/';
const META_APPS_DASHBOARD = 'https://developers.facebook.com/apps/';
const WHATSAPP_CLOUD_DOCS =
  'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';
const PERMANENT_TOKEN_DOCS =
  'https://developers.facebook.com/docs/whatsapp/business-management-api/get-started#1-acquire-an-access-token-using-a-system-user-or-facebook-login';
const BUSINESS_MANAGER = 'https://business.facebook.com/';

const TOTAL_STEPS = 6;
const WEBHOOK_FIELDS = ['messages'];

async function deriveVerifyToken(accessToken: string): Promise<string> {
  // Mirrors chat-server's docker/agent/chat-server/src/chat.ts:
  //   crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 32)
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(accessToken),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

// Build Meta deep-links if the customer pasted their App ID; fall back
// to the Apps dashboard otherwise so the link is always clickable.
function appUrls(appId: string) {
  const trimmed = appId.trim();
  const has = /^\d+$/.test(trimmed);
  return {
    apiConfig: has
      ? `https://developers.facebook.com/apps/${trimmed}/whatsapp-business/wa-dev-console/`
      : META_APPS_DASHBOARD,
    basicSettings: has
      ? `https://developers.facebook.com/apps/${trimmed}/settings/basic/`
      : META_APPS_DASHBOARD,
    webhookConfig: has
      ? `https://developers.facebook.com/apps/${trimmed}/whatsapp-business/wa-settings/`
      : META_APPS_DASHBOARD,
  };
}

export interface WhatsAppSetupHelperProps {
  workspaceId: string;
  /** Fired once credentials have been persisted (after step 5). The
   * parent uses this to flip the card to "Connected" immediately so
   * the user sees progress even if they close the dialog before
   * finishing step 6. */
  onSaved: () => void;
  /** Fired when the user clicks Done on the final step. */
  onClose: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

export function WhatsAppSetupHelper({
  workspaceId,
  onSaved,
  onClose,
}: WhatsAppSetupHelperProps) {
  const [step, setStep] = useState<Step>(1);
  const [appId, setAppId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [showApiToken, setShowApiToken] = useState(false);
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyToken, setVerifyToken] = useState('');
  const [copiedField, setCopiedField] = useState<'url' | 'verify' | null>(null);

  const webhookUrl = `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}/webhooks/whatsapp`;
  const urls = appUrls(appId);

  // Pre-compute verify token whenever the access token changes so step 6
  // never renders an empty value.
  useEffect(() => {
    if (!apiToken.trim()) {
      setVerifyToken('');
      return;
    }
    let cancelled = false;
    deriveVerifyToken(apiToken.trim()).then((vt) => {
      if (!cancelled) setVerifyToken(vt);
    });
    return () => {
      cancelled = true;
    };
  }, [apiToken]);

  const handleSaveCredentials = async () => {
    const trimmed = {
      apiToken: apiToken.trim(),
      phoneNumberId: phoneNumberId.trim(),
      appSecret: appSecret.trim(),
    };
    if (!trimmed.apiToken || !trimmed.phoneNumberId || !trimmed.appSecret) {
      setError('Access Token, Phone Number ID, and App Secret are all required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setIntegration(workspaceId, 'whatsapp', { credentials: trimmed });
      onSaved();
      setStep(6);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = async (text: string, field: 'url' | 'verify') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      const el = document.getElementById(
        field === 'url' ? 'whatsapp-webhook-url' : 'whatsapp-verify-token',
      ) as HTMLInputElement | null;
      el?.select();
    }
  };

  const allCredsPresent =
    apiToken.trim() && phoneNumberId.trim() && appSecret.trim();

  return (
    <div>
      {/* Step indicator */}
      <div className="mb-5 flex items-center">
        {(Array.from({ length: TOTAL_STEPS }, (_, i) => (i + 1) as Step)).map(
          (n, i) => (
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
              {i < TOTAL_STEPS - 1 && (
                <div
                  className={`mx-1.5 h-px w-5 ${n < step ? 'bg-zinc-700' : 'bg-zinc-200'}`}
                />
              )}
            </div>
          ),
        )}
      </div>

      {step === 1 && (
        <div>
          <h4 className="text-sm font-semibold">Step 1 · Create a Meta App</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Meta&apos;s app dashboard is where everything lives. We&apos;ll start
            by creating an empty app here.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. Click <em>Open Meta&apos;s app creator</em> below.
            </li>
            <li>
              2. On <em>Select an app type</em>, pick <em>Business</em> and
              click <em>Next</em>.
            </li>
            <li>
              3. Give the app any name (you can change it later) and confirm
              the contact email.
            </li>
            <li>
              4. <em>Business Portfolio</em> is optional here — you can attach
              one now or later. If you already have one, picking it now saves
              a click in step 3.
            </li>
            <li>
              5. Click <em>Create app</em>. Meta will ask you to re-enter
              your password before the app is actually created — this is
              expected.
            </li>
          </ol>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <a href={META_APP_CREATE} target="_blank" rel="noopener noreferrer">
                Open Meta&apos;s app creator
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a
                href={WHATSAPP_CLOUD_DOCS}
                target="_blank"
                rel="noopener noreferrer"
              >
                Cloud API docs
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
          </div>

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
          <h4 className="text-sm font-semibold">
            Step 2 · Add the WhatsApp product
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            After creating the app, Meta lands you on an{' '}
            <em>Add products to your app</em> page.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. Find the <em>WhatsApp</em> card on the products list.
            </li>
            <li>
              2. Click <em>Set up</em> on the WhatsApp card. WhatsApp will
              appear under <em>Products</em> in the left sidebar.
            </li>
            <li>
              3. (Optional, but speeds up the rest of the wizard) Copy your
              Meta <em>App ID</em> from the top of any app page and paste it
              below. The remaining steps will deep-link straight to the right
              Meta pages.
            </li>
          </ol>

          <div className="mt-4">
            <Label htmlFor="whatsapp-app-id">
              Meta App ID <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="whatsapp-app-id"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 1234567890123456"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              The 15–16-digit number shown next to <em>App ID:</em> at the top
              of your app dashboard.
            </p>
          </div>

          <div className="mt-5 flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
            <Button size="sm" onClick={() => setStep(3)}>
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <h4 className="text-sm font-semibold">
            Step 3 · Accept WhatsApp terms + pick a Business Portfolio
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Before WhatsApp&apos;s API Configuration page opens, Meta asks you
            to attach a Business Portfolio and accept their WhatsApp Business
            and Cloud-API hosting terms.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. In your app&apos;s left sidebar, click{' '}
              <em>WhatsApp → API Configuration</em> (or use the deep link
              below).
            </li>
            <li>
              2. Pick a Business Portfolio in the dropdown. If you don&apos;t
              have one yet, create it in Business Manager first (link below)
              and come back.
            </li>
            <li>
              3. Click <em>Continue</em> — this attaches the portfolio to your
              app and gives you a free WhatsApp test number (can message up to
              5 pre-verified recipients).
            </li>
          </ol>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <a href={urls.apiConfig} target="_blank" rel="noopener noreferrer">
                Open WhatsApp API Configuration
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a
                href={BUSINESS_MANAGER}
                target="_blank"
                rel="noopener noreferrer"
              >
                Business Manager
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
          </div>

          <div className="mt-5 flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
            <Button size="sm" onClick={() => setStep(4)}>
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          <h4 className="text-sm font-semibold">
            Step 4 · Generate access token + copy Phone Number ID
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Both live on the API Configuration page you just unlocked.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. Under <em>Access token</em>, click{' '}
              <em>Generate access token</em>.
            </li>
            <li>
              2. A popup window opens for account selection — make sure your
              browser allows popups from{' '}
              <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[10px]">
                developers.facebook.com
              </code>
              . Pick your WhatsApp Business Account and continue through
              Meta&apos;s consent flow. A token (starts with{' '}
              <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[10px]">
                EAA
              </code>
              ) appears in the textbox — copy it. <strong>Heads-up</strong>:
              this is a <em>temporary 24h token</em>, fine for trying things
              out. For production, generate a permanent System User token
              (link below).
            </li>
            <li>
              3. Scroll to <em>Send and receive messages → Step 1: Select
              phone numbers</em>. Copy the long numeric{' '}
              <em>Phone number ID</em> shown there (it has a copy button next
              to it).
            </li>
          </ol>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <a href={urls.apiConfig} target="_blank" rel="noopener noreferrer">
                Open API Configuration
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a
                href={PERMANENT_TOKEN_DOCS}
                target="_blank"
                rel="noopener noreferrer"
              >
                Permanent token guide
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="whatsapp-api-token">Access Token</Label>
              <div className="relative mt-1">
                <Input
                  id="whatsapp-api-token"
                  type={showApiToken ? 'text' : 'password'}
                  placeholder="EAA..."
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowApiToken((v) => !v)}
                  tabIndex={-1}
                >
                  {showApiToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <Label htmlFor="whatsapp-phone-number-id">Phone Number ID</Label>
              <Input
                id="whatsapp-phone-number-id"
                type="text"
                inputMode="numeric"
                placeholder="e.g. 123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <div className="mt-5 flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep(3)}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
            <Button
              size="sm"
              onClick={() => setStep(5)}
              disabled={!apiToken.trim() || !phoneNumberId.trim()}
            >
              Next
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div>
          <h4 className="text-sm font-semibold">
            Step 5 · Copy the App Secret + Save
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            The App Secret is what your workspace uses to verify that webhook
            payloads really came from Meta.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. In the left sidebar, click{' '}
              <em>App Settings → Basic</em> (or use the deep link below).
            </li>
            <li>
              2. Find the <em>App Secret</em> row (it sits next to{' '}
              <em>App ID</em> at the top of the page). Click <em>Show</em>.
            </li>
            <li>3. Copy the 32-character hex value and paste it below.</li>
          </ol>

          <Button asChild size="sm" className="mt-3">
            <a
              href={urls.basicSettings}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open App Settings → Basic
              <ExternalLink className="ml-1.5 h-3 w-3" />
            </a>
          </Button>

          <div className="mt-4">
            <Label htmlFor="whatsapp-app-secret">App Secret</Label>
            <div className="relative mt-1">
              <Input
                id="whatsapp-app-secret"
                type={showAppSecret ? 'text' : 'password'}
                placeholder="32-character hex string"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                disabled={saving}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowAppSecret((v) => !v)}
                tabIndex={-1}
              >
                {showAppSecret ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

          <div className="mt-5 flex justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(4)}
              disabled={saving}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              Back
            </Button>
            <Button
              size="sm"
              onClick={handleSaveCredentials}
              disabled={saving || !allCredsPresent}
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

      {step === 6 && (
        <div>
          <h4 className="text-sm font-semibold">
            Step 6 · Configure the Meta webhook
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Credentials saved. Now point Meta&apos;s webhook at your workspace
            so inbound WhatsApp messages reach the agent. Credentials take
            about a minute to propagate, so if Meta&apos;s <em>Verify</em>{' '}
            check fails on the first try, wait ~30 seconds and try again.
          </p>

          <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. In the left sidebar, click <em>WhatsApp → Configuration</em>{' '}
              (or use the deep link below).
            </li>
            <li>
              2. In the <em>Webhook</em> section, paste the Callback URL and
              Verify token from below.
            </li>
            <li>
              3. Click <em>Verify and save</em>.
            </li>
            <li>
              4. Once verified, find <em>Webhook fields</em> on the same page,
              click <em>Manage</em>, and toggle on:
              {WEBHOOK_FIELDS.map((e) => (
                <code
                  key={e}
                  className="mx-1 rounded bg-zinc-200 px-1 py-px font-mono text-[10px]"
                >
                  {e}
                </code>
              ))}
            </li>
          </ol>

          <Button asChild size="sm" className="mt-3">
            <a
              href={urls.webhookConfig}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Webhook Configuration
              <ExternalLink className="ml-1.5 h-3 w-3" />
            </a>
          </Button>

          <div className="mt-3">
            <Label htmlFor="whatsapp-webhook-url" className="text-[11px]">
              Callback URL
            </Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="whatsapp-webhook-url"
                readOnly
                value={webhookUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="cursor-text font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(webhookUrl, 'url')}
                type="button"
              >
                {copiedField === 'url' ? (
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

          <div className="mt-3">
            <Label htmlFor="whatsapp-verify-token" className="text-[11px]">
              Verify token
            </Label>
            <div className="mt-1 flex gap-2">
              <Input
                id="whatsapp-verify-token"
                readOnly
                value={verifyToken}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="cursor-text font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(verifyToken, 'verify')}
                type="button"
                disabled={!verifyToken}
              >
                {copiedField === 'verify' ? (
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
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Auto-generated from your access token — copy it as-is, this is
              the value Meta will compare against your workspace.
            </p>
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

import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

/**
 * Landing page Microsoft redirects to after the user authorizes.
 * Pulls the `code` from the URL, posts it back to the opener window,
 * and closes the popup. The opener (the Integrations page) exchanges
 * the code via PUT /integrations/microsoft.
 */
export function MicrosoftCallbackPage() {
  const [status, setStatus] = useState<'forwarding' | 'standalone' | 'error'>('forwarding');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    // Azure surfaces both `error` and `error_description` query params.
    // We prefer the description because it includes the AADSTS code and a
    // human sentence (e.g. "AADSTS65001: The user or administrator has not
    // consented..."), which is what we want to bubble back to the admin.
    const oauthError = params.get('error_description') || params.get('error');

    type Payload =
      | { type: 'microsoft-oauth-callback'; code: string; state: string | null }
      | { type: 'microsoft-oauth-callback'; error: string };
    const payload: Payload = oauthError
      ? { type: 'microsoft-oauth-callback', error: oauthError }
      : code
        ? { type: 'microsoft-oauth-callback', code, state }
        : { type: 'microsoft-oauth-callback', error: 'Missing authorization code in callback URL.' };

    // Deliver via TWO channels — whichever survives wins:
    //  - window.opener.postMessage: the common path.
    //  - BroadcastChannel: survives when opener is null (any redirect
    //    in the OAuth chain that sets COOP `same-origin`, browser
    //    severance under MSA-account routing, etc.). The Integrations
    //    view subscribes to the same channel name.
    // Verbose console logs (prefixed [oauth-ms]) so we can trace which
    // delivery channel landed across browsers / origins. Cheap to keep
    // until OAuth is rock-solid on every deployed origin.
    console.log('[oauth-ms] callback mounted', {
      origin: window.location.origin,
      hasOpener: !!window.opener,
      hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
      payloadType: 'error' in payload ? 'error' : 'code',
      state,
    });

    let delivered = false;
    // Deliver via THREE channels and let any survivor win. localStorage
    // is the most robust: the `storage` event fires across same-origin
    // windows regardless of browsing context group, so it works even
    // when COOP has severed the popup from its opener (Chrome puts a
    // severed popup in a separate agent cluster, which breaks both
    // postMessage-to-opener AND BroadcastChannel cross-context delivery).
    // The other two channels stay in place for browsers where they
    // work — first arrival at the parent wins via the `settled` guard.
    try {
      const key = 'oauth-callback-microsoft';
      // The value must be unique per send (storage events don't fire on
      // identical writes), so embed a timestamp.
      localStorage.setItem(
        key,
        JSON.stringify({ ...payload, ts: Date.now() }),
      );
      // Clean up after a short window so the next attempt starts fresh.
      setTimeout(() => {
        try { localStorage.removeItem(key); } catch { /* noop */ }
      }, 5000);
      console.log('[oauth-ms] localStorage written');
      delivered = true;
    } catch (err) {
      console.warn('[oauth-ms] localStorage failed', err);
    }
    try {
      // Do NOT close the channel synchronously after postMessage:
      // BroadcastChannel delivery is async (browser-internal IPC) and a
      // close() right after a send can drop the message before it
      // reaches other tabs. Letting the popup's unload GC the channel
      // is correct.
      const ch = new BroadcastChannel('microsoft-oauth-callback');
      ch.postMessage(payload);
      console.log('[oauth-ms] BroadcastChannel sent');
      delivered = true;
    } catch (err) {
      console.warn('[oauth-ms] BroadcastChannel failed', err);
    }
    if (window.opener) {
      try {
        window.opener.postMessage(payload, window.location.origin);
        console.log('[oauth-ms] postMessage sent to opener');
        delivered = true;
      } catch (err) {
        console.warn('[oauth-ms] postMessage failed', err);
      }
    } else {
      console.log('[oauth-ms] window.opener is null — skipping postMessage');
    }
    console.log('[oauth-ms] delivered=', delivered);

    if ('error' in payload) {
      setStatus('error');
      setError(payload.error);
      if (delivered) window.setTimeout(() => window.close(), 800);
      return;
    }

    if (delivered) {
      window.setTimeout(() => window.close(), 600);
    } else {
      setStatus('standalone');
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f7fa]">
      <div className="w-full max-w-sm rounded-[14px] border border-border bg-white p-8 text-center shadow-sm">
        {status === 'forwarding' && (
          <>
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-[#2563eb]" />
            <h1 className="text-base font-semibold">Finishing sign-in…</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              You can close this window once it doesn't close automatically.
            </p>
          </>
        )}
        {status === 'standalone' && (
          <>
            <CheckCircle2 className="mx-auto mb-4 h-10 w-10 text-emerald-600" />
            <h1 className="text-base font-semibold">Microsoft 365 connected</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              You can close this tab and return to your workspace.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="mx-auto mb-4 h-10 w-10 text-red-600" />
            <h1 className="text-base font-semibold">Couldn't connect Microsoft 365</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}

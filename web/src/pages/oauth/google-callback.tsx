import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';

/**
 * Landing page Google redirects to after the user authorizes.
 * We pull the `code` from the URL, post it back to the opener window
 * via window.postMessage, and close the popup. The opener (the
 * Integrations page) is responsible for actually exchanging the code
 * via PUT /integrations/google.
 */
export function GoogleCallbackPage() {
  const [status, setStatus] = useState<'forwarding' | 'standalone' | 'error'>('forwarding');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    type Payload =
      | { type: 'google-oauth-callback'; code: string; state: string | null }
      | { type: 'google-oauth-callback'; error: string };
    const payload: Payload = oauthError
      ? { type: 'google-oauth-callback', error: oauthError }
      : code
        ? { type: 'google-oauth-callback', code, state }
        : { type: 'google-oauth-callback', error: 'Missing authorization code in callback URL.' };

    // Two delivery channels — see microsoft-callback.tsx for the
    // rationale. postMessage + BroadcastChannel; whichever survives wins.
    console.log('[oauth-google] callback mounted', {
      origin: window.location.origin,
      hasOpener: !!window.opener,
      hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
      payloadType: 'error' in payload ? 'error' : 'code',
      state,
    });

    let delivered = false;
    // localStorage is the COOP-proof delivery channel — see
    // microsoft-callback.tsx for why we need three channels.
    try {
      const key = 'oauth-callback-google';
      localStorage.setItem(
        key,
        JSON.stringify({ ...payload, ts: Date.now() }),
      );
      setTimeout(() => {
        try { localStorage.removeItem(key); } catch { /* noop */ }
      }, 5000);
      console.log('[oauth-google] localStorage written');
      delivered = true;
    } catch (err) {
      console.warn('[oauth-google] localStorage failed', err);
    }
    try {
      const ch = new BroadcastChannel('google-oauth-callback');
      ch.postMessage(payload);
      console.log('[oauth-google] BroadcastChannel sent');
      delivered = true;
    } catch (err) {
      console.warn('[oauth-google] BroadcastChannel failed', err);
    }
    if (window.opener) {
      try {
        window.opener.postMessage(payload, window.location.origin);
        console.log('[oauth-google] postMessage sent to opener');
        delivered = true;
      } catch (err) {
        console.warn('[oauth-google] postMessage failed', err);
      }
    } else {
      console.log('[oauth-google] window.opener is null — skipping postMessage');
    }
    console.log('[oauth-google] delivered=', delivered);

    if ('error' in payload) {
      setStatus('error');
      setError(payload.error);
      if (delivered) window.setTimeout(() => window.close(), 800);
      return;
    }

    if (delivered) {
      // Brief pause so the user sees the success state before close.
      window.setTimeout(() => window.close(), 600);
    } else {
      // No delivery channel worked — user landed here directly. Show success.
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
            <h1 className="text-base font-semibold">Google connected</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              You can close this tab and return to your workspace.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="mx-auto mb-4 h-10 w-10 text-red-600" />
            <h1 className="text-base font-semibold">Couldn't connect Google</h1>
            <p className="mt-2 text-sm text-red-600">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}

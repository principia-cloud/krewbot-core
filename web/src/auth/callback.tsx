import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { handleCallback } from './cognito';
import { useAuth } from './auth-context';
import { usePostHog } from '@posthog/react';

export function CallbackPage() {
  const navigate = useNavigate();
  const { recheck } = useAuth();
  const posthog = usePostHog();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    if (oauthError) {
      setError(`Login failed: ${oauthError}`);
      return;
    }

    if (!code || !state) {
      setError('Missing authorization code');
      return;
    }

    handleCallback(code, state)
      .then((claims) => {
        posthog?.identify(claims.sub, { email: claims.email });
        posthog?.capture('login_completed', { method: 'google' });
        recheck();
        navigate('/', { replace: true });
      })
      .catch((err) => {
        posthog?.captureException(err);
        setError((err as Error).message);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center">
          <h1 className="mb-2 text-lg font-semibold">Login Failed</h1>
          <p className="mb-4 text-sm text-red-400">{error}</p>
          <a href="/login" className="text-sm text-accent hover:underline">
            Try again
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Completing login...</p>
      </div>
    </div>
  );
}

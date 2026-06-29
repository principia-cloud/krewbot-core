import { Navigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/auth/auth-context';
import { LoginExtras } from '@/extensions/login-extras';
import { APP_NAME, BRAND_LOGO_URL } from '@/lib/constants';

/**
 * Brand-neutral login shell. The actual sign-in UI lives in the
 * <LoginExtras /> slot:
 *   • An overlay supplies the Google IdP shortcut + magic-link
 *     form.
 *   • Core ships a single generic-hosted-UI button.
 *
 * The shell owns: auth-loaded gating, already-authenticated redirect,
 * brand chrome (logo + APP_NAME heading + tagline), and the card
 * container that wraps the slot. Anything else belongs in LoginExtras.
 */
export function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm text-center">
        <img
          src={BRAND_LOGO_URL}
          alt={APP_NAME}
          className="mx-auto mb-3 h-14 w-14"
        />
        <h1 className="mb-2 text-2xl font-bold">{APP_NAME}</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          AI assistants for your team
        </p>

        <div className="rounded-lg border border-border bg-card p-6">
          <LoginExtras />
        </div>
      </div>
    </div>
  );
}

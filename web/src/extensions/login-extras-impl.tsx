import { Button } from '@/components/ui/button';
import { startLogin } from '@/auth/cognito';

/**
 * Core default sign-in. Renders a single button that opens the Cognito
 * hosted-UI flow with no IdP filter — the operator's user pool decides
 * what identity providers are offered (username/password by default;
 * any federated IdP the operator configures will show up there).
 *
 * An overlay can swap this slot for a richer sign-in (e.g. an IdP
 * shortcut button plus a magic-link form).
 */
export function LoginExtras() {
  return (
    <>
      <h2 className="mb-1 text-lg font-semibold">Welcome</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Sign in to manage your workspaces
      </p>
      <Button className="w-full" size="lg" onClick={() => startLogin()}>
        Sign in
      </Button>
    </>
  );
}

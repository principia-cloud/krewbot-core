// Core stub. Self-hosted deployments have no concept of subscription
// status — workspaces are either provisioned or not — so the gate is
// always open. An overlay impl wraps children in a Stripe
// paywall when subscriptionStatus is non-active.
export function SubscriptionGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

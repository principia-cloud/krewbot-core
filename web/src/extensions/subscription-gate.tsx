// Subscription gate extension slot.
//   • An overlay renders a Stripe paywall around any
//     workspace-scoped child when subscription is non-active.
//     Implementation in ./subscription-gate-impl.tsx.
//   • Core (@krewbot/platform-core) replaces the impl with a pass-
//     through wrapper (children rendered unconditionally) in Phase 3.
//     Self-hosted deployments have no concept of subscription status.
export { SubscriptionGate } from './subscription-gate-impl';

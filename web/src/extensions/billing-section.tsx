// Billing section extension slot.
//   • An overlay renders a Stripe billing card in
//     SettingsView. Implementation in ./billing-section-impl.tsx.
//   • Core (@krewbot/platform-core) replaces the impl with a null-
//     rendering stub in Phase 3. Self-hosted deployments have no
//     concept of billing.
export { BillingSection } from './billing-section-impl';

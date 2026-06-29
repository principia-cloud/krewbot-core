// Core stub. Self-hosted deployments don't have a marketing banner.
// The export name matches the overlay impl so the slot's
// re-export (`export { ConsultantBanner as MarketingBanner }` in
// ./marketing-banner.tsx) keeps resolving.
export function ConsultantBanner() {
  return null;
}

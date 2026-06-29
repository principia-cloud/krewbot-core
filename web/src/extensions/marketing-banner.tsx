// Marketing banner extension slot.
//   • An overlay overrides this to render a marketing
//     Calendly CTA. Implementation in ./marketing-banner-impl.tsx.
//   • Core (@krewbot/platform-core) replaces the impl with a null-
//     rendering stub in Phase 3 so self-hosted deployments don't get a
//     branded banner.
//
// Importers should always import from this file, never directly from
// the -impl sibling — that's the seam.
export { ConsultantBanner as MarketingBanner } from './marketing-banner-impl';

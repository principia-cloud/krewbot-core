// Community-link extension slot (sidebar footer).
//   • Core (@krewbot/platform-core) and overlays render the
//     Discord invite (impl in ./community-link-impl.tsx).
//   • Overlays without a community CTA (e.g. a single-tenant
//     overlay) replace the impl with a null-rendering stub.
//
// Importers should always import from this file, never directly from
// the -impl sibling — that's the seam.
export { CommunityLink } from './community-link-impl';

// Workspace-creation extension slot.
//   • Core (@krewbot/platform-core) and overlays keep creation
//     enabled (impl exports `true`).
//   • Single-tenant overlays (where every member is
//     auto-enrolled into one shared workspace) override the impl with
//     `false`, which hides the sidebar "Create Workspace" button,
//     turns /onboarding into a redirect, and replaces the dashboard
//     zero-workspace redirect with a "no workspace assigned" notice.
//
// Importers should always import from this file, never directly from
// the -impl sibling — that's the seam.
export { WORKSPACE_CREATION_ENABLED } from './workspace-creation-impl';

// Login extras extension slot.
//   • An overlay renders the Google IdP shortcut + magic-link
//     form. Implementation in ./login-extras-impl.tsx.
//   • Core (@krewbot/platform-core) replaces the impl with a single
//     "Sign in" button that invokes the generic Cognito hosted-UI flow
//     (no IdP filter, no magic-link), since core ships the Cognito
//     user pool but not the overlay-only /auth/magic-link endpoint and
//     Google IdP isn't always configured.
export { LoginExtras } from './login-extras-impl';

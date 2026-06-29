// All backend URLs come from .env / .env.{mode} so the same code
// builds for beta and prod. See web/.env.prod for the prod values.
export const COGNITO_DOMAIN: string = import.meta.env.VITE_COGNITO_DOMAIN;
export const COGNITO_CLIENT_ID: string = import.meta.env.VITE_COGNITO_CLIENT_ID;
export const API_URL: string = import.meta.env.VITE_API_URL;

// Env-driven base URLs. For `npm run dev` (DEV=true) we keep localhost
// defaults so the loopback OAuth flow continues to work. For production
// builds (`npm run build -- --mode beta|prod`) values come from the
// matching .env.{mode} file.
const APP_BASE_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : import.meta.env.VITE_APP_BASE_URL;

export const WORKSPACE_DOMAIN_SUFFIX: string =
  import.meta.env.VITE_WORKSPACE_DOMAIN_SUFFIX;

export const COGNITO_REDIRECT_URI = `${APP_BASE_URL}/callback`;
export const COGNITO_SCOPES = 'openid email profile';

// Brand placeholders. Populated from VITE_* env vars so the same code
// builds a branded overlay (env supplies the brand values via web/.env*)
// or a neutral self-hosted instance (no env, falls through to defaults).
export const APP_NAME: string = import.meta.env.VITE_APP_NAME ?? 'platform';
export const APP_TITLE: string = import.meta.env.VITE_APP_TITLE ?? 'Platform';
export const BRAND_LOGO_URL: string =
  import.meta.env.VITE_BRAND_LOGO_URL ?? '/logo.svg';
export const BRAND_FAVICON_URL: string =
  import.meta.env.VITE_BRAND_FAVICON_URL ?? '/favicon.svg';

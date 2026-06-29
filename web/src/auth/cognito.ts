import {
  COGNITO_DOMAIN,
  COGNITO_CLIENT_ID,
  COGNITO_REDIRECT_URI,
  COGNITO_SCOPES,
} from '@/lib/constants';

// --- PKCE helpers ---

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, length);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(64);
  const hashed = await sha256(verifier);
  const challenge = base64UrlEncode(hashed);
  return { verifier, challenge };
}

// --- Token storage ---

const TOKEN_KEY = 'kb_id_token';
const REFRESH_KEY = 'kb_refresh_token';
const VERIFIER_KEY = 'kb_pkce_verifier';
const STATE_KEY = 'kb_oauth_state';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_KEY, token);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// --- JWT decode ---

export interface TokenClaims {
  sub: string;
  email?: string;
  name?: string;
  exp: number;
}

export function decodeToken(token: string): TokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let payload = parts[1];
    // Add base64 padding
    switch (payload.length % 4) {
      case 2: payload += '=='; break;
      case 3: payload += '='; break;
    }
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const claims = decodeToken(token);
  if (!claims?.exp) return true;
  // Consider expired if less than 5 minutes remaining
  return claims.exp - Date.now() / 1000 < 300;
}

// --- OAuth flow ---

export interface StartLoginOptions {
  /** Force a specific Cognito IdP (e.g. 'Google'). Omit for the generic
   *  hosted-UI flow that lets the operator's Cognito user pool decide. */
  identityProvider?: string;
}

export async function startLogin(opts: StartLoginOptions = {}): Promise<void> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomString(32);

  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: COGNITO_CLIENT_ID,
    redirect_uri: COGNITO_REDIRECT_URI,
    scope: COGNITO_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (opts.identityProvider) {
    params.set('identity_provider', opts.identityProvider);
  }

  window.location.href = `${COGNITO_DOMAIN}/oauth2/authorize?${params}`;
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<TokenClaims> {
  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);

  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  if (!savedState || savedState !== state) {
    throw new Error('State mismatch — possible CSRF attack');
  }
  if (!verifier) {
    throw new Error('Missing PKCE verifier');
  }

  const res = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: COGNITO_CLIENT_ID,
      code,
      redirect_uri: COGNITO_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const data = await res.json();
  localStorage.setItem(TOKEN_KEY, data.id_token);
  if (data.refresh_token) {
    localStorage.setItem(REFRESH_KEY, data.refresh_token);
  }

  const claims = decodeToken(data.id_token);
  if (!claims) throw new Error('Failed to decode ID token');
  return claims;
}

export async function refreshToken(): Promise<boolean> {
  const refresh = getRefreshToken();
  if (!refresh) return false;

  try {
    const res = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: COGNITO_CLIENT_ID,
        refresh_token: refresh,
      }),
    });

    if (!res.ok) return false;
    const data = await res.json();
    if (!data.id_token) return false;

    localStorage.setItem(TOKEN_KEY, data.id_token);
    return true;
  } catch {
    return false;
  }
}

export function logout(): void {
  clearTokens();
  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    logout_uri: window.location.origin + '/login',
  });
  window.location.href = `${COGNITO_DOMAIN}/logout?${params}`;
}

// Magic link auth has moved to @/auth/magic-link.
// It depends on an overlay-only backend route (POST /auth/magic-link) so it
// does not belong in the brand-neutral Cognito helpers.

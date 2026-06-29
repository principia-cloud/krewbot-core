import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest 4 ships an empty proxy for window.localStorage/sessionStorage
// when --localstorage-file isn't set. Replace with a simple in-memory
// Storage-compatible impl so app code can read/write and tests can clear.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  } as Storage;
}

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: makeStorage(),
});
Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: makeStorage(),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

if (!window.PointerEvent) {
  // jsdom doesn't ship PointerEvent; the layout uses pointer events for
  // chat-panel resize but tests don't drive them. Stubbing as Event keeps
  // addEventListener('pointermove', …) from throwing.
  // @ts-expect-error - assigning Event constructor to PointerEvent slot
  window.PointerEvent = window.Event;
}

vi.mock('@posthog/react', () => ({
  usePostHog: () => ({
    identify: vi.fn(),
    capture: vi.fn(),
    captureException: vi.fn(),
  }),
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Core tests run against the neutral platform defaults — no VITE_* env
// is supplied. Overlay test suites (in the consuming repo's web-overlay/
// test directory) supply their own brand-shaped values.
vi.mock('@/lib/constants', () => ({
  COGNITO_DOMAIN: 'https://cognito.test',
  COGNITO_CLIENT_ID: 'test-client',
  API_URL: 'https://api.test',
  COGNITO_REDIRECT_URI: 'http://localhost/callback',
  COGNITO_SCOPES: 'openid email profile',
  WORKSPACE_DOMAIN_SUFFIX: '.ws.test',
  APP_NAME: 'platform',
  APP_TITLE: 'Platform',
  BRAND_LOGO_URL: '/logo.svg',
  BRAND_FAVICON_URL: '/favicon.svg',
}));

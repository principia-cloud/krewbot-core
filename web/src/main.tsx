import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AuthProvider } from '@/auth/auth-context';
import { router } from './router';
import { APP_TITLE } from '@/lib/constants';
import './index.css';
import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';

// Apply the env-driven document title. index.html ships a static
// fallback ("Platform") which appears for the millisecond before this
// runs; setting it here means VITE_APP_TITLE is honoured without
// depending on Vite's HTML-placeholder substitution.
document.title = APP_TITLE;

if (import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN) {
  posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
    defaults: '2026-01-30',
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PostHogProvider client={posthog}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </PostHogProvider>
  </StrictMode>,
);

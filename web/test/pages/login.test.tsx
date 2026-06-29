import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mockUseAuth = vi.fn();
vi.mock('@/auth/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockStartLogin = vi.fn();
vi.mock('@/auth/cognito', () => ({
  startLogin: (...a: unknown[]) => mockStartLogin(...a),
}));

import { LoginPage } from '@/pages/login';

beforeEach(() => {
  mockUseAuth.mockReset();
  mockStartLogin.mockReset();
  mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
});

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage (core shell, neutral defaults)', () => {
  it('renders the APP_NAME heading from the env-driven brand placeholder', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'platform' })).toBeInTheDocument();
  });

  it('mounts the LoginExtras slot — core stub renders a single Sign in button', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: /^Sign in$/i })).toBeInTheDocument();
  });

  it('Sign in button invokes startLogin with no IdP filter', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/i }));
    expect(mockStartLogin).toHaveBeenCalledTimes(1);
    // No identityProvider argument — operator's Cognito pool decides.
    expect(mockStartLogin.mock.calls[0][0]).toBeUndefined();
  });

  it('shows a spinner while auth is loading', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });
    renderLogin();
    expect(screen.queryByRole('heading', { name: 'platform' })).not.toBeInTheDocument();
  });
});

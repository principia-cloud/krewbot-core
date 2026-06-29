import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mockUseAuth = vi.fn();
vi.mock('@/auth/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockCreateWorkspace = vi.fn();
vi.mock('@/api/workspaces', () => ({
  createWorkspace: (...a: unknown[]) => mockCreateWorkspace(...a),
}));

import { OnboardingPage } from '@/pages/onboarding';

beforeEach(() => {
  mockUseAuth.mockReset();
  mockCreateWorkspace.mockReset();
  mockUseAuth.mockReturnValue({ user: { sub: 'user-abc', email: 'tester@example.com' } });
});

function renderOnboarding() {
  return render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );
}

describe('OnboardingPage (core — single-step name+id form)', () => {
  it('renders the form with name and workspace id inputs', () => {
    renderOnboarding();
    expect(
      screen.getByRole('heading', { name: /Create your workspace/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Workspace ID/i)).toBeInTheDocument();
  });

  it('autoslugs the workspace ID from the name', () => {
    renderOnboarding();
    const name = screen.getByLabelText(/^Name$/i) as HTMLInputElement;
    const id = screen.getByLabelText(/Workspace ID/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Acme Engineering' } });
    expect(id.value).toBe('acme-engineering');
  });

  it('Submits createWorkspace with just workspaceId + name (no overlay fields)', async () => {
    mockCreateWorkspace.mockResolvedValue({
      workspaceId: 'acme-engineering',
      status: 'PROVISIONING',
    });

    renderOnboarding();
    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: 'Acme Engineering' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create workspace/i }));

    await waitFor(() => {
      expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateWorkspace.mock.calls[0][0]).toEqual({
      workspaceId: 'acme-engineering',
      name: 'Acme Engineering',
    });
  });

  it('disables the Create button until the form is valid', () => {
    renderOnboarding();
    const btn = screen.getByRole('button', { name: /Create workspace/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: 'Valid Name' },
    });
    expect(btn).toBeEnabled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mockUseWorkspace = vi.fn();
vi.mock('@/pages/workspace/workspace-context', () => ({
  useWorkspace: () => mockUseWorkspace(),
}));

vi.mock('@/api/integrations', () => ({
  listIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
  setIntegration: vi.fn(),
}));
vi.mock('@/api/workspaces', () => ({
  deleteWorkspace: vi.fn(),
}));

import { SettingsView } from '@/pages/workspace/settings-view';

beforeEach(() => {
  mockUseWorkspace.mockReset();
  mockUseWorkspace.mockReturnValue({
    workspaceId: 'ws-1',
    workspace: { name: 'My Workspace', createdAt: '2026-01-01T00:00:00Z' },
  });
});

describe('SettingsView (core)', () => {
  it('renders Workspace Info section + invokes the BillingSection slot', () => {
    // BillingSection is a core stub that returns null, so we just verify
    // the surrounding sections render — proving the slot is mounted and
    // doesn't blow up.
    render(
      <MemoryRouter>
        <SettingsView />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Workspace Info/i)).toBeInTheDocument();
    expect(screen.getAllByText('ws-1').length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const mockUseWorkspace = vi.fn();
vi.mock('@/pages/workspace/workspace-context', () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWorkspace: () => mockUseWorkspace(),
}));

vi.mock('@/pages/workspace/sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar-marker">sidebar</div>,
}));
vi.mock('@/pages/workspace/chat-panel', () => ({
  ChatPanel: () => <div data-testid="chat-panel-marker">chat</div>,
}));
vi.mock('@/pages/workspace/provisioning-tutorial', () => ({
  ProvisioningTutorial: () => <div data-testid="tutorial-marker">tutorial</div>,
}));
vi.mock('@/pages/workspace/claude-token-setup-modal', () => ({
  ClaudeTokenSetupModal: () => <div data-testid="claude-modal-marker">modal</div>,
}));

vi.mock('@/api/integrations', () => ({
  listIntegrations: vi.fn().mockResolvedValue({ integrations: ['claude'] }),
}));

import { WorkspaceLayout } from '@/pages/workspace/layout';

function renderLayout(initialPath = '/workspaces/ws-1') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/workspaces/:id" element={<WorkspaceLayout />}>
          <Route index element={<div data-testid="outlet-marker">outlet</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockUseWorkspace.mockReset();
});

describe('WorkspaceLayout (core)', () => {
  it('renders APP_NAME brand text in the mobile header', () => {
    mockUseWorkspace.mockReturnValue({
      workspaceId: 'ws-1',
      workspace: { status: 'RUNNING', name: 'X' },
      loading: false,
      error: null,
      chatOpen: false,
      setChatOpen: vi.fn(),
    });
    renderLayout();
    expect(screen.getAllByText('platform').length).toBeGreaterThan(0);
  });

  it('SubscriptionGate (core passthrough) always renders the Outlet', () => {
    mockUseWorkspace.mockReturnValue({
      workspaceId: 'ws-1',
      // No subscriptionStatus set — in an overlay this would gate the
      // Outlet behind a paywall. Core stub doesn't care.
      workspace: { status: 'RUNNING', name: 'X' },
      loading: false,
      error: null,
      chatOpen: false,
      setChatOpen: vi.fn(),
    });
    renderLayout();
    expect(screen.getByTestId('outlet-marker')).toBeInTheDocument();
  });

  it('MarketingBanner (core stub returns null) does not render any banner copy', () => {
    mockUseWorkspace.mockReturnValue({
      workspaceId: 'ws-1',
      workspace: { status: 'RUNNING', name: 'X' },
      loading: false,
      error: null,
      chatOpen: false,
      setChatOpen: vi.fn(),
    });
    renderLayout();
    expect(screen.queryByText(/consultant|hire an AI/i)).not.toBeInTheDocument();
  });

  it('writes chat-panel width under the localStorage key platform:chat-panel-width', async () => {
    vi.useFakeTimers();
    mockUseWorkspace.mockReturnValue({
      workspaceId: 'ws-1',
      workspace: { status: 'RUNNING', name: 'X' },
      loading: false,
      error: null,
      chatOpen: false,
      setChatOpen: vi.fn(),
    });
    renderLayout();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(window.localStorage.getItem('platform:chat-panel-width')).toBe('480');
    vi.useRealTimers();
  });
});

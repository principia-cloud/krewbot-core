import { createBrowserRouter, Navigate, useParams } from 'react-router';

/** Old `/agents/:agentId/explore` URL — preserved as a redirect to the
 * new Inspect tab inside the creator view so existing bookmarks work. */
function ExploreRedirect() {
  const { id, agentId } = useParams<{ id: string; agentId: string }>();
  return (
    <Navigate
      to={`/workspaces/${id}/agents/${agentId}?tab=inspect`}
      replace
    />
  );
}
import { AuthGuard } from '@/auth/auth-guard';
import { CallbackPage } from '@/auth/callback';
import { GoogleCallbackPage } from '@/pages/oauth/google-callback';
import { MicrosoftCallbackPage } from '@/pages/oauth/microsoft-callback';
import { LoginPage } from '@/pages/login';
import { BrowserLivePage } from '@/pages/browser-live';
import { DashboardPage } from '@/pages/dashboard/index';
import { OnboardingPage } from '@/pages/onboarding/index';
import { WorkspaceLayout } from '@/pages/workspace/layout';
import { FilesView } from '@/pages/workspace/files-view';
import { KnowledgeView } from '@/pages/workspace/knowledge-view';
import { IntegrationsView } from '@/pages/workspace/integrations-view';
import { AutomationsView } from '@/pages/workspace/automations-view';
import { SettingsView } from '@/pages/workspace/settings-view';
import { UsageView } from '@/pages/workspace/usage-view';
import { AgentsView } from '@/pages/workspace/agents-view';
import { AgentCreatorView } from '@/pages/workspace/agent-creator-view';
import { TasksView } from '@/pages/workspace/tasks-view';

export const router = createBrowserRouter([
  { path: '/browser-live', element: <BrowserLivePage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/callback', element: <CallbackPage /> },
  { path: '/oauth/google/callback', element: <GoogleCallbackPage /> },
  { path: '/oauth/microsoft/callback', element: <MicrosoftCallbackPage /> },
  {
    element: <AuthGuard />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/onboarding', element: <OnboardingPage /> },
      {
        path: '/workspaces/:id',
        element: <WorkspaceLayout />,
        children: [
          // Files used to be the workspace landing page, but the tree
          // is per-session — surfacing it as a top-level "workspace
          // files" entry was misleading. Now it's reachable via the
          // Files icon in the chat panel header (deep-links into the
          // active session). The index redirects to Agents, the new
          // primary workspace surface.
          { index: true, element: <Navigate to="agents" replace /> },
          { path: 'files', element: <FilesView /> },
          { path: 'knowledge', element: <KnowledgeView /> },
          { path: 'automations', element: <AutomationsView /> },
          { path: 'tasks', element: <TasksView /> },
          { path: 'agents', element: <AgentsView /> },
          { path: 'agents/:agentId', element: <AgentCreatorView /> },
          // /agents/:agentId/explore was the old standalone Explore
          // page; the same UI is now the Inspect tab inside the
          // creator view. Redirect so old links keep working.
          {
            path: 'agents/:agentId/explore',
            element: <ExploreRedirect />,
          },
          { path: 'integrations', element: <IntegrationsView /> },
          { path: 'usage', element: <UsageView /> },
          { path: 'settings', element: <SettingsView /> },
          // Redirects from old routes
          { path: 'billing', element: <Navigate to="../settings" replace /> },
          { path: 'context', element: <Navigate to="../knowledge" replace /> },
          { path: 'skills', element: <Navigate to="../knowledge" replace /> },
          { path: 'rules', element: <Navigate to="../knowledge" replace /> },
          { path: 'memory', element: <Navigate to="../knowledge" replace /> },
        ],
      },
    ],
  },
]);

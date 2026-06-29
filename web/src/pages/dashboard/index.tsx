import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { listMyWorkspaces } from '@/api/workspaces';
import { WORKSPACE_CREATION_ENABLED } from '@/extensions/workspace-creation';

export function DashboardPage() {
  const navigate = useNavigate();
  const [noWorkspace, setNoWorkspace] = useState(false);

  useEffect(() => {
    listMyWorkspaces()
      .then((res) => {
        const ws = res.workspaces || [];
        if (ws.length === 0) {
          if (WORKSPACE_CREATION_ENABLED) {
            navigate('/onboarding', { replace: true });
          } else {
            // Single-tenant deployments auto-enroll members into the
            // shared workspace; landing here means enrollment hasn't
            // happened (yet). Creating a workspace isn't an option.
            setNoWorkspace(true);
          }
        } else {
          navigate(`/workspaces/${ws[0].workspaceId}`, { replace: true });
        }
      })
      .catch(() => {
        navigate('/login', { replace: true });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (noWorkspace) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">No workspace assigned</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account isn't a member of any workspace yet. Try signing
            out and back in, or contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

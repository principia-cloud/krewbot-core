import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/auth-context';
import { createWorkspace } from '@/api/workspaces';
import { APP_NAME } from '@/lib/constants';
import { WORKSPACE_CREATION_ENABLED } from '@/extensions/workspace-creation';

/**
 * Core onboarding: a single "name + id" form that creates the workspace
 * and navigates to it.
 *
 * An overlay replaces this entire file with a 3-step
 * wizard that collects optional messaging tokens and kicks off a Stripe
 * Checkout session. The whole page is overridden (rather than a single
 * "extras" slot) because nearly every detail — request shape, response
 * handling, draft persistence — differs between the two flows.
 */

const SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,25}$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 25);
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Deployments with creation disabled (single-tenant overlays) never
  // link here, but the route still exists — bounce direct visits home.
  useEffect(() => {
    if (!WORKSPACE_CREATION_ENABLED) navigate('/', { replace: true });
  }, [navigate]);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNameChange = (next: string) => {
    setName(next);
    if (!slugEdited) setId(slugify(next));
  };

  const isValid = name.trim().length > 0 && SLUG_PATTERN.test(id);

  const handleCreate = async () => {
    if (!isValid) return;
    setCreating(true);
    setError(null);
    try {
      await createWorkspace({ workspaceId: id, name: name.trim() });
      navigate(`/workspaces/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <span className="text-base font-bold">{APP_NAME}</span>
        <span className="text-sm text-muted-foreground">
          {user?.email || user?.sub}
        </span>
      </header>

      <div className="mx-auto max-w-md px-4 pt-12 sm:px-6">
        <h1 className="mb-1 text-xl font-semibold">Create your workspace</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Give your workspace a name. The ID is used in URLs and is permanent.
        </p>

        <div className="space-y-4">
          <div>
            <Label htmlFor="ws-name" className="mb-1.5 block text-xs">
              Name
            </Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Acme Engineering"
              disabled={creating}
            />
          </div>

          <div>
            <Label htmlFor="ws-id" className="mb-1.5 block text-xs">
              Workspace ID
            </Label>
            <Input
              id="ws-id"
              value={id}
              onChange={(e) => {
                setSlugEdited(true);
                setId(e.target.value);
              }}
              placeholder="acme-engineering"
              disabled={creating}
              className="font-mono"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Up to 25 characters: letters, numbers, hyphens, underscores.
            </p>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <Button
            className="w-full"
            size="lg"
            onClick={handleCreate}
            disabled={!isValid || creating}
          >
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create workspace
          </Button>
        </div>
      </div>
    </div>
  );
}

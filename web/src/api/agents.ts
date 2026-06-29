import { apiFetch } from './client';
import { getToken } from '@/auth/cognito';
import { WORKSPACE_DOMAIN_SUFFIX } from '@/lib/constants';

function workspaceBaseUrl(workspaceId: string): string {
  return `https://${workspaceId}.${WORKSPACE_DOMAIN_SUFFIX}`;
}

async function workspaceFetch<T>(
  workspaceId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${workspaceBaseUrl(workspaceId)}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  // 201/200 with JSON body; 204 (no content) is also valid here.
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Row as persisted in the example-agents DDB table and returned by the
 * Management API. `deletion_pending` rows exist transiently — after
 * DELETE, the DDB row sits with a ttl attribute (7 days) and the
 * chat-server sweeper rm's the EFS dir within the next hour. The
 * Management API list endpoint already filters them out, so the UI
 * generally doesn't encounter this status, but the type keeps the
 * discriminator honest. */
export interface Agent {
  agentId: string;
  workspaceId: string;
  name: string;
  description: string;
  status: 'draft' | 'deployed' | 'deletion_pending';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  requiredSecrets: string[];
}

/** POST /workspaces/{id}/agents returns the new row + the session key
 * the UI should open a creator chat against. */
export interface CreatedAgent {
  agentId: string;
  name: string;
  description: string;
  status: 'draft';
  creatorSessionKey: string;
}

/** Result of POST .../deploy. `missing` lists the required secrets that
 * aren't yet configured; when non-empty and `status === 'missing_secrets'`,
 * the UI should show a banner. Re-POSTing with `override=true` flips the
 * row to 'deployed' even if secrets are missing. */
export interface DeployResult {
  agentId: string;
  status: 'deployed' | 'missing_secrets';
  missing: string[];
}

export function listAgents(
  workspaceId: string,
): Promise<{ agents: Agent[] }> {
  return apiFetch(`/workspaces/${workspaceId}/agents`);
}

export function getAgent(
  workspaceId: string,
  agentId: string,
): Promise<Agent> {
  return apiFetch(`/workspaces/${workspaceId}/agents/${agentId}`);
}

export function createAgent(
  workspaceId: string,
  body: { name: string; description?: string },
): Promise<CreatedAgent> {
  return apiFetch(`/workspaces/${workspaceId}/agents`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateAgent(
  workspaceId: string,
  agentId: string,
  body: { name?: string; description?: string },
): Promise<{ agentId: string; status: 'updated' }> {
  return apiFetch(`/workspaces/${workspaceId}/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAgent(
  workspaceId: string,
  agentId: string,
): Promise<void> {
  return apiFetch(`/workspaces/${workspaceId}/agents/${agentId}`, {
    method: 'DELETE',
  });
}

/** Deploy an agent in one call: secret check → promote def-draft → flip
 * status to deployed. Lives on the chat-server (workspace domain), not
 * the Management API, because promote needs EFS access and Lambda doesn't
 * mount EFS. The chat-server forwards the status flip to the Agent
 * Platform API internally, so the frontend only sees one endpoint. */
export function deployAgent(
  workspaceId: string,
  agentId: string,
  opts?: { override?: boolean },
): Promise<DeployResult> {
  const qs = opts?.override ? '?override=true' : '';
  return workspaceFetch<DeployResult>(
    workspaceId,
    `/api/agents/${agentId}/deploy${qs}`,
    { method: 'POST' },
  );
}

/** Create a chat session pinned to test one agent (loaded from the
 * agent's def-draft/, not the deployed snapshot). Returns the session
 * descriptor the UI can route into the workspace chat. */
export function createAgentTestSession(
  workspaceId: string,
  agentId: string,
  agentName?: string,
): Promise<{ id: string; name: string }> {
  return workspaceFetch<{ id: string; name: string }>(
    workspaceId,
    `/api/agents/${agentId}/test-session`,
    {
      method: 'POST',
      body: JSON.stringify(agentName ? { agentName } : {}),
    },
  );
}


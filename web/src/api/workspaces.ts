import { apiFetch } from './client';
import type {
  Workspace,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  MyWorkspaceMembership,
} from './types';

export function listMyWorkspaces(): Promise<{ workspaces: MyWorkspaceMembership[] }> {
  return apiFetch('/me/workspaces');
}

export function getWorkspace(workspaceId: string): Promise<Workspace> {
  return apiFetch(`/workspaces/${workspaceId}`);
}

export function createWorkspace(
  data: CreateWorkspaceRequest,
): Promise<{ workspaceId: string; status: string }> {
  return apiFetch('/workspaces', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateWorkspace(
  workspaceId: string,
  body: UpdateWorkspaceRequest,
): Promise<Workspace> {
  return apiFetch(`/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteWorkspace(
  workspaceId: string,
): Promise<{ workspaceId: string; status: string }> {
  return apiFetch(`/workspaces/${workspaceId}`, { method: 'DELETE' });
}

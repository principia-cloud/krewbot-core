import { apiFetch } from './client';
import type { IntegrationName } from './types';

/** One custom ("bring-your-own") secret. `name` is the normalised
 * storage key (lowercase + dashes, no `custom-` prefix — the backend
 * strips it); `displayName` is the admin's original friendly form
 * (may include uppercase + underscores), preserved for UI display. */
export interface CustomIntegrationEntry {
  name: string;
  displayName: string;
}

export interface IntegrationsListResponse {
  integrations: IntegrationName[];
  /** Sorted alphabetically by `name`. */
  custom: CustomIntegrationEntry[];
}

export function listIntegrations(
  workspaceId: string,
): Promise<IntegrationsListResponse> {
  return apiFetch(`/workspaces/${workspaceId}/integrations`);
}

/** Create or overwrite a custom secret. `name` may include uppercase
 * letters and underscores (for display); the backend normalises it to
 * lowercase + dashes for storage and preserves the original as the
 * `displayName`. Must match `[A-Za-z0-9][A-Za-z0-9_-]{0,62}`; value max
 * 8 KB UTF-8. Same endpoint handles both create and value-rotation —
 * the PUT is idempotent on the normalised key. */
export function setCustomIntegration(
  workspaceId: string,
  name: string,
  value: string,
): Promise<{
  integration: string;
  displayName: string;
  status: string;
  type: 'custom';
}> {
  return apiFetch(`/workspaces/${workspaceId}/integrations/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ custom: true, value }),
  });
}

export function removeCustomIntegration(
  workspaceId: string,
  name: string,
): Promise<{ integration: string; status: string; type: 'custom' }> {
  return apiFetch(
    `/workspaces/${workspaceId}/integrations/${name}?custom=true`,
    { method: 'DELETE' },
  );
}

export function getGoogleAuthUrl(
  workspaceId: string,
  redirectUri: string,
): Promise<{ url: string }> {
  return apiFetch(
    `/workspaces/${workspaceId}/integrations/google/auth-url?redirectUri=${encodeURIComponent(redirectUri)}`,
  );
}

export function getMicrosoftAuthUrl(
  workspaceId: string,
  redirectUri: string,
): Promise<{ url: string }> {
  return apiFetch(
    `/workspaces/${workspaceId}/integrations/microsoft/auth-url?redirectUri=${encodeURIComponent(redirectUri)}`,
  );
}

export function setIntegration(
  workspaceId: string,
  name: IntegrationName,
  data: Record<string, unknown>,
): Promise<{ integration: string; status: string }> {
  return apiFetch(`/workspaces/${workspaceId}/integrations/${name}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function removeIntegration(
  workspaceId: string,
  name: IntegrationName,
): Promise<{ integration: string; status: string }> {
  return apiFetch(`/workspaces/${workspaceId}/integrations/${name}`, {
    method: 'DELETE',
  });
}

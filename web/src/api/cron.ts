import { apiFetch } from './client';
import type { CronJob } from './workspace-client';

export function listCronJobs(
  workspaceId: string,
): Promise<{ jobs: CronJob[] }> {
  return apiFetch(`/workspaces/${workspaceId}/cron/jobs`);
}

import { apiFetch } from './client';

/** One bucket of token counters — the same shape for the monthly total and
 * each per-path/model/source breakdown row. */
export interface UsageBlock {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
  apiCalls: number;
}

export interface WorkspaceUsage {
  month: string;
  /** false when the deployment has no usage table configured. */
  enabled?: boolean;
  totals: UsageBlock;
  byPath: Record<string, UsageBlock>;
  byModel: Record<string, UsageBlock>;
  bySource: Record<string, UsageBlock>;
  /** Gateway billing block — separate accounting namespace from the token
   * counters above (costUsd only accrues in gateway mode). */
  gateway: { costUsd: number; budgetUsd: number; requests: number };
}

export function getWorkspaceUsage(
  workspaceId: string,
  month?: string,
): Promise<WorkspaceUsage> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  return apiFetch(`/workspaces/${workspaceId}/usage${qs}`);
}

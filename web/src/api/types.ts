// --- Workspace ---

export type WorkspaceStatus = 'PROVISIONING' | 'RUNNING' | 'RECOVERING' | 'DELETING' | 'FAILED';
export type MemberRole = 'admin' | 'member';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';

export interface Workspace {
  workspaceId: string;
  name: string;
  adminUserId: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt?: string;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionPlan?: string;
  subscriptionCurrentPeriodEnd?: string;
  trialEnd?: string;
  /** When true, the agent-platform-api's Langfuse proxy short-circuits
   * and no conversation traces leave the account for this workspace. */
  diagnosticsOptOut?: boolean;
}

export interface UpdateWorkspaceRequest {
  diagnosticsOptOut?: boolean;
}

export interface BillingInfo {
  subscriptionStatus: SubscriptionStatus | null;
  subscriptionPlan: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
}

export interface CreateWorkspaceRequest {
  workspaceId: string;
  name?: string;
  claudeToken?: string;
  telegramBotToken?: string;
  adminTelegramId?: string;
  notionToken?: string;
  googleAccountToken?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  whatsappApiToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappAppSecret?: string;
  teamsAppId?: string;
  teamsAppPassword?: string;
}

// --- Members ---

export interface Member {
  workspaceId: string;
  userId: string;
  role: MemberRole;
  addedAt: string;
  addedBy: string;
  telegramUserId?: string;
}

export interface AddMemberRequest {
  userId: string;
  role?: MemberRole;
  telegramUserId?: string;
}

// --- Integrations ---

export type IntegrationName = 'claude' | 'telegram' | 'notion' | 'google' | 'microsoft' | 'github' | 'slack' | 'linear' | 'whatsapp' | 'teams';

export interface SetClaudeIntegration {
  token: string;
}

export interface SetTelegramIntegration {
  token: string;
}

export interface SetNotionIntegration {
  token: string;
}

export interface SetGoogleIntegration {
  auth_code: string;
  redirect_uri: string;
}

// --- My workspaces ---

export interface MyWorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: MemberRole;
  addedAt: string;
  /** Enriched from the workspaces table so the UI can show a
   * "Deleting…" badge for in-flight tear-downs and skip them when
   * picking a post-delete redirect target. May be absent if the
   * workspaces row hasn't been read (transient backend hiccup). */
  status?: WorkspaceStatus;
  name?: string;
}

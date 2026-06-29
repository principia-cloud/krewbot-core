/**
 * Platform config schema.
 *
 * These interfaces are the single source of truth for the shape of an
 * overlay's `getConfig()` return value. Overlays import them from
 * `@krewbot/platform-core` and pass the resulting object straight to
 * `composePlatform(app, cfg)`.
 *
 * Overlays MAY extend these interfaces with their own fields (e.g. a
 * downstream overlay adds `landing` / `ci` to `StackIds`, `stripePriceId` to the
 * top-level config). The base shape covers everything `composePlatform`
 * needs; overlay-specific stacks read from the extended config.
 */

import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface StackIds {
  ecr: string;
  network: string;
  storage: string;
  cluster: string;
  auth: string;
  certificate: string;
  dataPlane: string;
  agentPlatformApi: string;
  managementApi: string;
  frontend: string;
  workspaceTemplate: string;
  /** LLM gateway stack (LiteLLM Lambda + Function URL). Optional — the gateway
   * is only composed when both this and infrastructureNames.gatewayRepository
   * are set. */
  llmGateway?: string;
}

export interface StorageNames {
  workspacesTable: string;
  workspaceMembersTable: string;
  chatDirectoryTable: string;
  agentsTable: string;
  /** Per-workspace LLM usage + monthly spend rollup (PK workspaceId, SK
   * MONTH#YYYY-MM rollup / REQ#ts#id detail). Read+written by the LLM gateway.
   * Optional — created only when set; required if the LLM gateway is composed. */
  llmUsageTable?: string;
}

export interface InfrastructureNames {
  agentRepository: string;
  sidecarRepository: string;
  /** ECR repo for the LLM gateway (LiteLLM) image. Optional — see
   * stackIds.llmGateway. */
  gatewayRepository?: string;
  ecsCluster: string;
  dataPlaneLoadBalancer: string;
  platformConfigSsmParameter: string;
  agentPlatformApiName: string;
  managementApiName: string;
  provisionStateMachineName: string;
  deprovisionStateMachineName: string;
  ecsTaskStateChangeRuleName: string;
  userPoolName: string;
  userPoolClientName: string;
}

export interface WorkspaceNamespaceNames {
  secretsPrefix: string;
  ssmPrefix: string;
  cronConnectionPrefix: string;
  cronDestinationPrefix: string;
  cronInvokeRolePrefix: string;
  cronRulePrefix: string;
  workspaceStackPrefix: string;
  managedByTag: string;
  langfusePlatformSecretName: string;
}

export interface PlatformSecretNames {
  /** Google OAuth client credentials (client_id + client_secret JSON).
   *  Read by workspace-api for per-workspace Google integrations and
   *  by AuthStack for Cognito federated sign-in. */
  googleOauth: string;
  /** Microsoft (Azure AD) OAuth client credentials (client_id +
   *  client_secret JSON). Read by workspace-api for per-workspace
   *  Microsoft 365 integrations. Multitenant Azure app — the per-user
   *  tenant_id is captured at exchange time. */
  microsoftOauth: string;
}

/** Shared LLM gateway config (Fargate). `enabled` is the master switch; the
 *  sizing/autoscaling fields are conservative defaults the overlay can tune
 *  (beta typically the smallest task, prod 1 vCPU). */
export interface LlmGatewayConfig {
  enabled: boolean;
  /** Fargate CPU units (256 = 0.25 vCPU, 1024 = 1 vCPU). Default 256. */
  cpu?: number;
  /** Task memory MiB (must be a valid Fargate cpu/memory pair). Default 2048 —
   *  LiteLLM's boot footprint exceeds 1 GB, so 2 GB is the floor. */
  memoryMiB?: number;
  /** Always-warm floor — keep ≥1 to avoid cold starts. Default 1. */
  minTasks?: number;
  /** Autoscaling ceiling — keep low to bound cost. Default 3. */
  maxTasks?: number;
  /** Target avg CPU% for scale-out. Default 60. */
  targetCpuPercent?: number;
  /** Image tag to deploy. Default 'latest'. */
  imageTag?: string;
  /** ALB listener-rule priority (below the per-workspace range). Default 10. */
  listenerRulePriority?: number;
}

/**
 * The base config object an overlay hands to `composePlatform`. Overlays
 * normally define their own config interface that `extends PlatformConfig`
 * with overlay-specific fields (Stripe price IDs, landing domain,
 * subscription sweeper rule name, etc.).
 */
export interface PlatformConfig {
  accountId: string;
  region: string;
  /** Free-form deployment label propagated as `PLATFORM_ENV` on every
   *  Lambda. Tags every structured log record. */
  envLabel: string;

  /** Toggle the cert-coupled stacks (Certificate / DataPlane /
   *  ManagementApi / Frontend). When false `composePlatform` returns
   *  only the foundation stacks; useful for first-bootstrap when the
   *  ACM cert hasn't been issued yet. When true, the cert/domain fields
   *  below are all required. */
  hasCertificate: boolean;
  certificateArn?: string;
  appDomain?: string;
  workspaceZone?: string;
  workspaceWildcard?: string;
  frontendBucketName?: string;

  cognitoDomainPrefix: string;
  /** Pin a specific construct ID for the Cognito hosted-UI domain to
   *  preserve the CFN logical ID across renames. Overlay-only escape hatch;
   *  self-hosted operators leave it undefined to get the neutral
   *  default. */
  cognitoDomainConstructId?: string;

  /** Agent persona substituted into the system prompt as
   *  `{{agent_name}}`. */
  agentName: string;

  /** Absolute path to the pre-synthesized workspace CFN template
   *  (produced by `scripts/synth-workspace-template.ts` or each overlay's
   *  equivalent). ManagementApiStack uploads it as an S3 asset. */
  workspaceTemplatePath: string;

  stackIds: StackIds;
  storageNames: StorageNames;
  infrastructureNames: InfrastructureNames;
  workspaceNamespace: WorkspaceNamespaceNames;
  platformSecrets: PlatformSecretNames;

  /** Optional ECS host + sandbox container sizing. Multi-tenant deploys
   *  (managed or self-hosted) omit this and get the packed default: r7g.large
   *  hosts with a 3584 MiB sandbox container, ~4 workspaces per host.
   *  Single-tenant overlays can give one workspace the whole
   *  host by raising `sandboxMemoryMiB` toward the instance's registerable
   *  memory so only one task fits. */
  clusterSizing?: {
    /** EC2 instance type for the ECS capacity ASG. Default 'r7g.large'.
     *  MUST stay arm64/Graviton — agent + sidecar images are arm64-only
     *  (multi-arch manifests cause `exec format error` on the AL2023 arm64
     *  AMI), so only Graviton families (the `g` suffix, e.g. r7g/c7g/m7g/
     *  t4g) are valid here. */
    instanceType?: string;
    /** Sandbox (agent) container memory hard limit, MiB. Default 3584.
     *  To force one workspace per host, set this above half the instance's
     *  registerable memory (e.g. ~30000 on a 32 GiB r7g.xlarge). */
    sandboxMemoryMiB?: number;
  };

  /** Optional turn-queue / bg-pool sizing written into the platform SSM
   *  parameter (`infrastructureNames.platformConfigSsmParameter`) at deploy.
   *  Runtime-tunable afterward by editing that parameter and force-redeploying
   *  sandbox services — no CDK redeploy needed. Defaults: maxConcurrent 4,
   *  maxBgConcurrent 4, maxWaitMs 60000. Any omitted field falls back to its
   *  default. Size these to the sandbox container's memory: each concurrent
   *  Claude CLI subprocess costs ~500 MiB. */
  turnQueue?: {
    maxConcurrent?: number;
    maxBgConcurrent?: number;
    maxWaitMs?: number;
  };

  /** LLM gateway (LiteLLM on Fargate) — a shared, multi-tenant proxy that lets
   *  gateway-mode workspaces run Bedrock models through Claude Code while the
   *  provider credentials stay off the sandbox. Optional and per-overlay:
   *  absent or `{ enabled: false }` ⇒ no gateway is composed (no Fargate
   *  service, ALB rule, usage table, or ECR repo) and the sandbox's
   *  LLM_GATEWAY_URL is empty. Requires `storageNames.llmUsageTable`,
   *  `infrastructureNames.gatewayRepository`, and `stackIds.llmGateway` to be
   *  set when enabled. */
  llmGateway?: LlmGatewayConfig;

  /** Optional Cognito pre-sign-up trigger code. Overlay-only (an
   *  overlay uses it for the closed-beta allowlist). Self-hosted overlays omit. */
  preSignUpLambdaCode?: lambda.Code;

  /** Optional override for the Agent Platform API Lambda code. Some
   *  overlays that ship hook overrides for agent-platform-api supply a
   *  pre-merged bundle here; self-hosted overlays omit and get core's
   *  own bundle. */
  agentPlatformApiLambdaCode?: lambda.Code;

  /** Optional Lambda asset factory passed through to ManagementApiStack.
   *  Some overlays supply this so `management-api-saas-addons`
   *  can construct stripe-webhook / calendly-stripe-bridge /
   *  subscription-sweeper Lambdas with consumer-side asset paths.
   *  Self-hosted overlays omit; core resolves its own Lambdas internally. */
  lambdaCodeFactory?: (
    relativePath: string,
    options?: Parameters<typeof lambda.Code.fromAsset>[1],
  ) => lambda.Code;
}

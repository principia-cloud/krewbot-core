/**
 * composePlatform — single-call factory that instantiates the full core
 * stack graph from a `PlatformConfig`.
 *
 * Replaces ~130 lines of stack-wiring boilerplate that overlays used to
 * carry in `bin/app.ts`. Encodes the inter-stack dependency order and
 * the cert-coupled gating in one place. Overlays still own the
 * overlay-only constructs (LandingStack, CiStack, etc.) — they call
 * `composePlatform(app, cfg)` first, then add their own stacks and call
 * `installManagementApiSaasAddons(platform.management!, ...)` against
 * the returned constructs.
 */

import * as cdk from 'aws-cdk-lib';
import { EcrStack } from './ecr-stack';
import { NetworkStack } from './network-stack';
import { StorageStack } from './storage-stack';
import { ClusterStack } from './cluster-stack';
import { AuthStack } from './auth-stack';
import { CertificateStack } from './certificate-stack';
import { DataPlaneStack } from './data-plane-stack';
import { AgentPlatformApiStack } from './agent-platform-api-stack';
import { ManagementApiStack } from './management-api-stack';
import { FrontendStack } from './frontend-stack';
import { LlmGatewayStack } from './llm-gateway-stack';
import type { PlatformConfig } from './config-types';

/** Result of `composePlatform`. The cert-coupled stacks are present
 *  only when `cfg.hasCertificate` is true. */
export interface ComposedPlatform {
  ecr: EcrStack;
  network: NetworkStack;
  storage: StorageStack;
  cluster: ClusterStack;
  auth: AuthStack;
  agentPlatform: AgentPlatformApiStack;
  cert?: CertificateStack;
  dataPlane?: DataPlaneStack;
  management?: ManagementApiStack;
  frontend?: FrontendStack;
  /** Present only when `stackIds.llmGateway` + `gatewayRepository` are set. */
  llmGateway?: LlmGatewayStack;
}

export function composePlatform(app: cdk.App, cfg: PlatformConfig): ComposedPlatform {
  const env: cdk.Environment = { account: cfg.accountId, region: cfg.region };

  // ===== Foundation (always deployed) =====
  const ecr = new EcrStack(app, cfg.stackIds.ecr, {
    env,
    repositoryNames: {
      agentRepository: cfg.infrastructureNames.agentRepository,
      sidecarRepository: cfg.infrastructureNames.sidecarRepository,
      gatewayRepository: cfg.infrastructureNames.gatewayRepository,
    },
  });

  const network = new NetworkStack(app, cfg.stackIds.network, { env });

  const storage = new StorageStack(app, cfg.stackIds.storage, {
    env,
    vpc: network.vpc,
    efsSg: network.efsSg,
    tableNames: cfg.storageNames,
  });

  const cluster = new ClusterStack(app, cfg.stackIds.cluster, {
    env,
    vpc: network.vpc,
    ecsInstanceSg: network.ecsInstanceSg,
    fileSystem: storage.fileSystem,
    clusterName: cfg.infrastructureNames.ecsCluster,
    platformConfigSsmParameterName: cfg.infrastructureNames.platformConfigSsmParameter,
    instanceType: cfg.clusterSizing?.instanceType,
    turnQueue: cfg.turnQueue,
  });

  const auth = new AuthStack(app, cfg.stackIds.auth, {
    env,
    envLabel: cfg.envLabel,
    appDomain: cfg.appDomain ?? 'http://localhost',
    cognitoDomainPrefix: cfg.cognitoDomainPrefix,
    cognitoDomainConstructId: cfg.cognitoDomainConstructId,
    platformSecrets: cfg.platformSecrets,
    userPoolName: cfg.infrastructureNames.userPoolName,
    userPoolClientName: cfg.infrastructureNames.userPoolClientName,
    preSignUpLambdaCode: cfg.preSignUpLambdaCode,
  });

  const agentPlatform = new AgentPlatformApiStack(app, cfg.stackIds.agentPlatformApi, {
    env,
    workspacesTable: storage.workspacesTable,
    workspaceMembersTable: storage.workspaceMembersTable,
    chatDirectoryTable: storage.chatDirectoryTable,
    agentsTable: storage.agentsTable,
    llmUsageTable: storage.llmUsageTable,
    apiName: cfg.infrastructureNames.agentPlatformApiName,
    envLabel: cfg.envLabel,
    namespaceNames: cfg.workspaceNamespace,
    lambdaCode: cfg.agentPlatformApiLambdaCode,
  });

  // ===== Cert-coupled stacks =====
  // Skipped when `hasCertificate=false` so an operator can deploy the
  // foundation while an ACM cert is still pending DNS validation. Once
  // the cert ARN is filled in, flip `hasCertificate` and re-synth.
  if (!cfg.hasCertificate) {
    return { ecr, network, storage, cluster, auth, agentPlatform };
  }

  if (!cfg.certificateArn || !cfg.appDomain || !cfg.workspaceZone || !cfg.frontendBucketName) {
    throw new Error(
      'composePlatform: hasCertificate=true requires certificateArn, ' +
        'appDomain, workspaceZone, and frontendBucketName. Fill them in or ' +
        'set hasCertificate=false to deploy foundation stacks only.',
    );
  }

  const cert = new CertificateStack(app, cfg.stackIds.certificate, {
    env,
    certificateArn: cfg.certificateArn,
  });

  const dataPlane = new DataPlaneStack(app, cfg.stackIds.dataPlane, {
    env,
    vpc: network.vpc,
    albSg: network.albSg,
    certificate: cert.certificate,
    loadBalancerName: cfg.infrastructureNames.dataPlaneLoadBalancer,
  });

  // ===== LLM gateway (optional, overlay-flagged) =====
  // A shared Fargate service behind this ALB. Composed only when the overlay
  // sets `llmGateway.enabled`; its URL flows to the sandbox as LLM_GATEWAY_URL.
  let llmGateway: LlmGatewayStack | undefined;
  if (cfg.llmGateway?.enabled) {
    if (!cfg.stackIds.llmGateway || !ecr.gatewayRepo || !storage.llmUsageTable) {
      throw new Error(
        'composePlatform: llmGateway.enabled requires stackIds.llmGateway, ' +
          'infrastructureNames.gatewayRepository, and storageNames.llmUsageTable.',
      );
    }
    const gw = cfg.llmGateway;
    llmGateway = new LlmGatewayStack(app, cfg.stackIds.llmGateway, {
      env,
      vpc: network.vpc,
      albSecurityGroup: network.albSg,
      httpsListener: dataPlane.httpsListener,
      gatewayRepo: ecr.gatewayRepo,
      imageTag: gw.imageTag,
      workspacesTable: storage.workspacesTable,
      llmUsageTable: storage.llmUsageTable,
      secretsPrefix: cfg.workspaceNamespace.secretsPrefix,
      envLabel: cfg.envLabel,
      hostName: `llm-gateway.${cfg.workspaceZone}`,
      listenerRulePriority: gw.listenerRulePriority,
      cpu: gw.cpu,
      memoryMiB: gw.memoryMiB,
      minTasks: gw.minTasks,
      maxTasks: gw.maxTasks,
      targetCpuPercent: gw.targetCpuPercent,
    });
  }

  const management = new ManagementApiStack(app, cfg.stackIds.managementApi, {
    env,
    workspacesTable: storage.workspacesTable,
    workspaceMembersTable: storage.workspaceMembersTable,
    agentsTable: storage.agentsTable,
    llmUsageTable: storage.llmUsageTable,
    fileSystem: storage.fileSystem,
    vpc: network.vpc,
    sidecarSg: network.sidecarSg,
    agentRepo: ecr.agentRepo,
    sidecarRepo: ecr.sidecarRepo,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    clusterName: cfg.infrastructureNames.ecsCluster,
    workspaceTemplatePath: cfg.workspaceTemplatePath,
    albListenerArn: dataPlane.httpsListener.listenerArn,
    workspaceZone: cfg.workspaceZone,
    appDomain: cfg.appDomain,
    agentName: cfg.agentName,
    envLabel: cfg.envLabel,
    agentPlatformApiUrl: agentPlatform.apiUrl,
    llmGatewayUrl: llmGateway?.serviceUrl,
    physicalNames: {
      managementApiName: cfg.infrastructureNames.managementApiName,
      provisionStateMachineName: cfg.infrastructureNames.provisionStateMachineName,
      deprovisionStateMachineName: cfg.infrastructureNames.deprovisionStateMachineName,
      ecsTaskStateChangeRuleName: cfg.infrastructureNames.ecsTaskStateChangeRuleName,
      platformConfigSsmParameter: cfg.infrastructureNames.platformConfigSsmParameter,
    },
    namespaceNames: cfg.workspaceNamespace,
    platformSecrets: cfg.platformSecrets,
    lambdaCodeFactory: cfg.lambdaCodeFactory,
  });

  const frontend = new FrontendStack(app, cfg.stackIds.frontend, {
    env,
    certificate: cert.certificate,
    appDomain: cfg.appDomain,
    bucketName: cfg.frontendBucketName,
  });

  return { ecr, network, storage, cluster, auth, agentPlatform, cert, dataPlane, management, frontend, llmGateway };
}

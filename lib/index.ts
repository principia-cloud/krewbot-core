/**
 * @krewbot/platform-core — CDK stack and construct surface.
 *
 * Self-hosted operators (and overlay deployments) import stacks from this
 * entry point:
 *
 *   import { NetworkStack, ManagementApiStack } from '@krewbot/platform-core';
 *
 * Re-exports are listed in dependency-tree order for readability.
 */

// Foundation
export { EcrStack, EcrStackProps } from './ecr-stack';
export { NetworkStack } from './network-stack';
export { StorageStack, StorageStackProps } from './storage-stack';
export { CertificateStack, CertificateStackProps } from './certificate-stack';

// Compute
export { ClusterStack, ClusterStackProps } from './cluster-stack';
export { DataPlaneStack, DataPlaneStackProps } from './data-plane-stack';
export { AuthStack, AuthStackProps } from './auth-stack';
export { FrontendStack, FrontendStackProps } from './frontend-stack';

// APIs
export { AgentPlatformApiStack, AgentPlatformApiStackProps } from './agent-platform-api-stack';
export { ManagementApiStack, ManagementApiStackProps } from './management-api-stack';
export { LlmGatewayStack, LlmGatewayStackProps } from './llm-gateway-stack';

// Per-workspace template (synthesized into assets/workspace-template.json)
export { WorkspaceStack } from './workspace-stack';

// Lambda asset helpers
export { pythonLambdaAsset } from './python-lambda-asset';

// Config schema + composition factory
export type {
  StackIds,
  StorageNames,
  InfrastructureNames,
  WorkspaceNamespaceNames,
  PlatformSecretNames,
  PlatformConfig,
} from './config-types';
export { composePlatform, ComposedPlatform } from './compose-platform';

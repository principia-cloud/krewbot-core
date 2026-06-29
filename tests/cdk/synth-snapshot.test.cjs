/**
 * Core-only CDK snapshot test.
 *
 * Synthesizes the whole core stack graph with brand-NEUTRAL config (no
 * leaked internal/brand names like a codename prefix or downstream
 * overlay names). The snapshot pins the resource shape + key physical
 * names so an accidental brand leak (e.g. a default fallback string
 * sneaking into a stack file) shows up as snapshot drift.
 *
 * For the overlay-shaped snapshots (which include `installManagementApiSaasAddons`
 * and overlay defaults), see a downstream overlay's `tests/cdk/synth-snapshot.test.cjs`.
 *
 * Run:
 *   npm test
 * Refresh after intentional changes:
 *   UPDATE_CDK_SNAPSHOTS=1 npm test
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const cdk = require("aws-cdk-lib");
const assertions = require("aws-cdk-lib/assertions");

const {
  EcrStack,
  NetworkStack,
  StorageStack,
  ClusterStack,
  DataPlaneStack,
  AgentPlatformApiStack,
  ManagementApiStack,
  WorkspaceStack,
  LlmGatewayStack,
} = require("../../dist/lib/index.js");

const SNAPSHOT_DIR = path.join(__dirname, "snapshots");
const UPDATE = process.env.UPDATE_CDK_SNAPSHOTS === "1";

// Brand-neutral test config. No internal/brand strings (no codename,
// no downstream overlay names). If a stack ever falls back to an overlay-shaped default
// instead of reading from props, the resulting snapshot will contain
// that string and the diff makes it visible.
const NEUTRAL_CONFIG = {
  accountId: "123456789012",
  region: "us-east-1",
  certificateArn:
    "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
  agentName: "selfhost-agent",
  appDomain: "app.example.test",
  workspaceZone: "ws.example.test",
  infrastructureNames: {
    agentRepository: "selfhost-agent",
    sidecarRepository: "selfhost-sidecar",
    gatewayRepository: "selfhost-llm-gateway",
    ecsCluster: "selfhost-cluster",
    platformConfigSsmParameter: "/selfhost/platform-config",
    dataPlaneLoadBalancer: "selfhost-dataplane",
    agentPlatformApiName: "selfhost-agent-platform-api",
    managementApiName: "selfhost-management-api",
    provisionStateMachineName: "selfhost-provision",
    deprovisionStateMachineName: "selfhost-deprovision",
    ecsTaskStateChangeRuleName: "selfhost-ecs-state-change",
  },
  storageNames: {
    workspacesTable: "selfhost-workspaces",
    workspaceMembersTable: "selfhost-workspace-members",
    chatDirectoryTable: "selfhost-chat-directory",
    agentsTable: "selfhost-agents",
    llmUsageTable: "selfhost-llm-usage",
  },
  workspaceNamespace: {
    secretsPrefix: "selfhost",
    ssmPrefix: "/selfhost",
    cronRulePrefix: "selfhost-cron",
    cronDestinationPrefix: "selfhost-cron-dest",
    cronInvokeRolePrefix: "selfhost-cron-invoke",
    cronConnectionPrefix: "selfhost-cron-conn",
    workspaceStackPrefix: "Selfhost-Workspace",
    managedByTag: "selfhost",
    langfusePlatformSecretName: "selfhost/platform/langfuse-keys",
  },
  platformSecrets: {
    googleOauth: "selfhost/google-oauth",
    microsoftOauth: "selfhost/microsoft-oauth",
  },
};

function appWithEnv() {
  return new cdk.App();
}

function expectSnapshot(name, value) {
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, serialized);
    return;
  }
  assert.equal(
    serialized,
    fs.readFileSync(file, "utf8"),
    `snapshot drifted: ${file}; rerun with UPDATE_CDK_SNAPSHOTS=1 if intentional`,
  );
}

function templateOf(stack) {
  return assertions.Template.fromStack(stack).toJSON();
}

// Keep snapshots small + readable: only capture the physical-name-ish
// props that prove "core synthesized with neutral config". Full
// resource bodies churn on every aws-cdk-lib bump.
function selectedProperties(props = {}) {
  const keys = [
    "ApiName",
    "ClusterName",
    "Environment",
    "LoadBalancerName",
    "Name",
    "ParameterName",
    "RepositoryName",
    "RoleName",
    "StateMachineName",
    "TableName",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(props, key))
      .map((key) => [key, props[key]]),
  );
}

function summarizeTemplate(template) {
  return {
    parameters: Object.fromEntries(
      Object.entries(template.Parameters || {}).map(([logicalId, param]) => [
        logicalId,
        { Type: param.Type, Default: param.Default },
      ]),
    ),
    resources: Object.fromEntries(
      Object.entries(template.Resources || {}).map(([logicalId, resource]) => [
        logicalId,
        {
          Type: resource.Type,
          Properties: selectedProperties(resource.Properties),
        },
      ]),
    ),
  };
}

function buildCoreStacks() {
  const app = appWithEnv();
  const cfg = NEUTRAL_CONFIG;
  const env = { account: cfg.accountId, region: cfg.region };

  const network = new NetworkStack(app, "Network", { env });
  const storage = new StorageStack(app, "Storage", {
    env,
    vpc: network.vpc,
    efsSg: network.efsSg,
    tableNames: cfg.storageNames,
  });
  const ecr = new EcrStack(app, "Ecr", {
    env,
    repositoryNames: {
      agentRepository: cfg.infrastructureNames.agentRepository,
      sidecarRepository: cfg.infrastructureNames.sidecarRepository,
      gatewayRepository: cfg.infrastructureNames.gatewayRepository,
    },
  });
  const cluster = new ClusterStack(app, "Cluster", {
    env,
    vpc: network.vpc,
    ecsInstanceSg: network.ecsInstanceSg,
    fileSystem: storage.fileSystem,
    clusterName: cfg.infrastructureNames.ecsCluster,
    platformConfigSsmParameterName:
      cfg.infrastructureNames.platformConfigSsmParameter,
  });
  const cert = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
    app,
    "Cert",
    cfg.certificateArn,
  );
  const dataPlane = new DataPlaneStack(app, "DataPlane", {
    env,
    vpc: network.vpc,
    albSg: network.albSg,
    certificate: cert,
    loadBalancerName: cfg.infrastructureNames.dataPlaneLoadBalancer,
  });
  const deps = new cdk.Stack(app, "Deps", { env });
  const userPool = new cdk.aws_cognito.UserPool(deps, "UserPool");
  const userPoolClient = userPool.addClient("UserPoolClient");

  // Stub Lambda code for snapshot stability: avoids docker bundling
  // and asset-hash churn. The stack's resource SHAPE is what matters
  // — we're proving "core synths" + "no overlay strings leak in".
  const stubCode = cdk.aws_lambda.Code.fromInline(
    "def handler(event, context): return {}",
  );

  const agentPlatform = new AgentPlatformApiStack(app, "AgentPlatformApi", {
    env,
    workspacesTable: storage.workspacesTable,
    workspaceMembersTable: storage.workspaceMembersTable,
    chatDirectoryTable: storage.chatDirectoryTable,
    agentsTable: storage.agentsTable,
    llmUsageTable: storage.llmUsageTable,
    lambdaCode: stubCode,
    apiName: cfg.infrastructureNames.agentPlatformApiName,
    envLabel: "prod",
    namespaceNames: {
      secretsPrefix: cfg.workspaceNamespace.secretsPrefix,
      ssmPrefix: cfg.workspaceNamespace.ssmPrefix,
      cronDestinationPrefix: cfg.workspaceNamespace.cronDestinationPrefix,
      cronInvokeRolePrefix: cfg.workspaceNamespace.cronInvokeRolePrefix,
      cronRulePrefix: cfg.workspaceNamespace.cronRulePrefix,
      langfusePlatformSecretName: cfg.workspaceNamespace.langfusePlatformSecretName,
    },
  });
  const llmGateway = new LlmGatewayStack(app, "LlmGateway", {
    env,
    vpc: network.vpc,
    albSecurityGroup: network.albSg,
    httpsListener: dataPlane.httpsListener,
    gatewayRepo: ecr.gatewayRepo,
    workspacesTable: storage.workspacesTable,
    llmUsageTable: storage.llmUsageTable,
    secretsPrefix: cfg.workspaceNamespace.secretsPrefix,
    envLabel: "prod",
    hostName: "llm-gateway.ws.example.test",
    cpu: 256,
    memoryMiB: 1024,
    minTasks: 1,
    maxTasks: 3,
  });
  const management = new ManagementApiStack(app, "ManagementApi", {
    env,
    workspacesTable: storage.workspacesTable,
    workspaceMembersTable: storage.workspaceMembersTable,
    agentsTable: storage.agentsTable,
    fileSystem: storage.fileSystem,
    vpc: network.vpc,
    sidecarSg: network.sidecarSg,
    agentRepo: ecr.agentRepo,
    sidecarRepo: ecr.sidecarRepo,
    userPool,
    userPoolClient,
    clusterName: cfg.infrastructureNames.ecsCluster,
    workspaceTemplatePath: path.join(
      __dirname,
      "fixtures",
      "workspace-template.stub.json",
    ),
    albListenerArn:
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/example/1/2",
    workspaceZone: cfg.workspaceZone,
    appDomain: cfg.appDomain,
    agentName: cfg.agentName,
    agentPlatformApiUrl: "https://agent-platform.example.test",
    llmGatewayUrl: llmGateway.serviceUrl,
    envLabel: "prod",
    lambdaCode: stubCode,
    physicalNames: {
      managementApiName: cfg.infrastructureNames.managementApiName,
      provisionStateMachineName:
        cfg.infrastructureNames.provisionStateMachineName,
      deprovisionStateMachineName:
        cfg.infrastructureNames.deprovisionStateMachineName,
      ecsTaskStateChangeRuleName:
        cfg.infrastructureNames.ecsTaskStateChangeRuleName,
      platformConfigSsmParameter:
        cfg.infrastructureNames.platformConfigSsmParameter,
    },
    namespaceNames: {
      secretsPrefix: cfg.workspaceNamespace.secretsPrefix,
      ssmPrefix: cfg.workspaceNamespace.ssmPrefix,
      cronRulePrefix: cfg.workspaceNamespace.cronRulePrefix,
      workspaceStackPrefix: cfg.workspaceNamespace.workspaceStackPrefix,
      managedByTag: cfg.workspaceNamespace.managedByTag,
    },
    platformSecrets: cfg.platformSecrets,
  });

  return { ecr, storage, cluster, dataPlane, agentPlatform, management, llmGateway };
}

test("workspace template synthesized shape snapshot", () => {
  const app = appWithEnv();
  const stack = new WorkspaceStack(app, "WorkspaceTemplate", {
    namespaceNames: {
      secretsPrefix: NEUTRAL_CONFIG.workspaceNamespace.secretsPrefix,
      ssmPrefix: NEUTRAL_CONFIG.workspaceNamespace.ssmPrefix,
      cronConnectionPrefix:
        NEUTRAL_CONFIG.workspaceNamespace.cronConnectionPrefix,
      cronDestinationPrefix:
        NEUTRAL_CONFIG.workspaceNamespace.cronDestinationPrefix,
      cronInvokeRolePrefix:
        NEUTRAL_CONFIG.workspaceNamespace.cronInvokeRolePrefix,
    },
  });
  expectSnapshot(
    "workspace-template-shape",
    summarizeTemplate(templateOf(stack)),
  );
});

test("core platform synthesized shape snapshot", () => {
  const stacks = buildCoreStacks();
  expectSnapshot(
    "core-platform-shape",
    Object.fromEntries(
      Object.entries(stacks).map(([name, stack]) => [
        name,
        summarizeTemplate(templateOf(stack)),
      ]),
    ),
  );
});


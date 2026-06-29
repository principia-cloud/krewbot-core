import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { SandboxTaskDefinition } from './constructs/sandbox-task-definition';
import { SidecarTaskDefinition } from './constructs/sidecar-task-definition';

export interface WorkspaceStackProps extends cdk.StackProps {
  /** Per-workspace namespace prefixes. Sourced from
   *  `cfg.workspaceNamespace`. Required: this stack carries no
   *  overlay-shaped defaults so it is copy-safe to a neutral core. */
  namespaceNames: {
    secretsPrefix: string;
    /** SSM Parameter Store namespace root (with leading slash). Used
     *  to scope per-workspace IAM for SSM and to locate the
     *  platform-wide tuning parameter. */
    ssmPrefix: string;
    cronConnectionPrefix: string;
    cronDestinationPrefix: string;
    cronInvokeRolePrefix: string;
  };
  /** Hard memory limit (MiB) for the sandbox agent container, baked into
   *  this per-workspace template at synth time. Sourced from
   *  `cfg.clusterSizing.sandboxMemoryMiB`. Default 3584 (packed multi-tenant).
   *  Each overlay synthesizes its own template, so this differs per overlay. */
  sandboxMemoryMiB?: number;
}

/**
 * Per-workspace CloudFormation stack — synthesized once by CDK into a template
 * that the provisioning workflow deploys per-workspace with different CFN Parameters.
 *
 * Why CFN Parameters (not cross-stack imports):
 *   Deployed by a Lambda at runtime, not by `cdk deploy`. Cross-stack Fn::ImportValue
 *   would couple this template to specific stack names. Parameters let the
 *   provisioning Lambda pass everything explicitly — platform stacks can be
 *   renamed/replaced without touching this template.
 */
export class WorkspaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkspaceStackProps) {
    super(scope, id, props);
    const namespaceNames = props.namespaceNames;

    // ===== Parameters =====
    const workspaceIdParam = new cdk.CfnParameter(this, 'WorkspaceId', {
      type: 'String',
      description: 'Workspace identifier (used in resource names, EFS paths, family names)',
      minLength: 1,
      maxLength: 64,
      // Why this pattern: workspaceId is interpolated into EFS paths, ECS
      // service names, and CFN stack names. Restricting to [a-zA-Z0-9_-]
      // prevents path traversal, CFN name injection, and shell escaping issues.
      allowedPattern: '^[a-zA-Z0-9_-]+$',
    });
    const uidGidParam = new cdk.CfnParameter(this, 'UidGid', {
      type: 'Number',
      description: 'POSIX uid/gid for this workspace',
      // minValue 1000: avoids collision with system users (root=0, system
      // accounts <1000). All workspaces currently share uid 1000; per-workspace
      // isolation comes from the EFS access point rootDirectory chroot, not
      // from uid separation.
      minValue: 1000,
    });
    const fileSystemIdParam = new cdk.CfnParameter(this, 'FileSystemId', {
      type: 'String',
      description: 'EFS file system ID (from StorageStack)',
    });
    const clusterNameParam = new cdk.CfnParameter(this, 'ClusterName', {
      type: 'String',
      description: 'ECS cluster name. Supplied by the provision Lambda from the platform-side config — no default here.',
    });
    const vpcIdParam = new cdk.CfnParameter(this, 'VpcId', {
      type: 'AWS::EC2::VPC::Id',
      description: 'VPC ID',
    });
    const subnetIdParam = new cdk.CfnParameter(this, 'SubnetId', {
      type: 'AWS::EC2::Subnet::Id',
      description: 'Subnet ID for sidecar awsvpc tasks',
    });
    const sidecarSgIdParam = new cdk.CfnParameter(this, 'SidecarSgId', {
      type: 'AWS::EC2::SecurityGroup::Id',
      description: 'Sidecar security group ID',
    });
    const agentRepoArnParam = new cdk.CfnParameter(this, 'AgentRepoArn', {
      type: 'String',
      description: 'Agent ECR repo ARN',
    });
    const sidecarRepoArnParam = new cdk.CfnParameter(this, 'SidecarRepoArn', {
      type: 'String',
      description: 'Sidecar ECR repo ARN',
    });
    const jwksUrlParam = new cdk.CfnParameter(this, 'JwksUrl', {
      type: 'String',
      description: 'Cognito JWKS URL',
    });
    // Data-plane routing parameters (populated by the provision Lambda from
    // DataPlaneStack outputs).
    const albListenerArnParam = new cdk.CfnParameter(this, 'AlbListenerArn', {
      type: 'String',
      description: 'HTTPS listener ARN of the shared data-plane ALB',
    });
    const listenerRulePriorityParam = new cdk.CfnParameter(this, 'ListenerRulePriority', {
      type: 'Number',
      description: 'Priority for the listener rule (must be unique per listener)',
      minValue: 1,
      maxValue: 50000,
    });
    const domainNameParam = new cdk.CfnParameter(this, 'DomainName', {
      type: 'String',
      description: 'Apex domain under which workspace subdomains are served',
    });
    // Cognito identifiers for container-level JWT validation.
    const cognitoUserPoolIdParam = new cdk.CfnParameter(this, 'CognitoUserPoolId', {
      type: 'String',
      description: 'Cognito user pool ID',
    });
    const cognitoClientIdParam = new cdk.CfnParameter(this, 'CognitoClientId', {
      type: 'String',
      description: 'Cognito app client ID',
    });
    // Agent Platform API URL — passed to the sandbox task so the chat-server
    // and agent_platform_mcp know who to call for workspace-scoped AWS ops
    // (members, cron CRUD, chat-directory observations). The sidecar no
    // longer needs this; it only vends secrets/SSM to /config.
    const agentPlatformApiUrlParam = new cdk.CfnParameter(this, 'AgentPlatformApiUrl', {
      type: 'String',
      description: 'Public HTTPS endpoint of the Agent Platform API (e.g. https://abc123.execute-api.us-east-1.amazonaws.com)',
    });
    const appUrlParam = new cdk.CfnParameter(this, 'AppUrl', {
      type: 'String',
      description: 'Web app base URL (configured via cfg.appDomain). Used by agent_platform_mcp to build browser-live URLs and substituted into the system prompt as {{app_url}}.',
    });
    const llmGatewayUrlParam = new cdk.CfnParameter(this, 'LlmGatewayUrl', {
      type: 'String',
      default: '',
      description: 'Public HTTPS endpoint (Function URL) of the LLM gateway. Empty when no gateway is deployed. Set as LLM_GATEWAY_URL on the sandbox; used only for gateway-mode workspaces.',
    });
    const agentNameParam = new cdk.CfnParameter(this, 'AgentName', {
      type: 'String',
      description: 'Agent persona name substituted into the system prompt as {{agent_name}}. Sourced from cfg.agentName.',
    });
    const platformEnvParam = new cdk.CfnParameter(this, 'PlatformEnv', {
      type: 'String',
      description: 'Free-form environment label (e.g. "prod", "beta", "staging") used to tag every structured log record. Passed at provision time by the Management API Lambda.',
    });
    const platformConfigSsmNameParam = new cdk.CfnParameter(this, 'PlatformConfigSsmName', {
      type: 'String',
      description: 'Platform-wide SSM parameter holding sidecar-vended runtime config. Supplied by the provision Lambda from the platform-side config.',
    });

    const workspaceId = workspaceIdParam.valueAsString;

    // ===== EFS Access Points =====
    // Why two separate access points (not one):
    //   The sandbox containers mount BOTH a data AP (rw) and a config AP (ro
    //   from the sandbox side). The sidecar writes secrets to the config AP.
    //   Splitting them means the agent container can be given ONLY the data
    //   AP — it physically cannot traverse to /config and read secrets.
    const dataAccessPoint = new efs.CfnAccessPoint(this, 'DataAccessPoint', {
      fileSystemId: fileSystemIdParam.valueAsString,
      posixUser: {
        uid: uidGidParam.valueAsString,
        gid: uidGidParam.valueAsString,
      },
      // Why chroot via rootDirectory: the access point makes the container
      // see `/workspaces/{workspaceId}/data` as `/`. Even if the container
      // escaped into the AP's view, it has no path to another workspace's data.
      rootDirectory: {
        path: cdk.Fn.sub('/workspaces/${WorkspaceId}/data'),
        creationInfo: {
          ownerUid: uidGidParam.valueAsString,
          ownerGid: uidGidParam.valueAsString,
          // Why 0750 (not 0755 or 0700):
          //   - owner (workspace uid) rwx
          //   - group (same) rx  — lets shared files be readable inside workspace
          //   - other: nothing — other workspaces can't read even if they
          //     somehow reached the path
          permissions: '0750',
        },
      },
      accessPointTags: [
        { key: 'WorkspaceId', value: workspaceId },
        { key: 'Purpose', value: 'data' },
      ],
    });

    // User-context access point (Stage 2 of the agent port). Chroot'd into
    // /workspaces/{workspaceId}/user_context/ so the sidecar can `git init`
    // and seed the four placeholder markdown files on first boot. The
    // sidecar mounts this rw; the sandbox's agent container continues to
    // access the same directory via the broader data access point (through
    // the context MCP, not directly).
    const userContextAccessPoint = new efs.CfnAccessPoint(this, 'UserContextAccessPoint', {
      fileSystemId: fileSystemIdParam.valueAsString,
      posixUser: {
        uid: uidGidParam.valueAsString,
        gid: uidGidParam.valueAsString,
      },
      rootDirectory: {
        path: cdk.Fn.sub('/workspaces/${WorkspaceId}/user_context'),
        creationInfo: {
          ownerUid: uidGidParam.valueAsString,
          ownerGid: uidGidParam.valueAsString,
          permissions: '0750',
        },
      },
      accessPointTags: [
        { key: 'WorkspaceId', value: workspaceId },
        { key: 'Purpose', value: 'user_context' },
      ],
    });

    const configAccessPoint = new efs.CfnAccessPoint(this, 'ConfigAccessPoint', {
      fileSystemId: fileSystemIdParam.valueAsString,
      posixUser: {
        uid: uidGidParam.valueAsString,
        gid: uidGidParam.valueAsString,
      },
      rootDirectory: {
        path: cdk.Fn.sub('/workspaces/${WorkspaceId}/config'),
        creationInfo: {
          ownerUid: uidGidParam.valueAsString,
          ownerGid: uidGidParam.valueAsString,
          permissions: '0750',
        },
      },
      accessPointTags: [
        { key: 'WorkspaceId', value: workspaceId },
        { key: 'Purpose', value: 'config' },
      ],
    });

    // ===== Cron trigger secret (per-workspace) =====
    // Used by EventBridge API Destinations to authenticate cron trigger
    // HTTP calls to the workspace's /cron endpoint. The http-server
    // validates this via /config/secrets/cron-trigger-key (synced by sidecar).
    const cronTriggerSecret = new secretsmanager.Secret(this, 'CronTriggerSecret', {
      secretName: cdk.Fn.sub(`${namespaceNames.secretsPrefix}/\${WorkspaceId}/cron-trigger-key`),
      description: `Cron trigger API key for workspace ${workspaceId}`,
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ===== EventBridge cron infrastructure =====
    // Static per-workspace resources: Connection, API Destination, and an
    // IAM role for EventBridge to invoke the API Destination. The sidecar
    // only creates/deletes rules targeting the pre-existing API Destination.

    // Connection: stores the cron-trigger-key as an API key header.
    const cronConnection = new events.CfnConnection(this, 'CronConnection', {
      name: cdk.Fn.sub(`${namespaceNames.cronConnectionPrefix}-\${WorkspaceId}`),
      authorizationType: 'API_KEY',
      authParameters: {
        apiKeyAuthParameters: {
          apiKeyName: 'X-Cron-Key',
          apiKeyValue: cronTriggerSecret.secretValue.unsafeUnwrap(),
        },
      },
    });
    // Force CFN to delete the connection (and the API destination that
    // depends on it) BEFORE the secret. apiKeyValue is a secretsmanager
    // dynamic reference (`{{resolve:...}}`), which CFN does not treat as a
    // dependency edge — without this addDependency, CFN can delete the
    // secret in parallel with the connection, and AWS Events fails to
    // resolve the dynamic reference during connection / API destination
    // delete validation. Symptoms previously seen on stack delete:
    //   CronApiDestination → "GeneralServiceException"
    //   CronConnection     → "Secrets Manager can't find the specified secret"
    cronConnection.node.addDependency(cronTriggerSecret);

    // API Destination: the HTTPS endpoint EventBridge calls when a cron
    // rule fires. Points to {workspaceId}.{domain}/cron.
    const cronApiDestination = new events.CfnApiDestination(this, 'CronApiDestination', {
      name: cdk.Fn.sub(`${namespaceNames.cronDestinationPrefix}-\${WorkspaceId}`),
      connectionArn: cronConnection.attrArn,
      httpMethod: 'POST',
      invocationEndpoint: cdk.Fn.sub('https://${WorkspaceId}.${DomainName}/cron'),
      invocationRateLimitPerSecond: 1,
    });

    // IAM role that EventBridge assumes to invoke the API Destination.
    // Deterministic role name so the Agent Platform API Lambda can derive
    // the ARN for iam:PassRole without an explicit lookup.
    const cronInvokeRole = new iam.Role(this, 'CronInvokeRole', {
      roleName: cdk.Fn.sub(`${namespaceNames.cronInvokeRolePrefix}-\${WorkspaceId}`),
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    cronInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:InvokeApiDestination'],
        resources: [cronApiDestination.attrArn],
      })
    );

    // Import ECR repos via ARNs (passed as parameters).
    // Why fromRepositoryAttributes (not fromRepositoryArn): CFN parameters
    // are late-bound tokens at synth time. fromRepositoryArn tries to parse
    // the ARN to derive the repo name, which fails for tokens.
    // fromRepositoryAttributes lets us provide both explicitly — we
    // reconstruct the name from the ARN suffix via Fn::Select/Fn::Split.
    const agentRepo = ecr.Repository.fromRepositoryAttributes(this, 'AgentRepo', {
      repositoryArn: agentRepoArnParam.valueAsString,
      repositoryName: cdk.Fn.select(1, cdk.Fn.split('/', agentRepoArnParam.valueAsString)),
    });
    const sidecarRepo = ecr.Repository.fromRepositoryAttributes(this, 'SidecarRepo', {
      repositoryArn: sidecarRepoArnParam.valueAsString,
      repositoryName: cdk.Fn.select(1, cdk.Fn.split('/', sidecarRepoArnParam.valueAsString)),
    });

    // ===== Task Definitions =====
    const sandboxTaskDef = new SandboxTaskDefinition(this, 'SandboxTaskDef', {
      workspaceId,
      uidGid: uidGidParam.valueAsString,
      agentRepo,
      fileSystemId: fileSystemIdParam.valueAsString,
      dataAccessPointId: dataAccessPoint.attrAccessPointId,
      configAccessPointId: configAccessPoint.attrAccessPointId,
      userContextAccessPointId: userContextAccessPoint.attrAccessPointId,
      cognitoUserPoolId: cognitoUserPoolIdParam.valueAsString,
      cognitoClientId: cognitoClientIdParam.valueAsString,
      awsRegion: this.region,
      domainName: domainNameParam.valueAsString,
      appUrl: appUrlParam.valueAsString,
      agentName: agentNameParam.valueAsString,
      agentPlatformApiUrl: agentPlatformApiUrlParam.valueAsString,
      llmGatewayUrl: llmGatewayUrlParam.valueAsString,
      platformEnv: platformEnvParam.valueAsString,
      sandboxMemoryMiB: props.sandboxMemoryMiB,
    });

    const sidecarTaskDef = new SidecarTaskDefinition(this, 'SidecarTaskDef', {
      workspaceId,
      uidGid: uidGidParam.valueAsString,
      sidecarRepo,
      fileSystemId: fileSystemIdParam.valueAsString,
      configAccessPointId: configAccessPoint.attrAccessPointId,
      userContextAccessPointId: userContextAccessPoint.attrAccessPointId,
      jwksUrl: jwksUrlParam.valueAsString,
      awsRegion: this.region,
      platformConfigSsmName: platformConfigSsmNameParam.valueAsString,
      platformEnv: platformEnvParam.valueAsString,
      workspaceSecretsPrefix: namespaceNames.secretsPrefix,
      workspaceSsmPrefix: namespaceNames.ssmPrefix,
    });

    // ===== Import VPC + Cluster =====
    // Why fromVpcAttributes with a placeholder AZ: we don't need to enumerate
    // subnets here — the sidecar service only places into the one subnet
    // passed as a parameter. VPC lookup requires some AZ, so we use the
    // region's first AZ as a placeholder; it's never actually used.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: vpcIdParam.valueAsString,
      availabilityZones: [cdk.Fn.select(0, cdk.Fn.getAzs(this.region))],
      publicSubnetIds: [subnetIdParam.valueAsString],
    });
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName: clusterNameParam.valueAsString,
      vpc,
      securityGroups: [],
    });

    // ===== Data-plane target group + listener rule =====
    // Each workspace gets its own target group. The sandbox ECS service
    // registers tasks here (dynamic host-port mapping). A host-based rule
    // on the shared ALB listener forwards {workspaceId}.{domain} traffic
    // to this target group.
    const targetGroup = new elbv2.CfnTargetGroup(this, 'SandboxTargetGroup', {
      name: cdk.Fn.sub('leo-tg-${WorkspaceId}'),
      vpcId: vpcIdParam.valueAsString,
      port: 8080,
      protocol: 'HTTP',
      targetType: 'instance',
      healthCheckPath: '/health',
      healthCheckProtocol: 'HTTP',
      healthCheckIntervalSeconds: 15,
      healthCheckTimeoutSeconds: 5,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      // Short deregistration delay so rolling restarts don't hold
      // connections on dead tasks.
      targetGroupAttributes: [
        { key: 'deregistration_delay.timeout_seconds', value: '10' },
      ],
    });

    new elbv2.CfnListenerRule(this, 'SandboxListenerRule', {
      listenerArn: albListenerArnParam.valueAsString,
      priority: listenerRulePriorityParam.valueAsNumber,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: {
            values: [cdk.Fn.sub('${WorkspaceId}.${DomainName}')],
          },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: targetGroup.ref,
        },
      ],
    });

    // ===== ECS Services =====
    // Why minHealthy=0, maxHealthy=100: each workspace runs exactly 1 task.
    // Rolling updates must be able to kill the old task (0% healthy) before
    // starting the new one, otherwise CFN deployment deadlocks on a 1-task service.
    const sandboxService = new ecs.Ec2Service(this, 'SandboxService', {
      cluster,
      taskDefinition: sandboxTaskDef.taskDefinition,
      desiredCount: 1,
      serviceName: cdk.Fn.sub('sandbox-${WorkspaceId}'),
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // 420 second grace period: cold start now includes ASG instance launch
      // (~90s) + ECS register + gVisor switch (~30s) + ECR image pull +
      // container start before the first ALB health check. Without enough
      // headroom here ECS tears tasks down during initial registration and
      // loops forever.
      healthCheckGracePeriod: cdk.Duration.seconds(420),
      // Bin-pack tasks by memory so multiple workspaces co-tenant on the
      // same EC2 instance up to its capacity. Default ECS strategy
      // (random/spread) leaves instances under-utilized — with 4
      // workspaces (each sandbox 1663 MiB + sidecar 256 MiB) and t3.medium
      // hosts (3839 MiB usable), bin-pack lets us fit 2 sandbox+sidecar
      // pairs per host instead of spreading across 3+ hosts.
      placementStrategies: [
        ecs.PlacementStrategy.packedByMemory(),
      ],
    });
    // Bind the sandbox service to the target group. ECS registers tasks
    // with the TG and tracks health automatically. Uses the low-level
    // escape hatch because fromClusterAttributes cluster + bridge mode
    // registration via CfnTargetGroup needs manual LoadBalancer config.
    const cfnSandboxService = sandboxService.node.defaultChild as ecs.CfnService;
    // Strip launchType so the service inherits the cluster's default capacity
    // provider strategy (set in ClusterStack). Without this, the service runs
    // under launchType=EC2 which bypasses the capacity provider and prevents
    // managed scale-out from firing on pending tasks.
    cfnSandboxService.launchType = undefined;
    cfnSandboxService.loadBalancers = [
      {
        targetGroupArn: targetGroup.ref,
        containerName: 'agent',
        containerPort: 8080,
      },
    ];

    // Both sandbox and sidecar use bridge mode, so neither needs a task-level
    // security group. Host-level ECS instance SG governs outbound traffic,
    // and DOCKER-USER iptables rules enforce egress filtering for all bridge
    // containers.
    const sidecarService = new ecs.Ec2Service(this, 'SidecarService', {
      cluster,
      taskDefinition: sidecarTaskDef.taskDefinition,
      desiredCount: 1,
      serviceName: cdk.Fn.sub('sidecar-${WorkspaceId}'),
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Same rationale as the sandbox service: bin-pack tightly so
      // sidecars co-tenant with their (and other workspaces') sandboxes
      // instead of spreading across hosts. Sidecars are tiny (256 MiB)
      // and tend to land on whichever host has the most slack — without
      // bin-pack that creates fragmentation.
      placementStrategies: [
        ecs.PlacementStrategy.packedByMemory(),
      ],
    });
    // Strip launchType so the sidecar service also inherits the cluster's
    // default capacity provider strategy (see sandbox service comment above).
    const cfnSidecarService = sidecarService.node.defaultChild as ecs.CfnService;
    cfnSidecarService.launchType = undefined;

    // Outputs (read by the provisioning Lambda after CFN deploy completes)
    new cdk.CfnOutput(this, 'SandboxServiceName', { value: sandboxService.serviceName });
    new cdk.CfnOutput(this, 'SidecarServiceName', { value: sidecarService.serviceName });
    new cdk.CfnOutput(this, 'DataAccessPointId', { value: dataAccessPoint.attrAccessPointId });
    new cdk.CfnOutput(this, 'ConfigAccessPointId', { value: configAccessPoint.attrAccessPointId });
    new cdk.CfnOutput(this, 'UserContextAccessPointId', { value: userContextAccessPoint.attrAccessPointId });
    new cdk.CfnOutput(this, 'CronTriggerSecretArn', { value: cronTriggerSecret.secretArn });
    new cdk.CfnOutput(this, 'CronApiDestinationArn', { value: cronApiDestination.attrArn });
    new cdk.CfnOutput(this, 'CronInvokeRoleArn', { value: cronInvokeRole.roleArn });
  }
}

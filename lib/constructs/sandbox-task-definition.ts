import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SandboxTaskDefinitionProps {
  workspaceId: string;
  // POSIX uid/gid for this workspace (matches EFS access point PosixUser).
  uidGid: string;
  agentRepo: ecr.IRepository;
  fileSystemId: string;
  dataAccessPointId: string;
  configAccessPointId: string;
  userContextAccessPointId: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  awsRegion: string;
  domainName: string;
  // Web app base URL (e.g. https://app.example.com). Used by the
  // agent_platform MCP to build user-facing browser-live URLs and
  // substituted into the system prompt as `{{app_url}}`.
  appUrl: string;
  /** Agent persona name substituted into the system prompt as
   *  `{{agent_name}}`. Sourced from cfg.agentName. */
  agentName: string;
  // Public HTTPS endpoint for the Agent Platform API. The chat-server
  // and agent_platform_mcp call this for workspace-scoped AWS ops
  // (members, cron CRUD, chat-directory observations) using the
  // per-workspace API key the sidecar materializes to
  // /config/secrets/agent-platform-key.
  agentPlatformApiUrl: string;
  /** Public HTTPS endpoint of the LLM gateway (Function URL). Set as
   * LLM_GATEWAY_URL; the chat-server uses it only for workspaces in gateway
   * mode (resolveTurnProvider). Empty string when no gateway is deployed —
   * gateway-mode turns then fail fast with a clear admin message. */
  llmGatewayUrl?: string;
  /** "beta" | "prod" — tagged onto every JSON log record so
   * cross-workspace CloudWatch queries can filter by env. */
  platformEnv: string;
  /** Hard memory limit (MiB) for the agent container. Default 3584
   *  (4 workspaces per r7g.large). Single-tenant overlays raise this
   *  toward the instance's registerable memory so one workspace fills
   *  the host. Sourced from cfg.clusterSizing.sandboxMemoryMiB. */
  sandboxMemoryMiB?: number;
}

/**
 * Per-workspace sandbox task definition — single container architecture.
 *
 * The agent container runs a Node.js Chat SDK server (:8080) that calls
 * the TS Agent SDK in-process. Python MCP servers are spawned via stdio.
 *
 * - Bridge network mode (to benefit from iptables DOCKER-USER rules)
 * - NO task role (sandbox must have no AWS credentials)
 * - Placement constraint: only gVisor-ready instances
 * - cap-drop ALL, no-new-privileges, read-only rootfs
 */
export class SandboxTaskDefinition extends Construct {
  public readonly taskDefinition: ecs.Ec2TaskDefinition;

  constructor(scope: Construct, id: string, props: SandboxTaskDefinitionProps) {
    super(scope, id);

    this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      family: `sandbox-${props.workspaceId}`,
      networkMode: ecs.NetworkMode.BRIDGE,
      // NO taskRole — sandbox containers must not have AWS credentials
    });

    this.taskDefinition.addPlacementConstraint(
      ecs.PlacementConstraint.memberOf('attribute:gvisor_ready == true')
    );

    this.taskDefinition.addVolume({
      name: 'workspace-data',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.dataAccessPointId,
          iam: 'DISABLED',
        },
      },
    });
    this.taskDefinition.addVolume({
      name: 'workspace-config',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.configAccessPointId,
          iam: 'DISABLED',
        },
      },
    });
    this.taskDefinition.addVolume({
      name: 'user-context',
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.userContextAccessPointId,
          iam: 'DISABLED',
        },
      },
    });

    const agentLogGroup = new logs.LogGroup(this, 'AgentLogs', {
      logGroupName: `/ecs/sandbox-${props.workspaceId}/agent`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const agent = this.taskDefinition.addContainer('agent', {
      containerName: 'agent',
      image: ecs.ContainerImage.fromEcrRepository(props.agentRepo, 'latest'),
      // Default 3584 MiB fits 4 sandboxes + 4 sidecars per r7g.large host
      // (~15,300 MiB registered after AL2023 overhead):
      //   4 * 3584 + 4 * 128 = 14848 MiB  (leaves ~500 MiB slack).
      // Pairs with MAX_CONCURRENT_TURNS (main) + MAX_CONCURRENT_BG_TURNS (bg)
      // gates (via the platform SSM config) so concurrent Claude CLI
      // subprocesses can't blow this budget — roughly (mem-200)/500 turn
      // slots. Single-tenant overlays raise this (cfg.clusterSizing) to
      // fill a bigger host with one workspace and run more concurrent turns.
      memoryLimitMiB: props.sandboxMemoryMiB ?? 3584,
      essential: true,
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      readonlyRootFilesystem: true,
      user: `${props.uidGid}:${props.uidGid}`,
      environment: {
        WORKSPACE_ID: props.workspaceId,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        AWS_REGION: props.awsRegion,
        JWKS_PATH: '/config/jwks.json',
        DOMAIN_NAME: props.domainName,
        APP_URL: props.appUrl,
        AGENT_NAME: props.agentName,
        AGENT_PLATFORM_API_URL: props.agentPlatformApiUrl,
        AGENT_PLATFORM_KEY_PATH: '/config/secrets/agent-platform-key',
        LLM_GATEWAY_URL: props.llmGatewayUrl ?? '',
        PLATFORM_ENV: props.platformEnv,
        LOG_LEVEL: 'info',
        // Turn-queue + bg-pool tuning knobs are NOT pinned here. They
        // live in the platform-wide SSM parameter named by the
        // PlatformConfigSsmName CFN parameter, which the sidecar
        // mirrors into /config/turn-queue.json. chat-server's
        // turn-queue-config.ts loads that file at startup with env-var
        // and hard-coded fallbacks. Operator workflow: write the SSM
        // parameter once and force-redeploy sandbox services — no CDK
        // redeploy needed to tune capacity cluster-wide.
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -sf http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: agentLogGroup,
        streamPrefix: 'agent',
      }),
    });

    agent.addMountPoints(
      { sourceVolume: 'workspace-data', containerPath: '/data', readOnly: false },
      { sourceVolume: 'workspace-config', containerPath: '/config', readOnly: true },
      { sourceVolume: 'user-context', containerPath: '/data/user_context', readOnly: false },
    );

    // Apply cap-drop ALL, no-new-privileges, and tmpfs /tmp on the agent container.
    const cfn = this.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    // Single container at index 0
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.LinuxParameters.Capabilities.Drop',
      ['ALL']
    );
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.LinuxParameters.Tmpfs',
      [{ ContainerPath: '/tmp', Size: 256, MountOptions: ['rw', 'noexec', 'nosuid'] }]
    );
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.DockerSecurityOptions',
      ['no-new-privileges']
    );
  }
}

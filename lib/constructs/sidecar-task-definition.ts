import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SidecarTaskDefinitionProps {
  workspaceId: string;
  // POSIX uid/gid for this workspace (matches the EFS access point PosixUser).
  // The container must run as this uid so client-side NFS permission checks
  // pass. The access point squashes all writes to this uid server-side
  // regardless, but the kernel on the client still validates against the
  // inode owner shown by the mount.
  uidGid: string;
  sidecarRepo: ecr.IRepository;
  fileSystemId: string;
  configAccessPointId: string;
  // Access point chroot'd into /workspaces/{workspaceId}/user_context/. The
  // sidecar mounts it rw to run a one-shot `git init` on first boot and
  // seed placeholder markdown files. The sandbox's agent container mounts
  // the broader data access point (which contains user_context/ as a
  // subdirectory) and reads/writes through the context MCP.
  userContextAccessPointId: string;
  jwksUrl: string;
  awsRegion: string;
  platformConfigSsmName: string;
  /** "beta" | "prod" — tagged onto every sidecar JSON log record. */
  platformEnv: string;
  /** Per-workspace namespace root for Secrets Manager (no leading or
   *  trailing slash). Sourced from the operator's
   *  `cfg.workspaceNamespace.secretsPrefix`. No overlay-shaped default. */
  workspaceSecretsPrefix: string;
  /** Per-workspace namespace root for SSM Parameter Store (with leading
   *  slash). The construct derives both the per-workspace prefix
   *  (`${prefix}/${workspaceId}/*`) and the platform-wide parameter
   *  path (`${prefix}/platform/*`) from this. */
  workspaceSsmPrefix: string;
}

/**
 * Per-workspace sidecar task definition — secrets-only after the
 * agent-platform API takeover.
 *
 * The sidecar's job is now narrow: vend per-workspace secrets and SSM
 * parameters into /config/secrets/* and /config/ssm/*, refresh JWKS into
 * /config/jwks.json, and one-shot init the user_context git repo. Every
 * workspace-mutating AWS call (DDB writes, EventBridge CRUD, members /
 * workspace metadata reads, chat-directory observations + snapshots) now
 * goes through the Agent Platform API Lambda over HTTPS.
 *
 * - Bridge network mode (DOCKER-USER controlled egress)
 * - HAS task role, scoped to per-workspace Secrets Manager + SSM prefixes
 * - Placement constraint: gVisor-ready instances
 * - Read-only rootfs, cap-drop ALL, no-new-privileges
 */
export class SidecarTaskDefinition extends Construct {
  public readonly taskDefinition: ecs.Ec2TaskDefinition;

  constructor(scope: Construct, id: string, props: SidecarTaskDefinitionProps) {
    super(scope, id);

    const account = cdk.Stack.of(this).account;
    // Prefixes used for the sidecar's automatic discovery of per-workspace
    // app-level secrets and SSM parameters. Everything under these prefixes
    // is fair game for the sidecar to read — new entries require no code
    // change. The IAM policy below enforces the same prefixes at the
    // principal boundary.
    // Strip any accidental leading/trailing slashes so the joined ARNs
    // come out clean regardless of how the prefix was written in config.
    const secretsRoot = props.workspaceSecretsPrefix.replace(/^\/+|\/+$/g, '');
    const ssmRoot = '/' + props.workspaceSsmPrefix.replace(/^\/+|\/+$/g, '');
    const workspaceSecretsPrefix = `${secretsRoot}/${props.workspaceId}/`;    // Secrets Manager names
    const workspaceSsmPrefix = `${ssmRoot}/${props.workspaceId}/`;            // SSM parameter names

    // Task role: scoped to THIS workspace's secrets + SSM only.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Per-workspace secrets prefix. Covers
    // {workspaceSecretsPrefix}/{workspaceId}/agent-platform-key, claude-token,
    // telegram-bot-token, and any future per-workspace secret added under
    // the same prefix.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          `arn:aws:secretsmanager:${props.awsRegion}:${account}:secret:${workspaceSecretsPrefix}*`,
        ],
      })
    );

    // ListSecrets has no resource-level constraint on AWS's side, so this
    // grant is account-wide. Mitigation: the sidecar filters server-side
    // via the name-prefix filter AND re-verifies the prefix client-side
    // before calling GetSecretValue, so a compromised sidecar cannot
    // escalate to reading secrets outside this workspace's prefix.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      })
    );

    // Per-workspace SSM prefix. get-parameters-by-path supports a
    // resource-level ARN pattern, so this grant is fully scoped.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${props.awsRegion}:${account}:parameter${workspaceSsmPrefix}*`,
        ],
      })
    );

    // Read-only access to the platform-wide turn-queue config parameter.
    // Cluster-wide tuning knobs live here (max concurrent turns, wait
    // timeout, bg pool size) so we don't have to redeploy every workspace
    // CFN stack to bump capacity.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${props.awsRegion}:${account}:parameter${ssmRoot}/platform/*`,
        ],
      })
    );

    this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      family: `sidecar-${props.workspaceId}`,
      networkMode: ecs.NetworkMode.BRIDGE,
      taskRole,
    });

    this.taskDefinition.addPlacementConstraint(
      ecs.PlacementConstraint.memberOf('attribute:gvisor_ready == true')
    );

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

    // user_context access point chroots into
    // /workspaces/{workspaceId}/user_context/. The sidecar needs write
    // access here so it can `git init` and seed placeholder files on
    // first boot. It never touches the rest of /data/.
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

    const logGroup = new logs.LogGroup(this, 'SidecarLogs', {
      logGroupName: `/ecs/sidecar-${props.workspaceId}/sidecar`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sidecar = this.taskDefinition.addContainer('sidecar', {
      containerName: 'sidecar',
      image: ecs.ContainerImage.fromEcrRepository(props.sidecarRepo, 'latest'),
      // 128 MiB — sized to fit 4 sidecars per r7g.large host alongside 4
      // sandboxes at 3584 MiB each. Sidecar is narrow by design (boto3 sync
      // + git init + JWKS refresh); typical RSS is ~60 MiB, 128 leaves
      // headroom for startup spikes.
      memoryLimitMiB: 128,
      essential: true,
      readonlyRootFilesystem: true,
      user: `${props.uidGid}:${props.uidGid}`,
      environment: {
        WORKSPACE_ID: props.workspaceId,
        CONFIG_DIR: '/config',
        JWKS_URL: props.jwksUrl,
        AWS_REGION: cdk.Stack.of(this).region,
        // Discovery prefixes — the sidecar enumerates and mirrors
        // everything under these into /config/secrets/ and /config/ssm/.
        WORKSPACE_SECRETS_PREFIX: workspaceSecretsPrefix,
        WORKSPACE_SSM_PREFIX: workspaceSsmPrefix,
        PLATFORM_CONFIG_SSM_NAME: props.platformConfigSsmName,
        USER_CONTEXT_DIR: '/data/user_context',
        PLATFORM_ENV: props.platformEnv,
        LOG_LEVEL: 'INFO',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'sidecar',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'test -f /config/jwks.json'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });
    sidecar.addMountPoints(
      {
        sourceVolume: 'workspace-config',
        containerPath: '/config',
        readOnly: false,
      },
      {
        sourceVolume: 'user-context',
        containerPath: '/data/user_context',
        readOnly: false,
      },
    );

    // Apply cap-drop ALL, no-new-privileges, and tmpfs /tmp via overrides.
    const cfn = this.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.LinuxParameters.Capabilities.Drop',
      ['ALL']
    );
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.LinuxParameters.Tmpfs',
      [{ ContainerPath: '/tmp', Size: 32, MountOptions: ['rw', 'noexec', 'nosuid'] }]
    );
    cfn.addPropertyOverride(
      'ContainerDefinitions.0.DockerSecurityOptions',
      ['no-new-privileges']
    );
  }
}

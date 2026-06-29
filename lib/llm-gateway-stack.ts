import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface LlmGatewayStackProps extends cdk.StackProps {
  /** Shared VPC (public-subnets-only, no NAT — tasks get a public IP). */
  vpc: ec2.IVpc;
  /** The ALB's security group — the only source allowed to reach the tasks. */
  albSecurityGroup: ec2.ISecurityGroup;
  /** The shared data-plane HTTPS listener; we attach one host-header rule. */
  httpsListener: elbv2.IApplicationListener;
  /** ECR repo holding the LiteLLM gateway image (docker/llm-gateway). */
  gatewayRepo: ecr.IRepository;
  imageTag?: string;
  /** Read for the fail-closed monthly budget check. */
  workspacesTable: dynamodb.ITable;
  /** Rollup read (budget) + write (atomic cost accounting). */
  llmUsageTable: dynamodb.ITable;
  /** Workspace secrets prefix — `wsk_` tokens validated against
   *  `{secretsPrefix}/{workspaceId}/agent-platform-key`. */
  secretsPrefix: string;
  envLabel: string;
  /** Host the gateway answers on — under *.ws.{root} so the existing wildcard
   *  cert + DNS already cover it (e.g. llm-gateway.ws.example.com). */
  hostName: string;
  /** ALB listener-rule priority. Keep below the per-workspace range. */
  listenerRulePriority?: number;
  // Conservative sizing/autoscaling knobs (overlay-tunable).
  cpu?: number;                 // Fargate CPU units (256 = 0.25 vCPU)
  memoryMiB?: number;
  minTasks?: number;            // always-warm floor — kills cold start
  maxTasks?: number;            // low ceiling — bounds cost
  targetCpuPercent?: number;
}

/**
 * LLM gateway — a LiteLLM proxy on an always-warm ECS Fargate service behind the
 * shared data-plane ALB. It presents an Anthropic-compatible /v1/messages
 * endpoint and translates to Bedrock Converse using the task role; real AWS
 * credentials live only here, never in the sandbox. Workspaces authenticate with
 * their own `wsk_` token, which the gateway validates and attributes spend to.
 *
 * One shared multi-tenant fleet (not one per workspace), conservatively
 * autoscaled (min 1 warm, low max, fast-out/slow-in).
 */
export class LlmGatewayStack extends cdk.Stack {
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, props: LlmGatewayStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'GwCluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'GwTask', {
      cpu: props.cpu ?? 256,
      // LiteLLM's import/boot footprint exceeds 1 GB, so 2 GB is the floor even
      // at the smallest (0.25) vCPU tier (valid Fargate pairs: 512/1024/2048).
      memoryLimitMiB: props.memoryMiB ?? 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Provider credential lives here only: Bedrock Converse (+ CountTokens for
    // Claude Code's context management).
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:CountTokens'],
      // foundation-model across regions (cross-region inference profiles route
      // to models in us-east-1/us-east-2/us-west-2) + the inference-profile ARNs
      // themselves (e.g. us.deepseek.r1-v1:0).
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        'arn:aws:bedrock:*:' + this.account + ':inference-profile/*',
      ],
    }));
    // Validate `wsk_` tokens (same secret the Agent Platform API authorizer reads).
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.secretsPrefix}/*/agent-platform-key*`],
    }));
    props.workspacesTable.grantReadData(taskDef.taskRole);
    props.llmUsageTable.grantReadWriteData(taskDef.taskRole);

    taskDef.addContainer('litellm', {
      image: ecs.ContainerImage.fromEcrRepository(props.gatewayRepo, props.imageTag ?? 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'llm-gateway' }),
      environment: {
        WORKSPACE_SECRETS_PREFIX: props.secretsPrefix,
        WORKSPACES_TABLE: props.workspacesTable.tableName,
        LLM_USAGE_TABLE: props.llmUsageTable.tableName,
        PLATFORM_ENV: props.envLabel,
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        PORT: '4000',
      },
      portMappings: [{ containerPort: 4000 }],
    });

    const svcSg = new ec2.SecurityGroup(this, 'GwSvcSg', {
      vpc: props.vpc,
      description: 'LLM gateway Fargate tasks - ALB ingress only',
      allowAllOutbound: true, // Bedrock/Secrets/DDB over public AWS endpoints (no NAT)
    });
    svcSg.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(4000), 'ALB to gateway tasks');

    const service = new ecs.FargateService(this, 'GwService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.minTasks ?? 1,
      assignPublicIp: true, // public subnets, no NAT
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [svcSg],
      minHealthyPercent: 100, // rolling deploy: start new before draining old
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(120), // LiteLLM boot
      circuitBreaker: { rollback: true },
    });

    const tg = new elbv2.ApplicationTargetGroup(this, 'GwTg', {
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      // Best for variable-duration LLM/streaming requests.
      loadBalancingAlgorithmType: elbv2.TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
      deregistrationDelay: cdk.Duration.seconds(120), // let in-flight streams finish
      healthCheck: {
        path: '/health/liveliness',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });
    service.attachToApplicationTargetGroup(tg);

    new elbv2.ApplicationListenerRule(this, 'GwRule', {
      listener: props.httpsListener,
      priority: props.listenerRulePriority ?? 10,
      conditions: [elbv2.ListenerCondition.hostHeaders([props.hostName])],
      action: elbv2.ListenerAction.forward([tg]),
    });

    // Conservative autoscaling: warm floor, low ceiling, react to bursts, shed slowly.
    const scaling = service.autoScaleTaskCount({
      minCapacity: props.minTasks ?? 1,
      maxCapacity: props.maxTasks ?? 3,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: props.targetCpuPercent ?? 60,
      scaleOutCooldown: cdk.Duration.minutes(1),
      scaleInCooldown: cdk.Duration.minutes(5),
    });

    this.serviceUrl = `https://${props.hostName}`;
    new cdk.CfnOutput(this, 'LlmGatewayUrl', { value: this.serviceUrl });
  }
}

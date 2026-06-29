import * as path from 'path';
import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ClusterStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  ecsInstanceSg: ec2.ISecurityGroup;
  fileSystem: efs.IFileSystem;
  /** Sourced from `cfg.infrastructureNames.ecsCluster`. */
  clusterName: string;
  /** Sourced from `cfg.infrastructureNames.platformConfigSsmParameter`. */
  platformConfigSsmParameterName: string;
  /** EC2 instance type for the capacity ASG. Sourced from
   *  `cfg.clusterSizing.instanceType`. Default 'r7g.large'. Must be
   *  arm64/Graviton (the agent/sidecar images are arm64-only). */
  instanceType?: string;
  /** Turn-queue / bg-pool sizing written into the platform SSM parameter.
   *  Sourced from `cfg.turnQueue`. Omitted fields fall back to defaults. */
  turnQueue?: {
    maxConcurrent?: number;
    maxBgConcurrent?: number;
    maxWaitMs?: number;
  };
}

export class ClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly capacityProvider: ecs.AsgCapacityProvider;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);
    const clusterName = props.clusterName;
    const platformConfigSsmParameterName = props.platformConfigSsmParameterName;

    this.cluster = new ecs.Cluster(this, 'SandboxCluster', {
      vpc: props.vpc,
      clusterName,
    });

    const instanceRole = new iam.Role(this, 'EcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonEC2ContainerServiceforEC2Role'
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:PutAttributes'],
        resources: ['*'],
        conditions: {
          ArnEquals: {
            'ecs:cluster': this.cluster.clusterArn,
          },
        },
      })
    );

    // From `dist/lib/cluster-stack.js`, `../..` is the package root.
    const userDataScript = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'ecs-instance-userdata.sh'),
      'utf-8'
    );
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `export ECS_CLUSTER_NAME="${clusterName}"`,
      `export AWS_REGION="${this.region}"`,
      userDataScript
    );

    const instanceType = props.instanceType ?? 'r7g.large';
    const launchTemplate = new ec2.LaunchTemplate(this, 'EcsLaunchTemplate', {
      // Default r7g.large (Graviton3, arm64, 16 GiB RAM), sized for 4
      // workspaces per host at sandbox=3584 + sidecar=128 MiB per combo.
      // Single-tenant overlays override via cfg.clusterSizing.instanceType
      // (e.g. r7g.xlarge with one workspace filling the host). Must stay
      // arm64/Graviton — the AL2023 arm64 AMI is selected just below.
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
      role: instanceRole,
      securityGroup: props.ecsInstanceSg,
      userData,
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      associatePublicIpAddress: true,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
      vpc: props.vpc,
      launchTemplate,
      minCapacity: 0,
      maxCapacity: 20,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    this.capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedTerminationProtection: true,
      targetCapacityPercent: 100,
    });
    this.cluster.addAsgCapacityProvider(this.capacityProvider);
    this.cluster.addDefaultCapacityProviderStrategy([
      {
        capacityProvider: this.capacityProvider.capacityProviderName,
        weight: 1,
        base: 0,
      },
    ]);

    new ssm.StringParameter(this, 'TurnQueueConfig', {
      parameterName: platformConfigSsmParameterName,
      description:
        'Cluster-wide TurnQueue + bg-pool tuning. Read by sidecar, vended to chat-server as /config/turn-queue.json.',
      stringValue: JSON.stringify({
        maxConcurrent: props.turnQueue?.maxConcurrent ?? 4,
        maxBgConcurrent: props.turnQueue?.maxBgConcurrent ?? 4,
        maxWaitMs: props.turnQueue?.maxWaitMs ?? 60000,
      }),
      tier: ssm.ParameterTier.STANDARD,
    });
  }
}

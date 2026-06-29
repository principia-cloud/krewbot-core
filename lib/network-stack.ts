import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly ecsInstanceSg: ec2.SecurityGroup;
  public readonly albSg: ec2.SecurityGroup;
  public readonly efsSg: ec2.SecurityGroup;
  // Retained for compatibility with existing per-workspace stacks; the
  // sidecar now runs in bridge mode and no longer uses a task-level SG.
  public readonly sidecarSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 AZs required for the ALB (ELBv2 spec). Public subnets only,
    // no NAT (cost control). ECS tasks still get placed on a single
    // instance in one of the AZs.
    this.vpc = new ec2.Vpc(this, 'SandboxVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Shared ALB security group. The data plane ALB lives in this SG; the
    // ECS instance SG only accepts inbound from this SG, so nothing outside
    // the ALB can reach the ephemeral container ports.
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Shared data-plane ALB',
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS from public internet'
    );
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP from public internet (redirected to HTTPS at the listener)'
    );

    // ECS instance SG: original description kept so CFN doesn't replace
    // the resource (the cluster stack consumes its export). The original
    // CloudFront prefix-list ingress is left in place because (a) it's
    // harmless - nothing sends CloudFront traffic at us - and (b) removing
    // inline SG rules forces a replacement that would break the export.
    this.ecsInstanceSg = new ec2.SecurityGroup(this, 'EcsInstanceSg', {
      vpc: this.vpc,
      description: 'ECS container instances - inbound from CloudFront only',
      allowAllOutbound: true,
    });
    // Original CloudFront rule (kept for replacement-avoidance).
    const cfPrefixListId = new cdk.CfnMapping(this, 'CloudfrontPrefixListMapping', {
      mapping: {
        'us-east-1': { prefixListId: 'pl-3b927c52' },
      },
    });
    this.ecsInstanceSg.addIngressRule(
      ec2.Peer.prefixList(cfPrefixListId.findInMap(this.region, 'prefixListId')),
      ec2.Port.tcpRange(32768, 65535),
      'CloudFront to ECS ephemeral ports'
    );
    // Real current data path: ALB to ECS bridge-mode ephemeral ports. Added
    // as a separate rule so it doesn't force SG replacement.
    this.ecsInstanceSg.addIngressRule(
      this.albSg,
      ec2.Port.tcpRange(32768, 65535),
      'ALB to ECS bridge-mode ephemeral ports'
    );

    // SG: Sidecar - no inbound, HTTPS outbound only. Kept identical to the
    // original so the CFN export consumed by the management API stack stays
    // stable. The sidecar now runs in bridge mode and doesn't actually use
    // a task-level SG, but the SG resource still exists to preserve the
    // cross-stack export contract. Will be cleaned up in a later pass.
    this.sidecarSg = new ec2.SecurityGroup(this, 'SidecarSg', {
      vpc: this.vpc,
      description: 'Sidecar tasks - no inbound, HTTPS outbound only',
      allowAllOutbound: false,
    });
    this.sidecarSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS outbound for AWS API calls'
    );

    // SG: EFS - NFS from ECS instances + sidecars
    this.efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      description: 'EFS mount targets - NFS from ECS instances and sidecars',
      allowAllOutbound: false,
    });
    this.efsSg.addIngressRule(
      this.ecsInstanceSg,
      ec2.Port.tcp(2049),
      'NFS from ECS instances'
    );
    this.efsSg.addIngressRule(
      this.sidecarSg,
      ec2.Port.tcp(2049),
      'NFS from sidecar tasks'
    );
    this.sidecarSg.addEgressRule(
      this.efsSg,
      ec2.Port.tcp(2049),
      'NFS outbound to EFS mount targets'
    );
  }
}

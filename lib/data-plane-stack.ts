import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface DataPlaneStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  /** Shared ACM cert (from CertificateStack). Must cover the workspace
   *  wildcard `*.ws.{root}` SAN. */
  certificate: acm.ICertificate;
  /** ALB physical name. Sourced from
   *  `cfg.infrastructureNames.dataPlaneLoadBalancer`. */
  loadBalancerName: string;
  /** HTML body served for unknown workspace subdomains. Optional;
   *  defaults to the neutral built-in 404 page bundled with this
   *  package. Operators can pass custom branded HTML here. */
  notFoundHtml?: string;
}

/**
 * Shared data-plane ALB. Every workspace's sandbox traffic goes through
 * this one ALB. Per-workspace routing is done with a host-based listener
 * rule (created by the per-workspace stack).
 *
 * DNS is managed by the operator (typically a wildcard CNAME
 * `*.ws.{rootDomain}` → this ALB's DNS name). Auth is NOT done at the
 * ALB layer — the agent container validates Bearer JWTs.
 */
export class DataPlaneStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: DataPlaneStackProps) {
    super(scope, id, props);

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: props.loadBalancerName,
    });

    // HTTP :80 → redirect to HTTPS.
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // HTTPS :443. Default action is 404; per-workspace stacks attach
    // Host-header rules to this listener.
    // From `dist/lib/data-plane-stack.js`, `../..` is the package root.
    const notFoundHtml = props.notFoundHtml ?? fs.readFileSync(
      path.join(__dirname, '..', '..', 'assets', 'error-pages', 'workspace-not-found.html'),
      'utf-8',
    );
    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [props.certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/html',
        messageBody: notFoundHtml,
      }),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description:
        'Point the operator-controlled wildcard CNAME `*.ws.{rootDomain}` at this value.',
    });
    new cdk.CfnOutput(this, 'HttpsListenerArn', { value: this.httpsListener.listenerArn });
  }
}

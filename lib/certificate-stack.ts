import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface CertificateStackProps extends cdk.StackProps {
  /**
   * ACM cert ARN for this environment. Must cover root + www.{root} +
   * app.{root} + *.ws.{root}. Issued and DNS-validated manually by the
   * operator; once ISSUED, paste the ARN into the deployment's config.
   */
  certificateArn: string;
}

/**
 * Imports a pre-provisioned ACM certificate for the current deployment.
 *
 * One cert per env, typically shared across the ALB (data plane) and
 * one or more CloudFront distributions.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    // Allow synth with an empty ARN so typechecking in CI works before
    // the cert is issued. Deploy will fail with a clearer CFN error.
    if (!props.certificateArn) {
      cdk.Annotations.of(this).addWarning(
        'CertificateStack: no certificate ARN configured. Issue the ACM ' +
          'cert (see config), DNS-validate, and paste the ARN into config ' +
          'before deploy.',
      );
    }

    // Imported cert (fromCertificateArn) — no CFN resource is created,
    // so the construct ID is cosmetic.
    this.certificate = acm.Certificate.fromCertificateArn(
      this,
      'ExampleCert',
      props.certificateArn || 'arn:aws:acm:us-east-1:000000000000:certificate/PENDING-CERT-ISSUANCE',
    );

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
    });
  }
}

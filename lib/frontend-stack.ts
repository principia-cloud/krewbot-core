import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  /** ACM certificate covering `appDomain` (from CertificateStack). */
  certificate: acm.ICertificate;
  /** Primary CNAME for the distribution, sourced from `cfg.appDomain`. */
  appDomain: string;
  /** Globally-unique S3 bucket name. Sourced from
   *  `cfg.frontendBucketName`. */
  bucketName: string;
}

/**
 * Static SPA hosting for the web frontend.
 *
 * Architecture: S3 (private, OAC) → CloudFront → {appDomain}.
 *
 * Prerequisites:
 *   - CertificateStack deployed and validated (one-time).
 *   - web/dist/ built and synced to the bucket (typically by a CI step
 *     outside this stack).
 *   - After first deploy: configure the operator's DNS to point
 *     `app.{rootDomain}` → the `DistributionDomainName` output.
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      domainNames: [props.appDomain],
      certificate: props.certificate,
      defaultRootObject: 'index.html',
      // SPA fallback: S3 returns 403 for paths the bucket doesn't have
      // (e.g. /workspaces/123). Rewrite to /index.html so client-side
      // routing can handle them.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: `Operator DNS: ${props.appDomain} → this value`,
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
    });
  }
}

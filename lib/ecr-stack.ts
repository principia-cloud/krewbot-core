import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  /** Physical repository names. Sourced from
   *  `cfg.infrastructureNames.{agent,sidecar}Repository`. */
  repositoryNames: {
    agentRepository: string;
    sidecarRepository: string;
    /** Optional — only created when set (LLM gateway image). */
    gatewayRepository?: string;
  };
}

export class EcrStack extends cdk.Stack {
  public readonly agentRepo: ecr.Repository;
  public readonly sidecarRepo: ecr.Repository;
  /** Present only when `repositoryNames.gatewayRepository` is set. */
  public readonly gatewayRepo?: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    const repositoryNames = props.repositoryNames;

    this.agentRepo = this.createRepo(repositoryNames.agentRepository);
    this.sidecarRepo = this.createRepo(repositoryNames.sidecarRepository);
    if (repositoryNames.gatewayRepository) {
      this.gatewayRepo = this.createRepo(repositoryNames.gatewayRepository);
    }
  }

  private createRepo(name: string): ecr.Repository {
    return new ecr.Repository(this, name, {
      repositoryName: name,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only the 10 most recent images',
        },
      ],
    });
  }
}

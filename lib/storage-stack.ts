import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  efsSg: ec2.ISecurityGroup;
  /** DDB table names. Sourced from `cfg.storageNames`. No defaults. */
  tableNames: {
    workspacesTable: string;
    workspaceMembersTable: string;
    chatDirectoryTable: string;
    agentsTable: string;
    /** Optional — table created only when set. */
    llmUsageTable?: string;
  };
}

export class StorageStack extends cdk.Stack {
  public readonly fileSystem: efs.FileSystem;
  public readonly workspacesTable: dynamodb.Table;
  public readonly workspaceMembersTable: dynamodb.Table;
  public readonly chatDirectoryTable: dynamodb.Table;
  public readonly agentsTable: dynamodb.Table;
  /** Present only when `tableNames.llmUsageTable` is set. */
  public readonly llmUsageTable?: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const tableNames = props.tableNames;

    this.fileSystem = new efs.FileSystem(this, 'SandboxEfs', {
      vpc: props.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroup: props.efsSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // Why add ClientMount explicitly: CDK's default policy grants only
    // ClientRootAccess + ClientWrite. Without ClientMount, NFS mounts
    // from access points with iam=DISABLED are rejected with "access
    // denied by server".
    this.fileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        principals: [new iam.AnyPrincipal()],
        conditions: {
          Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
        },
      })
    );

    this.workspacesTable = new dynamodb.Table(this, 'Workspaces', {
      tableName: tableNames.workspacesTable,
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.workspaceMembersTable = new dynamodb.Table(this, 'WorkspaceMembers', {
      tableName: tableNames.workspaceMembersTable,
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.workspaceMembersTable.addGlobalSecondaryIndex({
      indexName: 'by-user',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
    });

    this.chatDirectoryTable = new dynamodb.Table(this, 'ChatDirectory', {
      tableName: tableNames.chatDirectoryTable,
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entityKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.agentsTable = new dynamodb.Table(this, 'Agents', {
      tableName: tableNames.agentsTable,
      partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Per-workspace LLM usage. Single table, disjoint SK namespaces with
    // distinct owners:
    //
    // Gateway-owned (billing/budget; written per completion by the LLM
    // gateway, read for the fail-closed budget check):
    //   sk = "MONTH#YYYY-MM"   → atomic monthly rollup { costUsd, inputTokens,
    //                            outputTokens, cache*InputTokens, requests }
    //   sk = "REQ#<ts>#<id>"   → per-completion detail row (TTL-aged)
    //
    // Agent-Platform-API-owned (unified token counter; written per turn via
    // POST /usage/turns from the chat-server, covers BOTH provider paths):
    //   sk = "TURN#<ts>#<turnId>"            → per-turn detail (TTL-aged)
    //   sk = "USAGE#MONTH#YYYY-MM[#DIM#x]"   → monthly rollups (total +
    //                                          per-PATH/MODEL/SOURCE)
    //   sk = "CTX#<hash>"                    → context-composition snapshot
    //
    // Reads never sum across the two namespaces; budget enforcement only
    // ever touches MONTH# costUsd. `ttl` ages detail rows, never rollups.
    if (tableNames.llmUsageTable) {
      this.llmUsageTable = new dynamodb.Table(this, 'LlmUsage', {
        tableName: tableNames.llmUsageTable,
        partitionKey: { name: 'workspaceId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        timeToLiveAttribute: 'ttl',
      });
    }
  }
}

import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwAuth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwInt from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import * as path from 'path';
import { pythonLambdaAsset } from './python-lambda-asset';

export interface ManagementApiStackProps extends cdk.StackProps {
  workspacesTable: dynamodb.ITable;
  workspaceMembersTable: dynamodb.ITable;
  agentsTable: dynamodb.ITable;
  /** Per-workspace LLM usage table (present when storageNames.llmUsageTable is
   *  configured). Enables workspace-api's `GET /workspaces/{id}/usage` read-back
   *  for the web UI. Read-only here — writes happen in the agent-platform-api
   *  (TURN#/USAGE#/CTX# rows) and the gateway (MONTH#/REQ# rows). */
  llmUsageTable?: dynamodb.ITable;
  fileSystem: efs.IFileSystem;
  vpc: ec2.IVpc;
  sidecarSg: ec2.ISecurityGroup;
  agentRepo: ecr.IRepository;
  sidecarRepo: ecr.IRepository;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  clusterName: string;
  /** Path to synthesized WorkspaceStack template file (from cdk.out). */
  workspaceTemplatePath: string;
  /** HTTPS listener ARN on the shared data-plane ALB. */
  albListenerArn: string;
  /** Workspace subdomain zone, configured via cfg.workspaceZone. Workspaces are
   * served at `{workspaceId}.{workspaceZone}`. */
  workspaceZone: string;
  /** App domain (e.g. `app.example.com`). Configured via `cfg.appDomain`.
   *  Used as the agent's `APP_URL` env and (when overlay addons are
   *  installed) as the magic-link / Stripe URL base. */
  appDomain: string;
  /** Agent persona name substituted into `{{agent_name}}` in the
   *  system prompt. Sourced from `cfg.agentName`. */
  agentName: string;
  /** Public HTTPS endpoint for the Agent Platform API (passed through to
   * the per-workspace stack so the sandbox containers know who to call). */
  agentPlatformApiUrl: string;
  /** Public HTTPS endpoint (Function URL) of the LLM gateway, passed through to
   * the per-workspace stack as the sandbox's LLM_GATEWAY_URL. Optional/empty
   * until the gateway is deployed. */
  llmGatewayUrl?: string;
  lambdaCode?: lambda.Code;
  /** Lambda asset factory. Called as `factory('lambda/provision', { bundling? })`
   *  and returns a `lambda.Code`. The consumer (the bin/app.ts of the
   *  deployment that wires this stack) supplies this with its own
   *  `__dirname` so paths resolve against the consumer's filesystem.
   *  Required for Lambda paths not bundled inside this package (e.g.
   *  `lambda/workspace-api`, when the consumer overlays operator-specific
   *  hooks on top of core's neutral stubs). */
  lambdaCodeFactory?: (
    relativePath: string,
    options?: Parameters<typeof lambda.Code.fromAsset>[1],
  ) => lambda.Code;
  /** Physical resource names (API, state machines, EventBridge rules,
   *  SSM parameter). Sourced from `cfg.infrastructureNames`. Stack
   *  carries no defaults so it is copy-safe to a neutral core. */
  physicalNames: {
    managementApiName: string;
    provisionStateMachineName: string;
    deprovisionStateMachineName: string;
    ecsTaskStateChangeRuleName: string;
    platformConfigSsmParameter: string;
  };
  /** Free-form deployment environment label, propagated as `PLATFORM_ENV`
   *  to every Lambda in this stack and to the per-workspace stack as a
   *  CFN parameter. Tags every structured log record. */
  envLabel: string;
  /** Per-workspace namespace prefixes propagated to provision /
   *  deprovision Lambdas. Sourced from `cfg.workspaceNamespace`. */
  namespaceNames: {
    secretsPrefix: string;
    ssmPrefix: string;
    cronRulePrefix: string;
    workspaceStackPrefix: string;
    managedByTag: string;
  };
  /** Platform-level (non-per-workspace) secret names. Supplied from
   *  `cfg.platformSecrets`; the stack carries no overlay-shaped defaults
   *  so it is copy-safe to a core repo with neutral config. */
  platformSecrets: {
    googleOauth: string;
    microsoftOauth: string;
  };
}

/**
 * Management API stack — the control plane for workspace lifecycle.
 *
 * Components:
 *   - API Gateway HTTP API with Cognito JWT authorizer
 *   - Single Lambda (`workspace-api`) handling all routes via Powertools router
 *   - Step Functions: provision + deprovision, each with poll-describe loops
 *     for CFN status
 *   - EventBridge rule for ECS task state changes → task-cleanup lambda
 *   - Workspace CFN template uploaded as an S3 asset (used by provisioning)
 */
export class ManagementApiStack extends cdk.Stack {
  // Public properties exposed so an overlay addon
  // (`lib/management-api-saas-addons.ts`) can mutate the workspace-api
  // Lambda (add env vars, IAM grants) and attach overlay-only routes /
  // Lambdas inside this stack's scope. Core deployments use none of
  // these from outside; overlay deployments call
  // `installManagementApiSaasAddons(mgmt, ...)` from `bin/app.ts`.
  public readonly workspaceApiFn: lambda.Function;
  public readonly httpApi: apigw.HttpApi;
  public readonly provisionStateMachine: sfn.IStateMachine;
  public readonly deprovisionStateMachine: sfn.IStateMachine;
  /** Shared Lambda integration for routes attached to the
   *  workspace-api function. Reused by overlay-only routes so they don't
   *  create a parallel integration construct. */
  public readonly workspaceApiIntegration: apigwInt.HttpLambdaIntegration;
  /** Cognito JWT authorizer used by every authenticated workspace-api
   *  route. Re-used by overlay authenticated routes. */
  public readonly jwtAuthorizer: apigwAuth.HttpJwtAuthorizer;
  /** Code asset used by overlay-only Lambdas. Same `lambdaCode` /
   *  bundling factory as the core Lambdas. Exposed so the addon can
   *  reuse the asset path resolution. */
  public readonly lambdaCodeFactory: (
    relativePath: string,
    options?: Parameters<typeof lambda.Code.fromAsset>[1],
  ) => lambda.Code;

  constructor(scope: Construct, id: string, props: ManagementApiStackProps) {
    super(scope, id, props);
    const physicalNames = props.physicalNames;
    const namespaceNames = props.namespaceNames;
    const platformSecrets = props.platformSecrets;

    // ========== Workspace CFN template as S3 asset ==========
    // Why S3 asset: the provision Lambda calls cfn.createStack(TemplateURL=...).
    // The synthesized WorkspaceStack template lives in cdk.out after synth;
    // uploading it as an asset gives us a stable S3 URL to pass as an env var.
    const workspaceTemplateAsset = new s3Assets.Asset(this, 'WorkspaceTemplate', {
      path: props.workspaceTemplatePath,
    });

    // Shared across every Lambda in this stack: tells the structured logger
    // which env to tag records with so CloudWatch Logs Insights filters
    // `filter env = "prod"` work across the whole fleet.
    const platformEnv = props.envLabel;

    const commonWorkspaceEnv = {
      WORKSPACES_TABLE: props.workspacesTable.tableName,
      MEMBERS_TABLE: props.workspaceMembersTable.tableName,
      PLATFORM_ENV: platformEnv,
      WORKSPACE_SECRETS_PREFIX: namespaceNames.secretsPrefix,
      WORKSPACE_SSM_PREFIX: namespaceNames.ssmPrefix,
      CRON_RULE_PREFIX: namespaceNames.cronRulePrefix,
        WORKSPACE_STACK_PREFIX: namespaceNames.workspaceStackPrefix,
        PLATFORM_CONFIG_SSM_NAME: physicalNames.platformConfigSsmParameter,
        LOG_LEVEL: 'INFO',
    };
    // Lambda asset resolution. Strategy:
    //   - Core Lambdas (provision, deprovision, post-provision,
    //     post-deprovision, task-cleanup, workspace-api) live inside this
    //     package at `<package-root>/lambda/<name>` and are resolved
    //     internally.
    //   - Overlays that need a customized workspace-api bundle pass
    //     `props.lambdaCodeFactory` and have the factory special-case
    //     'lambda/workspace-api' (pointing at their merged .build/
    //     directory). The factory wins over internal resolution for this
    //     path so the overlay's hooks are picked up.
    //   - Overlay-only Lambdas (stripe-webhook, calendly-stripe-bridge, etc.)
    //     are resolved via the factory's catch-all branch.
    //   - `props.lambdaCode` (a single Code) overrides everything for
    //     test snapshots via Code.fromInline.
    const CORE_LAMBDA_PATHS = new Set([
      'lambda/provision',
      'lambda/post-provision',
      'lambda/deprovision',
      'lambda/post-deprovision',
      'lambda/task-cleanup',
      'lambda/workspace-api',
    ]);
    const lambdaCode = (
      relativePath: string,
      options?: Parameters<typeof lambda.Code.fromAsset>[1],
    ) => {
      if (props.lambdaCode) return props.lambdaCode;
      // Workspace-api: factory wins if supplied (overlay case).
      // Otherwise fall through to internal resolution against core's bundle.
      if (relativePath === 'lambda/workspace-api' && props.lambdaCodeFactory) {
        return props.lambdaCodeFactory(relativePath, options);
      }
      if (CORE_LAMBDA_PATHS.has(relativePath)) {
        // `dist/lib/management-api-stack.js` → `dist/lib/`, walk up two
        // to package root, then into `lambda/<name>`. pythonLambdaAsset
        // also injects `shared/python/platform_log.py` into the bundle
        // so the Lambda's `from platform_log import ...` resolves.
        return pythonLambdaAsset(
          path.join(__dirname, '..', '..', relativePath),
          options,
        );
      }
      if (props.lambdaCodeFactory) return props.lambdaCodeFactory(relativePath, options);
      throw new Error(
        'No Lambda code source for "' + relativePath + '". This path is not a ' +
          'core Lambda; the caller must supply props.lambdaCodeFactory to ' +
          'resolve it against their own filesystem.',
      );
    };
    this.lambdaCodeFactory = lambdaCode;

    // CloudFormation service role. CFN assumes this to create/delete the
    // per-workspace stacks, so the provision/deprovision Lambdas no longer
    // need the broad resource-CRUD permissions on their own identities
    // (the old design gave those Lambdas iam:*/secretsmanager:*/ecs:* on
    // Resource:"*" — a compromise of either was account-admin). The broad
    // grants live here, behind a CloudFormation-only trust boundary; the
    // Lambdas keep only cfn:{Create,Delete,Describe}Stack + iam:PassRole
    // (to hand this role to CFN) + the narrow set they call directly.
    const cfnExecRole = new iam.Role(this, 'WorkspaceCfnExecutionRole', {
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description:
        'Assumed by CloudFormation to provision/deprovision per-workspace ' +
        'stacks. Holds the broad resource-CRUD perms so the control-plane ' +
        'Lambdas do not have to.',
    });
    cfnExecRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          // ec2:Describe* — CFN resolves VPC/subnet/SG lookups during synth.
          'ec2:Describe*',
          // Workspace-stack resource types CFN creates/deletes on our behalf.
          'elasticfilesystem:*',
          'ecs:*',
          'elasticloadbalancing:*',
          'iam:*',
          'secretsmanager:*',
          'logs:*',
          // EventBridge Connection / ApiDestination / invoke role created by
          // the workspace template for cron triggers.
          'events:*',
          // CDK injects a bootstrap-version Rule into every template; CFN
          // reads /cdk-bootstrap/hnb659fds/version from SSM to validate it.
          'ssm:GetParameters',
          'ssm:GetParameter',
        ],
        resources: ['*'],
      })
    );
    // CFN fetches the workspace template from S3 using this role.
    workspaceTemplateAsset.grantRead(cfnExecRole);

    // ========== Step Function lambdas (provision/post-provision/deprovision/post-deprovision) ==========
    const provisionFn = new lambda.Function(this, 'ProvisionFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/provision'),
      timeout: cdk.Duration.minutes(1),
      environment: {
        ...commonWorkspaceEnv,
        WORKSPACE_TEMPLATE_URL: workspaceTemplateAsset.httpUrl,
        FILE_SYSTEM_ID: props.fileSystem.fileSystemId,
        CLUSTER_NAME: props.clusterName,
        VPC_ID: props.vpc.vpcId,
        SUBNET_ID: props.vpc.publicSubnets[0].subnetId,
        SIDECAR_SG_ID: props.sidecarSg.securityGroupId,
        AGENT_REPO_ARN: props.agentRepo.repositoryArn,
        SIDECAR_REPO_ARN: props.sidecarRepo.repositoryArn,
        JWKS_URL: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}/.well-known/jwks.json`,
        ALB_LISTENER_ARN: props.albListenerArn,
        DOMAIN_NAME: props.workspaceZone,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        AGENT_PLATFORM_API_URL: props.agentPlatformApiUrl,
        LLM_GATEWAY_URL: props.llmGatewayUrl ?? '',
        APP_URL: `https://${props.appDomain}`,
        AGENT_NAME: props.agentName,
        MANAGED_BY_TAG: namespaceNames.managedByTag,
        WORKSPACE_CFN_EXEC_ROLE_ARN: cfnExecRole.roleArn,
      },
    });
    props.workspacesTable.grantReadWriteData(provisionFn);
    props.workspaceMembersTable.grantReadWriteData(provisionFn);
    workspaceTemplateAsset.grantRead(provisionFn);

    // Why these CFN actions: provision creates a workspace stack with IAM
    // resources. Scoping the ARN to the operator-configured workspace
    // stack prefix prevents this lambda from touching unrelated stacks.
    provisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:CreateStack', 'cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${namespaceNames.workspaceStackPrefix}-*/*`],
      })
    );
    // Hand the CFN service role to CloudFormation (CreateStack RoleARN).
    // The PassedToService condition ensures the role can ONLY be passed to
    // CloudFormation, not assumed for arbitrary purposes.
    provisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [cfnExecRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
      })
    );
    // The narrow set the provision Lambda calls DIRECTLY (not via CFN):
    //   secrets.{create_secret,put_secret_value,describe_secret} — seeds the
    //   per-workspace agent-platform-key / cron-trigger-key, and
    //   ssm.put_parameter — writes per-workspace params (context-mode,
    //   admin/member telegram ids). Both scoped to the workspace prefix.
    provisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*`,
        ],
      })
    );
    provisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${namespaceNames.ssmPrefix}/*`,
        ],
      })
    );

    const postProvisionFn = new lambda.Function(this, 'PostProvisionFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/post-provision'),
      timeout: cdk.Duration.seconds(30),
      environment: commonWorkspaceEnv,
    });
    props.workspacesTable.grantReadWriteData(postProvisionFn);
    postProvisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${namespaceNames.workspaceStackPrefix}-*/*`],
      })
    );

    const deprovisionFn = new lambda.Function(this, 'DeprovisionFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/deprovision'),
      timeout: cdk.Duration.seconds(30),
      environment: { ...commonWorkspaceEnv, WORKSPACE_CFN_EXEC_ROLE_ARN: cfnExecRole.roleArn },
    });
    props.workspacesTable.grantReadWriteData(deprovisionFn);
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DeleteStack', 'cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${namespaceNames.workspaceStackPrefix}-*/*`],
      })
    );
    // Hand the CFN service role to CloudFormation (DeleteStack RoleARN), so
    // CFN tears down the workspace stack's resources — not the Lambda.
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [cfnExecRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
      })
    );
    // The narrow set deprovision calls DIRECTLY (not via CFN):
    //   secrets.list_secrets + delete_secret — sweep per-workspace secrets;
    //   ssm.get_parameters_by_path + delete_parameters — sweep per-workspace
    //   params; events.list_rules + list_targets_by_rule + remove_targets +
    //   delete_rule — sweep per-workspace cron rules. List APIs (ListSecrets,
    //   ListRules) have no resource-level support, so they stay on "*" (read
    //   only); every mutating action is scoped to the workspace prefix.
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WorkspaceSecretsCleanup',
        actions: ['secretsmanager:DeleteSecret'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*`,
        ],
      })
    );
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WorkspaceSsmCleanup',
        actions: ['ssm:GetParametersByPath', 'ssm:DeleteParameter', 'ssm:DeleteParameters'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${namespaceNames.ssmPrefix}/*`,
        ],
      })
    );
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WorkspaceCronRuleCleanup',
        actions: ['events:ListTargetsByRule', 'events:RemoveTargets', 'events:DeleteRule'],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:rule/${namespaceNames.cronRulePrefix}--*`,
        ],
      })
    );
    // List APIs have no resource-level scoping; read-only, low blast radius.
    deprovisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WorkspaceListForCleanup',
        actions: ['secretsmanager:ListSecrets', 'events:ListRules'],
        resources: ['*'],
      })
    );

    const postDeprovisionFn = new lambda.Function(this, 'PostDeprovisionFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/post-deprovision'),
      timeout: cdk.Duration.seconds(30),
      environment: commonWorkspaceEnv,
    });
    props.workspacesTable.grantReadWriteData(postDeprovisionFn);
    props.workspaceMembersTable.grantReadWriteData(postDeprovisionFn);

    // ========== Provision Step Function ==========
    // Why not use CFN .sync integration: the provision lambda does important
    // work BEFORE creating the stack (atomic uid counter, DDB writes). We
    // need lambda → CFN create, then poll via describe-stack loop.
    const provisionTask = new sfnTasks.LambdaInvoke(this, 'InvokeProvision', {
      lambdaFunction: provisionFn,
      outputPath: '$.Payload',
    });
    const waitForCfn = new sfn.Wait(this, 'WaitForCfn', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });
    const describeStack = new sfnTasks.CallAwsService(this, 'DescribeStack', {
      service: 'cloudformation',
      action: 'describeStacks',
      parameters: { StackName: sfn.JsonPath.stringAt('$.stackName') },
      // Scope to the workspace-stack prefix rather than all stacks.
      iamResources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${namespaceNames.workspaceStackPrefix}-*/*`],
      resultPath: '$.describe',
    });
    const postProvisionTask = new sfnTasks.LambdaInvoke(this, 'InvokePostProvision', {
      lambdaFunction: postProvisionFn,
      outputPath: '$.Payload',
    });
    const cfnFailed = new sfn.Fail(this, 'CfnFailed', {
      error: 'CfnStackCreateFailed',
      cause: 'Workspace stack failed to create',
    });
    // Rollback states (ROLLBACK_COMPLETE, UPDATE_ROLLBACK_COMPLETE) end in
    // "COMPLETE" too, so we must check for failure states FIRST.
    const checkCfnStatus = new sfn.Choice(this, 'CheckCfnStatus')
      .when(
        sfn.Condition.or(
          sfn.Condition.stringMatches('$.describe.Stacks[0].StackStatus', '*FAILED'),
          sfn.Condition.stringMatches('$.describe.Stacks[0].StackStatus', '*ROLLBACK*')
        ),
        cfnFailed
      )
      .when(
        sfn.Condition.stringEquals('$.describe.Stacks[0].StackStatus', 'CREATE_COMPLETE'),
        postProvisionTask
      )
      .when(
        sfn.Condition.stringEquals('$.describe.Stacks[0].StackStatus', 'UPDATE_COMPLETE'),
        postProvisionTask
      )
      .otherwise(waitForCfn);

    const provisionDefinition = provisionTask
      .next(waitForCfn)
      .next(describeStack)
      .next(checkCfnStatus);

    this.provisionStateMachine = new sfn.StateMachine(this, 'ProvisionStateMachine', {
      stateMachineName: physicalNames.provisionStateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(provisionDefinition),
      timeout: cdk.Duration.minutes(30),
    });

    // ========== Deprovision Step Function ==========
    // Loop: deprovision → wait → describe → check status
    //   - Still DELETE_IN_PROGRESS: wait + describe again
    //   - DELETE_FAILED: fail the execution
    //   - Stack gone (DescribeStacks throws): catch → post-deprovision cleanup
    const deprovisionTask = new sfnTasks.LambdaInvoke(this, 'InvokeDeprovision', {
      lambdaFunction: deprovisionFn,
      outputPath: '$.Payload',
    });
    const waitForDelete = new sfn.Wait(this, 'WaitForDelete', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });
    const postDeprovisionTask = new sfnTasks.LambdaInvoke(this, 'InvokePostDeprovision', {
      lambdaFunction: postDeprovisionFn,
      outputPath: '$.Payload',
    });
    const deleteFailed = new sfn.Fail(this, 'DeleteFailed', {
      error: 'CfnStackDeleteFailed',
      cause: 'Workspace stack delete failed',
    });
    // describeStackDel: if the stack is fully gone, DescribeStacks throws
    // CloudFormation.CloudFormationException ("... does not exist"). Catch
    // that and route to post-deprovision. Otherwise inspect the status.
    const describeStackDel = new sfnTasks.CallAwsService(this, 'DescribeStackDel', {
      service: 'cloudformation',
      action: 'describeStacks',
      parameters: { StackName: sfn.JsonPath.stringAt('$.stackName') },
      // Scope to the workspace-stack prefix rather than all stacks.
      iamResources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${namespaceNames.workspaceStackPrefix}-*/*`],
      resultPath: '$.describe',
    }).addCatch(postDeprovisionTask, {
      errors: ['CloudFormation.CloudFormationException'],
      resultPath: '$.error',
    });
    const checkDeleteStatus = new sfn.Choice(this, 'CheckDeleteStatus')
      .when(
        sfn.Condition.stringEquals('$.describe.Stacks[0].StackStatus', 'DELETE_FAILED'),
        deleteFailed
      )
      .otherwise(waitForDelete);

    const deprovisionDefinition = deprovisionTask
      .next(waitForDelete)
      .next(describeStackDel)
      .next(checkDeleteStatus);

    this.deprovisionStateMachine = new sfn.StateMachine(this, 'DeprovisionStateMachine', {
      stateMachineName: physicalNames.deprovisionStateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(deprovisionDefinition),
      timeout: cdk.Duration.minutes(30),
    });

    // ========== Workspace API Lambda (all HTTP routes via Powertools) ==========
    // Why one lambda (not one per route): the API is a small control plane
    // (7 endpoints). A single Powertools-routed lambda keeps cold starts
    // warm across routes, centralizes Pydantic validation, and reduces CDK
    // noise. If any endpoint needs stricter isolation later, it can be
    // split out without changing the route contract.
    this.workspaceApiFn = new lambda.Function(this, 'WorkspaceApiFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/workspace-api', {
        // Why bundling: workspace-api has pip dependencies (powertools, pydantic).
        // Docker bundling installs them into the asset at synth time.
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          // Force amd64 so `pip install` resolves x86_64 wheels regardless
          // of the host arch. Lambda runs x86_64; bundling on Apple Silicon
          // without this pulls aarch64 wheels (pydantic_core etc.) and the
          // function fails to import at cold start.
          platform: 'linux/amd64',
          command: [
            'bash',
            '-c',
            'pip install -r requirements.txt -t /asset-output && cp -a . /asset-output',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      // X-Ray tracing: gives us the call graph for workspace-api → DDB →
      // Step Functions on every invocation. Cost is trivial at our volume
      // (first 100k traces/month free) and the call-graph view pays for
      // itself during provisioning bug investigations.
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        WORKSPACES_TABLE: props.workspacesTable.tableName,
        MEMBERS_TABLE: props.workspaceMembersTable.tableName,
        AGENTS_TABLE: props.agentsTable.tableName,
        PROVISION_STATE_MACHINE_ARN: this.provisionStateMachine.stateMachineArn,
        DEPROVISION_STATE_MACHINE_ARN: this.deprovisionStateMachine.stateMachineArn,
        POWERTOOLS_SERVICE_NAME: 'workspace-api',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        PLATFORM_ENV: platformEnv,
        WORKSPACE_SECRETS_PREFIX: namespaceNames.secretsPrefix,
        WORKSPACE_SSM_PREFIX: namespaceNames.ssmPrefix,
        CRON_RULE_PREFIX: namespaceNames.cronRulePrefix,
        GOOGLE_OAUTH_SECRET_NAME: platformSecrets.googleOauth,
        MICROSOFT_OAUTH_SECRET_NAME: platformSecrets.microsoftOauth,
        // The OAuth redirect-URI allowlist in workspace-api/index.py
        // reads APP_URL to permit the deployed app origin's callback
        // alongside loopback. Without it the allowlist falls back to
        // loopback-only and rejects every real workspace's Connect
        // attempt with 400.
        APP_URL: `https://${props.appDomain}`,
        ...(props.llmUsageTable
          ? { LLM_USAGE_TABLE: props.llmUsageTable.tableName }
          : {}),
      },
    });
    // ReadWrite: reads for GET /workspaces/{id}; writes for
    // PUT /workspaces/{id}/browser/cookies (admin sets cookies that
    // the agent's browser sessions inject at turn start).
    props.workspacesTable.grantReadWriteData(this.workspaceApiFn);
    props.workspaceMembersTable.grantReadWriteData(this.workspaceApiFn);
    props.agentsTable.grantReadWriteData(this.workspaceApiFn);
    // Read-only: GET /workspaces/{id}/usage aggregates the usage rollups.
    props.llmUsageTable?.grantReadData(this.workspaceApiFn);
    this.provisionStateMachine.grantStartExecution(this.workspaceApiFn);
    this.deprovisionStateMachine.grantStartExecution(this.workspaceApiFn);

    // Integration endpoints need to create/update/delete per-workspace secrets.
    this.workspaceApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DeleteSecret',
          'secretsmanager:RestoreSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*`,
        ],
      })
    );
    // GET /integrations enumerates secrets under the workspace secrets
    // prefix to determine which integrations are configured. ListSecrets
    // does not support resource-level permissions, so it must be granted
    // account-wide.
    this.workspaceApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:ListSecrets'],
        resources: ['*'],
      })
    );
    // Bump the per-workspace `secrets-revision` SSM parameter on every
    // workspace-secret write so the sidecar's next 15s tick triggers a
    // full Secrets Manager sync. Also write the per-workspace `llm-provider`
    // routing config (mode/model) the sidecar vends to the sandbox. Scoped
    // narrowly to those two basenames; nothing else under the workspace's SSM
    // prefix is writable.
    this.workspaceApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${namespaceNames.ssmPrefix}/*/secrets-revision`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${namespaceNames.ssmPrefix}/*/llm-provider`,
        ],
      })
    );
    // Google + Microsoft OAuth token exchange needs the shared platform
    // client credentials.
    this.workspaceApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${platformSecrets.googleOauth}*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${platformSecrets.microsoftOauth}*`,
        ],
      })
    );

    // Cron job listing: read-only access to EventBridge rules for the UI.
    // ListTargetsByRule is needed to surface the agentId stored in the
    // target Input JSON so the Schedules UI can render the agent badge.
    this.workspaceApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:ListRules', 'events:ListTargetsByRule'],
        resources: ['*'],
      })
    );

    // ========== HTTP API with Cognito JWT authorizer ==========
    // Why HTTP API v2 (not REST API v1): cheaper, lower latency, built-in
    // JWT authorizer. We don't need v1's per-method request validators —
    // validation is done by Pydantic inside the lambda.
    this.httpApi = new apigw.HttpApi(this, 'ManagementApi', {
      apiName: physicalNames.managementApiName,
      corsPreflight: {
        // Restrict to the app's own origin (+ localhost for dev) rather
        // than '*': this is a Bearer-token API, so a wildcard let any
        // site issue authenticated XHRs from a victim who already holds a
        // token. Browsers only honor an exact-origin match here.
        allowOrigins: [
          `https://${props.appDomain}`,
          'http://localhost:5173',
          'http://localhost:3000',
        ],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    this.jwtAuthorizer = new apigwAuth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      }
    );

    this.workspaceApiIntegration = new apigwInt.HttpLambdaIntegration(
      'WorkspaceApiInt',
      this.workspaceApiFn
    );

    const addRoute = (method: apigw.HttpMethod, routePath: string) => {
      this.httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: this.workspaceApiIntegration,
        authorizer: this.jwtAuthorizer,
      });
    };

    addRoute(apigw.HttpMethod.POST, '/workspaces');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}');
    addRoute(apigw.HttpMethod.PATCH, '/workspaces/{workspaceId}');
    addRoute(apigw.HttpMethod.DELETE, '/workspaces/{workspaceId}');
    addRoute(apigw.HttpMethod.GET, '/me/workspaces');
    addRoute(apigw.HttpMethod.POST, '/workspaces/{workspaceId}/members');
    addRoute(apigw.HttpMethod.DELETE, '/workspaces/{workspaceId}/members/{userId}');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/members');
    addRoute(apigw.HttpMethod.PATCH, '/workspaces/{workspaceId}/members/me/telegram');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/integrations');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/integrations/google/auth-url');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/integrations/microsoft/auth-url');
    addRoute(apigw.HttpMethod.PUT, '/workspaces/{workspaceId}/integrations/{name}');
    addRoute(apigw.HttpMethod.DELETE, '/workspaces/{workspaceId}/integrations/{name}');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/cron/jobs');
    // Token usage read-back (Usage page in the web UI)
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/usage');
    // Browser cookies (admin-managed, injected into agent browser sessions)
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/browser/cookies');
    addRoute(apigw.HttpMethod.PUT, '/workspaces/{workspaceId}/browser/cookies');
    addRoute(apigw.HttpMethod.DELETE, '/workspaces/{workspaceId}/browser/cookies');
    // Agents (user-defined per-workspace agents — Agent Creator)
    addRoute(apigw.HttpMethod.POST, '/workspaces/{workspaceId}/agents');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/agents');
    addRoute(apigw.HttpMethod.GET, '/workspaces/{workspaceId}/agents/{agentId}');
    addRoute(apigw.HttpMethod.PATCH, '/workspaces/{workspaceId}/agents/{agentId}');
    addRoute(apigw.HttpMethod.DELETE, '/workspaces/{workspaceId}/agents/{agentId}');
    addRoute(apigw.HttpMethod.POST, '/workspaces/{workspaceId}/agents/{agentId}/deploy');

    // ========== Task cleanup via EventBridge ==========
    const taskCleanupFn = new lambda.Function(this, 'TaskCleanupFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCode('lambda/task-cleanup'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        WORKSPACES_TABLE: props.workspacesTable.tableName,
        PLATFORM_ENV: platformEnv,
        LOG_LEVEL: 'INFO',
      },
    });
    props.workspacesTable.grantReadWriteData(taskCleanupFn);

    new events.Rule(this, 'EcsTaskStateChangeRule', {
      ruleName: physicalNames.ecsTaskStateChangeRuleName,
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [{ suffix: `:cluster/${props.clusterName}` }],
        },
      },
      targets: [new eventsTargets.LambdaFunction(taskCleanupFn)],
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'ProvisionStateMachineArn', {
      value: this.provisionStateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, 'DeprovisionStateMachineArn', {
      value: this.deprovisionStateMachine.stateMachineArn,
    });
  }
}

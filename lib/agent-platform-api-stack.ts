import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwAuth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwInt from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AgentPlatformApiStackProps extends cdk.StackProps {
  workspacesTable: dynamodb.ITable;
  workspaceMembersTable: dynamodb.ITable;
  chatDirectoryTable: dynamodb.ITable;
  agentsTable: dynamodb.ITable;
  /** Per-workspace LLM usage table (read for the /llm-gateway/usage route).
   *  Optional so deployments without the LLM gateway still compose. */
  llmUsageTable?: dynamodb.ITable;
  /** Override the Lambda code asset (typically Code.fromInline for tests).
   *  Production callers leave this undefined; the stack resolves the
   *  Lambda source from this package's own `lambda/agent-platform-api/`. */
  lambdaCode?: lambda.Code;
  /** Public API name. Sourced from `cfg.infrastructureNames.agentPlatformApiName`. */
  apiName: string;
  /** Free-form deployment environment label, propagated as `PLATFORM_ENV`
   *  on the API + authorizer Lambdas. Tags every structured log record. */
  envLabel: string;
  /** Per-workspace + platform-level namespace names. Sourced from
   *  `cfg.workspaceNamespace`. */
  namespaceNames: {
    secretsPrefix: string;
    ssmPrefix: string;
    cronDestinationPrefix: string;
    cronInvokeRolePrefix: string;
    cronRulePrefix: string;
    langfusePlatformSecretName: string;
  };
}

/**
 * Agent Platform API — workspace-scoped HTTPS API the chat-server
 * (and `agent_platform_mcp`) calls on behalf of the agent. Per-workspace
 * API key (Secrets Manager) validated by a separate Lambda authorizer,
 * cached at the API Gateway layer.
 */
export class AgentPlatformApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: AgentPlatformApiStackProps) {
    super(scope, id, props);
    const namespaceNames = props.namespaceNames;
    // Core Lambda source ships inside this package at
    // `<package-root>/lambda/agent-platform-api/`. Override via
    // `props.lambdaCode` for test snapshots (Code.fromInline).
    const lambdaCodeAsset = props.lambdaCode ?? lambda.Code.fromAsset(
      path.join(__dirname, '..', '..', 'lambda', 'agent-platform-api'),
      {
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
      },
    );

    const authorizerFn = new lambda.Function(this, 'AgentPlatformAuthorizerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'authorizer.handler',
      code: lambdaCodeAsset,
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        POWERTOOLS_SERVICE_NAME: 'agent-platform-authorizer',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        PLATFORM_ENV: props.envLabel,
        WORKSPACE_SECRETS_PREFIX: namespaceNames.secretsPrefix,
      },
    });
    authorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*/agent-platform-key*`,
        ],
      }),
    );

    const apiFn = new lambda.Function(this, 'AgentPlatformApiFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambdaCodeAsset,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        WORKSPACES_TABLE: props.workspacesTable.tableName,
        MEMBERS_TABLE: props.workspaceMembersTable.tableName,
        CHAT_DIRECTORY_TABLE: props.chatDirectoryTable.tableName,
        AGENTS_TABLE: props.agentsTable.tableName,
        AWS_ACCOUNT_ID: this.account,
        POWERTOOLS_SERVICE_NAME: 'agent-platform-api',
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_LOGGER_LOG_EVENT: 'false',
        PLATFORM_ENV: props.envLabel,
        WORKSPACE_SECRETS_PREFIX: namespaceNames.secretsPrefix,
        WORKSPACE_SSM_PREFIX: namespaceNames.ssmPrefix,
        CRON_DESTINATION_PREFIX: namespaceNames.cronDestinationPrefix,
        CRON_INVOKE_ROLE_PREFIX: namespaceNames.cronInvokeRolePrefix,
        CRON_RULE_PREFIX: namespaceNames.cronRulePrefix,
        LANGFUSE_PLATFORM_SECRET: namespaceNames.langfusePlatformSecretName,
        ...(props.llmUsageTable
          ? { LLM_USAGE_TABLE: props.llmUsageTable.tableName }
          : {}),
      },
    });

    props.workspacesTable.grantReadWriteData(apiFn);
    // ReadWrite: reads for GET /usage + /llm-gateway/usage; writes for
    // POST /usage/turns (per-turn token records + USAGE# rollups + CTX#
    // snapshots — the gateway-owned MONTH#/REQ# rows are written by the
    // gateway task, not here).
    props.llmUsageTable?.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*/agent-platform-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.langfusePlatformSecretName}*`,
        ],
      }),
    );
    props.workspaceMembersTable.grantReadData(apiFn);
    props.chatDirectoryTable.grantReadWriteData(apiFn);
    props.agentsTable.grantReadWriteData(apiFn);

    // Workspace custom-secret writes (creator session). Scoped to
    // custom-* suffix so the Lambda can't touch typed-integration
    // secrets at the same workspace path. No GetSecretValue.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DeleteSecret',
          'secretsmanager:RestoreSecret',
          'secretsmanager:UpdateSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${namespaceNames.secretsPrefix}/*/custom-*`,
        ],
      }),
    );

    // Bump the per-workspace `secrets-revision` SSM parameter on every
    // custom-secret create/delete so the sidecar's cheap-probe loop
    // pulls the new value within ~5s instead of waiting for the 15-min
    // backstop. Mirrors the grant on the Management API stack
    // (lib/management-api-stack.ts) for the typed-integration path.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${namespaceNames.ssmPrefix}/*/secrets-revision`,
        ],
      }),
    );

    // AgentCore Browser session lifecycle.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:StartBrowserSession',
          'bedrock-agentcore:StopBrowserSession',
          'bedrock-agentcore:GetBrowserSession',
          'bedrock-agentcore:ListBrowserSessions',
          'bedrock-agentcore:ConnectBrowserAutomationStream',
          'bedrock-agentcore:ConnectBrowserLiveViewStream',
          'bedrock-agentcore:SaveBrowserSessionProfile',
        ],
        resources: ['*'],
      })
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateBrowserProfile',
          'bedrock-agentcore:ListBrowserProfiles',
          'bedrock-agentcore:GetBrowserProfile',
        ],
        resources: ['*'],
      })
    );

    // EventBridge rule management for cron CRUD.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'events:PutRule',
          'events:PutTargets',
          'events:DeleteRule',
          'events:RemoveTargets',
          'events:DescribeRule',
          'events:ListTargetsByRule',
        ],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:rule/${namespaceNames.cronRulePrefix}--*`,
        ],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:DescribeApiDestination'],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:api-destination/${namespaceNames.cronDestinationPrefix}-*`,
        ],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:ListRules'],
        resources: ['*'],
      }),
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${this.account}:role/${namespaceNames.cronInvokeRolePrefix}-*`],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'events.amazonaws.com' },
        },
      }),
    );

    const httpApi = new apigw.HttpApi(this, 'AgentPlatformApi', {
      apiName: props.apiName,
    });

    const authorizer = new apigwAuth.HttpLambdaAuthorizer(
      'AgentPlatformAuthorizer',
      authorizerFn,
      {
        responseTypes: [apigwAuth.HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.Authorization'],
        resultsCacheTtl: cdk.Duration.minutes(5),
      },
    );

    const integration = new apigwInt.HttpLambdaIntegration(
      'AgentPlatformInt',
      apiFn,
    );

    const addRoute = (method: apigw.HttpMethod, routePath: string) => {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration,
        authorizer,
      });
    };

    addRoute(apigw.HttpMethod.GET, '/workspace');
    addRoute(apigw.HttpMethod.GET, '/llm-gateway/usage');
    // Unified token usage (chat-server writes per turn, reads tallies).
    addRoute(apigw.HttpMethod.POST, '/usage/turns');
    addRoute(apigw.HttpMethod.GET, '/usage');
    addRoute(apigw.HttpMethod.GET, '/usage/turns');
    addRoute(apigw.HttpMethod.GET, '/usage/session');
    addRoute(apigw.HttpMethod.GET, '/members');
    addRoute(apigw.HttpMethod.GET, '/cron/jobs');
    addRoute(apigw.HttpMethod.POST, '/cron/jobs');
    addRoute(apigw.HttpMethod.DELETE, '/cron/jobs/{jobName}');
    addRoute(apigw.HttpMethod.GET, '/chats');
    addRoute(apigw.HttpMethod.GET, '/people');
    addRoute(apigw.HttpMethod.POST, '/chat-directory/observations');
    addRoute(apigw.HttpMethod.GET, '/workspace/agents');
    addRoute(apigw.HttpMethod.PUT, '/agents/{agentId}/metadata');
    addRoute(apigw.HttpMethod.POST, '/agents/{agentId}/status');
    addRoute(apigw.HttpMethod.POST, '/workspace/custom-secrets');
    addRoute(apigw.HttpMethod.DELETE, '/workspace/custom-secrets/{name}');
    addRoute(apigw.HttpMethod.POST, '/browser/sessions');
    addRoute(apigw.HttpMethod.GET, '/browser/sessions/current');
    addRoute(apigw.HttpMethod.DELETE, '/browser/sessions/{sessionId}');
    addRoute(apigw.HttpMethod.GET, '/browser/cookies');
    addRoute(apigw.HttpMethod.POST, '/browser/sessions/{sessionId}/save-profile');

    // Langfuse proxy — no Bearer authorizer (handler does inline Basic-auth validation).
    httpApi.addRoutes({
      path: '/langfuse/api/public/ingestion',
      methods: [apigw.HttpMethod.POST],
      integration,
    });

    this.apiUrl = httpApi.apiEndpoint;
    new cdk.CfnOutput(this, 'AgentPlatformApiUrl', { value: httpApi.apiEndpoint });
  }
}

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  /** Free-form deployment environment label (e.g. `'prod'`, `'beta'`,
   *  `'staging'`). Forwarded as `PLATFORM_ENV` to the pre-sign-up Lambda
   *  trigger when one is wired via `preSignUpLambdaCode`; consumers that
   *  don't supply that trigger can pass any string. */
  envLabel: string;
  /** Web app domain. Drives Cognito callback + logout URLs. */
  appDomain: string;
  /** Globally-unique Cognito hosted-UI domain prefix. */
  cognitoDomainPrefix: string;
  /** Platform-level secret names. `googleOauth` holds the OAuth client
   *  credentials (client_id + client_secret JSON) for federated Google
   *  sign-in. */
  platformSecrets: {
    googleOauth: string;
  };
  /** User pool + client physical names. */
  userPoolName: string;
  userPoolClientName: string;
  /** Optional code asset for a Cognito Pre-Sign-up Lambda trigger.
   *  When provided, the stack creates the Lambda and wires it as the
   *  user pool's preSignUp trigger. Used by overlays to enforce
   *  a closed-beta allowlist on federated sign-ins. Self-hosted
   *  operators omit this and get the standard open pool. */
  preSignUpLambdaCode?: lambda.Code;
  /** Construct ID for the Cognito hosted-UI domain. Defaults to the
   *  neutral `'UserPoolDomain'`. Existing deployments override this to
   *  pin the CFN logical ID and avoid an in-place rename — renaming the
   *  construct ID forces CFN to CREATE the new domain before DELETING
   *  the old one, which fails since Cognito doesn't permit two domains
   *  with the same prefix on the same user pool. Fresh deploys can
   *  leave it as default. */
  cognitoDomainConstructId?: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    let preSignUpFn: lambda.Function | undefined;
    if (props.preSignUpLambdaCode) {
      preSignUpFn = new lambda.Function(this, 'AuthPreSignUpFn', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        code: props.preSignUpLambdaCode,
        // Cognito waits synchronously for this Lambda; 5s is the
        // Cognito-imposed maximum.
        timeout: cdk.Duration.seconds(5),
        memorySize: 256,
        environment: {
          PLATFORM_ENV: props.envLabel,
          LOG_LEVEL: 'INFO',
        },
      });
    }

    this.userPool = new cognito.UserPool(this, 'SandboxUserPool', {
      userPoolName: props.userPoolName,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lambdaTriggers: preSignUpFn ? { preSignUp: preSignUpFn } : undefined,
    });

    // Why a standalone iam.Policy (not addToRolePolicy): inlining the
    // policy on the role creates a CFN dependency cycle —
    //   role <- lambda <- userPool (via trigger) <- role (via policy ref)
    // A separate AWS::IAM::Policy resource breaks the cycle.
    if (preSignUpFn && preSignUpFn.role) {
      new iam.Policy(this, 'AuthPreSignUpListUsersPolicy', {
        roles: [preSignUpFn.role],
        statements: [
          new iam.PolicyStatement({
            actions: ['cognito-idp:ListUsers'],
            resources: [this.userPool.userPoolArn],
          }),
        ],
      });
    }

    // Google identity provider — uses the platform-level OAuth client
    // (one Google Cloud Console app per deployment).
    const googleClientSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleClientSecret',
      props.platformSecrets.googleOauth,
    );
    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleProvider', {
      userPool: this.userPool,
      clientId: googleClientSecret.secretValueFromJson('client_id').unsafeUnwrap(),
      clientSecretValue: googleClientSecret.secretValueFromJson('client_secret'),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    // localhost callback/logout URLs are dev-only. Registering them on the
    // prod client lets an obtained auth code be redirected to a listener on
    // a victim's machine (aids code-interception / phishing), so ship prod
    // with only the real app-domain URLs.
    const isProd = props.envLabel === 'prod';
    const devCallbacks = isProd
      ? []
      : ['http://localhost:3000/callback', 'http://localhost:5173/callback'];
    const devLogouts = isProd
      ? []
      : ['http://localhost:3000/logout', 'http://localhost:5173/login'];

    this.userPoolClient = this.userPool.addClient('SandboxAppClient', {
      userPoolClientName: props.userPoolClientName,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
        adminUserPassword: true,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        // Authorization Code + PKCE only. Implicit grant is deprecated
        // (removed in OAuth 2.1): it returns tokens in the URL fragment,
        // which leak via browser history / Referer / proxy logs and have
        // no PKCE protection. The SPA uses response_type=code with PKCE
        // S256 (web/src/auth/cognito.ts), so implicit was unused attack
        // surface.
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [...devCallbacks, `https://${props.appDomain}/callback`],
        logoutUrls: [...devLogouts, `https://${props.appDomain}/login`],
      },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });
    this.userPoolClient.node.addDependency(googleProvider);

    this.userPoolDomain = this.userPool.addDomain(
      props.cognitoDomainConstructId ?? 'UserPoolDomain',
      { cognitoDomain: { domainPrefix: props.cognitoDomainPrefix } },
    );

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `https://${this.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
    new cdk.CfnOutput(this, 'JwksUrl', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json`,
    });
  }
}

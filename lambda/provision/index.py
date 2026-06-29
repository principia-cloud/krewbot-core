"""
Provisioning Lambda — invoked by the provision Step Function.

Steps:
  1. Fix uid/gid = 1000 (all workspaces share one; isolation comes from the
     EFS access point chroot, not from POSIX).
  2. Put workspace row in DynamoDB with status=PROVISIONING
  3. Add the creating user as the workspace admin in the members table
  4. Create the per-workspace agent secrets + SSM params under
     {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/ and {WORKSPACE_SSM_PREFIX}/
     {workspaceId}/. Absent inputs are skipped silently so
     partially-configured workspaces still provision — the sidecar's
     discovery loop picks up anything added later.
  5. CreateStack with the workspace template + CFN parameters

Step Functions waits for CFN via its poll-describe loop, then the
post-provision Lambda marks the workspace as RUNNING.
"""

import hashlib
import os
import re
import secrets as secrets_lib
import boto3
from botocore.exceptions import ClientError
from datetime import datetime, timezone

from platform_log import init_logger, log_catch

logger = init_logger("provision")

# Langfuse is intentionally NOT auto-provisioned per workspace. The
# Organization API (the one that can POST /api/public/projects) is a
# Langfuse Enterprise feature; on the Hobby tier it isn't callable.
# Instead, every workspace funnels its traces through the proxy route
# on the Agent Platform API using the SAME per-workspace agent-platform
# key already vended, and all traces land in a single shared platform
# Langfuse project. The platform Langfuse credentials live at the
# secret name configured by LANGFUSE_PLATFORM_SECRET on the Agent
# Platform API Lambda; only that Lambda reads them.

ddb = boto3.resource("dynamodb")
cfn = boto3.client("cloudformation")
secrets = boto3.client("secretsmanager")
ssm = boto3.client("ssm")

workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])
members_table = ddb.Table(os.environ["MEMBERS_TABLE"])

WORKSPACE_TEMPLATE_URL = os.environ["WORKSPACE_TEMPLATE_URL"]
FILE_SYSTEM_ID = os.environ["FILE_SYSTEM_ID"]
CLUSTER_NAME = os.environ["CLUSTER_NAME"]
VPC_ID = os.environ["VPC_ID"]
SUBNET_ID = os.environ["SUBNET_ID"]
SIDECAR_SG_ID = os.environ["SIDECAR_SG_ID"]
AGENT_REPO_ARN = os.environ["AGENT_REPO_ARN"]
SIDECAR_REPO_ARN = os.environ["SIDECAR_REPO_ARN"]
JWKS_URL = os.environ["JWKS_URL"]
ALB_LISTENER_ARN = os.environ["ALB_LISTENER_ARN"]
DOMAIN_NAME = os.environ["DOMAIN_NAME"]
COGNITO_USER_POOL_ID = os.environ["COGNITO_USER_POOL_ID"]
COGNITO_CLIENT_ID = os.environ["COGNITO_CLIENT_ID"]
AGENT_PLATFORM_API_URL = os.environ["AGENT_PLATFORM_API_URL"]
# Optional: only set once the LLM gateway is deployed. Empty → gateway-mode
# workspaces fail fast with a clear admin message; default workspaces unaffected.
LLM_GATEWAY_URL = os.environ.get("LLM_GATEWAY_URL", "")
APP_URL = os.environ["APP_URL"]
AGENT_NAME = os.environ["AGENT_NAME"]
PLATFORM_ENV = os.environ["PLATFORM_ENV"]
PLATFORM_CONFIG_SSM_NAME = os.environ["PLATFORM_CONFIG_SSM_NAME"]
WORKSPACE_SECRETS_PREFIX = os.environ["WORKSPACE_SECRETS_PREFIX"].strip("/")
WORKSPACE_SSM_PREFIX = "/" + os.environ["WORKSPACE_SSM_PREFIX"].strip("/")
WORKSPACE_STACK_PREFIX = os.environ["WORKSPACE_STACK_PREFIX"]
MANAGED_BY_TAG = os.environ["MANAGED_BY_TAG"]
# CloudFormation service role. CFN assumes this to create the workspace
# stack's resources, so this Lambda's own role doesn't need the broad
# resource-CRUD permissions (see lib/management-api-stack.ts).
WORKSPACE_CFN_EXEC_ROLE_ARN = os.environ["WORKSPACE_CFN_EXEC_ROLE_ARN"]

WORKSPACE_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _put_secret(name: str, value: str) -> None:
    """Create or overwrite a Secrets Manager secret.

    Idempotent: if the secret already exists (idempotent re-provision), we
    PutSecretValue onto the existing one instead of failing.
    """
    try:
        secrets.create_secret(Name=name, SecretString=value)
        logger.info(
            "secret created",
            extra={"event": "provision.secret.created", "secretName": name},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceExistsException":
            secrets.put_secret_value(SecretId=name, SecretString=value)
            logger.info(
                "secret updated",
                extra={"event": "provision.secret.updated", "secretName": name},
            )
        else:
            log_catch(
                logger,
                "provision.secret.create_failed",
                e,
                secretName=name,
            )
            raise


def _put_ssm(name: str, value: str) -> None:
    """Create or overwrite an SSM String parameter."""
    ssm.put_parameter(Name=name, Value=value, Type="String", Overwrite=True)
    logger.info(
        "ssm param put",
        extra={"event": "provision.ssm.put", "paramName": name},
    )


def _provision_agent_platform_key(workspace_id: str) -> None:
    """Generate the per-workspace API key for the Agent Platform API.

    Format: `wsk_{workspaceId}_{32-byte-hex}`. The workspaceId prefix lets
    the API Lambda parse the key and look up the matching secret without
    needing a separate index table. Idempotent on re-provision: if the
    secret already exists we leave it alone (the sidecar may already be
    serving the existing value to chat-server, and rotating mid-flight
    would lock chat-server out until the next sync tick).
    """
    name = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/agent-platform-key"
    try:
        secrets.describe_secret(SecretId=name)
        logger.info(
            "agent-platform-key already exists, leaving in place",
            extra={
                "event": "provision.platform_key.already_exists",
                "workspaceId": workspace_id,
            },
        )
        return
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceNotFoundException":
            log_catch(
                logger,
                "provision.platform_key.describe_failed",
                e,
                workspaceId=workspace_id,
            )
            raise
    value = f"wsk_{workspace_id}_{secrets_lib.token_hex(32)}"
    secrets.create_secret(
        Name=name,
        SecretString=value,
        Description=f"Agent Platform API key for workspace {workspace_id}",
    )
    logger.info(
        "agent-platform-key created",
        extra={
            "event": "provision.platform_key.created",
            "workspaceId": workspace_id,
        },
    )


def _seed_agent_config(workspace_id: str, event: dict) -> None:
    """Create per-workspace agent secrets + SSM params from the request body.

    All inputs are optional at v1 (a workspace can be provisioned without an
    agent and have tokens added later via AWS console / CLI), so missing
    fields are skipped silently. The sidecar's discovery loop picks up any
    entry added to the prefix on its next tick, so order doesn't matter.
    """
    secret_prefix = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}"
    ssm_prefix = f"{WORKSPACE_SSM_PREFIX}/{workspace_id}"

    claude_token = event.get("claudeToken")
    if claude_token:
        _put_secret(f"{secret_prefix}/claude-token", claude_token)

    telegram_bot_token = event.get("telegramBotToken")
    if telegram_bot_token:
        _put_secret(f"{secret_prefix}/telegram-bot-token", telegram_bot_token)

    # Optional integration tokens — sidecar auto-discovers these on next tick.
    notion_token = event.get("notionToken")
    if notion_token:
        _put_secret(f"{secret_prefix}/notion-token", notion_token)

    google_account_token = event.get("googleAccountToken")
    if google_account_token:
        _put_secret(f"{secret_prefix}/google-account-token", google_account_token)

    # Messaging platform credentials — stored as individual secrets per field.
    if event.get("slackBotToken"):
        _put_secret(f"{secret_prefix}/slack-bot-token", event["slackBotToken"])
    if event.get("slackSigningSecret"):
        _put_secret(f"{secret_prefix}/slack-signing-secret", event["slackSigningSecret"])
    if event.get("whatsappApiToken"):
        _put_secret(f"{secret_prefix}/whatsapp-access-token", event["whatsappApiToken"])
    if event.get("whatsappPhoneNumberId"):
        _put_secret(f"{secret_prefix}/whatsapp-phone-number-id", event["whatsappPhoneNumberId"])
    if event.get("whatsappAppSecret"):
        _put_secret(f"{secret_prefix}/whatsapp-app-secret", event["whatsappAppSecret"])
    if event.get("teamsAppId"):
        _put_secret(f"{secret_prefix}/teams-app-id", event["teamsAppId"])
    if event.get("teamsAppPassword"):
        _put_secret(f"{secret_prefix}/teams-app-password", event["teamsAppPassword"])

    # admin/member telegram IDs are stored as telegramUserId on each
    # member row in the workspace-members DDB table (not SSM).


def handler(event, context):
    workspace_id = event["workspaceId"]
    admin_user_id = event["adminUserId"]
    workspace_name = event.get("workspaceName", workspace_id)

    logger.info(
        "provisioning workspace",
        extra={
            "event": "provision.start",
            "workspaceId": workspace_id,
            "adminUserId": admin_user_id,
            "workspaceName": workspace_name,
        },
    )

    # Validate workspaceId matches the pattern allowed by the CFN template.
    # Why here (not just in CFN): workspaceId is interpolated into a stack
    # name BEFORE CFN validates parameters. Bad input would surface as a
    # confusing CFN error instead of a clear 400.
    if not WORKSPACE_ID_PATTERN.match(workspace_id):
        raise ValueError("Invalid workspaceId: must match ^[a-zA-Z0-9_-]{1,64}$")

    # Step 1: fixed uid/gid for all workspaces.
    #
    # All workspace containers and EFS access points use uid/gid 1000.
    # Isolation between workspaces is enforced by the EFS access point
    # rootDirectory chroot — each access point is locked to its own
    # /workspaces/{workspaceId}/ subtree and cannot see any other. POSIX
    # uid separation on top of that chroot would be pure defense-in-depth
    # and is not worth the operational complexity of per-workspace uid
    # allocation, since re-provisioning the same workspaceId with a new
    # uid would orphan the on-disk directory ownership.
    uid_gid = 1000

    # Derive a deterministic ALB listener rule priority (1..50000) from the
    # workspaceId. Same workspace always gets the same priority, so re-
    # provisioning is idempotent. Collisions would conflict at the ALB (two
    # rules can't share a priority on the same listener); for realistic
    # workspace counts (<1000) the birthday collision probability is low,
    # and a collision just means provisioning fails loudly, at which point
    # we'd pick a different workspaceId. Range 1000+ leaves the 1-999 band
    # free for hand-managed rules.
    h = int(hashlib.md5(workspace_id.encode()).hexdigest(), 16)
    listener_rule_priority = 1000 + (h % 49000)

    now = datetime.now(timezone.utc).isoformat()

    # Step 2: patch uidGid + ensure status=PROVISIONING on the workspace row.
    # The row itself is written upstream by workspace-api's create_workspace
    # in pending_payment state; the Stripe webhook flips it to PROVISIONING
    # before invoking this Step Function. We just need to stamp uidGid now
    # that this Lambda has picked it. update_item (not put_item) so we
    # don't clobber any composition-hook-supplied fields (e.g.
    # pendingConfig, or overlay-side billing identifiers) that upstream
    # writers set on the row.
    workspaces_table.update_item(
        Key={"workspaceId": workspace_id},
        UpdateExpression="SET uidGid = :u, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":u": uid_gid, ":s": "PROVISIONING"},
    )

    # Step 3: link the caller's Telegram id onto the existing admin member
    # row if the wizard collected one. The row itself was created by
    # workspace-api at POST /workspaces time.
    admin_tg_id = event.get("adminTelegramId")
    if admin_tg_id:
        members_table.update_item(
            Key={"workspaceId": workspace_id, "userId": admin_user_id},
            UpdateExpression="SET telegramUserId = :t",
            ExpressionAttributeValues={":t": str(admin_tg_id)},
        )

    # Step 4a: provision the per-workspace Agent Platform API key. The
    # sidecar's discovery loop will pick this up and write it to
    # /config/secrets/agent-platform-key for the chat-server + MCPs.
    _provision_agent_platform_key(workspace_id)

    # Step 4b: seed agent config (secrets + SSM) before the stack comes up.
    # The sidecar discovery loop picks these up on its next tick once the
    # stack's sidecar service is running. Failures here are fatal — if the
    # caller specified agent config and we can't persist it, the workspace
    # is in an inconsistent state and provisioning should surface the error.
    _seed_agent_config(workspace_id, event)

    # Step 5: create the CFN stack.
    stack_name = f"{WORKSPACE_STACK_PREFIX}-{workspace_id}"
    create_result = cfn.create_stack(
        StackName=stack_name,
        TemplateURL=WORKSPACE_TEMPLATE_URL,
        Parameters=[
            {"ParameterKey": "WorkspaceId", "ParameterValue": workspace_id},
            {"ParameterKey": "UidGid", "ParameterValue": str(uid_gid)},
            {"ParameterKey": "FileSystemId", "ParameterValue": FILE_SYSTEM_ID},
            {"ParameterKey": "ClusterName", "ParameterValue": CLUSTER_NAME},
            {"ParameterKey": "VpcId", "ParameterValue": VPC_ID},
            {"ParameterKey": "SubnetId", "ParameterValue": SUBNET_ID},
            {"ParameterKey": "SidecarSgId", "ParameterValue": SIDECAR_SG_ID},
            {"ParameterKey": "AgentRepoArn", "ParameterValue": AGENT_REPO_ARN},
            {"ParameterKey": "SidecarRepoArn", "ParameterValue": SIDECAR_REPO_ARN},
            {"ParameterKey": "JwksUrl", "ParameterValue": JWKS_URL},
            {"ParameterKey": "AlbListenerArn", "ParameterValue": ALB_LISTENER_ARN},
            {"ParameterKey": "ListenerRulePriority", "ParameterValue": str(listener_rule_priority)},
            {"ParameterKey": "DomainName", "ParameterValue": DOMAIN_NAME},
            {"ParameterKey": "CognitoUserPoolId", "ParameterValue": COGNITO_USER_POOL_ID},
            {"ParameterKey": "CognitoClientId", "ParameterValue": COGNITO_CLIENT_ID},
            {"ParameterKey": "AgentPlatformApiUrl", "ParameterValue": AGENT_PLATFORM_API_URL},
            {"ParameterKey": "LlmGatewayUrl", "ParameterValue": LLM_GATEWAY_URL},
            {"ParameterKey": "AppUrl", "ParameterValue": APP_URL},
            {"ParameterKey": "AgentName", "ParameterValue": AGENT_NAME},
            {"ParameterKey": "PlatformEnv", "ParameterValue": PLATFORM_ENV},
            {"ParameterKey": "PlatformConfigSsmName", "ParameterValue": PLATFORM_CONFIG_SSM_NAME},
        ],
        # Why CAPABILITY_NAMED_IAM: the workspace stack creates IAM roles
        # with explicit names (e.g. the cron-invoke role named with the
        # operator's configured prefix). CFN requires the NAMED_IAM
        # capability any time a template assigns explicit role/policy
        # names, because you're taking responsibility for avoiding name
        # collisions across stacks.
        Capabilities=["CAPABILITY_NAMED_IAM"],
        # CFN creates/owns the stack's resources as this service role, not
        # as the Lambda's identity (which now holds only cfn + PassRole +
        # narrow direct grants).
        RoleARN=WORKSPACE_CFN_EXEC_ROLE_ARN,
        Tags=[
            {"Key": "WorkspaceId", "Value": workspace_id},
            {"Key": "ManagedBy", "Value": MANAGED_BY_TAG},
        ],
    )

    logger.info(
        "cfn stack create submitted",
        extra={
            "event": "provision.stack_created",
            "workspaceId": workspace_id,
            "stackName": stack_name,
            "stackId": create_result["StackId"],
        },
    )
    return {
        "workspaceId": workspace_id,
        "stackName": stack_name,
        "uidGid": uid_gid,
        "cfnStackId": create_result["StackId"],
    }

"""
Deprovisioning Lambda — invoked by the deprovision Step Function.

Marks the workspace as DELETING, tears down per-workspace agent secrets/SSM
params created by the provision Lambda, and initiates CFN stack deletion.
Step Functions waits for CFN to finish via its poll-describe loop, then
calls post-deprovision to clean up DynamoDB rows.
"""

import os
import boto3
from botocore.exceptions import ClientError
from datetime import datetime, timezone

from platform_log import init_logger, log_catch

logger = init_logger("deprovision")

# Note: we deliberately do NOT delete the workspace's Langfuse project
# on deprovision. Deleting a Langfuse project hard-deletes every trace
# in it — no recovery. Since Langfuse Cloud has unlimited projects on
# every tier, orphan projects cost nothing and the trace history stays
# available for post-mortems. Any per-workspace `langfuse-keys` secret
# under {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/* is still cleaned up
# by the generic _delete_workspace_secrets sweep below, so the project
# is simply orphaned (no one holds the keys anymore).

ddb = boto3.resource("dynamodb")
cfn = boto3.client("cloudformation")
secrets = boto3.client("secretsmanager")
ssm = boto3.client("ssm")
events = boto3.client("events")

workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])
WORKSPACE_SECRETS_PREFIX = os.environ["WORKSPACE_SECRETS_PREFIX"].strip("/")
WORKSPACE_SSM_PREFIX = "/" + os.environ["WORKSPACE_SSM_PREFIX"].strip("/")
CRON_RULE_PREFIX = os.environ["CRON_RULE_PREFIX"]
WORKSPACE_STACK_PREFIX = os.environ["WORKSPACE_STACK_PREFIX"]
# CFN assumes this service role to delete the workspace stack's resources,
# so this Lambda's role doesn't need broad delete perms (see
# lib/management-api-stack.ts).
WORKSPACE_CFN_EXEC_ROLE_ARN = os.environ["WORKSPACE_CFN_EXEC_ROLE_ARN"]


# Suffixes of secrets owned by the per-workspace CFN stack. We must NOT
# delete these out-of-band — CFN's stack delete reads them while tearing
# down dependent resources (e.g. the EventBridge Connection's apiKeyValue
# is a `{{resolve:secretsmanager:...}}` dynamic reference to
# cron-trigger-key, and AWS Events fails the API destination + connection
# delete when the dynamic reference can't resolve). CFN destroys these
# itself when the stack is deleted (RemovalPolicy.DESTROY in workspace-stack.ts).
_CFN_MANAGED_SECRET_SUFFIXES = ("cron-trigger-key",)


def _delete_workspace_secrets(workspace_id: str) -> None:
    """Delete agent-config secrets under {WORKSPACE_SECRETS_PREFIX}/{workspaceId}/*.

    Symmetrical with the discovery approach on the provision/sidecar side:
    we don't hardcode a list of which secrets to delete — we enumerate
    whatever is actually there. Future per-workspace secrets are cleaned
    up automatically.

    Skips CFN-managed secrets (see _CFN_MANAGED_SECRET_SUFFIXES) — those
    are owned by the per-workspace stack and CFN destroys them itself.

    Uses ForceDeleteWithoutRecovery so the secret name is immediately
    reusable (no 7-30 day recovery window blocking the next provision of
    the same workspaceId).
    """
    prefix = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/"
    paginator = secrets.get_paginator("list_secrets")
    deleted = 0
    skipped = 0
    for page in paginator.paginate(Filters=[{"Key": "name", "Values": [prefix]}]):
        for s in page.get("SecretList", []):
            name = s.get("Name", "")
            if not name.startswith(prefix):
                # Defense in depth: list-secrets filters are prefix matches
                # and could theoretically return overlapping names. Never
                # delete anything that doesn't strictly match our prefix.
                continue
            suffix = name[len(prefix):]
            if suffix in _CFN_MANAGED_SECRET_SUFFIXES:
                logger.info(
                    "skipping cfn-managed secret",
                    extra={
                        "event": "deprovision.secret.skipped_cfn",
                        "workspaceId": workspace_id,
                        "secretName": name,
                    },
                )
                skipped += 1
                continue
            try:
                secrets.delete_secret(SecretId=name, ForceDeleteWithoutRecovery=True)
                logger.info(
                    "secret deleted",
                    extra={
                        "event": "deprovision.secret.deleted",
                        "workspaceId": workspace_id,
                        "secretName": name,
                    },
                )
                deleted += 1
            except ClientError as e:
                log_catch(
                    logger,
                    "deprovision.secret.delete_failed",
                    e,
                    workspaceId=workspace_id,
                    secretName=name,
                )
    logger.info(
        "secret deletion summary",
        extra={
            "event": "deprovision.secrets.summary",
            "workspaceId": workspace_id,
            "deleted": deleted,
            "skipped": skipped,
            "prefix": prefix,
        },
    )


def _delete_workspace_ssm(workspace_id: str) -> None:
    """Delete every SSM parameter under {WORKSPACE_SSM_PREFIX}/{workspaceId}/*."""
    prefix = f"{WORKSPACE_SSM_PREFIX}/{workspace_id}/"
    paginator = ssm.get_paginator("get_parameters_by_path")
    names = []
    for page in paginator.paginate(Path=prefix, Recursive=True):
        for p in page.get("Parameters", []):
            pname = p.get("Name", "")
            if pname.startswith(prefix):
                names.append(pname)
    # delete_parameters accepts up to 10 at a time.
    while names:
        batch, names = names[:10], names[10:]
        try:
            ssm.delete_parameters(Names=batch)
            for n in batch:
                logger.info(
                    "ssm param deleted",
                    extra={
                        "event": "deprovision.ssm.deleted",
                        "workspaceId": workspace_id,
                        "paramName": n,
                    },
                )
        except ClientError as e:
            log_catch(
                logger,
                "deprovision.ssm.delete_failed",
                e,
                workspaceId=workspace_id,
                batch=batch,
            )


def _delete_cron_rules(workspace_id: str) -> None:
    """Delete all EventBridge cron rules for this workspace.

    Rules are named {CRON_RULE_PREFIX}--{workspaceId}--{jobName}. We
    enumerate by prefix and tear down targets + rule for each.
    """
    prefix = f"{CRON_RULE_PREFIX}--{workspace_id}--"
    deleted = 0
    try:
        resp = events.list_rules(NamePrefix=prefix)
        for rule in resp.get("Rules", []):
            name = rule["Name"]
            if not name.startswith(prefix):
                continue
            try:
                # Must remove targets before deleting the rule
                targets = events.list_targets_by_rule(Rule=name)
                target_ids = [t["Id"] for t in targets.get("Targets", [])]
                if target_ids:
                    events.remove_targets(Rule=name, Ids=target_ids)
                events.delete_rule(Name=name)
                logger.info(
                    "cron rule deleted",
                    extra={
                        "event": "deprovision.cron.deleted",
                        "workspaceId": workspace_id,
                        "ruleName": name,
                    },
                )
                deleted += 1
            except ClientError as e:
                log_catch(
                    logger,
                    "deprovision.cron.delete_failed",
                    e,
                    workspaceId=workspace_id,
                    ruleName=name,
                )
    except ClientError as e:
        log_catch(
            logger,
            "deprovision.cron.list_failed",
            e,
            workspaceId=workspace_id,
        )
    logger.info(
        "cron deletion summary",
        extra={
            "event": "deprovision.cron.summary",
            "workspaceId": workspace_id,
            "deleted": deleted,
            "prefix": prefix,
        },
    )


def handler(event, context):
    workspace_id = event["workspaceId"]
    stack_name = f"{WORKSPACE_STACK_PREFIX}-{workspace_id}"

    logger.info(
        "deprovisioning workspace",
        extra={
            "event": "deprovision.start",
            "workspaceId": workspace_id,
            "stackName": stack_name,
        },
    )

    workspaces_table.update_item(
        Key={"workspaceId": workspace_id},
        UpdateExpression="SET #s = :status, updatedAt = :ts",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":status": "DELETING",
            ":ts": datetime.now(timezone.utc).isoformat(),
        },
        # Why this condition: protects against double-delete and against
        # deleting a workspace row that was never successfully provisioned.
        ConditionExpression="attribute_exists(workspaceId)",
    )

    _delete_cron_rules(workspace_id)

    # Tear down per-workspace agent config BEFORE deleting the CFN stack so
    # that a stuck stack deletion doesn't leave orphaned secrets behind.
    # These are additive to whatever the CFN stack itself destroys
    # (origin-verify secret, etc.).
    _delete_workspace_secrets(workspace_id)
    _delete_workspace_ssm(workspace_id)

    cfn.delete_stack(StackName=stack_name, RoleARN=WORKSPACE_CFN_EXEC_ROLE_ARN)
    logger.info(
        "cfn stack delete initiated",
        extra={
            "event": "deprovision.stack_delete_initiated",
            "workspaceId": workspace_id,
            "stackName": stack_name,
        },
    )
    return {"workspaceId": workspace_id, "stackName": stack_name}

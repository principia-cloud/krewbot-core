"""
Task cleanup Lambda — subscribed to ECS task state-change EventBridge events.

When a workspace sandbox task transitions, update the workspace row's status
so Lambda@Edge can respond accordingly (503 during RECOVERING).

Event source: aws.ecs / ECS Task State Change
"""

import os
import re
import boto3
from datetime import datetime, timezone
from botocore.exceptions import ClientError

from platform_log import init_logger, log_catch

logger = init_logger("task-cleanup")

ddb = boto3.resource("dynamodb")
workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])

# Why only sandbox (not sidecar): routing targets the sandbox HTTP server.
# Sidecar state is operationally interesting but doesn't affect user traffic.
SANDBOX_FAMILY_PATTERN = re.compile(r"^sandbox-([a-zA-Z0-9_-]+)$")


def handler(event, context):
    detail = event.get("detail", {})
    task_definition_arn = detail.get("taskDefinitionArn", "")
    last_status = detail.get("lastStatus", "")
    desired_status = detail.get("desiredStatus", "")

    # taskDefinitionArn format: arn:...:task-definition/sandbox-{id}:revision
    family = task_definition_arn.split("/")[-1].split(":")[0]
    match = SANDBOX_FAMILY_PATTERN.match(family)
    if not match:
        return {"skipped": True, "reason": f"Not a workspace sandbox: {family}"}

    workspace_id = match.group(1)
    logger.info(
        "task state change",
        extra={
            "event": "task_cleanup.state_change",
            "workspaceId": workspace_id,
            "lastStatus": last_status,
            "desiredStatus": desired_status,
        },
    )

    if last_status == "RUNNING" and desired_status == "RUNNING":
        new_status = "RUNNING"
    elif last_status == "STOPPED" and desired_status == "RUNNING":
        new_status = "RECOVERING"
    else:
        return {"skipped": True, "reason": f"unhandled {last_status}/{desired_status}"}

    # Why ConditionExpression: don't overwrite DELETING or PROVISIONING states
    # — those are managed by the provision/deprovision Step Functions.
    try:
        workspaces_table.update_item(
            Key={"workspaceId": workspace_id},
            UpdateExpression="SET #s = :new, updatedAt = :ts",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":new": new_status,
                ":ts": datetime.now(timezone.utc).isoformat(),
                ":running": "RUNNING",
                ":recovering": "RECOVERING",
            },
            ConditionExpression="#s IN (:running, :recovering)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info(
                "workspace in terminal state, skipping",
                extra={
                    "event": "task_cleanup.skipped_terminal",
                    "workspaceId": workspace_id,
                    "expected": True,
                },
            )
        else:
            # Re-raise after logging — DynamoDB errors beyond the expected
            # condition-failure are worth escalating to Step Functions.
            log_catch(
                logger,
                "task_cleanup.update_failed",
                e,
                workspaceId=workspace_id,
                newStatus=new_status,
            )
            raise

    return {"workspaceId": workspace_id, "newStatus": new_status}

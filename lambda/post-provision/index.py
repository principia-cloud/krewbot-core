"""
Post-provision Lambda — invoked by Step Functions after CFN creates the
workspace stack successfully. Reads the CFN stack outputs and updates the
workspace row with runtime info (service names, access point IDs) + marks
status=RUNNING.
"""

import os
import boto3
from datetime import datetime, timezone

from platform_log import init_logger, log_catch  # noqa: F401

logger = init_logger("post-provision")

ddb = boto3.resource("dynamodb")
cfn = boto3.client("cloudformation")

workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])


def handler(event, context):
    workspace_id = event["workspaceId"]
    stack_name = event["stackName"]

    desc = cfn.describe_stacks(StackName=stack_name)
    outputs = {o["OutputKey"]: o["OutputValue"] for o in desc["Stacks"][0].get("Outputs", [])}
    logger.info(
        "cfn stack outputs resolved",
        extra={
            "event": "post_provision.stack_outputs",
            "workspaceId": workspace_id,
            "stackName": stack_name,
            "outputKeys": list(outputs.keys()),
        },
    )

    workspaces_table.update_item(
        Key={"workspaceId": workspace_id},
        UpdateExpression=(
            "SET #s = :status, "
            "sandboxServiceName = :ss, "
            "sidecarServiceName = :sc, "
            "dataAccessPointId = :dap, "
            "configAccessPointId = :cap, "
            "originSecretArn = :osa, "
            "updatedAt = :ts"
        ),
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":status": "RUNNING",
            ":ss": outputs.get("SandboxServiceName", ""),
            ":sc": outputs.get("SidecarServiceName", ""),
            ":dap": outputs.get("DataAccessPointId", ""),
            ":cap": outputs.get("ConfigAccessPointId", ""),
            ":osa": outputs.get("OriginSecretArn", ""),
            ":ts": datetime.now(timezone.utc).isoformat(),
        },
    )

    logger.info(
        "workspace marked RUNNING",
        extra={"event": "post_provision.done", "workspaceId": workspace_id},
    )
    return {"workspaceId": workspace_id, "status": "RUNNING"}

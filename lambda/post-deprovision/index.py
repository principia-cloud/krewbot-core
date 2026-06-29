"""
Post-deprovision Lambda — invoked after CFN finishes deleting the workspace
stack. Cleans up DynamoDB rows for the workspace and all its members.
"""

import os
import boto3
from boto3.dynamodb.conditions import Key

from platform_log import init_logger, log_catch  # noqa: F401

logger = init_logger("post-deprovision")

ddb = boto3.resource("dynamodb")

workspaces_table = ddb.Table(os.environ["WORKSPACES_TABLE"])
members_table = ddb.Table(os.environ["MEMBERS_TABLE"])


def handler(event, context):
    workspace_id = event["workspaceId"]

    # Delete all member rows for this workspace.
    # Why query + batch delete (no transaction): members can be arbitrary
    # count; transactions are capped at 100 items. Eventual consistency is
    # fine here since the stack is already gone.
    members = members_table.query(
        KeyConditionExpression=Key("workspaceId").eq(workspace_id)
    )
    member_count = len(members.get("Items", []))
    with members_table.batch_writer() as batch:
        for item in members.get("Items", []):
            batch.delete_item(
                Key={"workspaceId": workspace_id, "userId": item["userId"]}
            )

    workspaces_table.delete_item(Key={"workspaceId": workspace_id})

    logger.info(
        "deleted workspace + members",
        extra={
            "event": "post_deprovision.done",
            "workspaceId": workspace_id,
            "memberCount": member_count,
        },
    )
    return {"workspaceId": workspace_id, "status": "DELETED"}

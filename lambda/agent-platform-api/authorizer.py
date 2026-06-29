"""
Agent Platform API authorizer — API Gateway HTTP API custom Lambda
authorizer (SIMPLE response format, v2.0 payload).

For each incoming request API Gateway invokes this Lambda with the
identity source (the `Authorization` header). We:

    1. Parse the Bearer token; reject anything that doesn't match
       `wsk_<workspaceId>_<hex>`.
    2. Look up `{WORKSPACE_SECRETS_PREFIX}/<workspaceId>/agent-platform-key`
       in Secrets Manager and constant-time compare against the token.
    3. On success, return the workspaceId in the authorizer context;
       the route handler reads it from
       `event.requestContext.authorizer.lambda.workspaceId`.

API Gateway caches our response by identity-source value for the TTL
configured in CDK (300s in this stack). A stable workspace key hits
Secrets Manager at most once per cache window across ALL warm Lambda
instances — meaningfully better than the previous in-handler module
cache, which was per-Lambda-instance only.
"""

import hmac
import os
import re
from typing import Optional

import boto3
from botocore.exceptions import ClientError

secrets_client = boto3.client("secretsmanager")
WORKSPACE_SECRETS_PREFIX = os.environ["WORKSPACE_SECRETS_PREFIX"].strip("/")

_KEY_PATTERN = re.compile(r"^wsk_([a-zA-Z0-9_-]{1,64})_([a-f0-9]{32,128})$")
_DENY = {"isAuthorized": False}


def _resolve_workspace_key(workspace_id: str) -> Optional[str]:
    name = f"{WORKSPACE_SECRETS_PREFIX}/{workspace_id}/agent-platform-key"
    try:
        resp = secrets_client.get_secret_value(SecretId=name)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("ResourceNotFoundException", "InvalidRequestException"):
            return None
        raise
    return resp.get("SecretString") or None


def handler(event, _context):
    headers = event.get("headers") or {}
    # API Gateway HTTP API normalizes header names to lowercase.
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return _DENY

    token = auth[len("Bearer "):].strip()
    m = _KEY_PATTERN.match(token)
    if not m:
        return _DENY
    workspace_id = m.group(1)

    expected = _resolve_workspace_key(workspace_id)
    if not expected or not hmac.compare_digest(token, expected):
        return _DENY

    return {
        "isAuthorized": True,
        "context": {"workspaceId": workspace_id},
    }

#!/usr/bin/env bash
# Enable the LLM gateway for a single workspace.
#
# Writes the per-workspace `llm-provider` SSM parameter (sidecar-synced to
# /config/ssm/llm-provider within ~5s) AND the monthly budget on the workspace
# DDB row. Prefer the management API (PATCH /workspaces/<id>) once that path is
# deployed — this raw-CLI form is the bootstrap fallback for testing.
#
# Usage:
#   AWS_PROFILE=<beta> ./scripts/enable-llm-gateway.sh \
#       testws-01 bedrock/amazon.nova-pro-v1:0 25
#
# Args: <workspaceId> <model> <monthlyBudgetUsd> [smallFastModel]
# Beta = account 123456789012, us-east-1, prefixes example-sandbox / /example-sandbox.
set -euo pipefail

WS="${1:?workspaceId required}"
MODEL="${2:?model required, e.g. bedrock/amazon.nova-pro-v1:0}"
BUDGET="${3:?monthlyBudgetUsd required (fail-closed: gateway needs a positive budget)}"
SMALL_FAST="${4:-$MODEL}"
REGION="${AWS_REGION:-us-east-1}"
SSM_PREFIX="${WORKSPACE_SSM_PREFIX:-/example-sandbox}"
WORKSPACES_TABLE="${WORKSPACES_TABLE:-example-workspaces}"

PROVIDER_DOC=$(printf '{"mode":"gateway","model":"%s","smallFastModel":"%s"}' "$MODEL" "$SMALL_FAST")

echo "→ SSM ${SSM_PREFIX}/${WS}/llm-provider = ${PROVIDER_DOC}"
aws ssm put-parameter --region "$REGION" --overwrite --type String \
  --name "${SSM_PREFIX}/${WS}/llm-provider" \
  --value "$PROVIDER_DOC"

echo "→ DDB ${WORKSPACES_TABLE} row ${WS}: llmProviderMode=gateway, model, budget=${BUDGET}"
aws dynamodb update-item --region "$REGION" \
  --table-name "$WORKSPACES_TABLE" \
  --key "{\"workspaceId\":{\"S\":\"${WS}\"}}" \
  --update-expression "SET llmProviderMode = :m, llmProviderModel = :model, llmMonthlyBudgetUsd = :b" \
  --expression-attribute-values \
    "{\":m\":{\"S\":\"gateway\"},\":model\":{\"S\":\"${MODEL}\"},\":b\":{\"N\":\"${BUDGET}\"}}"

echo "✓ ${WS} is in gateway mode (model=${MODEL}, budget=\$${BUDGET}/mo)."
echo "  The sidecar vends /config/ssm/llm-provider within ~5s; the chat-server"
echo "  re-reads it per turn. To revert: set the SSM doc to {\"mode\":\"anthropic-direct\"}."

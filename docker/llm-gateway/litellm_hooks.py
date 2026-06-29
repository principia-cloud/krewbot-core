"""
litellm_hooks.py — thin LiteLLM adapters over gateway_core.

Wired in config.yaml:
  general_settings:
    custom_auth: litellm_hooks.user_api_key_auth
  litellm_settings:
    callbacks: ["litellm_hooks.usage_logger_instance"]

All real logic (token validation, fail-closed budget enforcement, usage
accounting) lives in gateway_core and is unit-tested there. These adapters only
translate LiteLLM's call shapes to/from those functions. They are intentionally
minimal because they can only be exercised against a running LiteLLM proxy.
"""

from datetime import datetime, timezone

from fastapi import HTTPException

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

import gateway_core


async def user_api_key_auth(request, api_key: str) -> UserAPIKeyAuth:
    """Validate the workspace `wsk_` bearer token and enforce the monthly cap.

    LiteLLM passes the bearer value as `api_key`. We validate it, enforce the
    fail-closed budget, and return a UserAPIKeyAuth whose `user_id` is the
    workspaceId — that propagates into the success event so the usage logger can
    attribute spend. Rejections surface as HTTP 401 (bad token) or 402 (over /
    no budget); the chat-server maps 402 to a friendly user message.
    """
    token = (api_key or "").strip()
    try:
        workspace_id = gateway_core.validate_token(token)
        gateway_core.enforce_budget(workspace_id, datetime.now(timezone.utc))
    except gateway_core.GatewayAuthError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    return UserAPIKeyAuth(api_key=token, user_id=workspace_id)


class UsageLogger(CustomLogger):
    """Record per-completion cost + tokens to the usage table, attributed to the
    workspace that authenticated the request; clamp oversized max_tokens."""

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        # Clamp max_tokens under the target model's output limit (Nova's 10000).
        data = gateway_core.clamp_max_tokens(data)
        # FAIL CLOSED on pricing: never serve a model we can't authoritatively
        # price — an unpriceable model would mis-attribute spend AND bypass the
        # budget cap. Reject before any inference happens. The detail string
        # can surface verbatim in end-user chat (the CLI relays API errors),
        # so it names the model but NOT the pricing internals — those go to
        # the gateway log only.
        try:
            gateway_core.price_for(data.get("model"))
        except gateway_core.PricingError as e:
            import sys
            print(f"GATEWAY pricing: rejecting pre-call: {e}", file=sys.stderr)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"The model '{data.get('model')}' is not available on this gateway. "
                    "If it was changed just now, retry in a minute; otherwise ask an "
                    "administrator to enable it."
                ),
            )
        return data

    # Usage is recorded IN-PATH (post_call hooks run before the response returns)
    # rather than in async_log_success_event, which fires AFTER the response —
    # under AWS Lambda the execution environment freezes before that post-response
    # task completes, so the DynamoDB write is lost. The post_call hooks below run
    # while the invocation is still active, so they're reliable on Lambda AND
    # Fargate, and (since a request is either streaming or not) never double-count.

    @staticmethod
    def _get(obj, key, default=None):
        # Attr-or-key access: /v1/messages responses/chunks are Anthropic dicts;
        # /chat/completions are objects.
        if obj is None:
            return default
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    @classmethod
    def _toks(cls, usage):
        # Anthropic usage: input_tokens/output_tokens; OpenAI: prompt/completion.
        def g(*names):
            for n in names:
                v = cls._get(usage, n)
                if v:
                    return v
            return 0
        if not usage:
            return 0, 0
        return g("prompt_tokens", "input_tokens"), g("completion_tokens", "output_tokens")

    @classmethod
    def _cache_toks(cls, usage):
        # Anthropic-only fields; OpenAI-shape responses simply yield zeros.
        if not usage:
            return 0, 0
        return (
            cls._get(usage, "cache_creation_input_tokens") or 0,
            cls._get(usage, "cache_read_input_tokens") or 0,
        )

    def _record(self, user_api_key_dict, model, in_tok, out_tok, request_id,
                cache_creation=0, cache_read=0):
        workspace_id = getattr(user_api_key_dict, "user_id", None)
        if not workspace_id:
            return
        # Always cost from our authoritative price map (LiteLLM doesn't know
        # these Bedrock prices). Fail closed: if the model isn't priced, do NOT
        # record a guessed cost — log and skip (the pre-call hook should already
        # have rejected it, so this is defense in depth).
        try:
            cost = gateway_core.compute_cost(model, in_tok, out_tok)
        except gateway_core.PricingError:
            import sys
            print(f"GATEWAY pricing: refusing to record usage for unpriced model {model!r}", file=sys.stderr)
            return
        gateway_core.record_usage(
            workspace_id, model=model or "unknown",
            input_tokens=in_tok or 0, output_tokens=out_tok or 0,
            cost_usd=cost or 0, now=datetime.now(timezone.utc),
            request_id=request_id or "unknown",
            cache_creation_input_tokens=cache_creation or 0,
            cache_read_input_tokens=cache_read or 0,
        )

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        # Non-streaming completion. response is an Anthropic-format dict for
        # /v1/messages (usage under the "usage" key), an object for /chat/completions.
        usage = self._get(response, "usage")
        in_tok, out_tok = self._toks(usage)
        cache_creation, cache_read = self._cache_toks(usage)
        hidden = self._get(response, "_hidden_params") or {}
        self._record(
            user_api_key_dict,
            model=data.get("model"),
            in_tok=in_tok, out_tok=out_tok,
            request_id=self._get(response, "id"),
            cache_creation=cache_creation, cache_read=cache_read,
        )
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        # Streaming completion (what Claude Code uses). Forward every chunk,
        # capture the usage chunk, then record after the stream is exhausted —
        # still in-path, so it survives the Lambda freeze.
        # For /v1/messages the chunks are raw Anthropic SSE bytes, so we buffer
        # the decoded text and extract token counts from the wire format after
        # the stream (input_tokens from message_start, output_tokens cumulative in
        # message_delta). Object chunks (/chat/completions) expose usage directly.
        in_tok = out_tok = cache_creation = cache_read = 0
        last_id = None
        buf = []
        async for chunk in response:
            if isinstance(chunk, (bytes, bytearray)):
                buf.append(bytes(chunk).decode("utf-8", "ignore"))
            else:
                u = self._get(chunk, "usage") or self._get(self._get(chunk, "message"), "usage")
                if u:
                    i, o = self._toks(u)
                    cc, cr = self._cache_toks(u)
                    in_tok, out_tok = max(in_tok, i), max(out_tok, o)
                    cache_creation, cache_read = max(cache_creation, cc), max(cache_read, cr)
                last_id = self._get(chunk, "id") or last_id
            yield chunk
        if buf:
            wire = gateway_core.extract_stream_usage("".join(buf))
            in_tok = wire["input_tokens"] or in_tok
            out_tok = wire["output_tokens"] or out_tok
            cache_creation = wire["cache_creation_input_tokens"] or cache_creation
            cache_read = wire["cache_read_input_tokens"] or cache_read
            last_id = wire["request_id"] or last_id
        self._record(
            user_api_key_dict,
            model=request_data.get("model"),
            in_tok=in_tok, out_tok=out_tok,
            request_id=last_id,
            cache_creation=cache_creation, cache_read=cache_read,
        )


usage_logger_instance = UsageLogger()

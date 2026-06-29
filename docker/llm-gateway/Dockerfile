# LLM gateway image — LiteLLM proxy, run as a long-lived Fargate service.
#
# Presents an Anthropic-compatible /v1/messages (+ count_tokens) endpoint that
# Claude Code talks to via ANTHROPIC_BASE_URL, and translates to the Bedrock
# Converse API using the task role's credentials — so real AWS credentials live
# only here, never in the sandbox. Auth + monthly hard-cap + usage accounting are
# in litellm_hooks (over the unit-tested gateway_core).
FROM ghcr.io/berriai/litellm:main-stable

WORKDIR /app
COPY config.yaml gateway_core.py litellm_hooks.py /app/

# gateway_core uses boto3 — already bundled in the LiteLLM image for Bedrock.
# PYTHONPATH so litellm can import litellm_hooks; HOME=/tmp for any scratch writes.
ENV PYTHONPATH=/app \
    HOME=/tmp \
    PORT=4000

EXPOSE 4000

# The ALB target group health-checks /health/liveliness; this is a belt-and-braces
# container check so ECS also sees an unhealthy proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4000/health/liveliness',timeout=4).status==200 else 1)" || exit 1

# litellm base image ENTRYPOINT is `litellm`; CMD provides the args.
CMD ["--config", "/app/config.yaml", "--port", "4000", "--num_workers", "1"]

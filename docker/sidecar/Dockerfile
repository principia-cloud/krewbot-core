FROM python:3.12-alpine
# boto3 for AWS API calls. git for user_context repo initialization.
RUN apk add --no-cache git
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY supervisor.py ./
COPY jobs/ ./jobs/
# platform_log.py is the canonical shared JSON-line logger. It's not
# checked into docker/sidecar/ — the deploy workflow runs
# scripts/inject-shared-log.sh to stage it from shared/python/ before
# `docker build`. Importers do `from platform_log import init_logger`.
COPY platform_log.py ./platform_log.py
# The sidecar writes to /config (EFS access point). The access point's
# PosixUser overrides the container's effective uid for EFS writes, so
# file ownership on EFS is always the configured workspace uid/gid
# regardless of what the process runs as.
USER app
CMD ["python3", "/app/supervisor.py"]

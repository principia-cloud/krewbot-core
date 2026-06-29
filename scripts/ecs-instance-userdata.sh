#!/bin/bash
set -euo pipefail

# ========== 1. ECS Configuration ==========
# Write config BEFORE Docker/ECS start (they start automatically on ECS-optimized AMIs)
echo "ECS_CLUSTER=${ECS_CLUSTER_NAME}" >> /etc/ecs/ecs.config
echo 'ECS_INSTANCE_ATTRIBUTES={"gvisor_ready":"false"}' >> /etc/ecs/ecs.config

# ========== 2. Install amazon-efs-utils ==========
yum install -y amazon-efs-utils

# ========== 3. Install gVisor (runsc) ==========
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/latest/x86_64"
elif [ "$ARCH" = "aarch64" ]; then
  GVISOR_URL="https://storage.googleapis.com/gvisor/releases/release/latest/aarch64"
fi
curl -fsSL "${GVISOR_URL}/runsc" -o /usr/local/bin/runsc
curl -fsSL "${GVISOR_URL}/containerd-shim-runsc-v1" -o /usr/local/bin/containerd-shim-runsc-v1
chmod 755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1

# ========== 4. Configure Docker with gVisor + security defaults ==========
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'DOCKEREOF'
{
  "default-runtime": "runc",
  "runtimes": {
    "runsc": {
      "path": "/usr/local/bin/runsc"
    }
  },
  "no-new-privileges": true
}
DOCKEREOF

# ========== 5. iptables DOCKER-USER rules (network isolation) ==========
# These rules block sandbox containers (bridge mode) from reaching anything
# except the internet. Sidecar tasks use awsvpc mode and bypass DOCKER-USER.
#
# We wait for Docker to start naturally (ECS-optimized AMI starts it automatically)
# rather than calling systemctl start docker ourselves.

# Wait for Docker to be running and DOCKER-USER chain to exist
for i in $(seq 1 60); do
  if iptables -L DOCKER-USER -n &>/dev/null; then
    break
  fi
  sleep 2
done

# Rule 1: DROP IMDS
iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP
# Rule 2: DROP all link-local (credential endpoint, etc)
iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP
# Rule 3: DROP 10.0.0.0/8 (VPC)
iptables -I DOCKER-USER -d 10.0.0.0/8 -j DROP
# Rule 4: DROP 172.16.0.0/12 (VPC + Docker bridge)
iptables -I DOCKER-USER -d 172.16.0.0/12 -j DROP
# Rule 5: DROP 192.168.0.0/16 (VPC)
iptables -I DOCKER-USER -d 192.168.0.0/16 -j DROP

# Allow NFS (port 2049) to EFS mount targets. The amazon-ecs-volume-plugin
# + efs-proxy run in the task netns and need to reach EFS mount targets
# inside the VPC. Added to position 1 so it short-circuits the DROPs.
iptables -I DOCKER-USER -p tcp --dport 2049 -j RETURN

# Allow DNS to the Amazon VPC resolver (always .2 of the VPC CIDR). Required
# for bridge-mode containers to resolve public AWS endpoints (Cognito, S3,
# Secrets Manager, etc). Without this, the broad 10.0.0.0/8 DROP below
# would kill DNS before any other traffic can flow.
#
# Note: this is scoped to the VPC resolver only and doesn't let containers
# reach arbitrary 10.x addresses — only UDP/TCP 53 to the specific resolver.
iptables -I DOCKER-USER -d 10.0.0.2/32 -p udp --dport 53 -j RETURN
iptables -I DOCKER-USER -d 10.0.0.2/32 -p tcp --dport 53 -j RETURN

# Allow RELATED and ESTABLISHED connections back to containers. Without this,
# DNS responses, HTTPS responses, and EFS replies all get dropped by the
# broad private-range DROPs when they return to the container's docker0
# bridge IP (172.17.x.x). This rule is placed FIRST so it short-circuits
# all reply traffic for connections the container legitimately initiated.
iptables -I DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# Allow INBOUND-TO-CONTAINER traffic unconditionally. The DROP rules below
# are meant to block containers from REACHING OUT to sensitive addresses,
# not to block external systems from reaching containers. Since the host
# port mapping + Docker NAT is the only way to reach a bridge-mode
# container from outside, any packet whose output interface is docker0
# has already been accepted at the host firewall level. Without this
# rule, ALB health-check traffic (src=ALB ENI, dst=container 172.17.x.x
# after DNAT) gets caught by the DROP 172.16.0.0/12 rule.
iptables -I DOCKER-USER -o docker0 -j RETURN

# ========== 6. Persist iptables rules via systemd ==========
cat > /etc/systemd/system/iptables-docker-user.service << 'IPTEOF'
[Unit]
Description=Restore DOCKER-USER iptables rules
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c "\
  iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP; \
  iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP; \
  iptables -I DOCKER-USER -d 10.0.0.0/8 -j DROP; \
  iptables -I DOCKER-USER -d 172.16.0.0/12 -j DROP; \
  iptables -I DOCKER-USER -d 192.168.0.0/16 -j DROP; \
  iptables -I DOCKER-USER -p tcp --dport 2049 -j RETURN; \
  iptables -I DOCKER-USER -d 10.0.0.2/32 -p udp --dport 53 -j RETURN; \
  iptables -I DOCKER-USER -d 10.0.0.2/32 -p tcp --dport 53 -j RETURN; \
  iptables -I DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN; \
  iptables -I DOCKER-USER -o docker0 -j RETURN"

[Install]
WantedBy=multi-user.target
IPTEOF
systemctl daemon-reload
systemctl enable iptables-docker-user.service

# ========== 7. gVisor SIGHUP switching ==========
# reset-docker-runtime: resets to runc before Docker starts (on reboot)
cat > /etc/systemd/system/reset-docker-runtime.service << 'RESETEOF'
[Unit]
Description=Reset Docker runtime to runc before start
Before=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c "if [ -f /etc/docker/daemon.json ]; then sed -i 's/\"default-runtime\": \"runsc\"/\"default-runtime\": \"runc\"/' /etc/docker/daemon.json; fi"

[Install]
WantedBy=docker.service
RESETEOF

# Write the gVisor switch script as a standalone file (avoids systemd heredoc escaping issues)
cat > /usr/local/bin/switch-gvisor-runtime.sh << 'GVISOREOF'
#!/bin/bash
set -euo pipefail

# CRITICAL: wait for the ECS agent to be fully registered BEFORE flipping
# the Docker default runtime. The ECS agent container needs to reach the
# EC2 instance metadata service (169.254.169.254) to determine its AWS
# region, and gVisor's netstack does not share link-local routes from the
# host. If we flip the runtime first, the ECS agent container is launched
# under runsc and dies in a loop with "network unreachable" to IMDS.
#
# Running order:
#   1. Docker starts with runc (via reset-docker-runtime.service).
#   2. ecs.service starts, launches ecs-agent container under runc.
#   3. Agent reads region from IMDS, connects to ECS, registers itself.
#   4. We poll /v1/metadata until ContainerInstanceArn is populated.
#   5. Only THEN flip daemon.json to runsc and SIGHUP. Existing containers
#      (including ecs-agent) keep their current runtime. New containers
#      launched after this point use runsc.
for i in $(seq 1 60); do
  METADATA=$(curl -s http://localhost:51678/v1/metadata 2>/dev/null || echo "")
  if echo "$METADATA" | python3 -c "import sys,json; json.load(sys.stdin)['ContainerInstanceArn']" &>/dev/null; then
    break
  fi
  sleep 2
done

# Re-read metadata after the wait loop.
METADATA=$(curl -s http://localhost:51678/v1/metadata 2>/dev/null || echo "")
if ! echo "$METADATA" | python3 -c "import sys,json; json.load(sys.stdin)['ContainerInstanceArn']" &>/dev/null; then
  echo "ERROR: ECS agent did not register within 120s, aborting gvisor switch" >&2
  exit 1
fi

# Now safe to flip the runtime. Existing ecs-agent container keeps runc;
# new task containers will pick up runsc.
sed -i 's/"default-runtime": "runc"/"default-runtime": "runsc"/' /etc/docker/daemon.json
kill -SIGHUP $(cat /var/run/docker.pid)
sleep 3

RUNTIME=$(docker info --format '{{.DefaultRuntime}}')
if [ "$RUNTIME" != "runsc" ]; then
  echo "ERROR: Docker runtime is $RUNTIME, expected runsc" >&2
  exit 1
fi

# Signal ECS that this instance is gVisor-ready. $METADATA was populated
# in the wait loop above and is safe to reuse.
INSTANCE_ARN=$(echo "$METADATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['ContainerInstanceArn'])")
CLUSTER_ARN=$(echo "$METADATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['Cluster'])")
REGION=$(echo "$INSTANCE_ARN" | cut -d: -f4)

aws ecs put-attributes \
  --cluster "$CLUSTER_ARN" \
  --attributes "name=gvisor_ready,value=true,targetId=$INSTANCE_ARN" \
  --region "$REGION"

echo "gVisor runtime active and ECS attribute set"
GVISOREOF
chmod 755 /usr/local/bin/switch-gvisor-runtime.sh

# switch-gvisor-runtime: switches to runsc after ECS agent is up, then signals readiness
cat > /etc/systemd/system/switch-gvisor-runtime.service << 'SWITCHEOF'
[Unit]
Description=Switch Docker to gVisor runtime and signal ECS readiness
After=ecs.service
Requires=ecs.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/switch-gvisor-runtime.sh

[Install]
WantedBy=multi-user.target
SWITCHEOF

# Add drop-in to ecs.service to run gVisor switch after ECS agent starts
mkdir -p /etc/systemd/system/ecs.service.d
cat > /etc/systemd/system/ecs.service.d/gvisor-switch.conf << 'DROPINEOF'
[Service]
ExecStartPost=/usr/local/bin/switch-gvisor-runtime.sh
DROPINEOF

systemctl daemon-reload
systemctl enable reset-docker-runtime.service
systemctl enable switch-gvisor-runtime.service

# ========== 8. Let the normal boot sequence handle Docker + ECS ==========
# On ECS-optimized AMIs, docker.service and ecs.service are enabled and start
# automatically after cloud-init finishes. We must NOT call systemctl start
# from here — it deadlocks because systemd waits for cloud-init, which waits
# for the service.
#
# Boot sequence after cloud-init completes:
#   1. docker.service starts (picks up our daemon.json with runsc runtime)
#   2. ecs.service starts (reads /etc/ecs/ecs.config we wrote)
#   3. switch-gvisor-runtime.service starts (After=ecs.service)
#      → switches default runtime to runsc via SIGHUP
#      → calls ecs:PutAttributes to set gvisor_ready=true
#
# The iptables DOCKER-USER rules are already applied above (step 5) and
# persist across Docker restarts via iptables-docker-user.service.

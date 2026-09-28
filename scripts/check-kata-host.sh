#!/usr/bin/env bash
# Operator-run smoke check. This does not certify Agentor worker migration or DinD.
set -euo pipefail

RUNTIME=agentor-kata-qemu
DOCKER_SOCKET=unix:///var/run/docker.sock
IMAGE=ubuntu:24.04
container_id=

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker -H "$DOCKER_SOCKET" rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

report() {
  local passed=$1 message=$2 guest=${3:-}
  jq -n --arg runtime "$RUNTIME" --arg image "$IMAGE" --arg hostKernel "$(uname -r)" \
    --arg guestKernel "$guest" --arg message "$message" --argjson passed "$passed" \
    '{passed:$passed,runtime:$runtime,image:$image,hostKernel:$hostKernel,guestKernel:$guestKernel,kernelReleaseDiffers:($guestKernel != "" and $guestKernel != $hostKernel),isolationVerified:false,message:$message,scope:"requested-runtime create/start/exec only; VM isolation, DinD and Agentor migration unverified"}'
}

command -v jq >/dev/null || { printf 'jq is required.\n' >&2; exit 1; }
if ! command -v docker >/dev/null || [[ ! -S /var/run/docker.sock ]]; then
  report false 'Local Docker Engine is unavailable.'
  exit 1
fi
if ! docker -H "$DOCKER_SOCKET" info --format '{{json .Runtimes}}' | jq -e --arg runtime "$RUNTIME" 'has($runtime)' >/dev/null; then
  report false 'Docker does not report agentor-kata-qemu; run host setup first.'
  exit 1
fi
if ! timeout 240 docker -H "$DOCKER_SOCKET" pull "$IMAGE" >/dev/null; then
  report false 'Could not pull the Ubuntu canary image.'
  exit 1
fi
if ! container_id=$(timeout 180 docker -H "$DOCKER_SOCKET" create --runtime "$RUNTIME" \
  --label agentor.kata.canary=true --restart no "$IMAGE" sleep 180); then
  report false 'Docker could not create a Kata canary container.'
  exit 1
fi
if [[ "$(docker -H "$DOCKER_SOCKET" inspect --format '{{.HostConfig.Runtime}}' "$container_id")" != "$RUNTIME" ]]; then
  report false 'Canary container did not use the requested runtime.'
  exit 1
fi
if ! timeout 180 docker -H "$DOCKER_SOCKET" start "$container_id" >/dev/null; then
  report false 'Kata QEMU guest did not start; inspect Docker and Kata logs.'
  exit 1
fi
if ! guest_kernel=$(timeout 120 docker -H "$DOCKER_SOCKET" exec "$container_id" uname -r); then
  report false 'Kata QEMU guest started but Docker exec failed.'
  exit 1
fi
if [[ -z "$guest_kernel" ]]; then
  report false 'Canary returned an empty kernel release.' "$guest_kernel"
  exit 1
fi
report true 'Requested-runtime container started and Docker exec succeeded; kernel equality or inequality alone does not verify VM isolation.' "$guest_kernel"

#!/usr/bin/env bash
# Operator-run smoke check. This does not certify Agentor worker migration or DinD.
set -euo pipefail

RUNTIME=agentor-kata-qemu
DOCKER_SOCKET=unix:///var/run/docker.sock
IMAGE=ubuntu:24.04
container_id=
passed=false
guest_kernel=
initial_user_exec=false
restart_passed=false
restarted_user_exec=false
message='Kata smoke check did not complete.'

docker_available() { command -v docker >/dev/null && [[ -S /var/run/docker.sock ]]; }
cleanup() {
  if [[ -n "$container_id" ]]; then
    if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
      printf 'Refusing cleanup of an invalid container ID.\n' >&2
      return 1
    fi
    if ! timeout 120 docker -H "$DOCKER_SOCKET" rm -f "$container_id" >/dev/null; then
      printf 'Cleanup failed; inspect this exact canary container before removal: %s\n' "$container_id" >&2
      return 1
    fi
  fi
}

report() {
  jq -n --arg runtime "$RUNTIME" --arg image "$IMAGE" --arg hostKernel "$(uname -r)" \
    --arg guestKernel "$guest_kernel" --arg message "$message" --argjson passed "$passed" \
    --argjson initialUserExecPassed "$initial_user_exec" --argjson restartPassed "$restart_passed" \
    --argjson restartedUserExecPassed "$restarted_user_exec" \
    '{passed:$passed,runtime:$runtime,image:$image,hostKernel:$hostKernel,guestKernel:$guestKernel,
      kernelReleaseDiffers:($guestKernel != "" and $guestKernel != $hostKernel),isolationVerified:false,
      initialUserExecPassed:$initialUserExecPassed,restartPassed:$restartPassed,
      restartedUserExecPassed:$restartedUserExecPassed,message:$message,
      scope:"requested-runtime create/start/root exec and UID/GID 1000 exec before/after restart only; VM isolation, DinD and Agentor migration unverified"}'
}

finish() {
  local rc=$?
  trap - EXIT
  if ! cleanup; then
    rc=1
    message="$message Canary cleanup failed; exact container ID is in stderr."
  fi
  [[ $rc == 0 ]] || passed=false
  report
  exit "$rc"
}

check_user_exec() {
  local identity
  if ! identity=$(timeout 120 docker -H "$DOCKER_SOCKET" exec --user 1000:1000 "$container_id" \
      sh -c 'printf "%s:%s" "$(id -u)" "$(id -g)"'); then return 1; fi
  [[ "$identity" == 1000:1000 ]]
}

main() {
  command -v jq >/dev/null || { printf 'jq is required.\n' >&2; return 1; }
  trap finish EXIT
  if ! docker_available; then
    message='Local Docker Engine is unavailable.'; return 1
  fi
  if ! timeout 30 docker -H "$DOCKER_SOCKET" info --format '{{json .Runtimes}}' | jq -e --arg runtime "$RUNTIME" 'has($runtime)' >/dev/null; then
    message='Docker does not report agentor-kata-qemu; run host setup first.'; return 1
  fi
  if ! timeout 240 docker -H "$DOCKER_SOCKET" pull "$IMAGE" >/dev/null; then
    message='Could not pull the Ubuntu canary image.'; return 1
  fi
  if ! container_id=$(timeout 180 docker -H "$DOCKER_SOCKET" create --runtime "$RUNTIME" \
    --label agentor.kata.canary=true --restart no "$IMAGE" sleep 600); then
    message='Docker could not create a Kata canary container; a timed-out create may require operator inspection.'; return 1
  fi
  if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
    message='Docker returned an invalid canary container ID.'; return 1
  fi
  if [[ "$(timeout 30 docker -H "$DOCKER_SOCKET" inspect --format '{{.HostConfig.Runtime}}' "$container_id")" != "$RUNTIME" ]]; then
    message='Canary container did not use the requested runtime.'; return 1
  fi
  if ! timeout 180 docker -H "$DOCKER_SOCKET" start "$container_id" >/dev/null; then
    message='Kata QEMU guest did not start; inspect Docker and Kata logs.'; return 1
  fi
  if ! guest_kernel=$(timeout 120 docker -H "$DOCKER_SOCKET" exec "$container_id" uname -r) || [[ -z "$guest_kernel" ]]; then
    message='Kata QEMU guest did not return a kernel release through Docker exec.'; return 1
  fi
  if ! check_user_exec; then
    message='Initial explicit UID/GID 1000 Docker exec failed or returned the wrong identity.'; return 1
  fi
  initial_user_exec=true
  if ! timeout 180 docker -H "$DOCKER_SOCKET" restart --time 10 "$container_id" >/dev/null; then
    message='Kata canary restart failed; inspect Docker and Kata logs.'; return 1
  fi
  restart_passed=true
  if ! check_user_exec; then
    message='Explicit UID/GID 1000 Docker exec failed after restart; this host is not worker-compatible.'; return 1
  fi
  restarted_user_exec=true
  passed=true
  message='Requested-runtime container started, root exec and explicit UID/GID 1000 exec before/after restart succeeded. This does not certify VM isolation or Agentor lifecycle compatibility.'
}

# Source-only offline fixtures override host operations, never a real socket.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

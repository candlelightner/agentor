#!/usr/bin/env bash
# Disposable runc DinD experiment inside an Agentor worker's own Docker daemon.
# This script never installs/validates Kata and never changes host configuration.
set -euo pipefail

if [[ "${1:-}" != --run-worker-local || $# -gt 2 ||
      ( $# == 2 && "$2" != --seccomp-unconfined ) ]]; then
  printf 'Usage: bash scripts/probe-worker-local-dind.sh --run-worker-local [--seccomp-unconfined]\n' >&2
  exit 2
fi
for command in docker jq timeout pgrep; do command -v "$command" >/dev/null; done
[[ -e /.dockerenv && -d /workspace ]] || { printf 'Run only inside a worker container.\n' >&2; exit 1; }
pgrep -x dockerd >/dev/null || { printf 'No worker-local dockerd process.\n' >&2; exit 1; }
outer() { docker -H unix:///var/run/docker.sock "$@"; }
[[ "$(outer info --format '{{.Name}}')" == "$(hostname)" ]] || {
  printf 'Docker daemon identity differs from this worker; refusing to proceed.\n' >&2; exit 1;
}
probe_image=$(outer image inspect agentor-test-runner:latest --format '{{.Id}}')
probe_dir=$(mktemp -d /workspace/kata-dind-probe.XXXXXXXX)
probe_label="$(basename -- "$probe_dir")"
probe_volume="${probe_label}-data"
probe_container=
probe_phase=initializing
probe_passed=false
probe_seccomp=default
security_args=()
if [[ "${2:-}" == --seccomp-unconfined ]]; then
  probe_seccomp=unconfined
  security_args+=(--security-opt seccomp=unconfined)
fi

collect_logs() {
  [[ -z "$probe_container" ]] || outer logs "$probe_container" > "$probe_dir/daemon.log" 2>&1 || true
}
remove_container() {
  [[ -n "$probe_container" ]] || return 0
  [[ "$(outer inspect --format '{{index .Config.Labels "agentor.dind-probe"}}' "$probe_container")" == "$probe_label" ]] || return 1
  outer rm -f "$probe_container" >/dev/null
  probe_container=
}
cleanup() {
  local exit_code=$?
  trap - EXIT
  collect_logs
  local cleaned=true
  remove_container || cleaned=false
  if outer volume inspect "$probe_volume" >/dev/null 2>&1; then
    if [[ "$(outer volume inspect --format '{{index .Labels "agentor.dind-probe"}}' "$probe_volume")" == "$probe_label" ]]; then
      outer volume rm "$probe_volume" >/dev/null || cleaned=false
    else cleaned=false; fi
  fi
  [[ "$cleaned" == true ]] || exit_code=1
  jq -n --arg scope 'worker-local runc only; Kata permissions/storage/host validation not tested' \
    --arg phase "$probe_phase" --arg image "$probe_image" --arg seccomp "$probe_seccomp" \
    --argjson passed "$probe_passed" --argjson cleaned "$cleaned" --argjson exitCode "$exit_code" \
    '{scope:$scope,passed:$passed,lastPhase:$phase,image:$image,seccomp:$seccomp,cleaned:$cleaned,exitCode:$exitCode}' > "$probe_dir/result.json"
  printf 'Probe evidence: %s\n' "$probe_dir"
  jq . "$probe_dir/result.json"
  exit "$exit_code"
}
trap cleanup EXIT

outer info --format '{{json .}}' | jq '{Name,ServerVersion,Driver,DriverStatus,DockerRootDir,SecurityOptions,Runtimes:(.Runtimes|keys)}' > "$probe_dir/outer-info.json"
outer volume create --label "agentor.dind-probe=$probe_label" "$probe_volume" >/dev/null

start_daemon() {
  local iteration=$1
  probe_phase="create-$iteration"
  probe_container=$(outer create --name "${probe_label}-${iteration}" --runtime runc \
    --label "agentor.dind-probe=$probe_label" --restart no --cgroupns private \
    --cap-add SYS_ADMIN --cap-add NET_ADMIN --cap-add SYS_RESOURCE --cap-drop SYS_MODULE \
    "${security_args[@]}" --mount "type=volume,source=$probe_volume,target=/var/lib/docker" \
    --entrypoint dockerd "$probe_image" --host unix:///run/dind-probe.sock \
    --pidfile /run/dind-probe.pid --data-root /var/lib/docker)
  outer inspect "$probe_container" | jq '.[0] | {Id,Image,HostConfig,Mounts,Path,Args}' > "$probe_dir/container-$iteration.json"
  jq -e --arg volume "$probe_volume" '
    .HostConfig.Privileged == false and .HostConfig.Runtime == "runc"
    and .HostConfig.NetworkMode != "host" and .HostConfig.PidMode != "host"
    and .HostConfig.IpcMode != "host" and .HostConfig.CgroupnsMode == "private"
    and ((.HostConfig.Devices // []) | length == 0)
    and ((.HostConfig.DeviceRequests // []) | length == 0)
    and ((.HostConfig.DeviceCgroupRules // []) | length == 0)
    and ((.HostConfig.Binds // []) | length == 0)
    and ((.HostConfig.CapAdd | sort) == (["CAP_SYS_ADMIN","CAP_NET_ADMIN","CAP_SYS_RESOURCE"] | sort)
      or (.HostConfig.CapAdd | sort) == (["SYS_ADMIN","NET_ADMIN","SYS_RESOURCE"] | sort))
    and (.Mounts | length == 1 and .[0].Type == "volume" and .[0].Name == $volume and .[0].Destination == "/var/lib/docker")
  ' "$probe_dir/container-$iteration.json" >/dev/null
  probe_phase="daemon-start-$iteration"
  timeout 30 docker -H unix:///var/run/docker.sock start "$probe_container" >/dev/null
  for attempt in {1..30}; do
    if timeout 3 docker -H unix:///var/run/docker.sock exec "$probe_container" \
      docker -H unix:///run/dind-probe.sock info --format '{{json .}}' > "$probe_dir/inner-info-$iteration.json" 2>/dev/null; then
      jq -e '.Driver == "overlay2"' "$probe_dir/inner-info-$iteration.json" >/dev/null
      return
    fi
    [[ "$(outer inspect --format '{{.State.Running}}' "$probe_container")" == true ]] || break
    sleep 1
  done
  printf 'Inner daemon did not become ready; inspect %s/daemon.log.\n' "$probe_dir" >&2
  return 1
}
inner() { timeout 120 docker -H unix:///var/run/docker.sock exec "$probe_container" docker -H unix:///run/dind-probe.sock "$@"; }

start_daemon first
outer exec "$probe_container" sh -c 'stat -f -c "%T" /var/lib/docker; cat /proc/self/cgroup; grep /sys/fs/cgroup /proc/self/mountinfo; grep "^Cap" /proc/self/status' > "$probe_dir/guest-prerequisites.txt"
probe_phase=pull
inner pull alpine:3.23 > "$probe_dir/pull.log" 2>&1
inner image inspect alpine:3.23 --format '{{json .RepoDigests}}' > "$probe_dir/nested-image-digests.json"
probe_phase=run
inner run --rm alpine:3.23 sh -c 'printf "nested-run-ok\n"' > "$probe_dir/run.log" 2>&1
probe_phase=build
timeout 120 docker -H unix:///var/run/docker.sock exec -i "$probe_container" docker -H unix:///run/dind-probe.sock build --network=none -t dind-probe-built - > "$probe_dir/build.log" 2>&1 <<'DOCKERFILE'
FROM alpine:3.23
RUN printf 'built-ok\n' > /built-marker
DOCKERFILE
probe_phase=nested-volume
inner volume create nested-data > "$probe_dir/nested-volume.log"
inner run --rm -v nested-data:/data dind-probe-built sh -c 'cp /built-marker /data/retained' >> "$probe_dir/nested-volume.log" 2>&1
probe_phase=daemon-restart
outer restart --time 10 "$probe_container" > "$probe_dir/restart.log"
for attempt in {1..30}; do inner info >/dev/null 2>&1 && break; sleep 1; done
inner run --rm -v nested-data:/data dind-probe-built cat /data/retained >> "$probe_dir/restart.log" 2>&1
collect_logs
remove_container
start_daemon recreated
probe_phase=recreation-retention
inner run --rm -v nested-data:/data dind-probe-built cat /data/retained > "$probe_dir/recreation.log" 2>&1
probe_phase=complete
probe_passed=true

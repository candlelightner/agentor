#!/usr/bin/env bash
# Operator-run standalone compatibility canary, never an attestation or deployment.
# Failure retains containers and volumes for diagnosis. Success removes only its
# exact containers; image, named volumes, and evidence always remain.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash scripts/test-kata-worker.sh --disposable-host --image LOCAL_IMAGE' \
    'Requires an explicitly approved disposable host with Kata already installed.' \
    'Uses only unix:///var/run/docker.sock; no pulls, builds, host setup, or fallback.' \
    'Retains evidence and volumes; retains failed containers. Does not enable validation.'
}
approved=false
image_ref=
while (($#)); do
  case "$1" in
    --disposable-host) approved=true; shift ;;
    --image) [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }; image_ref=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$approved" == true && -n "$image_ref" && "$image_ref" != -* ]] || { usage >&2; exit 2; }
for dependency in docker jq timeout mktemp; do
  command -v "$dependency" >/dev/null || { printf 'Missing dependency: %s\n' "$dependency" >&2; exit 1; }
done

umask 077
evidence=$(mktemp -d "${TMPDIR:-/tmp}/agentor-kata-worker.XXXXXXXX")
run_id="kata-worker-$(date -u +%Y%m%dT%H%M%SZ)-${evidence##*.}"
workspace_volume="$run_id-workspace"
agent_volume="$run_id-agent-data"
runtime=agentor-kata-qemu
docker_socket=unix:///var/run/docker.sock
containers=()
complete=false
current_id=
printf 'Evidence: %s\n' "$evidence"

dk() { timeout 180 docker -H "$docker_socket" "$@"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
finish() {
  local result=$? cid
  trap - EXIT
  set +e
  for cid in "${containers[@]}"; do
    dk inspect "$cid" >"$evidence/$cid.final-inspect.json" 2>"$evidence/$cid.final-inspect.stderr"
    dk logs --timestamps "$cid" >"$evidence/$cid.final.log" 2>&1
  done
  if [[ "$complete" == true ]]; then
    for cid in "${containers[@]}"; do
      # Only full IDs returned by this run's create calls, never name/glob lookup.
      if ! dk rm -f "$cid" >>"$evidence/cleanup.log" 2>&1; then result=1; fi
    done
  fi
  jq -n --argjson passed "$([[ $result == 0 && "$complete" == true ]] && echo true || echo false)" \
    --arg evidence "$evidence" --arg image "${image_id:-}" \
    --arg workspace "$workspace_volume" --arg agentData "$agent_volume" \
    --argjson containers "$(printf '%s\n' "${containers[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    '{passed:$passed,evidence:$evidence,image:$image,retainedVolumes:[$workspace,$agentData],containerIds:$containers,
      scope:"standalone non-DinD worker startup/restart/recreate; not API/UI, isolation certification, DinD, or migration acceptance",
      hostValidated:false}' | tee "$evidence/result.json"
  if [[ "$complete" != true || $result != 0 ]]; then
    printf 'Failure: inspect evidence and exact IDs before cleanup; volumes/image are retained. No automatic retry or fallback.\n' >&2
  fi
  exit "$result"
}
trap finish EXIT

dk info >"$evidence/docker-info.txt"
dk version >"$evidence/docker-version.txt"
dk info --format '{{json .Runtimes}}' | jq -e --arg runtime "$runtime" 'has($runtime)' >/dev/null \
  || fail 'Kata runtime is unavailable.'
dk image inspect "$image_ref" >"$evidence/image.json"
image_id=$(jq -er '.[0].Id | select(test("^sha256:[0-9a-f]{64}$"))' "$evidence/image.json")
jq -e 'length == 1 and (.[0].Config.User == "agent" or .[0].Config.User == "1000" or .[0].Config.User == "1000:1000")
  and .[0].Config.Entrypoint == ["/home/agent/entrypoint.sh"]
  and ((.[0].Config.Volumes // {}) | length == 0)' "$evidence/image.json" >/dev/null \
  || fail 'Expected a standard locally built Agentor worker image, without image-declared volumes.'

for volume in "$workspace_volume" "$agent_volume"; do
  if dk volume inspect "$volume" >/dev/null 2>&1; then fail "Refusing existing volume: $volume"; fi
  dk volume create --label "agentor.kata.worker-canary=$run_id" "$volume" >>"$evidence/volumes.txt"
done
environment='{"dockerEnabled":false,"networkMode":"full","envVars":"","setupScript":"","exposeApis":{"portMappings":false,"domainMappings":false,"usage":false}}'
worker='{"displayName":"Disposable Kata canary","repos":[],"initScript":"","gitName":"","gitEmail":""}'
# Deliberate standalone deviations: no orchestrator exists at the loopback URL,
# restart=no prevents unattended VM-reboot startup, and the default bridge is
# used instead of the Agentor deployment network. This is not API acceptance.

create_worker() {
  local generation=$1
  # Explicit values only: never forward ambient environment or credentials.
  if ! dk create --cidfile "$evidence/$generation.cid" --name "$run_id-$generation" \
    --label "agentor.kata.worker-canary=$run_id" --runtime "$runtime" --restart no --network bridge \
    --init --shm-size 512m --interactive --tty \
    --mount "type=volume,source=$workspace_volume,target=/workspace" \
    --mount "type=volume,source=$agent_volume,target=/home/agent/.agent-data" \
    --tmpfs '/run/agentor-secrets:rw,nosuid,nodev,noexec,mode=0711,uid=0,gid=0,size=16777216' \
    --env "ENVIRONMENT=$environment" --env 'CAPABILITIES=[]' --env 'INSTRUCTIONS=[]' \
    --env "WORKER=$worker" --env 'AGENTOR_RUNTIME_ROLE=worker' --env 'AGENTOR_ADMIN_WORKSPACE=' \
    --env 'WORKER_LOCAL_ENV=' --env 'WORKER_SECRET_HANDSHAKE=' --env 'DOCKER_ENABLED=false' \
    --env 'ORCHESTRATOR_URL=http://127.0.0.1:1' --env "WORKER_CONTAINER_NAME=$run_id-$generation" \
    --env 'GITHUB_TOKEN=' --env 'GH_TOKEN=' --env 'AGENTOR_GH_TOKEN=' \
    --env 'ANTHROPIC_API_KEY=' --env 'OPENAI_API_KEY=' --env 'GEMINI_API_KEY=' \
    "$image_id" >"$evidence/$generation.create.stdout" 2>"$evidence/$generation.create.stderr"; then
    fail "Create failed or timed out; check $generation.cid and the exact name $run_id-$generation for an uncertain daemon outcome."
  fi
  current_id=$(<"$evidence/$generation.cid")
  [[ "$current_id" =~ ^[0-9a-f]{64}$ ]] || fail 'Create returned an invalid container ID.'
  containers+=("$current_id")
  inspect_policy "$generation-created"
  dk start "$current_id" >"$evidence/$generation.start.log" 2>&1
}

inspect_policy() {
  local stage=$1
  dk inspect "$current_id" >"$evidence/$stage.inspect.json"
  jq -e --arg image "$image_id" --arg workspace "$workspace_volume" --arg data "$agent_volume" \
    --arg environment "$environment" \
    --slurpfile imageConfig "$evidence/image.json" '
    .[0] | .Image == $image and .HostConfig.Runtime == "agentor-kata-qemu"
    and .HostConfig.Privileged == false and .HostConfig.Init == true
    and .HostConfig.ShmSize == 536870912 and .HostConfig.RestartPolicy.Name == "no"
    and (.HostConfig.CapAdd // [] | length == 0) and (.HostConfig.Devices // [] | length == 0)
    and (.HostConfig.DeviceRequests // [] | length == 0) and (.HostConfig.DeviceCgroupRules // [] | length == 0)
    and (.HostConfig.Binds // [] | length == 0) and (.HostConfig.VolumesFrom // [] | length == 0)
    and (.HostConfig.PortBindings // {} | length == 0) and .HostConfig.PublishAllPorts == false
    and (.HostConfig.SecurityOpt // [] | length == 0)
    and (.HostConfig.PidMode // "") == "" and .HostConfig.IpcMode == "private"
    and (.HostConfig.UTSMode // "") == "" and (.HostConfig.UsernsMode // "") == ""
    and .HostConfig.CgroupnsMode == "private" and .HostConfig.NetworkMode == "bridge"
    and .Config.User == $imageConfig[0][0].Config.User
    and .Config.Entrypoint == $imageConfig[0][0].Config.Entrypoint
    and .Config.Cmd == $imageConfig[0][0].Config.Cmd
    and .Config.Tty == true and .Config.OpenStdin == true
    and (.Config.Env | index("AGENTOR_RUNTIME_ROLE=worker") != null)
    and (.Config.Env | index("DOCKER_ENABLED=false") != null)
    and (.Config.Env | index("ENVIRONMENT=" + $environment) != null)
    and ([.Mounts[] | select(.Type != "tmpfs")] | length == 2)
    and ([.Mounts[] | select(.Type == "volume" and .Name == $workspace and .Destination == "/workspace" and .RW)] | length == 1)
    and ([.Mounts[] | select(.Type == "volume" and .Name == $data and .Destination == "/home/agent/.agent-data" and .RW)] | length == 1)
    and (.HostConfig.Tmpfs | keys == ["/run/agentor-secrets"])
    and .HostConfig.Tmpfs["/run/agentor-secrets"] == "rw,nosuid,nodev,noexec,mode=0711,uid=0,gid=0,size=16777216"
    ' "$evidence/$stage.inspect.json" >/dev/null || fail "Unexpected container settings at $stage."
}

ready_and_services() {
  local stage=$1 deadline=$((SECONDS + 240)) ready=false
  while ((SECONDS < deadline)); do
    [[ "$(dk inspect --format '{{.State.Running}}' "$current_id")" == true ]] || fail "Worker exited at $stage."
    if timeout 15 docker -H "$docker_socket" exec --user 1000:1000 "$current_id" \
      grep -qx 'READY|' /tmp/worker-events >"$evidence/$stage.ready.stdout" 2>"$evidence/$stage.ready.stderr"; then
      ready=true; break
    fi
    sleep 2
  done
  [[ "$ready" == true ]] || fail "Worker READY deadline expired at $stage."
  inspect_policy "$stage"
  dk exec --user 1000:1000 "$current_id" bash -euc '
    test "$(id -u)" = 1000
    tmux has-session -t main
    test "$AGENTOR_RUNTIME_ROLE" = worker
    test ! -S /var/run/docker.sock
    curl --fail --silent --show-error --location --max-time 30 http://127.0.0.1:8443/ -o /dev/null
    curl --fail --silent --show-error --max-time 30 http://127.0.0.1:6080/agentor.html -o /dev/null
    cat /tmp/worker-events
    uname -a
  ' >"$evidence/$stage.services.log" 2>&1
  dk logs --timestamps "$current_id" >"$evidence/$stage.container.log" 2>&1
}

marker_check() {
  local stage=$1
  dk exec --user 1000:1000 "$current_id" bash -euc '
    for dir in /workspace /home/agent/.agent-data; do
      test "$(cat "$dir/.kata-canary-marker")" = "$1"
      test "$(stat -c %u:%g "$dir/.kata-canary-marker")" = 1000:1000
      printf "%s " "$dir"
      stat -c "%u:%g %a" "$dir/.kata-canary-marker"
    done
  ' bash "$run_id" >"$evidence/$stage.markers.log" 2>&1
}

create_worker first
ready_and_services first
dk exec --user 1000:1000 "$current_id" bash -euc '
  for dir in /workspace /home/agent/.agent-data; do
    printf "%s\n" "$1" > "$dir/.kata-canary-marker"
  done
' bash "$run_id" >"$evidence/marker-write.log" 2>&1
marker_check first
# Remove the prior READY record so a stale rootfs marker cannot satisfy restart.
dk exec --user 1000:1000 "$current_id" rm /tmp/worker-events
dk restart --time 20 "$current_id" >"$evidence/restart.log" 2>&1
ready_and_services restarted
marker_check restarted
dk stop --time 20 "$current_id" >"$evidence/stop-first.log" 2>&1
create_worker replacement
ready_and_services replacement
marker_check replacement
complete=true

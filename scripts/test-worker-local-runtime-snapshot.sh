#!/usr/bin/env bash
# Tests Docker snapshot/config and save/load semantics, not Kata or migration.
set -euo pipefail
[[ "${1:-}" == --run-worker-local && $# == 1 ]] || { printf 'Use --run-worker-local inside an isolated worker.\n' >&2; exit 2; }
[[ -e /.dockerenv && -d /workspace ]] && pgrep -x dockerd >/dev/null
snapshot_docker() { docker -H unix:///var/run/docker.sock "$@"; }
[[ "$(snapshot_docker info --format '{{.Name}}')" == "$(hostname)" ]] || { printf 'Not this worker Docker daemon.\n' >&2; exit 1; }
snapshot_base=$(snapshot_docker image inspect agentor-test-runner:latest --format '{{.Id}}')
snapshot_evidence=$(mktemp -d /workspace/kata-snapshot-proof.XXXXXXXX)
snapshot_label=$(basename "$snapshot_evidence" | tr '[:upper:]' '[:lower:]')
snapshot_tag="agentor-import-${snapshot_label}:runtime-proof"
snapshot_source=
snapshot_target=
snapshot_passed=false
cleanup_snapshot() {
  local snapshot_exit=$?
  trap - EXIT
  local snapshot_cleanup=true
  for snapshot_container in "$snapshot_target" "$snapshot_source"; do
    [[ -n "$snapshot_container" ]] || continue
    if [[ "$(snapshot_docker inspect --format '{{index .Config.Labels "agentor.snapshot-proof"}}' "$snapshot_container" 2>/dev/null)" == "$snapshot_label" ]]; then
      snapshot_docker rm -f -v "$snapshot_container" >/dev/null || snapshot_cleanup=false
    else snapshot_cleanup=false; fi
  done
  if snapshot_docker image inspect "$snapshot_tag" >/dev/null 2>&1; then
    if [[ "$(snapshot_docker image inspect --format '{{index .Config.Labels "agentor.snapshot-proof"}}' "$snapshot_tag")" == "$snapshot_label" ]]; then
      snapshot_docker image rm "$snapshot_tag" >/dev/null || snapshot_cleanup=false
    else snapshot_cleanup=false; fi
  fi
  [[ "$snapshot_cleanup" == true ]] || snapshot_exit=1
  jq -n --arg scope 'worker-local runc snapshot/save/load only; no Kata or migration acceptance' \
    --argjson passed "$snapshot_passed" --argjson cleaned "$snapshot_cleanup" \
    '{scope:$scope,passed:$passed,cleaned:$cleaned}' > "$snapshot_evidence/result.json"
  printf 'Snapshot evidence: %s\n' "$snapshot_evidence"
  jq . "$snapshot_evidence/result.json"
  exit "$snapshot_exit"
}
trap cleanup_snapshot EXIT

snapshot_source=$(snapshot_docker create --name "${snapshot_label}-source" --runtime runc \
  --user 1000:1000 --network none --cap-drop ALL --security-opt no-new-privileges \
  --restart no --label "agentor.snapshot-proof=$snapshot_label" --workdir /tmp \
  --env SNAPSHOT_PROOF_CONFIG=runtime-only --env 'WORKER_LOCAL_ENV={"REMOVED":"old"}' --env WORKER_SECRET_HANDSHAKE=1 \
  --entrypoint node "$snapshot_base" -e \
  'const fs=require("fs");const p="/tmp/rootfs-proof";if(!fs.existsSync(p)){if(process.env.SNAPSHOT_PROOF_CONFIG!=="runtime-only")process.exit(2);fs.writeFileSync(p,String(Date.now()))}else if(["SNAPSHOT_PROOF_CONFIG","WORKER_LOCAL_ENV","WORKER_SECRET_HANDSHAKE"].some(k=>process.env[k]!==""))process.exit(3);if(process.cwd()!=="/tmp")process.exit(4);console.log(fs.readFileSync(p,"utf8"))')
snapshot_docker start -a "$snapshot_source" > "$snapshot_evidence/source.txt"
[[ "$(snapshot_docker inspect --format '{{.State.ExitCode}}' "$snapshot_source")" == 0 ]]
snapshot_baked_env=$(snapshot_docker image inspect "$snapshot_base" | jq '.[0].Config.Env // []')
snapshot_runtime_env=$(snapshot_docker inspect "$snapshot_source" | jq '.[0].Config.Env // []')
snapshot_commit_body=$(jq -n --argjson baked "$snapshot_baked_env" --argjson runtime "$snapshot_runtime_env" \
  '($baked | map(split("=")[0])) as $keys | {Env: ($baked + [$runtime[] | split("=")[0] as $k | select(($keys | index($k)) == null) | $k + "="])}')
# Same Docker commit body/merge contract used by the migration service. Every
# runtime-only Env key is explicitly blank, since omission inherits old values.
curl --fail --silent --show-error --unix-socket /var/run/docker.sock \
  -H 'Content-Type: application/json' --data-binary "$snapshot_commit_body" \
  "http://localhost/commit?container=${snapshot_source}&repo=${snapshot_tag%:*}&tag=${snapshot_tag##*:}&pause=false" \
  | jq -r .Id > "$snapshot_evidence/image-id.txt"
snapshot_docker image inspect "$snapshot_tag" | jq '.[0] | {Id,Config:{Entrypoint:.Config.Entrypoint,Cmd:.Config.Cmd,User:.Config.User,WorkingDir:.Config.WorkingDir}}' > "$snapshot_evidence/config-before.json"
snapshot_docker image save -o "$snapshot_evidence/snapshot.tar" "$snapshot_tag"
sha256sum "$snapshot_evidence/snapshot.tar" > "$snapshot_evidence/archive.sha256"
# Remove only our exact image tag. The stopped source retains its base image.
snapshot_docker image rm "$snapshot_tag" >/dev/null
snapshot_docker image load -i "$snapshot_evidence/snapshot.tar" > "$snapshot_evidence/load.txt"
snapshot_docker image inspect "$snapshot_tag" | jq '.[0] | {Id,Config:{Entrypoint:.Config.Entrypoint,Cmd:.Config.Cmd,User:.Config.User,WorkingDir:.Config.WorkingDir}}' > "$snapshot_evidence/config-after.json"
cmp "$snapshot_evidence/config-before.json" "$snapshot_evidence/config-after.json"
snapshot_target=$(snapshot_docker create --name "${snapshot_label}-loaded" --runtime runc \
  --network none --cap-drop ALL --security-opt no-new-privileges --restart no \
  --label "agentor.snapshot-proof=$snapshot_label" "$snapshot_tag")
snapshot_docker start -a "$snapshot_target" > "$snapshot_evidence/loaded.txt"
[[ "$(snapshot_docker inspect --format '{{.State.ExitCode}}' "$snapshot_target")" == 0 ]]
cmp "$snapshot_evidence/source.txt" "$snapshot_evidence/loaded.txt"
snapshot_passed=true

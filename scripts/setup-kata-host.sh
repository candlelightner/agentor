#!/usr/bin/env bash
# Operator-run setup for the standard Ubuntu 24.04 Docker Engine host.
set -euo pipefail

KATA_VERSION=4.2.0
KATA_ROOT=/opt/kata
KATA_RUNTIME=agentor-kata-qemu
KATA_SHIM=/opt/kata/runtime-rs/bin/containerd-shim-kata-v2
KATA_CONFIG=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml
KATA_MARKER=/opt/kata/.agentor-kata-release
DOCKER_CONFIG=/etc/docker/daemon.json
DOCKER_SOCKET=unix:///var/run/docker.sock
setup_scratch=
setup_staged_config=

cleanup_setup() {
  # Persistent state survives install_host's function scope and set -u.
  [[ -z "$setup_scratch" ]] || rm -rf -- "$setup_scratch"
  [[ -z "$setup_staged_config" ]] || rm -f -- "$setup_staged_config"
  setup_scratch=
  setup_staged_config=
}

require_root() { [[ "${EUID}" == 0 ]] || die 'Run --install as root with sudo.'; }

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage:
  setup-kata-host.sh --preflight
  setup-kata-host.sh --install --accept-install --accept-docker-restart
  setup-kata-host.sh --status
  setup-kata-host.sh --render-daemon-config INPUT OUTPUT
  setup-kata-host.sh --validate-archive ARCHIVE.tar.zst

Run --preflight first. --install changes this host and restarts Docker only with
both explicit consent flags. --render-daemon-config is for offline fixtures.
EOF
}

validate_archive() {
  python3 "$(dirname -- "${BASH_SOURCE[0]}")/validate-kata-archive.py" "$1"
}

same_daemon_config() {
  [[ -f "$2" ]] && jq -e -n --slurpfile proposed "$1" --slurpfile current "$2" \
    '$proposed == $current' >/dev/null
}

expected_sha() {
  case "$1" in
    amd64) printf '%s\n' b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8 ;;
    arm64) printf '%s\n' 5dd4e9f2d5ea9e6bdfa2f476b3315335b58252366fcda2775a3094fc8fec376b ;;
    *) return 1 ;;
  esac
}

render_daemon_config() {
  local source=$1 output=$2
  [[ "$source" != "$output" ]] || die 'Input and output Docker config paths must differ.'
  command -v jq >/dev/null || die 'jq is required to preserve existing Docker configuration.'
  if [[ "$source" == /dev/null ]]; then
    printf '{}\n' | jq --arg name "$KATA_RUNTIME" --arg shim "$KATA_SHIM" --arg config "$KATA_CONFIG" '
      .runtimes = ((.runtimes // {}) + {($name): {runtimeType: $shim, options: {ConfigPath: $config}}})
    ' > "$output"
    return
  fi
  jq -e --arg name "$KATA_RUNTIME" --arg shim "$KATA_SHIM" --arg config "$KATA_CONFIG" '
    if type != "object" then error("Docker config must be a JSON object") else . end
    | if (.runtimes? != null and (.runtimes | type) != "object") then error("runtimes must be an object") else . end
    | if (.runtimes[$name]? != null and .runtimes[$name] != {runtimeType: $shim, options: {ConfigPath: $config}})
      then error("existing agentor-kata-qemu runtime has a different configuration") else . end
    | .runtimes = ((.runtimes // {}) + {($name): {runtimeType: $shim, options: {ConfigPath: $config}}})
  ' "$source" > "$output"
}

docker_server_version() {
  docker -H "$DOCKER_SOCKET" version --format '{{.Server.Version}}' 2>/dev/null
}

daemon_config_matches() {
  [[ -f "$DOCKER_CONFIG" ]] && jq -e --arg runtime "$KATA_RUNTIME" --arg shim "$KATA_SHIM" --arg config "$KATA_CONFIG" \
    '.runtimes[$runtime] == {runtimeType:$shim,options:{ConfigPath:$config}}' "$DOCKER_CONFIG" >/dev/null 2>&1
}

docker_runtime_report_matches() {
  # Moby v26.1.5 and docker-v29.1.3 daemon/info_unix.go copy only Path/Args
  # into Info.Runtimes, not shim-v2 Type/Options. A shim-v2 alias can be {}.
  # Verify registration and reject any exposed contradictions, but never infer
  # that this API proves the running daemon's ConfigPath (or a successful boot).
  docker -H "$DOCKER_SOCKET" info --format '{{json .Runtimes}}' 2>/dev/null |
    jq -e --arg runtime "$KATA_RUNTIME" --arg shim "$KATA_SHIM" --arg config "$KATA_CONFIG" \
      'type == "object" and (.[$runtime] | type == "object"
        and ((has("path") | not) or .path == "")
        and ((has("runtimeArgs") | not) or .runtimeArgs == [])
        and ((has("runtimeType") | not) or .runtimeType == $shim)
        and ((has("options") | not) or .options == {ConfigPath:$config}))' >/dev/null 2>&1
}

docker_runtime_matches() {
  daemon_config_matches && docker_runtime_report_matches
}

runtime_failure_diagnostics() {
  printf 'Runtime verification: exact daemon.json configuration matches: ' >&2
  if daemon_config_matches; then printf 'yes\n' >&2; else printf 'no\n' >&2; fi
  printf 'Docker runtime registration (options/arguments omitted from diagnostics):\n' >&2
  if ! docker -H "$DOCKER_SOCKET" info --format '{{json .Runtimes}}' 2>/dev/null |
    jq --arg runtime "$KATA_RUNTIME" \
      'if type != "object" then error("runtime map is not an object") else
        {runtime:$runtime,registered:has($runtime),entryType:(.[$runtime]|type),
         path:(.[$runtime] | if type == "object" then .path else null end),
         runtimeType:(.[$runtime] | if type == "object" then .runtimeType else null end)} end' >&2; then
    printf 'Could not read a valid runtime map from the local Docker daemon.\n' >&2
  fi
}

host_arch() {
  case "$(uname -m)" in
    x86_64) printf 'amd64' ;;
    aarch64) printf 'arm64' ;;
    *) printf 'unsupported' ;;
  esac
}

preflight() {
  command -v jq >/dev/null || die 'jq is required to report host compatibility.'
  local os_id=unknown os_version=unknown arch docker_version=unknown docker_major=0
  local errors=() rootless=false
  if [[ -r /etc/os-release ]]; then
    # os-release is provided by the host OS, not user supplied input.
    # shellcheck disable=SC1091
    source /etc/os-release
    os_id=${ID:-unknown}
    os_version=${VERSION_ID:-unknown}
  fi
  [[ "$os_id" == ubuntu && "$os_version" == 24.04 ]] || errors+=("Only Ubuntu 24.04 is in the candidate matrix; other hosts need separate compatibility review. No matrix is physically validated yet.")
  arch=$(host_arch)
  [[ "$arch" != unsupported ]] || errors+=("Only amd64 and arm64 Kata 4.2.0 release artifacts are pinned.")
  [[ -c /dev/kvm ]] || errors+=("/dev/kvm is unavailable; enable hardware or nested virtualization and KVM.")
  [[ -c /dev/vhost-vsock ]] || errors+=("/dev/vhost-vsock is unavailable; load vhost_vsock before installing.")
  [[ -S /var/run/docker.sock ]] || errors+=("Local Docker Engine socket /var/run/docker.sock is unavailable.")
  command -v docker >/dev/null || errors+=("Docker CLI is required.")
  command -v dockerd >/dev/null || errors+=("Docker Engine dockerd is required.")
  command -v systemctl >/dev/null || errors+=("systemd Docker service is required.")
  command -v curl >/dev/null || errors+=("curl is required.")
  command -v zstd >/dev/null || errors+=("zstd is required to unpack the pinned Kata release.")
  command -v tar >/dev/null || errors+=("tar is required to unpack the pinned Kata release.")
  command -v sha256sum >/dev/null || errors+=("sha256sum is required to verify the pinned Kata release.")
  command -v python3 >/dev/null || errors+=("python3 is required to validate archive paths, types, and links.")
  [[ ! -L /etc/docker && ! -L "$DOCKER_CONFIG" ]] || errors+=("Symlinked Docker configuration paths require manual review.")
  if command -v docker >/dev/null && [[ -S /var/run/docker.sock ]]; then
    docker_version=$(docker_server_version || printf unknown)
    docker_major=${docker_version%%.*}
    [[ "$docker_major" =~ ^[0-9]+$ ]] || docker_major=0
    (( docker_major >= 26 )) || errors+=("Docker Engine 26 or newer is required; detected ${docker_version}.")
    if docker -H "$DOCKER_SOCKET" info --format '{{json .SecurityOptions}}' 2>/dev/null | jq -e 'index("name=rootless") != null' >/dev/null 2>&1; then
      rootless=true
      errors+=("Rootless Docker Engine is not supported by this host installer.")
    fi
  fi
  if command -v systemctl >/dev/null && ! systemctl is-active --quiet docker.service; then
    errors+=("docker.service must be active on this host.")
  fi
  # The script edits the standard config path only; custom daemon config needs review.
  if command -v systemctl >/dev/null && systemctl cat docker.service 2>/dev/null | grep -q -- '--config-file'; then
    errors+=("docker.service uses a custom --config-file; review its location and configure Kata manually.")
  fi
  if [[ -e "$DOCKER_CONFIG" ]] && ! jq -e 'type == "object"' "$DOCKER_CONFIG" >/dev/null 2>&1; then
    errors+=("/etc/docker/daemon.json is not a valid JSON object.")
  fi
  local error_json
  error_json=$(printf '%s\n' "${errors[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')
  jq -n --arg arch "$arch" --arg os "$os_id" --arg osVersion "$os_version" --arg dockerVersion "$docker_version" \
    --arg runtime "$KATA_RUNTIME" --arg release "$KATA_VERSION" --argjson rootless "$rootless" --argjson errors "$error_json" \
    '{prerequisitesDetected:($errors|length == 0),physicalHostValidated:false, os:$os, osVersion:$osVersion, arch:$arch, dockerVersion:$dockerVersion, rootless:$rootless, runtime:$runtime, kataVersion:$release, errors:$errors}'
  (( ${#errors[@]} == 0 ))
}

status() {
  local arch expected installed=false registered=false active=false
  arch=$(host_arch)
  expected=$(expected_sha "$arch" 2>/dev/null || printf unsupported)
  if [[ -f "$KATA_MARKER" && -x "$KATA_SHIM" && -f "$KATA_CONFIG" ]] &&
    [[ "$(<"$KATA_MARKER")" == "$KATA_VERSION $arch $expected" ]]; then
    installed=true
  fi
  if daemon_config_matches; then
    registered=true
  fi
  if command -v docker >/dev/null && [[ -S /var/run/docker.sock ]] &&
    docker_runtime_report_matches; then
    active=true
  fi
  jq -n --arg runtime "$KATA_RUNTIME" --arg version "$KATA_VERSION" --argjson installed "$installed" \
    --argjson registered "$registered" --argjson active "$active" \
    '{runtime:$runtime,kataVersion:$version,installed:$installed,daemonConfigRegistered:$registered,dockerReportsRuntime:$active,dockerRuntimeOptionsVerified:false,canaryResult:"not_recorded"}'
}

install_host() {
  require_root
  preflight >&2 || die 'Host preflight failed; no files changed.'
  local arch expected archive_url scratch staged_config backup='' existing=false config_changed=false failure_reason=''
  arch=$(host_arch)
  expected=$(expected_sha "$arch")
  archive_url="https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-${arch}.tar.zst"
  if [[ -e "$KATA_ROOT" || -L "$KATA_ROOT" ]]; then
    [[ -d "$KATA_ROOT" && ! -L "$KATA_ROOT" && -f "$KATA_MARKER" && -x "$KATA_SHIM" && -f "$KATA_CONFIG" ]] || die '/opt/kata already exists and is not a complete Agentor-managed Kata installation; inspect it manually.'
    [[ "$(<"$KATA_MARKER")" == "$KATA_VERSION $arch $expected" ]] || die '/opt/kata has another release; explicit upgrade review is required.'
    existing=true
  fi
  mkdir -p "$(dirname -- "$KATA_ROOT")" "$(dirname -- "$DOCKER_CONFIG")"
  trap cleanup_setup EXIT
  setup_scratch=$(mktemp -d "$(dirname -- "$KATA_ROOT")/.agentor-kata-setup.XXXXXXXX")
  scratch=$setup_scratch
  setup_staged_config=$(mktemp "$(dirname -- "$DOCKER_CONFIG")/.agentor-daemon.XXXXXXXX")
  staged_config=$setup_staged_config
  render_daemon_config "$( [[ -f "$DOCKER_CONFIG" ]] && printf '%s' "$DOCKER_CONFIG" || printf /dev/null )" "$staged_config"
  dockerd --validate --config-file "$staged_config" >/dev/null || die 'Docker rejected the proposed daemon configuration; no files changed.'
  if [[ "$existing" == false ]]; then
    printf 'Downloading pinned Kata Containers %s for %s (about 1 GB on amd64).\n' "$KATA_VERSION" "$arch" >&2
    curl --proto '=https' --tlsv1.2 -fL --retry 3 -o "$scratch/kata.tar.zst" "$archive_url"
    printf '%s  %s\n' "$expected" "$scratch/kata.tar.zst" | sha256sum -c - >/dev/null || die 'Kata release checksum mismatch; no files changed.'
    mkdir -p "$scratch/unpack"
    validate_archive "$scratch/kata.tar.zst" || die 'Kata archive failed safe-extraction validation.'
    tar --zstd -xf "$scratch/kata.tar.zst" -C "$scratch/unpack" --no-same-owner
    [[ -x "$scratch/unpack/opt/kata/runtime-rs/bin/containerd-shim-kata-v2" ]] || die 'Kata release is missing the runtime-rs shim.'
    [[ -f "$scratch/unpack/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml" ]] || die 'Kata release is missing the QEMU configuration.'
    printf '%s %s %s\n' "$KATA_VERSION" "$arch" "$expected" > "$scratch/unpack/opt/kata/.agentor-kata-release"
    mv -- "$scratch/unpack/opt/kata" "$KATA_ROOT"
  fi
  if ! same_daemon_config "$staged_config" "$DOCKER_CONFIG"; then
    if [[ -f "$DOCKER_CONFIG" ]]; then
      backup=$(mktemp "${DOCKER_CONFIG}.agentor-kata-XXXXXXXX.bak")
      cp -p -- "$DOCKER_CONFIG" "$backup"
      printf 'Saved Docker configuration backup: %s\n' "$backup" >&2
      chmod --reference="$DOCKER_CONFIG" "$staged_config"
      chown --reference="$DOCKER_CONFIG" "$staged_config"
    else
      chmod 0644 "$staged_config"
    fi
    mv -- "$staged_config" "$DOCKER_CONFIG"
    config_changed=true
    printf 'Registered %s while preserving the Docker default runtime.\n' "$KATA_RUNTIME" >&2
  fi
  if [[ "$existing" == true && "$config_changed" == false ]] &&
    docker_runtime_matches; then
    status
    printf 'Kata files and daemon.json match; Docker reports the runtime alias. Docker was not restarted.\n' >&2
    printf 'Docker info does not verify active ConfigPath/options. Run scripts/check-kata-host.sh next.\n' >&2
    return
  fi
  # Explicit operator consent was required before entering this function.
  if ! systemctl restart docker.service; then
    failure_reason='Docker service restart failed.'
  elif ! docker_runtime_matches; then
    failure_reason='Docker runtime registration or exact on-disk configuration did not match after restart.'
  fi
  if [[ -n "$failure_reason" ]]; then
    runtime_failure_diagnostics
    if [[ "$config_changed" == true ]]; then
      if [[ -n "$backup" ]]; then cp -p -- "$backup" "$DOCKER_CONFIG"; else rm -f -- "$DOCKER_CONFIG"; fi
      systemctl restart docker.service || printf 'WARNING: Docker restart after configuration rollback also failed.\n' >&2
    fi
    die "$failure_reason Previous daemon.json was restored if this run changed it. Inspect docker.service before upgrading Agentor."
  fi
  status
  printf 'Run scripts/check-kata-host.sh next; a runtime listing is not a VM boot check.\n' >&2
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
case "${1:-}" in
  --preflight) [[ $# == 1 ]] || { usage >&2; exit 2; }; preflight ;;
  --status) [[ $# == 1 ]] || { usage >&2; exit 2; }; status ;;
  --render-daemon-config) [[ $# == 3 ]] || { usage >&2; exit 2; }; render_daemon_config "$2" "$3" ;;
  --validate-archive) [[ $# == 2 ]] || { usage >&2; exit 2; }; validate_archive "$2" ;;
  --install)
    [[ $# == 3 && " $2 $3 " == *' --accept-install '* && " $2 $3 " == *' --accept-docker-restart '* ]] ||
      die 'Both --accept-install and --accept-docker-restart are required; Docker restart can interrupt running services.'
    install_host
    ;;
  *) usage >&2; exit 2 ;;
esac
fi

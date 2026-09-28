#!/usr/bin/env bash
# Offline configuration fixtures only: never contacts Docker or changes the host.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
setup="$repo_dir/scripts/setup-kata-host.sh"
canary="$repo_dir/scripts/check-kata-host.sh"
fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$fixture_dir"' EXIT

bash -n "$setup" "$canary" "$repo_dir/install.sh"
python3 "$repo_dir/tests/kata-archive-fixtures.py"

printf '%s\n' '{"default-runtime":"runc","log-driver":"json-file","runtimes":{"other":{"path":"/usr/local/bin/other"}}}' > "$fixture_dir/existing.json"
bash "$setup" --render-daemon-config "$fixture_dir/existing.json" "$fixture_dir/merged.json"
jq -e '
  .["default-runtime"] == "runc"
  and .["log-driver"] == "json-file"
  and .runtimes.other.path == "/usr/local/bin/other"
  and .runtimes["agentor-kata-qemu"] == {
    runtimeType:"/opt/kata/runtime-rs/bin/containerd-shim-kata-v2",
    options:{ConfigPath:"/opt/kata/share/defaults/kata-containers/runtime-rs/configuration-qemu-runtime-rs.toml"}
  }
' "$fixture_dir/merged.json" >/dev/null

bash "$setup" --render-daemon-config "$fixture_dir/merged.json" "$fixture_dir/rerendered.json"
jq -e -n --slurpfile first "$fixture_dir/merged.json" --slurpfile second "$fixture_dir/rerendered.json" '$first == $second' >/dev/null

printf '%s\n' '{"runtimes":{"agentor-kata-qemu":{"path":"/usr/bin/other"}}}' > "$fixture_dir/conflict.json"
if bash "$setup" --render-daemon-config "$fixture_dir/conflict.json" "$fixture_dir/rejected.json" >/dev/null 2>&1; then
  printf 'Conflicting runtime registration was accepted.\n' >&2
  exit 1
fi
printf '%s\n' '{"runtimes":[]}' > "$fixture_dir/invalid-runtimes.json"
if bash "$setup" --render-daemon-config "$fixture_dir/invalid-runtimes.json" "$fixture_dir/rejected.json" >/dev/null 2>&1; then
  printf 'Non-object runtime registration was accepted.\n' >&2
  exit 1
fi
printf '%s\n' 'not json' > "$fixture_dir/malformed.json"
if bash "$setup" --render-daemon-config "$fixture_dir/malformed.json" "$fixture_dir/rejected.json" >/dev/null 2>&1; then
  printf 'Malformed Docker configuration was accepted.\n' >&2
  exit 1
fi
if bash "$setup" --install >/dev/null 2>&1; then
  printf 'Host installation did not require explicit consent flags.\n' >&2
  exit 1
fi

# Docker Info reports only Path/Args/status in Moby v26.1.5 and v29.1.3;
# unlike daemon.json, a shim-v2 entry is normally an empty object.
(
  source "$setup"
  DOCKER_CONFIG="$fixture_dir/merged.json"
  runtime_report='{"runc":{"path":"runc"},"agentor-kata-qemu":{}}'
  docker() { printf '%s\n' "$runtime_report"; }
  docker_runtime_matches
  for runtime_report in \
    '{"agentor-kata-qemu":{"status":{}}}' \
    '{"agentor-kata-qemu":{"path":"","runtimeArgs":[]}}'; do
    docker_runtime_matches
  done
  runtime_report=$(jq -c '.runtimes' "$DOCKER_CONFIG")
  docker_runtime_matches
  for runtime_report in \
    '{}' '[]' 'null' 'not-json' \
    '{"agentor-kata-qemu":null}' '{"agentor-kata-qemu":[]}' \
    '{"agentor-kata-qemu":"shim"}' \
    '{"agentor-kata-qemu":{"path":"/usr/bin/runc"}}' \
    '{"agentor-kata-qemu":{"runtimeArgs":["unexpected"]}}' \
    '{"agentor-kata-qemu":{"runtimeType":"unexpected-shim"}}' \
    '{"agentor-kata-qemu":{"options":{"ConfigPath":"unexpected-config"}}}'; do
    if docker_runtime_matches; then
      printf 'Invalid Docker Info runtime report was accepted: %s\n' "$runtime_report" >&2
      exit 1
    fi
  done
  runtime_report='{"agentor-kata-qemu":{}}'
  DOCKER_CONFIG="$fixture_dir/conflict.json"
  if docker_runtime_matches; then
    printf 'Alias-only report bypassed conflicting on-disk configuration.\n' >&2
    exit 1
  fi
  DOCKER_CONFIG="$fixture_dir/merged.json"
  docker() { return 1; }
  if docker_runtime_matches; then
    printf 'Failed Docker Info command was accepted.\n' >&2
    exit 1
  fi
)

# Source-only tests replace every host operation and redirect all installation
# paths into the fixture directory. They never invoke host installation mode.
mock_install() (
  source "$setup"
  local scenario=$1
  KATA_ROOT="$fixture_dir/$scenario/opt/kata"
  KATA_SHIM="$KATA_ROOT/shim"
  KATA_CONFIG="$KATA_ROOT/config"
  KATA_MARKER="$KATA_ROOT/marker"
  DOCKER_CONFIG="$fixture_dir/$scenario/etc/docker/daemon.json"
  mkdir -p "$KATA_ROOT" "$(dirname -- "$DOCKER_CONFIG")"
  printf 'fixture\n' > "$KATA_SHIM"
  chmod +x "$KATA_SHIM"
  printf 'fixture\n' > "$KATA_CONFIG"
  printf '%s amd64 %s\n' "$KATA_VERSION" "$(expected_sha amd64)" > "$KATA_MARKER"
  require_root() { :; }
  preflight() { :; }
  host_arch() { printf amd64; }
  dockerd() { :; }
  docker() {
    case "$scenario" in
      stale-active)
        if [[ ! -e "$fixture_dir/$scenario/restarts" ]]; then
          printf '{"agentor-kata-qemu":{"path":"/usr/bin/runc"}}\n'
          return
        fi ;;
      fail-missing|fail-existing) printf '{}\n'; return ;;
      fail-malformed) printf 'not-json\n'; return ;;
      fail-query) return 1 ;;
    esac
    printf '{"runc":{"path":"runc"},"agentor-kata-qemu":{}}\n'
  }
  systemctl() {
    printf '%s\n' "$*" >> "$fixture_dir/$scenario/restarts"
    [[ "$scenario" != fail-restart ]]
  }
  curl() { printf 'Unexpected download in managed-install fixture.\n' >&2; return 1; }
  status() { :; }
  if [[ "$scenario" == unchanged || "$scenario" == stale-active ]]; then
    render_daemon_config /dev/null "$fixture_dir/$scenario/rendered.json"
    # Deliberately use different whitespace to test semantic idempotence.
    jq -c . "$fixture_dir/$scenario/rendered.json" > "$DOCKER_CONFIG"
  elif [[ "$scenario" == fail-existing ]]; then
    cp "$fixture_dir/existing.json" "$DOCKER_CONFIG"
  fi
  install_host
  [[ -f "$DOCKER_CONFIG" ]]
  if [[ "$scenario" == unchanged ]]; then
    [[ ! -e "$fixture_dir/$scenario/restarts" ]]
  else
    [[ "$(<"$fixture_dir/$scenario/restarts")" == 'restart docker.service' ]]
  fi
  # Test cleanup after the function's local variables have gone out of scope.
  scratch_path=$setup_scratch
  staged_path=$setup_staged_config
  cleanup_setup
  [[ ! -e "$scratch_path" && ! -e "$staged_path" ]]
)
mock_install unchanged
mock_install registration-needed
mock_install stale-active

for scenario in fail-missing fail-existing fail-malformed fail-query fail-restart; do
  if mock_install "$scenario" > "$fixture_dir/$scenario.stdout" 2> "$fixture_dir/$scenario.stderr"; then
    printf 'Expected installation verification failure: %s\n' "$scenario" >&2
    exit 1
  fi
  if [[ "$scenario" == fail-existing ]]; then
    cmp "$fixture_dir/existing.json" "$fixture_dir/$scenario/etc/docker/daemon.json"
  else
    [[ ! -e "$fixture_dir/$scenario/etc/docker/daemon.json" ]]
  fi
  [[ "$(wc -l < "$fixture_dir/$scenario/restarts")" == 2 ]]
  grep -q 'Runtime verification: exact daemon.json configuration matches: yes' "$fixture_dir/$scenario.stderr"
  grep -q 'Docker runtime registration' "$fixture_dir/$scenario.stderr"
  grep -q 'Previous daemon.json was restored' "$fixture_dir/$scenario.stderr"
  if [[ "$scenario" == fail-query || "$scenario" == fail-malformed ]]; then
    grep -q 'Could not read a valid runtime map' "$fixture_dir/$scenario.stderr"
  elif [[ "$scenario" == fail-restart ]]; then
    grep -q 'Docker service restart failed' "$fixture_dir/$scenario.stderr"
    grep -q 'restart after configuration rollback also failed' "$fixture_dir/$scenario.stderr"
  fi
done

printf 'Kata host offline fixtures passed.\n'

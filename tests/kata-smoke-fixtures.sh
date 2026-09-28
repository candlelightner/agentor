#!/usr/bin/env bash
# Source-only fake Docker fixtures; no host socket, daemon, or container access.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$fixture_dir"' EXIT
cid=$(printf 'a%.0s' {1..64})

mock_run() (
  local scenario=$1
  shift
  source "$repo_dir/scripts/check-kata-host.sh"
  docker_available() { [[ "$scenario" != unavailable ]]; }
  timeout() {
    [[ "$1" =~ ^[0-9]+$ && "$1" -le 240 ]] || return 96
    shift
    "$@"
  }
  docker() {
    printf '%s\n' "$*" >>"$fixture_dir/$scenario.calls"
    [[ "$1" == -H && "$2" == unix:///var/run/docker.sock ]] || return 97
    shift 2
    case "$1" in
      info)
        [[ "$scenario" != missing-runtime ]] || { printf '{}\n'; return; }
        printf '{"agentor-kata-qemu":{}}\n' ;;
      pull) [[ "$scenario" != pull-failure ]] ;;
      create)
        [[ "$*" == *'--runtime agentor-kata-qemu'* ]] || return 98
        [[ "$scenario" != invalid-id ]] || { printf 'not-an-id\n'; return; }
        printf '%s\n' "$cid"
        [[ "$scenario" != create-failure-with-id ]] ;;
      inspect) printf '%s\n' agentor-kata-qemu ;;
      start)
        [[ "$scenario" != start-failure ]] || return 1
        [[ "$scenario" != restart-start-failure || "$initial_user_exec" == false ]] ;;
      exec)
        if [[ "$2" != --user ]]; then printf '6.18.35\n'; return; fi
        [[ "$3" == 1000:1000 && "$4" == "$cid" ]] || return 99
        if [[ "$initial_user_exec" == false && "$scenario" == initial-user-failure ]]; then return 1; fi
        if [[ "$initial_user_exec" == true && "$scenario" == restarted-user-failure ]]; then return 1; fi
        if [[ "$initial_user_exec" == true && "$scenario" == wrong-identity ]]; then printf '0:0'; return; fi
        printf '1000:1000' ;;
      restart) [[ "$scenario" != restart-failure ]] ;;
      stop)
        [[ "$scenario" != stop-uncertain ]] || return 124
        [[ "$scenario" != stop-failure ]] ;;
      rm)
        [[ $# == 3 && "$2" == -f && "$3" == "$cid" ]] || return 100
        [[ "$scenario" != cleanup-failure ]] ;;
      *) printf 'Unexpected fake Docker operation: %s\n' "$*" >&2; return 101 ;;
    esac
  }
  main "$@"
)

mock_run success >"$fixture_dir/success.json" 2>"$fixture_dir/success.stderr"
jq -e '.passed and .initialUserExecPassed and .restartPassed and .restartedUserExecPassed
  and (.isolationVerified == false) and .restartMethod == "stop-start"' "$fixture_dir/success.json" >/dev/null
[[ $(grep -c ' exec --user 1000:1000 ' "$fixture_dir/success.calls") == 2 ]]
[[ $(grep -c " rm -f $cid$" "$fixture_dir/success.calls") == 1 ]]
[[ $(grep -c " start $cid$" "$fixture_dir/success.calls") == 2 ]]
[[ $(grep -c " stop --time 10 $cid$" "$fixture_dir/success.calls") == 1 ]]
! grep -q ' restart ' "$fixture_dir/success.calls"
for method in stop-start docker; do
  mock_run "explicit-$method" --restart-method "$method" >"$fixture_dir/explicit-$method.json" 2>"$fixture_dir/explicit-$method.stderr"
  jq -e --arg method "$method" '.passed and .restartMethod == $method' "$fixture_dir/explicit-$method.json" >/dev/null
done
[[ $(grep -c ' restart ' "$fixture_dir/explicit-docker.calls") == 1 ]]
[[ $(grep -c " start $cid$" "$fixture_dir/explicit-docker.calls") == 1 ]]
! grep -q ' stop ' "$fixture_dir/explicit-docker.calls"

for scenario in unavailable missing-runtime pull-failure invalid-id create-failure-with-id \
  start-failure initial-user-failure restart-failure restarted-user-failure wrong-identity cleanup-failure; do
  if mock_run "$scenario" --restart-method docker >"$fixture_dir/$scenario.json" 2>"$fixture_dir/$scenario.stderr"; then
    printf 'Expected smoke-check failure: %s\n' "$scenario" >&2; exit 1
  fi
  jq -e '.passed == false and .isolationVerified == false' "$fixture_dir/$scenario.json" >/dev/null
  case "$scenario" in
    unavailable|missing-runtime|pull-failure|invalid-id)
      if [[ -f "$fixture_dir/$scenario.calls" ]] && grep -q ' rm ' "$fixture_dir/$scenario.calls"; then
        printf 'Cleanup ran without a valid created ID: %s\n' "$scenario" >&2; exit 1
      fi ;;
    *) [[ $(grep -c " rm -f $cid$" "$fixture_dir/$scenario.calls") == 1 ]] ;;
  esac
done
for scenario in stop-failure stop-uncertain restart-start-failure; do
  if mock_run "$scenario" --restart-method stop-start >"$fixture_dir/$scenario.json" 2>"$fixture_dir/$scenario.stderr"; then
    printf 'Expected stop/start failure: %s\n' "$scenario" >&2; exit 1
  fi
  jq -e '.passed == false and .restartMethod == "stop-start" and .restartPassed == false' "$fixture_dir/$scenario.json" >/dev/null
  ! grep -q ' restart ' "$fixture_dir/$scenario.calls"
  expected_starts=1
  [[ "$scenario" != restart-start-failure ]] || expected_starts=2
  [[ $(grep -c " start $cid$" "$fixture_dir/$scenario.calls") == "$expected_starts" ]]
  [[ $(grep -c " rm -f $cid$" "$fixture_dir/$scenario.calls") == 1 ]]
done
! grep -q ' stop ' "$fixture_dir/restart-failure.calls"
for scenario in invalid-method missing-method duplicate-method unknown-argument; do
  case "$scenario" in
    invalid-method) args=(--restart-method auto) ;;
    missing-method) args=(--restart-method) ;;
    duplicate-method) args=(--restart-method docker --restart-method stop-start) ;;
    unknown-argument) args=(--unrecognized) ;;
  esac
  if mock_run "$scenario" "${args[@]}" >"$fixture_dir/$scenario.stdout" 2>"$fixture_dir/$scenario.stderr"; then
    printf 'Accepted invalid smoke arguments: %s\n' "$scenario" >&2; exit 1
  fi
  [[ ! -e "$fixture_dir/$scenario.calls" ]]
done
jq -e '.initialUserExecPassed and .restartPassed and (.restartedUserExecPassed == false)' \
  "$fixture_dir/restarted-user-failure.json" >/dev/null
jq -e '.initialUserExecPassed and (.restartPassed == false) and (.restartedUserExecPassed == false)' \
  "$fixture_dir/restart-failure.json" >/dev/null
jq -e '.message | contains("cleanup failed")' "$fixture_dir/cleanup-failure.json" >/dev/null
grep -q "$cid" "$fixture_dir/cleanup-failure.stderr"
printf 'Kata smoke offline fixtures passed (3 success, 14 failure, 4 invalid-argument scenarios).\n'

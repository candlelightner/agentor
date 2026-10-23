#!/usr/bin/env bash
# Caller must hold the workflow's per-image promotion concurrency lock.
set -euo pipefail
phase='checking the current main revision'
trap 'printf "[image-promotion] Failed while %s; shared-tag promotion stopped, published SHA references retained.\n" "$phase" >&2' ERR
: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GITHUB_REF:?}" "${IMAGE:?}"
if [[ "$GITHUB_REF" != refs/heads/main || ! "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo '[image-promotion] Invalid main revision context; promotion stopped, published SHA references retained.' >&2
  exit 1
fi
head_sha=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo '[image-promotion] Invalid main head response; promotion stopped, published SHA references retained.' >&2
  exit 1
fi
# A newer revision may have passed its build while this run was waiting.
if [[ "$head_sha" != "$GITHUB_SHA" ]]; then
  echo '[image-promotion] Run is no longer main HEAD; main/latest promotion skipped, published SHA references retained.'
  exit 0
fi
phase='promoting main/latest from the full commit reference'
docker buildx imagetools create --tag "$IMAGE:main" --tag "$IMAGE:latest" "$IMAGE:sha-$GITHUB_SHA"
echo '[image-promotion] Current main revision promoted to main/latest; published SHA references retained.'

#!/usr/bin/env bash
# Run inside the candidate image with a fresh checked-out workspace, no socket.
set -euo pipefail
phase='checking the image contract'
trap 'printf "[ci-quality] Failed while %s; quality validation stopped; dependent publication is blocked and the image is ineligible for publication.\n" "$phase" >&2' ERR
node tests/ci-quality/check-image.mjs --preflight
phase='installing checked-out orchestrator dependencies'
npm ci --prefix orchestrator --no-audit --no-fund
phase='installing checked-out test dependencies'
npm ci --prefix tests --no-audit --no-fund
phase='checking preinstalled browser and system tools'
node tests/ci-quality/check-image.mjs
phase='typechecking the orchestrator'
(cd orchestrator && npm run typecheck)
phase='running ordinary module, browser and security fixtures'
(cd tests && npm run test:modules -- --grep-invert 'api/(incus-admin-restore|incus-derived-image|incus-docker-restore-archive|incus-selected-restore|managed-kilo-parent|portable-pax-size)\.spec\.ts')
phase='checking the CI profiler'
python3 scripts/profile-ci-workflow.py --self-test
phase='running the existing root-owned archive fixture split'
(cd tests && sudo -- "$(command -v node)" ./node_modules/@playwright/test/cli.js test \
  --config=playwright.modules.config.ts \
  api/incus-admin-restore.spec.ts api/incus-derived-image.spec.ts \
  api/incus-docker-restore-archive.spec.ts api/incus-selected-restore.spec.ts \
  api/managed-kilo-parent.spec.ts api/portable-pax-size.spec.ts)
printf '[ci-quality] Full quality validation passed.\n'

# Standalone quality image: phase-one operator contract

Issue [#47](https://github.com/candlelightner/agentor/issues/47) evaluates a
separate Ubuntu 24.04 amd64 image for the quality job. This is a preparation
path: active CI still uses its existing hosted runner, and no timing result yet
justifies switching it.

## Image contents and validation

The candidate combines Ubuntu 24.04 with the official Node 22 and Docker 28 CLI
images, plus the system tools used by the quality and archive-fixture suites.
It includes the Playwright browser installed from the checked-in test lockfile.
It does not bake in application or test `node_modules`; the job installs both
workspaces with `npm ci` from the current lockfiles. A checked-in compatibility
guard generates a compatibility contract inside the image from the checked-in
test lock, image recipe, and guard. It binds the candidate to Ubuntu 24.04,
Linux amd64, Node 22 and ABI, Playwright, Chromium, and supported tool versions.
The preflight runs before dependency installation, and the full check runs
before tests. Missing or stale inputs stop validation with a fixed reason and
outcome; they never trigger a tool or browser download fallback.

Quality commands run as the unprivileged UID/GID 1001. The six existing
archive-fixture specs that need root are excluded from the ordinary module run
and run unchanged through passwordless `sudo`; do not run the full suite as
root. Docker and Compose are clients only: the quality image has no daemon,
host socket, or privileged-container requirement. Keep the existing isolated
Docker-in-Docker regression image and workflow unchanged.

For a local candidate check, use a Linux amd64 host with Docker Buildx and a
local Docker engine. The checkout and npm-cache directory mounted below must
be writable by UID 1001, which runs the candidate. The container run does not
mount the host Docker socket or use Docker `--privileged`; its `sudo` remains
limited to the six existing root-owned fixtures.

```sh
python3 -m unittest discover -s tests/helpers -p test_ci_quality_image.py

docker buildx build --pull --no-cache --platform linux/amd64 --load \
  -f tests/ci-quality/Dockerfile \
  -t agentor-quality-candidate:local .

QUALITY_NPM_CACHE=/tmp/agentor-quality-npm-cache
mkdir -p "$QUALITY_NPM_CACHE"
docker run --rm --init --shm-size=1g \
  --mount "type=bind,src=$PWD,dst=/workspace" \
  --mount "type=bind,src=$QUALITY_NPM_CACHE,dst=/home/runner/.npm" \
  --env CI=true agentor-quality-candidate:local \
  bash tests/ci-quality/run-quality.sh
```

The Python check is an offline contract/workflow test. These commands pull
public base images but do not log in to or push to a registry; the run installs
current workspace lockfiles. Local build or install elapsed time is not a
matched hosted adoption benchmark.

## Refresh and publication boundaries

CI maintainers own the quality-image workflow, recipe, compatibility guard,
and weekly refresh. Refresh floating Ubuntu 24.04, Node 22, and Docker 28 base
inputs with BuildKit pulling current tags and disabling build cache. The
generated contract records the actual Node patch and ABI, npm and supported
tool versions, exact Playwright/Chromium versions, and hashes of the test lock,
image recipe, and guard. Build provenance also records resolved public base
materials and their digests. Browser security updates require a reviewed test
lockfile bump, not an unreviewed browser download during a job.

CI maintainers should review each weekly scheduled main run. Candidate
validation must pass before the publisher can run. A refresh or validation
failure blocks new publication and never changes active jobs; once an approved
digest exists, it remains available while maintainers resolve the failure.
Preserve the workflow run summary as the source-SHA, image-contract,
base-material, and published-digest receipt. The same-run image handoff
artifact expires after one day; a separate compact publication receipt is
retained for 30 days.

Pull-request validation is read-only and receives no package-write permission.
Only a trusted `main` run may publish, and it must publish the exact image
artifact that passed candidate validation. Use the unique source-SHA/run-ID/
attempt tag, then retain the registry's immutable digest with the run's image
contract and resolved base materials; do not move a `latest` tag. The
preparation workflow has not yet been used to publish an image. A successful
push does not make the package anonymously pullable by itself; verify an
anonymous clean pull of the pinned digest before considering untrusted-PR
adoption. Before merging this workflow, review and approve the
package name, automatic publication on matching `main` pushes, weekly runs and
manual dispatches, and the intended package visibility. The initial merge
itself triggers a matching main push. The workflow does not change package
visibility, grant PR registry credentials, or switch active CI.

## Adoption and rollback gate

Keep issue #47 open until a clean registry pull passes the unchanged quality
suite with functional parity and matched hosted cold and warm runs show the
full elapsed time, including image pull and dependency installation. Local
single-CPU timings are not a hosted comparison. Adopt the image only if those
matched measurements improve the quality path without changing its checks.
Until then, leave the active job alone. If a later adoption regresses, restore
the previously approved image digest together with its matching lock and
compatibility contract; do not roll back to a floating tag.

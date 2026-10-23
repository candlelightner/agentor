# Standalone quality image: phase-one operator contract

Issue [#47](https://github.com/candlelightner/agentor/issues/47) introduced a
separate Ubuntu 24.04 amd64 image for the quality job. The existing quality
job and test gate now select the reviewed immutable image when its approved
inputs match; incompatible checkouts run all existing baseline checks.

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
mount the host Docker socket or use Docker `--privileged`; the quality command uses `sudo`
only for the six existing root-owned fixtures.

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
initial trusted publication passed and its digest is anonymously pullable. A successful
push does not make the package anonymously pullable by itself. The reviewed
digest passed anonymous clean pulls and full quality in both hosted benchmark
image jobs. Maintainers must review future publication-trigger or package
visibility changes. The existing workflow does not change package visibility,
grant PR registry credentials, or automatically change the reviewed active pin.

## Guarded selection, updates and rollback

`tests/ci-quality/approved-image.json` reviews the canonical immutable image
reference, Node 22 ABI 127 and the three approved test-lock, Dockerfile and
live-guard hashes. The host's stdlib selector compares those fixed input paths
without running image code. Matching inputs select the image. Changed or
missing inputs log why all existing baseline quality commands will run,
including the original sudo split. This lets a Playwright/recipe update pass
PR checks before a trusted main workflow can publish its new compatible image;
there is no image-publication/merge deadlock.

A malformed pin or noncanonical/nonimmutable reference fails selection with
a visible reason. Once selected, an image pull, contract or test failure is a
real quality failure: there is no error-triggered baseline retry. The image's
own guard remains strict. The container receives only the checkout, npm
download-cache mount and `CI=true`; anonymous pull uses an empty host-side
Docker configuration, which is never mounted into quality. The image path
caches npm downloads by runner OS/architecture, Node ABI and both lockfiles,
and runs `npm ci` every time. It never caches project `node_modules`.

Weekly publication does not move the active pin. Maintainers review the
publication receipt and compatible inputs, then update the digest/hashes in a
separate PR. If adoption regresses, restore the last approved digest and its
matching hashes, or remove image selection while preserving all baseline
checks. Do not weaken the live guard or roll back to a floating tag.

## Hosted measurements and limits

[Run 39930171116](https://github.com/candlelightner/agentor/actions/runs/39930171116)
measured two independent Ubuntu 24.04 hosted pairs at PR-merge checkout
`40f5f2094a16a612a4756ec9a448836125a1b829`. Each arm ran cold then warm from
fresh tracked workspaces, using Node 22.23.4 and the same locks/browser/tests.
Cold npm/browser download directories were empty; the pinned image was absent
before anonymous pull. Existing runner tools, shared base layers and Node's
hosted tool cache were not pruned. Warm reused that arm's download/browser
cache and image layers, with fresh workspaces and `npm ci`.

| Pair/sample | Baseline | Pinned image, including pull | Image difference |
| --- | ---: | ---: | ---: |
| 1 cold | 897.36s | 283.21s | 614.15s faster; installation outlier |
| 1 warm | 245.06s | 260.51s | 15.45s slower |
| 2 cold | 326.72s | 274.04s | 52.68s faster (16.1%) |
| 2 warm | 264.09s | 251.85s | 12.25s faster |

Image cold pulls took 20.53s and 19.61s. All eight samples passed exact source,
lock, Node/browser and per-case pass/skip parity: 1,907 ordinary passes and 65
skips, plus 61 root-fixture passes and one skip, with no unexpected/flaky tests.
Warm medians were effectively tied: baseline 254.58s, image 256.18s.

Pair 1 baseline spent 577.25s in Chromium/library installation; its precise
mirror/download cause was not retained. That outlier dominates the two-sample
cold median and does not justify a routine 54.5% speedup claim. The second
cold pair showed a real pull-inclusive 52.68s saving, but recent ordinary active
quality jobs were around 289–294s, so routine gains could be only 10–15s.
Independent machines and package/network variation remain limitations. The
change targets cold preparation reliability and a modest routine preparation
saving while retaining an explicit complete baseline path; it does not promise every future run will be faster. Local
single-CPU measurements are not included in this hosted comparison.

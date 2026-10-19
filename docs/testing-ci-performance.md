# CI performance measurements

Issue [#22](https://github.com/candlelightner/agentor/issues/22) targets the time
between a source change and validated images. Keep the isolated Docker regression,
module tests, native amd64/arm64 builds, and test gate intact when comparing changes.
All figures below describe public GitHub-hosted CI, with no deployment diagnostics.

## Reproduce the profile

The profiler uses read-only `gh run view` calls for run/job metadata and selected
job logs. It emits numeric timing/cache/disk aggregates plus workflow job/step names;
it does not save or emit raw logs, runner hostnames, addresses, or credentials.
It requires Python 3 and an authenticated GitHub CLI with read access.

```sh
python3 scripts/profile-ci-workflow.py --self-test
python3 scripts/profile-ci-workflow.py --repo candlelightner/agentor \
  39162764839 39163852725 39166236297 39167116698 \
  39285683149 39286626898 > /tmp/agentor-ci-profile.json
```

Underlying commands, for examining a particular public job privately:

```sh
gh run view RUN_ID --repo OWNER/REPO --json jobs,createdAt,startedAt,event,conclusion,attempt
gh run view RUN_ID --repo OWNER/REPO --job JOB_ID --log
```

Use `--attempt 1` to separate a failed attempt from its retry. The default GitHub
view may combine successful jobs from earlier attempts with retried jobs.
Use `--input-dir DIR` instead of `--repo` to analyze previously downloaded
`RUN_ID.json`, `RUN_ID-regression.log`, and `RUN_ID-amd64.log` privately.
Do not commit raw logs. The script's synthetic parser check requires no network.

Durations come from job/step start and completion timestamps. Each attempt's
elapsed time starts at its own `startedAt` and ends at its last job completion;
reruns exclude the previous attempt and manual delay. Saved rerun metadata must
include `startedAt`; the profiler refuses to guess from the original creation
time. `updatedAt` can change after completion. Initial dispatch delay
includes scheduling and runner provisioning; it is **not** an exact queue-only
measurement. Delay between dependent jobs also includes dispatch overhead.
Missing phase markers produce `null`, not a fabricated duration. Inner worker
completion uses `Worker image built.` when available, falling back to the old
Docker image naming event. The profiler records the separate outer-runner build
step, bounded regression step, and entire regression job so moving work between
steps cannot masquerade as a speedup. The new `outer_and_bootstrap` phase excludes
the separately recorded outer build action. Compare whole-job durations first.

## Baseline: 18–19 October 2026

These are six representative successful runs on the previous workflow. Main #29
needed a manifest retry and must not be treated as an ordinary end-to-end sample.
Links retain the underlying job and step intervals.

| Run | Trigger | Last job complete | Regression step | Outer runner + daemon | Inner worker build | Inner orchestrator build | Test cases |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [39162764839](https://github.com/candlelightner/agentor/actions/runs/39162764839) | PR #20 | 12m20s | 9m49s | 61s | 281s | 99s | 107s |
| [39163852725](https://github.com/candlelightner/agentor/actions/runs/39163852725) | main #20 | 13m27s | 10m12s | 54s | 314s | 98s | 107s |
| [39166236297](https://github.com/candlelightner/agentor/actions/runs/39166236297) | PR #23 | 11m00s | 8m13s | 67s | 267s | 68s | 64s |
| [39167116698](https://github.com/candlelightner/agentor/actions/runs/39167116698) | main #23 | 12m22s | 9m34s | 57s | 276s | 97s | 104s |
| [39285683149](https://github.com/candlelightner/agentor/actions/runs/39285683149) | PR #29 | 12m58s | 10m18s | 57s | 304s | 103s | 112s |
| [39286626898](https://github.com/candlelightner/agentor/actions/runs/39286626898) | main #29 | 14m54s* | 10m32s | 72s | 366s | 85s | 75s |

For example, PR #23 was created at 21:05:01 UTC. Its regression job ran
21:05:13–21:13:58; the bounded regression step ran 21:05:16–21:13:29. Inner
image builds ran 21:06:23–21:11:58, and test cases ran 21:12:24–21:13:28.
The test gate finished 21:14:03; the final architecture job finished 21:16:01.

The outer phase includes Compose startup, runner image download/build, container
launch, and inner daemon bootstrap. Worker build ends at its image naming event;
orchestrator build ends at `Images built`. Test cases exclude Playwright process
setup. Additional regression time comprises stack startup (6–7s), test dependency
installation (16–27s), Playwright process setup (5–8s), and post-test cleanup
(21–32s). Job setup adds another 3–5s before the bounded step.

*Main #29's first manifest merge failed during the GHCR outage at 16:48:56 UTC;
its retry completed 16:50:04. Both architecture builds had succeeded by 16:48:34.
The failed manifest job took 23s; the retry took 15s. Keep the retry and intervening
manual delay separate from ordinary build performance. Main #20 also retried a
worker build after a transient VS Code CLI download failure.

### Critical path and cache evidence

Initial dispatch took 3–4s; validation jobs started 3–4s after change detection.
The parallel quality job took 254–287s. Its dependency installs took 27–44s,
Chromium/system setup 14–16s, typecheck 28–35s, module tests 151–166s, and
root-owned fixtures 12–15s. Regression was always the longer validation job.

Inner image builds consumed **335–451s, about 68–72% of the regression step**.
Five runs show no inner `CACHED` lines. Main #20 shows nine after a retry within
the same run; these do not demonstrate caching between runs. Every regression
started with zero outer build cache and zero local volumes. Persisting a DinD
volume helps repeated local runs, but a new hosted runner does not inherit it.

In contrast, each existing amd64 architecture build imported the GitHub Actions
BuildKit cache and reported 5–6 cached layers. After the test gate, the architecture
matrix added another 108–123s to the critical path. Successful main manifest jobs
normally added 15–22s after architecture builds.

### Disk evidence and limits

Every baseline capacity sample reported approximately **86 GiB free** on a
145 GiB runner filesystem before regression, with 1.869 GB of Docker images,
zero local volumes, and zero build cache. These are rounded public CI aggregates.
There is no post-build or peak-disk sample in the baseline, so 86 GiB is only the
minimum **observed before building**, not a measured minimum during the job.

The old 16 GiB guard referred to a previous 12.5 GiB warm local footprint plus
3.5 GiB transient allowance. It does not establish headroom for an added BuildKit
store plus `--load` or duplicate cached layers. The new admission requirement is
**24 GiB**, a conservative estimate rather than a measured peak. A sampler starts
before the outer build action and runs through regression and cleanup, recording
available disk every ten seconds. Its final fixed-format aggregate is parsed as
`sampled_min_available_disk_gib`; malformed values and extra text are ignored.
A ten-second sample can miss a shorter transient peak, so describe this as sampled
headroom, not an exact peak measurement. Use only synthetic CI builds and aggregate
disk figures in published comparisons.

## Candidate changes, ranked

1. **Cache exact-source images for the private regression daemon.** This addresses
   the measured 335–451s repeated image-build cost. Keep isolated Docker state,
   the production sizing-helper smoke check, and image identity validation.
   Cache import/export, image transfer/load, and cache misses have costs; the
   gross build opportunity is not a measured net saving.
2. **Overlap unpublished architecture builds with validation if still needed.**
   The current post-gate tail is 108–123s. Publishing and tag promotion must
   continue to require passing tests. Measure extra contention and avoid granting
   publication access to pull requests.
3. **Cache the outer test-runner build if material afterward.** Its whole phase
   costs 54–72s, some of which is startup rather than cacheable build work. Large
   browser layers can make cache export/restore expensive.
4. **Keep the current browser setup and test coverage.** Quality's Chromium
   installation is only 14–16s and runs in parallel. It is not today's critical
   path. Shared-state regression sharding adds complexity to a 64–112s test phase
   while most time is still spent building images.

## Selected strategy awaiting final-path measurement

Keep the ordinary Compose build for the outer test-runner. An explicit outer
BuildKit cache was tested and rejected: its action took 342s cold and 163s warm,
versus the old complete runner/bootstrap phase of 54–72s. The timing domains
are not identical, but the cached build action alone exceeded the previous whole
phase in both samples. Moving that cost out of the bounded regression step is
not a speed improvement.

Inside the private regression daemon, worker and orchestrator builds use separate
GHA cache scopes and load current source builds into that daemon. Existing
`worker-amd64` and `orchestrator-amd64` release scopes are additional import-only
seeds; exports remain in dedicated test scopes. BuildKit checks Dockerfile,
source, platform, and build inputs, so cache reuse cannot skip changed source.
This caches image layers; live Docker volumes, container state, credentials, and
test outputs are not cache artifacts. The production sizing-helper smoke check
and regression coverage remain in the execution path.

Cache API transfers have configured timeouts; these do not bound the entire
export stage (the experimental cold worker export took 298s despite `timeout=2m`).
Cache export errors do not fail a source build. Failed cache-backed builds retry
from the same source without remote cache arguments. The inner builder prunes
duplicate build layers after each loaded image; cleanup failure stops the run
rather than proceeding with unknown disk headroom. Publication and native
architecture-build ordering retain the test gate.

The existing release scopes were observed using cache API v2. Public cache-list
metadata cannot attribute content-addressed shared blobs to one scope, so it is
not an honest per-image size measurement. Read-only release imports avoid a new
write destination but do not eliminate storage used by dedicated test exports.

Inner caching still adds import/export, builder startup, image load, and cleanup
costs. The selected path requires fresh PR validation plus main cold/warm
measurements. The completed two-cache experiment below is evidence for choosing
the path; it is not a benchmark of this final selection.

### Experimental cold hosted result

[PR #30, run 39291752872, attempt 1](https://github.com/candlelightner/agentor/actions/runs/39291752872/attempts/1)
passed all validation and native image builds. The same 35 isolated regression
tests passed, with no image-build retry and no cached layers. This first run took
**24m02s**, versus the baseline's 11m00s–13m27s without registry retry. It is a
measured cold regression, not an established speed improvement.

The entire isolated regression job took 23m07s. Outer-runner preparation took
342s, including a 251.1s cache export. The bounded regression step took 1015s:
worker build/load/cache/cleanup consumed 742.2s and orchestrator consumed 159.2s.
Worker Docker image export took 174.2s, including an overlapping 71.9s import into
Docker; cache export then took 298.0s. Orchestrator Docker export took 9.4s,
including a 6.2s Docker import; cache export took 58.1s. Do not sum nested image
export/import intervals. Cache import stages took only 0.1–0.2s and had no hits.
The test-case interval was 76.6s. Minimum sampled available disk was 62.61 GiB.
The logs do not separately attribute every compression and transfer sub-operation.

| Candidate | Effort | Benefit constrained by evidence |
| --- | --- | --- |
| Inner image caching | Medium; implemented | Targets 335–451s repeated builds; cold export/load overhead is substantial; warm inner phase fell to 175s |
| Import existing release scopes as read-only seed | Low | Could reduce first-build misses; exact-source keys preserve correctness, actual hits and quota impact require a run |
| Outer runner caching | Low; implemented | Old whole phase was 54–72s; cold export alone took 251s, so the action was rejected even after a warm rerun |
| Overlap architecture builds while retaining publication gate | Medium | Old post-gate tail 108–123s; extra contention may reduce the benefit |
| Browser setup optimization | Low | Only 14–16s in a parallel noncritical job; little end-to-end opportunity |

### Experimental warm hosted result

[The same run, attempt 2](https://github.com/candlelightner/agentor/actions/runs/39291752872/attempts/2)
passed all jobs in **9m03s**, measured from its own 17:34:06 UTC start through
17:43:09 completion. The isolated regression job took 490s; its bounded step took
300s, including an 82.3s test-case interval.
All 35 regression tests passed again, with no image-build retry. There were 57
cached layers: six outer-runner, 35 worker, and 16 orchestrator. Minimum sampled
available disk was 70.65 GiB.

The warm outer action took 163s, including a 158.4s Docker image export with an
overlapping 26.9s Docker import. Worker build/load/cache/cleanup took 158.8s:
Docker image export took 147.9s (including a 71.8s Docker import), followed by a
5.0s cache export. Orchestrator took 16.2s, including 11.3s Docker export (6.7s
Docker import) and 3.0s cache export. Outer cache export took 1.9s. Cache manifest
imports took 0.4–0.5s. Image materialization now dominates cached build time.

The experimental warm regression job was 35–178s shorter than the baseline's
525–668s range. Its total was also shorter than the historical 660–807s range,
but this is an unchanged-commit rerun with already seeded caches and cached
architecture builds, not a matched changed-source benchmark. It demonstrates
cache reuse; it does not establish that every future change will run in 9m03s.
The rejected outer action still exceeded the old complete outer phase, supporting
the selected ordinary Compose runner build.

## Experiment comparison and final acceptance

Both two-cache experimental runs passed.
The table measures that experiment, including the rejected outer-cache action.
Do not claim a measured speedup for the selected path until new runs validate it. Record commit/run links, cache state, test count/results,
regression preparation/build/test durations, architecture/manifest times,
disk low-water mark, and total time through the last successful job. Compare
ordinary runs separately from retries and external download/registry failures.

| Measurement | Old workflow | Experimental cold run | Experimental warm run |
| --- | --- | --- | --- |
| Entire isolated regression job | 525–668s across the sample | 1387s | 490s |
| Bounded regression step | 493–632s, including outer build | 1015s; outer build separate | 300s; outer build separate |
| Explicit outer-runner build action | Bundled into regression step | 342s | 163s |
| Inner image build/load/cache/cleanup | 335–451s | 901.4s | 175.0s |
| Test cases | 64–112s | 76.6s; 35 passed | 82.3s; 35 passed |
| Pre-build free disk | About 86 GiB | About 86 GiB | About 86 GiB |
| Minimum sampled free disk during job | Not sampled | 62.61 GiB; 10s samples | 70.65 GiB; 10s samples |
| End-to-end attempt elapsed without registry retry | 660–807s | 1442s | 543s |

Final selected-path acceptance remains pending: fresh PR CI, a main run, and a
second warm main run must establish passing coverage, actual cache hits, whole-job
and per-attempt elapsed time, export/load overhead, and sampled disk headroom.
Keep cold misses, cache seeding, and external failures distinct in that comparison.

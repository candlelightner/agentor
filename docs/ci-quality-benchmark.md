# Hosted quality runner benchmark

This independent PR workflow measures the published phase-one runner before
any active-job adoption. It never publishes an image, changes registry
visibility, mounts a host socket into quality, or runs privileged containers.
The pinned input is:

```
ghcr.io/candlelightner/agentor-ci-quality@sha256:bcf69468194f5ef9d21d312452850188c925f3e714b18b35b3ef95dca742f236
```

Two pairs compare independent fresh `ubuntu-24.04` hosted jobs, one baseline
and one image arm per pair. Each job executes cold then warm samples. The
matrix reverses arm listing in the second pair, but GitHub scheduling and
hardware are not deterministic; these are matched source/runner-class
comparisons, not identical physical machines. Concurrent-job scheduling and
ordinary network/load variance remain limitations. Private single-CPU worker
measurements are not substituted for these hosted results.

Both arms use the same checked-out commit, lockfiles, full typecheck/module
suite, six-spec sudo archive split, CI profiler check, Node 22.23.4 and locked
Playwright/Chromium. Every sample unpacks a fresh tracked checkout and runs
both `npm ci` commands; `node_modules` and Nuxt output are never reused. Each
sample also has fresh HOME/XDG cache state; only the declared npm/browser
download caches persist into warm samples. The
baseline follows active preparation: installs qemu-utils and locked Chromium/libraries
inside each measured sample. The image validates its preinstalled contract
and tools. Baseline timing begins before its setup-node action, so its cold
Node acquisition or warm tool-cache lookup is included.

Cold means first use of arm-private empty npm/browser directories, without
Actions dependency-cache restores. The image target must be absent before
the cold pull; a preexisting image invalidates that sample rather than
pruning any runner state. Anonymous Docker CLI pull uses a fresh empty
configuration directory. Shared base layers, preinstalled runner tools and
GitHub's Node tool cache may already exist and are not destructively removed.
Consequently this is not an assertion that every OS/base byte is uncached.

Warm means a sequential repeat on that same job host, reusing only that
arm's npm download cache, baseline browser cache, installed system tools and
Docker image layers. It still uses a fresh workspace, `npm ci`, an explicit
image pull and full tests. Warm reuse is informative; normal fresh hosted
jobs need the cold pull, so adoption must improve representative cold totals,
not merely warm repeats.

The 35-minute job deadline bounds stalled network/tool/test occupancy. A
failure or cancellation reports that incomplete samples cannot justify
adoption. Receipts retain measured total and phase durations, source SHA,
lock hashes, exact Node/browser versions, image-cache presence, and every
Playwright case's pass/skip/failure status. Only sanitized numeric/status
receipts and source test identifiers are uploaded, for 30 days; raw command
output stays on the ephemeral runner. Compare complete pairs with matching
case/skip sets and successful ordinary plus root-fixture suites. Missing
receipts or failures are not speedups. Checkout, artifact upload and job
scheduling are outside sample timing; fresh-workspace copy, Node setup,
image pull, dependency installation and full quality are inside it.

Cheap parser/exclusion checks need no Docker, package installation or Nuxt
writes:

```sh
python3 tests/ci-quality/benchmark.py --self-test
```

Keep issue #47 open until these hosted results establish parity and a real
pull-inclusive improvement. Active quality and isolated DinD workflows remain
unchanged; image adoption requires a separately reviewed change.

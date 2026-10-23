# Image publication

Orchestrator and worker builds publish multi-platform manifests only after the
CI test gate. Pull requests build without registry login or publication. Release
tags retain their existing version and major/minor tags.

Each successful merge publishes `sha-<full-commit-sha>` before shared-tag
promotion. The existing short SHA tags remain available for compatibility;
use the full SHA reference for commit-specific deployments.

Main promotion uses a separate job with a per-image concurrency group and
`cancel-in-progress: false`. The lock covers the main HEAD check and the single
manifest command that updates `main` and `latest`. An older run finishing after
a newer run cannot move either shared tag back to its older revision. Pending
promotion jobs may be replaced by GitHub concurrency scheduling, but immutable
SHA publication has already completed outside that lock.

A run whose commit is no longer main HEAD skips shared tags and reports that
its SHA references remain available. This also applies when a newer commit only
changes unrelated files: shared tags stay on the previously promoted image until
a current-head image build succeeds (a manual main run builds both images).
If the HEAD lookup fails, promotion fails closed with a bounded reason; it does
not affect the already published SHA references. Registry failures may partially
update shared tags; rerun the current main workflow to recover.

Run the registry-free reverse-completion regression with:

```sh
python3 -m unittest discover -s tests/helpers -p test_main_image_promotion.py
```

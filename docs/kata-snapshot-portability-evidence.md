# Snapshot portability evidence, 2026-09-29

Scope: synthetic stopped-rootfs snapshot transfer between the approved disposable
Kata VM and worker-local classic Docker. This is not full Agentor instance
restore, migration rollback, or production-host acceptance.

## Source and transfer

A fresh Kata Ubuntu container ran as UID/GID `1000:1000`, without privileges,
capabilities, network, mounts, devices, or host namespaces. It wrote a synthetic
marker at `/tmp/portable-proof` and exited successfully. Docker committed the
stopped rootfs with its entrypoint, user, synthetic environment variable and a
command checking those values. No real credentials or production data were used.

The source image was saved and transferred over pinned SSH to worker-local Docker.
Both copies of `snapshot.tar` had SHA-256
`ea97c1581379bc7a925991859b65d8d2df4a0c0d3de4ce7b21ff7db385761496`.
The image reference is `agentor-import-kata-portable-brmpjsu0:runtime-proof`.

| Identity | Digest |
| --- | --- |
| VM containerd image ID (manifest) | `sha256:3f1948e3450aef771aa6527874d43c81b1f7831de9e54f31e648ffe699e7b74f` |
| Worker-local classic image ID / proven raw config | `sha256:a09b3303918cffc5c2b7fafbf361fefa86e12060ec0794e1a5ceb857e85ace91` |

The strict archive proof bound the source manifest to that exact config digest
and `linux/amd64` platform. The destination verifier accepted the enriched
identity despite the changed Docker ID.

## Destination execution

A fresh worker-local container was created using the immutable destination ID,
not the transferred tag. It inherited `/bin/sh`, UID/GID `1000:1000`, the synthetic
environment and checking command. It used no network or mounts, dropped all
capabilities, set no-new-privileges, and had a read-only rootfs. Its inspected
image matched the requested ID; execution returned 0 and the preserved marker.
Exact container ID/label cleanup succeeded and subsequent inspection returned 404.

The combined real-archive/API suite passed 7 tests, including classic/containerd
equality, wrong immutable ID/platform rejection, a native gzip/multi-platform
archive, destination API proof checks, this synthetic snapshot execution, and a
real tag-replacement test. The latter rejected the changed tag while the
previously resolved immutable ID still executed the correct snapshot. It restored
the test-owned tag and verified exact container cleanup. This exercises the
resolver, not ContainerManager or the new DockerService creation branch.
The other archive fixtures use an orchestrator image, not migrated workers.

## Real DockerService creation boundary

A separate, independently reviewed worker-local harness passed three tests
against the actual `DockerService.createWorkerContainer()` implementation:

- Creation with `expectedImageId` used the immutable synthetic snapshot ID;
  the method's real pre-start Docker inspection succeeded and the resulting
  container's `Image` and `Config.Image` matched that ID.
- A missing immutable ID returned 404 without creating a container.
- An image/expected-ID mismatch was rejected before container creation.

This used nonprivileged `legacy-runc`, non-DinD, network `none`, `start:false`,
and two fresh labeled named volumes. A fixture supplied only the volume bindings;
Docker operations were real, not mocked. The container remained in `created`
state and was never started. Exact identity checks preceded cleanup; the test
container and both volumes were removed and their absence verified. Snapshot
images/tags and runtime gates were unchanged. This closes only the real
DockerService creation-boundary check, not Kata execution, manager lifecycle,
migration, or encrypted instance restore.

Harness: `/workspace/kata-image-proof-live/docker-service-proof.spec.ts`,
SHA-256 `f7467d1946cd41325ca1806555f259aa4e265674a20c5a9be3fe242e6fdd0923`.
Config: `/workspace/kata-image-proof-live/docker-service-proof.config.ts`,
SHA-256 `71c791ae936876aa875840310afa889653b7928426e4ec46215bbbfad01d7651`.
Results: `/workspace/kata-image-proof-live/docker-service-proof-results.log`.
Run from `tests/` with
`npx playwright test --config=/workspace/kata-image-proof-live/docker-service-proof.config.ts`.

## Evidence and limitations

- Source VM: `/home/kata-test/kata-portable-snapshot.BRMpjsu0`.
- Local source log: `/workspace/kata-vm-portable-snapshot-3.log`.
- Local archive: `/workspace/kata-image-proof-live/containerd-snapshot.tar`.
- Local tests/results: `/workspace/kata-image-proof-live/proof.spec.ts` and
  `real-final-use-results.log`.
- Source exact container `b887dbf13f18989b49ef9f8c849f8bf3d3c4d01744c38d05480f0fda8b54b126`
  was removed and absence verified. Snapshot images and archives remain.
- Combined source/tmpfs evidence archive:
  `/workspace/kata-vm-snapshot-tmpfs-evidence.tar.gz`, SHA-256
  `5431a09f8015c48ed35a5fe26666f2960a8bda4b4924adf11787229adb327ca1`.

Two earlier source harness attempts stopped safely: mixed-case generated image
name rejected before commit; then Docker29's deprecated `--pause` warning
contaminated the captured commit ID. The latter's small snapshot remains for
evidence. Lowercase naming and `--no-pause` corrected the harness; these attempts
are not product validation. An earlier destination test used a reference outside
the supported runtime-snapshot naming contract; it was corrected to a test-owned
snapshot-shaped tag, not by relaxing the production validator.

No VM daemon configuration, outer-host state, runtime gates, migration-capacity
gate or production installation was changed. Durable worker identity propagation
and actual lifecycle final-use checks have separate module coverage. Full
encrypted instance restore and real Agentor lifecycle acceptance remain required;
this fixture alone proves neither workflow.

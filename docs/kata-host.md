# Optional Kata/QEMU host setup

Agentor's VM-backed ordinary workers use the Docker runtime name
`agentor-kata-qemu`. The host setup is an operator action. Running `install.sh`
downloads the setup and check scripts but does not install Kata, edit Docker,
restart a service, or migrate a worker.

## Candidate host matrix and rollout order

No physical-host matrix has been validated, and this work is not ready to deploy.
The candidate pinned path is Kata Containers **4.2.0** with its Rust shim and QEMU
configuration, on **Ubuntu 24.04**, **amd64 or arm64**, Docker Engine **26+**,
and a local, rootful, systemd-managed Docker daemon. Hardware virtualization
and `/dev/kvm` plus `/dev/vhost-vsock` must be available. A VM host needs
nested virtualization enabled by its provider. The script checks the local
Docker socket; it does not configure a remote daemon. Ubuntu 26.04 and other
distributions have not been validated, so the installer stops with a specific
compatibility error. The same applies to rootless Docker, a custom Docker
configuration path, an existing unrelated `/opt/kata`, or a conflicting
`agentor-kata-qemu` registration. Do not bypass these checks for production.

If Agentor is managed through Portainer, or other applications share the
Docker host, schedule a maintenance window before restarting Docker. Install
the Kata host runtime **before** updating the Agentor stack in Portainer or
with Compose. This adds a named optional Docker runtime and preserves the
existing `default-runtime`, so existing containers retain their runtime. A
Docker daemon restart can interrupt existing containers and services; check
their health before continuing. Do not re-create or migrate legacy Agentor
workers merely to install the host runtime.

From the installation directory:

```bash
bash scripts/setup-kata-host.sh --preflight
sudo bash scripts/setup-kata-host.sh --install --accept-install --accept-docker-restart
bash scripts/setup-kata-host.sh --status
bash scripts/check-kata-host.sh
```

The two `--accept-*` options are explicit consent to install the pinned
release and restart the Docker daemon. The script downloads the matching
official release archive, verifies its hard-coded SHA-256 digest, checks the
archive paths and required files, validates a merged daemon configuration,
then installs to `/opt/kata` and registers `agentor-kata-qemu`. The daemon JSON
merge retains existing keys and runtimes, including `default-runtime`. An
existing `/etc/docker/daemon.json` gets a uniquely named backup. A repeated run
with the same managed release, exact on-disk configuration, and reported runtime
alias returns without a Docker restart; a different existing Kata installation is left untouched for manual
review. If Docker fails after
the restart, the previous daemon JSON is restored when the script changed it
and Docker restart is retried. Installed `/opt/kata` files remain for inspection;
temporary downloads and staged configuration are cleaned up.

The preflight and status commands print JSON. `prerequisitesDetected: true` means the
basic candidate host requirements were detected; `physicalHostValidated` remains
false. `dockerReportsRuntime: true` means
Docker lists the alias. Neither means a VM or Agentor worker succeeded. The
status field `dockerRuntimeOptionsVerified` remains false because Docker info
does not expose the effective shim-v2 options. The
check script starts a disposable Ubuntu container with that runtime, records
the guest and host kernel releases, verifies explicit UID/GID `1000:1000` exec
both before and after separate stop/start, prints stage-specific JSON including
`restartMethod`, and
removes its exact canary container. Cleanup failure also fails the check.
It may pull `ubuntu:24.04`; it does not remove the shared image.
A successful smoke check is **not** DinD or full
Agentor migration acceptance or VM isolation proof. Kernel release equality or
inequality is only supporting information, not an isolation test. The report
always sets `isolationVerified: false`. An operator-approved physical-host canary
must additionally correlate the container with its Kata shim/QEMU process and VM
configuration, verify no host devices or namespaces were granted to the worker,
and test a disposable Agentor worker's required operations before rollout.

Agentor additionally requires `KATA_HOST_VALIDATED=true` as destination operator
attestation before creating a Kata worker. Set it only after the canary evidence
has been reviewed. It does not override the separate `KATA_DIND_NOT_VALIDATED`
gate or turn alias registration into host validation.

After the basic smoke check, the opt-in standalone worker test is:

```bash
sudo bash scripts/test-kata-worker.sh --disposable-host --image LOCAL_WORKER_IMAGE
```

Build the standard `worker/Dockerfile` locally first; the test does not build or
pull images. It checks READY, UID-1000 services/writes, restart and recreation,
but is not an orchestrator API/UI test. It retains image/volumes/evidence and
retains failed containers (possibly running) for exact-ID diagnosis. The tested
Docker 29.1.3/containerd 2.2.1/Kata 4.2.0 VM failed explicit UID exec after Docker's
combined restart. Separate stop/start on the same daemon passed the standard
standalone non-DinD worker's services and volume persistence through recreation.
The updated smoke and full worker scripts subsequently passed directly without
the diagnostic wrapper. See [the VM evidence](kata-worker-vm-evidence.md) for exact
script/image identities and limits; real Agentor API/UI lifecycle acceptance is
still pending.

Both canaries default to `--restart-method stop-start`, matching Agentor's running
Kata-worker restart path. `--restart-method docker` explicitly tests Docker's
combined restart and never falls back after failure. Legacy workers keep their
existing combined restart path. Do not attest the host from root-only checks,
change Docker's storage backend in place, or substitute root exec for UID 1000.

## Compatibility boundaries

### Archive validation correction (2026-09-28)

The first operator attempt on a disposable Ubuntu 24.04 amd64 VM with Docker
29.1.3 passed preflight and checksum verification, but rejected the official
archive's `.` directory header. No Kata installation or Docker restart occurred.
The validator now accepts only directory headers for `.` and `opt` as extraction
scaffolding; payloads and link targets remain confined to `opt/kata`.
Eleven archive fixture cases and the offline host fixtures pass. The full pinned
amd64 archive also passed read-only validation inside the development worker,
with SHA-256 `b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8`.
This verifies archive compatibility only, not installation, VM boot, or isolation.

### Docker runtime reporting correction (2026-09-28)

The second VM attempt installed the pinned files and restarted Docker, but the
installer incorrectly required `runtimeType` and `options` from `docker info`.
Docker's runtime reporting omits those fields for configured shim-v2 runtimes;
an empty object for the alias is valid. The installer consequently rolled back
the newly created daemon configuration and restarted Docker again. The managed
Kata files remain and can be reused on retry without another release download.

Verification now separates exact on-disk shim/options configuration from the
runtime alias Docker reports. Any reported contradictory configuration is still
rejected. The API does not prove which ConfigPath is loaded; a no-op registration
check is not proof of effective shim configuration or VM isolation. The separate
boot check and operator canary remain mandatory, and `KATA_HOST_VALIDATED` must
remain unset pending that evidence.

Source: Moby's `fillPlatformInfo` copies only runtime Path/Args and status in
[Docker 26.1.5](https://github.com/moby/moby/blob/v26.1.5/daemon/info_unix.go)
and [Docker 29.1.3](https://github.com/moby/moby/blob/docker-v29.1.3/daemon/info_unix.go).

### Host and guest prerequisites

Kata's VM requires `/dev/kvm` and VSOCK. If the preflight reports missing
`/dev/vhost-vsock`, load `vhost_vsock` under your host change process; Kata
also documents `vhost_net` for networking. The setup script does not load
kernel modules, change device permissions, or expose host devices to workers.
SELinux policy, unusual storage drivers, a custom containerd setup, and
provider-specific nested virtualization remain host-specific validation
items. A passed preflight does not prove them compatible.

The current Agentor DinD design uses `overlay2` on a Docker named volume
mounted at `/var/lib/docker`. Kata documents that virtiofs cannot serve as an
OverlayFS upper layer without special support, so this mount arrangement may
fail inside a Kata guest. An ordinary Kata worker can pass the basic boot
check while a `dockerEnabled` worker still fails. A disposable DinD worker
must demonstrate `dockerd`, image pull/build, nested container execution, and
persistence before DinD workers are migrated. Do not fall back to a privileged
host container automatically if that test fails.

Do **not** set Docker `Privileged: true` merely because the runtime is Kata.
Docker enumerates host devices into the OCI specification for privileged
containers; Kata's versioned privileged guide warns about this behavior and
documents CRI-specific mitigation, not a verified Docker Engine option. Kata
DinD must remain gated until an exact permission configuration has been proved
to support the inner daemon without host devices, host namespaces, or host
socket exposure. Candidate capability settings are not proof. Existing hardware
assignments, specialized mounts, and helper containers need separate feature
checks. Network policy changes remain out of scope.

Still required before enabling this feature: physical-host evidence for the
exact OS/kernel, architecture, Docker/containerd and pinned Kata/QEMU versions;
permission/device isolation checks; guest `/var/lib/docker` backing filesystem
and nested overlay2 tests (pull/build/run/volume/restart/recreate); storage
failure/recovery and cross-host restore; and explicit migration/rootfs-preserving
rollback validation. Offline fixtures cannot satisfy these gates. No host setup
or privileged host access is authorized by repository tests.

## Remaining operator work

The [worker-local runc probe](kata-dind-local-evidence.md) started `overlay2` and
pulled an image, but nested execution failed on read-only private cgroups. It
did not exercise Kata or select a loop-backed filesystem. Keep Kata DinD gated
until guest permissions, writable private cgroups, storage and persistence have
been demonstrated together on the disposable target-host canary.

Migration preserves the stopped source rootfs as an image and copies supported
worker-owned persistent data before replacement. Shared credential/Kilo mounts
retain their identity and current contents; rollback does **not** rewind shared
account state. Validate the real stop/snapshot/copy/start/rollback sequence and
retain its recovery evidence until explicit finalization. Whole-instance restore
holds workers for destination runtime approval, removes imported privilege
grants, and omits source-host migration journals. Review these behaviors with
the operator before rollout; see [the upgrade handoff](kata-upgrade-plan.md#operator-handoff).

## Snapshot images and disaster recovery

A migrated worker depends on its captured local image, named
`agentor-import-<workerId>:runtime-<operationId>`. Rebuild/unarchive preserves
that image's entrypoint, command, working directory and user. Snapshot defaults
retain the source image's baked environment, but runtime-injected keys are
explicitly blanked so deleting an account token, local variable payload or
secret-handshake setting cannot resurrect it on rebuild. The immediate
migration replacement still receives the current source container configuration.

Whole-instance backups include control-plane state and selected volumes, **not
Docker image layers**. Their additive `images.capturedWorkerImages` inventory
lists each snapshot reference and exact image ID. Destination restore preflight
blocks until every listed tag resolves to that same ID. Old manifests without
this field remain readable. Missing images never trigger a standard-image fallback.

Before accepting migration and deleting rollback evidence, the operator must
back up these images separately. On the source daemon, `docker image save -o
<protected-archive> <exact-snapshot-reference>` preserves both layers and image
configuration; encrypt the archive using the installation's approved backup
method before transfer. On the destination, decrypt in protected temporary
storage, run `docker image load -i <protected-archive>`, and compare `docker image
inspect --format '{{.Id}}' <exact-snapshot-reference>` with the recorded image ID
before proceeding. Do not use `docker export`/`docker import` for this path:
those do not preserve image configuration. Rootfs files may contain credentials;
protect these archives like the encrypted instance backup. This is an explicit
operator image-transfer dependency, not automatic image backup.

Cross-store transfer remains an acceptance blocker: Docker classic may report
the config digest as `Id`, while Docker29's containerd store reports a manifest
digest for the same saved image. The current exact-ID destination check rejects
that legitimate mismatch. Do not bypass it or replace it with tag-only matching.
A verified portable config identity (including runtime configuration and ordered
layer identities) and backward-compatible manifest handling still need
implementation and cross-store tests before this procedure is generally usable.

`scripts/test-worker-local-runtime-snapshot.sh --run-worker-local` checks a
disposable unprivileged container's writable rootfs, configuration, runtime-Env
clearing, and image save/load round trip in the worker-local daemon. It does
not validate Kata, a different host, or the full Agentor migration workflow.

## Capacity admission remains unresolved

Preflight explicitly reports `capacityAdmission: not-yet-implemented`. Docker's
API cannot establish free space for every image/layer/content-store filesystem.
A worker or helper's `df` is not a valid substitute: volume storage and image
content may reside on different filesystems. A sound automatic admission check
needs operator-provided read-only storage mappings/capacity measurements, bounded
source sizing, and reservation or a post-stop recheck. Until implemented and
tested, this is a rollout blocker; copying failure alone is not capacity proof.
Public migration currently rejects with
`WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED` before journal or Docker access;
preflight and existing-journal recovery/finalization remain available.

The proposed next step is a narrowly scoped, operator-installed capacity broker
with authenticated, operation-bound filesystem measurements and durable
per-filesystem byte/inode reservations, followed by a fresh stopped-source
recheck. Broker trust/key deployment and a maintenance lease or equivalent
controls over unrelated writers still need an operator choice. A signature
authenticates evidence but cannot stop another worker or host process consuming
space. Protected recovery capacity must survive uncertain outcomes; neither
restarts nor expired evidence may silently release it. No production collector,
new host mount, global worker stop, or filesystem quota policy is authorized by
this design proposal. Source-host reservations must never become destination
authority through backup restore.

## Sources and pin

- [Kata installation guide](https://github.com/kata-containers/kata-containers/blob/main/docs/installation.md): Docker 26+, host requirements, `runtime-rs` QEMU shim/config registration.
- [Kata Docker in Docker guide](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-run-docker-with-kata.md): virtiofs/OverlayFS upper-layer caveat. Its older claim that Docker cannot launch Kata predates the current installation guide.
- [Kata 4.2.0 privileged containers](https://github.com/kata-containers/kata-containers/blob/4.2.0/docs/how-to/privileged.md): Docker host-device enumeration warning and CRI-specific mitigation.
- [Docker alternative runtimes](https://docs.docker.com/engine/daemon/alternative-runtimes/): `runtimeType`, `options`, and named shim registration.
- [Kata Containers 4.2.0 release](https://github.com/kata-containers/kata-containers/releases/tag/4.2.0): `kata-static-4.2.0-amd64.tar.zst` SHA-256 `b828904fa3f1e49ddd7dc799c72cb1503cd1e772d354c3987c8d4189b2a623a8`; arm64 SHA-256 `5dd4e9f2d5ea9e6bdfa2f476b3315335b58252366fcda2775a3094fc8fec376b` (GitHub release asset digests, checked 2026-09-28).

The release archive is not upgraded automatically. Review a newer Kata
release and its compatibility before changing the pinned version or digest.

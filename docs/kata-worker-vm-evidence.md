# Disposable Kata worker evidence — 2026-09-28

Status: **not ready to deploy**. First boot passed; restart broke explicit-user
Docker exec with the containerd image store. A minimal classic-overlay2 control
passed, but full worker acceptance on that backend is still outstanding.
The host-validation flag and Kata DinD gate remain disabled.

## Scope and environment

The operator provided a dedicated disposable Ubuntu 24.04 amd64 VM and approved
pinned-key SSH with guest-only sudo. No outer-host changes, production data,
production deployment, or changes to the existing VM daemon's runtime/storage
configuration were performed by this agent. Later diagnostic daemons used
separate configurations/stores; the VM-local service restart needed to recover
an unintended bridge side effect is documented below. The guest has 4 vCPUs,
8 GiB RAM and a 40 GiB disk.

- VM kernel: `6.8.0-142-generic`.
- Docker: `29.1.3`; containerd: `2.2.1`; storage: `overlayfs` with
  `io.containerd.snapshotter.v1` (Docker's containerd image store).
- Kata Rust shim: `4.2.0`; QEMU: `11.0.1`; Kata guest kernel: `6.18.35`.
- Operator evidence correlated an exact Ubuntu canary container ID to its
  shim, child QEMU process, sandbox paths, and KVM VM/vCPU descriptors.
- Guest seccomp is disabled in the selected default configuration; shim/QEMU
  run as VM-local root without seccomp. These are review facts, not an isolation
  certification. The container had no requested privileged mode, added devices,
  host namespaces, sockets, or user-supplied host bind mounts.

The native worker image was built from `ae38e4c` using `worker/Dockerfile`, without
credentials or publication. The VM needed the Ubuntu `docker-buildx` package
`0.30.1-0ubuntu1~24.04.1`; installing it added only that package and restarted no
services. The build log is `/workspace/kata-vm-worker-build.log` in the development
worker. The VM-local image is `agentor-kata-canary-worker:ae38e4c`, immutable Docker
image ID `sha256:4ddae0ac807ef1ece54882e26df9b8d0eecc73793f58a0bae05fa08262c15996`.

## Standalone worker canary

`scripts/test-kata-worker.sh --disposable-host --image LOCAL_IMAGE` runs the
standard worker entrypoint/user with Kata, init, 512 MiB shared memory, the
standard secrets tmpfs, and two unique named volumes. DinD is false, role is
ordinary worker, credentials/custom settings are empty, and no port is published.
The deliberate standalone differences are `restart=no`, Docker's default bridge,
and a nonfunctional loopback orchestrator URL. This is not an API/UI test.

An initial attempt stopped before startup because the harness expected network
mode `default` while Docker 29 reported `bridge`. The harness now explicitly
requests/checks `bridge`; there was no policy or permission change. That unused
container was removed by exact ID, while its named volumes and evidence remain.

The corrected attempt used container
`70c8922803e3874f7fa9051917b9c4284601c6f12c7413efdc2812caf264be0d`:

- First boot reached `READY|`.
- UID 1000 tmux, editor HTTP, and desktop HTTP checks passed.
- Marker writes to `/workspace` and `/home/agent/.agent-data` passed with
  ownership `1000:1000` and mode `0644`.
- Docker restart returned success, but UID-1000 exec and health checks failed:
  `open /var/lib/docker/rootfs/overlayfs/<container-id>: no such file or directory`.
- Docker still reported the container running. Its rootfs path was independently
  confirmed absent. The canary failed its post-restart READY deadline; replacement
  and persistence-after-restart checks were not reached.

VM evidence: `/home/kata-test/agentor-kata-worker.eus7Ti9I`.
Development-worker summary: `/workspace/kata-vm-worker-canary-2.log`.
The failed container is retained for diagnosis (stopped after evidence collection),
along with its image, workspace/config volumes, and logs. No volume data was deleted.

## Minimal control experiment

Two explicitly selected runtimes were compared using the existing local
`ubuntu:24.04` image, no network, mounts, added capabilities, or devices. Runc was
an independent control, never a fallback for a failed Kata worker.

| Operation | runc | agentor-kata-qemu |
| --- | --- | --- |
| Initial root exec | Passed | Passed |
| Initial explicit `1000:1000` exec | Passed | Passed |
| Restart followed by root exec | Passed | Passed |
| Explicit `1000:1000` exec after restart | Passed | Failed: missing overlayfs rootfs path |

VM evidence: `/home/kata-test/kata-restart-probe.nqjUTOCX`.
Development-worker summary: `/workspace/kata-vm-restart-user-probe.log`.
The exact diagnostic containers were removed; the base image and evidence remain.

Moby's [Docker 29.1.3 exec path](https://github.com/moby/moby/blob/docker-v29.1.3/daemon/exec_linux.go)
uses containerd user/group resolution for nonempty exec users. This helps explain
why root-only smoke testing missed the failure; the root cause of the missing
mount still needs investigation. No daemon restart, storage-driver change, mount
repair, version change, or root-user workaround was attempted to hide the failure.

Remaining: restart/user-resolution compatibility, complete worker recreation and
persistence, real API/UI paths, migration/capacity admission, and DinD permissions
and storage. None is established by first-boot success.

## Storage-backend comparison and diagnostic recovery

Independent source review localized the explicit-user error to Docker's
host-side supplementary-group lookup, before the shim receives the exec.
Even a numeric UID/GID invokes this lookup with the containerd image store.
The missing `spec.Root.Path` explains the failure, but the exact mount-lifecycle
teardown responsible for removing it is not yet proven.

Disposable private Docker/containerd daemons compared the same Ubuntu image
and installed Kata Rust shim/configuration. Image transfer compared the saved
configuration SHA-256 and ordered layer identities, rather than assuming a
containerd OCI-index ID equals a classic Docker configuration ID. The successful
comparisons use explicit private containerd roots/state/sockets and a separate
network namespace, no networking on the test container, no mounts, no added
capabilities/devices, and no privileged mode. Only exact test containers are
removed; private stores and evidence remain.

| Backend | Initial UID-1000 exec | Restart/root exec | Post-restart UID-1000 exec |
| --- | --- | --- | --- |
| Classic `overlay2` | Passed | Passed | Passed |
| Containerd `overlayfs` | Passed | Passed | Failed: missing private-store rootfs path |

The matched classic result is recorded at `/var/tmp/kata-store-probe.bB50X7Um`
(overall exit 0). The containerd result is recorded at
`/var/tmp/kata-store-probe.4IP3e3pT` inside the disposable VM. Its failed exec
returned 126; exact-container cleanup returned 0, and both private daemons exited.
An earlier private-containerd trial inherited an unusually restrictive `0077`
daemon umask and failed initial unprivileged library loading; it is not the
matched restart comparison. The repeated comparison uses normal `0022` daemon
umasks while keeping the enclosing evidence directories private.

Two diagnostic assumptions required correction, and their effects were not
hidden or treated as successful runtime tests:

- Docker 29 on Ubuntu auto-selected the system containerd socket when given an
  empty containerd setting. The ownership guard rejected it before image load or
  test-container creation. The diagnostic now starts its own containerd and
  verifies its configuration, process identity, and socket ownership.
- `--bridge none` does **not** guarantee a side-effect-free second daemon in the
  same network namespace: Moby's `configureNetworking` calls
  `removeDefaultBridgeInterface()` when the bridge is disabled. The first
  private-daemon startup removed the disposable VM's `docker0`, causing a
  subsequent smoke startup and cleanup to fail. The VM-local Docker service was
  restarted to restore its original bridge; `daemon.json` retained SHA-256
  `74b0b314ff3a005384a2595d392a61c21acdd090a36f77eaf1211cad918737cf`.
  The failed smoke's exact container
  `3d724f73aef8b10034036069b1ac2becf2d1c45262a0d7f0662217240bb071d0`
  was removed, and its orphaned task/QEMU was cleaned up with exact-ID and
  process-identity checks. The original failed worker stayed stopped; no
  persistent volumes or images were deleted. All later private-daemon runs
  require a separate network namespace and preserve the restored bridge and
  primary Docker service identity.

No outer-host operation, production change, storage-backend switch on the
existing daemon, or validation-gate change occurred. **Do not toggle the existing
daemon's image-store setting as a repair:** doing so changes which image/container
inventory is visible and does not establish migration or backup safety.

The operator smoke check now requires UID/GID `1000:1000` exec before and after
restart and treats exact-container cleanup failure as failure. Offline fixtures
cover these stages. Re-running it on the restored primary daemon returned exit 1
with `initialUserExecPassed: true`, `restartPassed: true`, and
`restartedUserExecPassed: false`. Cleanup succeeded; no smoke containers or Kata
tasks remained. The real failure is now caught by the operator check.
This still does not certify isolation, real Agentor lifecycle behavior, DinD,
or migration.

Top-level diagnostic evidence (without private store contents) is also retained
in the development worker at
`/workspace/kata-vm-storage-evidence.2t673YMJ/evidence.tar.gz`, SHA-256
`933a2ba2f1277acacfe2e8bc4fa8272e8512d207c4348e2404b7a580b82b7e0d`.
The smoke report is `/workspace/kata-vm-strengthened-smoke-3.log`; final VM state
is `/workspace/kata-vm-private-final-state.log`.

A current orchestrator test image was built locally as
`agentor-kata-validation-orchestrator:3507171`, ID
`sha256:23b1a75156f00b098cecf864c12b0f8ee44ce6ac8833c24f3edd75394df32ab8`.
The build passed; no browser/API stack was run from it in this checkpoint and
it was not published. Browser acceptance remains outstanding.

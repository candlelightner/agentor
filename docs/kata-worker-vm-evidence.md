# Disposable Kata worker evidence — 2026-09-28

Status: **not ready to deploy**. First boot passed; restart broke explicit-user
Docker exec. The host-validation flag and Kata DinD gate remain disabled.

## Scope and environment

The operator provided a dedicated disposable Ubuntu 24.04 amd64 VM and approved
pinned-key SSH with guest-only sudo. No outer-host changes, production data,
production deployment, or runtime/storage configuration changes were performed
by this agent. The guest has 4 vCPUs, 8 GiB RAM and a 40 GiB disk.

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

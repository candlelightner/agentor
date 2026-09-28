# Disposable Kata worker evidence — 2026-09-28

Status: **not ready to deploy**. Docker's combined restart broke explicit-user
exec with the containerd image store; separate stop/start passed the standard
standalone non-DinD worker's restart/replacement checks on the same daemon.
A minimal classic-overlay2 control passed, but full worker acceptance on that
backend is still outstanding. Real Agentor API/UI lifecycle acceptance is pending.
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

At that checkpoint, restart/recreation compatibility remained unresolved. The
later separate stop/start result below supersedes that narrow compatibility
blocker, not the outstanding API/UI, migration, capacity, or DinD acceptance.

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

## Separate stop/start correction

On the original Docker29/containerd daemon, a plain Ubuntu Kata container passed
two explicit stop/start cycles with numeric `0:0`, numeric `1000:1000`, and named
`ubuntu` exec. VM evidence is `/home/kata-test/kata-stop-start.BTUAiCUf`;
the development-worker summary is `/workspace/kata-vm-stop-start.log`.

The standard worker canary then passed initial/restarted/replacement READY,
UID-1000 tmux/editor/desktop checks, and marker contents/ownership on both retained
persistent volumes. This experiment kept the canary script unchanged (SHA-256
`ddefdd029a5257cd65aa88bef40893afe5bcf664df309830f255dd7c95dfcc29`)
and used a narrow external wrapper translating only its exact
`docker restart --time 20 <CID>` call into awaited stop followed by start. Every
other Docker call, including explicit-user exec, reached the same daemon
unchanged. No runtime, user, privilege, or storage fallback occurred.

Here, tmux/editor/desktop checks mean session existence and successful HTTP
responses. They do not establish interactive terminal, browser editor,
VNC/WebSocket, or clipboard acceptance.

- VM evidence: `/home/kata-test/kata-worker-stop-start.8ANRJuae/agentor-kata-worker.KNElAeau`.
- Development-worker summary: `/workspace/kata-vm-worker-stop-start.log`.
- Exact successful test containers, subsequently removed:
  `83f96e592dcd049e15362e698db63f6d3baa07ca04327cc28c32dd4e67f00dcf`
  and `534d6206c7621f3ec146c42c56614e0932c7ec2deac2dfc15f3e73217f09955e`.
- Retained volumes: `kata-worker-20260928T174813Z-KNElAeau-workspace` and
  `kata-worker-20260928T174813Z-KNElAeau-agent-data`; the worker image is unchanged.

Agentor now performs separate awaited stop/start for running Kata workers inside
the existing owner/worker lifecycle fence. Legacy workers retain Docker's
combined restart, including explicit administrator-authorized privileged legacy
workers. Stopped workers still start directly. Runtime/restore checks, durable
running intent, secret restart policy, bootstrap, and health validation are
unchanged. Failed or ambiguous stop never proceeds to start; start failure leaves
the runtime unknown. Eight new direct-manager regressions cover these boundaries.

Both operator canaries now default to `--restart-method stop-start` and record
`restartMethod` in JSON. Explicit `--restart-method docker` remains a diagnostic
of Docker's combined restart; failure never switches methods automatically.
The wrapper experiment proves the chosen primitive with the standard image, not
execution of the updated manager through authenticated APIs.

The current repository scripts then passed directly on the original daemon,
without a wrapper. `/workspace/kata-vm-direct-stop-start.log` records the smoke
and full standalone-worker JSON, both `passed: true` and
`restartMethod: stop-start`, with `isolationVerified: false` /
`hostValidated: false`. Script identities were checked before execution:

- Smoke SHA-256: `86e20ddc733fcd8be96ccfe4c676d21505103bed8115f8ce13e20bbaa88c6da5`.
- Worker SHA-256: `46aaad551b2398acc336074d60a0cd1d0d4e0a70370629d1fd8d0f015a4673bb`.
- VM worker evidence: `/home/kata-test/agentor-kata-worker.MsE4ozsQ`.
- Removed exact successful containers:
  `904becfed1d0085e00f0b5ccda285ec7bf33507edb74ba6586948b7d078a1cd3`
  and `f4d578e94228e1ec193b1e443921d961f36b4d1df361c30ef9e7c98f5467df73`.
- Retained volumes: `kata-worker-20260928T180141Z-MsE4ozsQ-workspace` and
  `kata-worker-20260928T180141Z-MsE4ozsQ-agent-data`.

The current smoke script's explicit `--restart-method docker` control again
failed after combined restart (`initialUserExecPassed: true`, `restartPassed:
true`, `restartedUserExecPassed: false`), with successful exact-container
cleanup. `/workspace/kata-vm-direct-combined-restart.log` records the exit-1
result; the default stop/start did not hide or retry that failure.

Local verification passed 345 module tests, 21 offline smoke scenarios and 11
fake-Docker worker-harness cases. These are distinct from the direct VM tests.
The full classic-overlay2 worker attempt stopped in the private-daemon identity
guard before acceptance; its evidence remains at
`/var/tmp/kata-classic-worker.cHkzClyM`. A Bash unquoted-pattern comparison was
identified in that outside-repository diagnostic guard; no successful full
classic worker result is claimed.

Capacity admission, guest DinD permissions/storage/cgroups, backup/migration
rollback, and real API/UI worker lifecycle acceptance remain incomplete. The
six import/restore UI-control cases are separately scoped mocked-operation tests;
their browser pass below does not prove real worker migration. No host attestation
or DinD gate is enabled by this result.

## Browser runtime controls

Six focused import/backup UI cases passed in Chromium against a fresh VM-local
orchestrator (21.6 seconds), with real setup/login but mocked import/restore
operation routes. Ordinary-user cases mock the displayed session role; they are
not backend authorization tests. They cover administrator legacy acknowledgement,
reset on modal close, no runtime override for original-worker restore, and no
legacy selection/override in the ordinary-user controls.

The orchestrator used `AGENTOR_INSTANCE_RECOVERY_MODE=true` to suppress automatic
workers and administrative workspaces. No Kata validation flag was set. The
harness rejected existing managed workers/Traefik and fixed networks before
startup, and verified preexisting container IDs remained afterward. The browser
ran as the test-directory owner, UID/GID 1001, with all capabilities dropped and
no Docker socket. Only the test orchestrator had the disposable VM Docker socket.

- Log: `/workspace/kata-vm-ui-acceptance-2.log`.
- VM evidence: `/home/kata-test/kata-ui-evidence.jGOOc9B2`.
- Reports: `/home/kata-test/kata-ui-tests.Wih6QSEQ/playwright-report`.
- Retained data: `kata-ui-20260928T181016Z-jGOOc9B2-data`.
- Harness SHA-256: `852b06e7f5a863b89c394e545e7aa77b64bc6b05aed4ca62947a0672c70c6621`.
- Orchestrator VM manifest ID: `sha256:49861c2978532dd9766a0e1cdd5625c306c1800f7190e79f8f35b06cd2ff06d5`;
  verified config digest: `sha256:dcc2191f2b072bcb84c71970afe3ed439a65a8cdb2c63a6d698813d9395f60b6`.
- Playwright VM manifest ID: `sha256:6010c1140fc5c0cb4e969822a31b1562ade77886e8a000be2a37677c39fe9c8e`;
  verified config digest: `sha256:fc1610b07935476ac20219b7911f6bbe47ac861523635845ba0bc7cc5f0277c4`.

The first UI harness attempt failed at npm before tests because a capability-
dropped root browser could not read the UID1001-owned 0700 test directory. It
cleaned up successfully; evidence remains at `kata-ui-evidence.HRKjznc1`. The
second run used that non-root owner rather than adding capabilities.

Both runs removed only their exact containers and labeled empty networks,
retaining data/evidence. Main Docker PID28754, service start time, and daemon.json
hash remained unchanged; the original failed worker remains stopped. There are
no active test containers. Worker and UI evidence/reports are archived locally
at `/workspace/kata-vm-stop-start-ui-evidence.tar.gz`, SHA-256
`5eecff308eb1edcc86c8b3c53a81ba18eb34d4b2e24c30c5061b9cf79a308a45`.

Image transfer exposed a separate backup compatibility blocker: classic Docker's
config ID and containerd Docker's manifest ID differ for unchanged content.
Raw config hashes were verified on both sides; the current snapshot destination
check would reject this valid transfer. A portable cryptographic identity must
be implemented before claiming cross-store snapshot restore support.

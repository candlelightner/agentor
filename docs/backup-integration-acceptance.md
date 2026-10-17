# Isolated combined backup acceptance

The full workspace and whole-instance suites are preserved, but their same-host rootful DinD launcher is **blocked**. The disposable VM alternative below is implemented for review but has not been launched or accepted. Finishing migration and consolidating the branches does not remove this blocker. The original same-host launcher remains plan-only; it does not contact Docker or Git.

## Concrete commands

From the consolidated repository root, inspect the plan first (this performs no Docker or Git operation):

```sh
python3 scripts/test-backup-integration.py --suite workspace
python3 scripts/test-backup-integration.py --suite instance
```

The plan reports `execution.status: blocked` and `BACKUP_RUNNER_DEVICE_ISOLATION_UNVERIFIED`. `--execute` exits with code 2 before any subprocess, lease, source export, build, container/volume creation or cleanup, even as root or with environment flags. There is no privileged fallback or receipt bypass. Do not copy the advisory `build`, `run` or `cleanup` arrays into a shell: they describe the preserved suite/resource scope, not an accepted execution procedure.

Each plan selects a fresh random run ID; `--run-id readable-id` chooses an explicit ID. Its standalone Compose document does not inherit `docker-compose.tests.yml`. It explicitly sets `privileged: false`, private cgroup/IPC namespaces, drops all capabilities, and retains no-new-privileges. There are no device requests, device-cgroup overrides, host namespace selections, host ports or host socket/cgroup/device binds. Only a future tracked source snapshot and uniquely named local volumes are allowed. The strict configuration validator rejects extra privilege/device/mount fields and external or device-backed volumes. **This is an intentionally non-executable isolation requirement, not a claim that cap-drop-all can run rootful Docker.**

The source-export and exclusive-lease helpers remain unit tested for a future runner. No execution path currently calls them. A future reviewed implementation must preserve clean committed source export, ignore untracked secrets, independently reserve/inspect exact newly created resource identities before start, and clean up only resources whose ownership was established.

The workspace plan retains:

```text
api/backups.spec.ts
api/instance-backups-api.spec.ts
ui/backup-management.spec.ts
ui/instance-backup-management.spec.ts
ui/backup-management-real.spec.ts
--workers=1 --retries=0
```

The dedicated whole-instance plan enables `INSTANCE_DOCKER_BACKUP_TEST=true` and runs only:

```text
api/instance-backup-docker-live.spec.ts --project=api --workers=1 --retries=0
```

Do not append other tests to that invocation: the whole-instance test deliberately retires its source installation after exporting its artifact. The real instance spec is skipped before browser fixture creation unless explicitly enabled.

## Isolation and build contract

The earlier launcher inherited `privileged: true` from the generic runner. Docker documents that privileged containers gain all host-device access, so absence of a host socket or bind mount was insufficient to protect production disks and backups. That execution path has been removed. The generic `docker-compose.tests.yml` is still a privileged development runner and must not be substituted on the production host.

Simply adding `SYS_ADMIN` to an unprivileged runner is also not an accepted fix. The current entrypoint requires writable private cgroup-v2 delegation, and rootful nested runc manages device restrictions using BPF. Docker's default seccomp profile enables BPF with `SYS_ADMIN`; the cgroup library can query, replace and detach existing device filters. A private cgroup namespace and `HostConfig.Privileged=false` therefore do not by themselves prove the outer filter remains protected. Denying all BPF operations breaks ordinary nested-container device setup; running only privileged inner containers would discard the required constrained-helper and worker behavior. See the [Docker privilege contract](https://docs.docker.com/reference/cli/docker/container/run/#privileged), [default seccomp capability rules](https://github.com/moby/profiles/blob/main/seccomp/default.json), [kernel device-controller semantics](https://docs.kernel.org/admin-guide/cgroup-v2.html#device-controller), and [runc cgroup device-filter management](https://github.com/opencontainers/cgroups/blob/main/devices/ebpf_linux.go).

This assessment establishes a missing isolation design, not a proof that every possible constrained DinD implementation is impossible. No host capability probe, Docker create/start, cgroup mutation or device-access experiment was performed for this change. There is no validated minimum capability/security-option set to publish.

A practical next design is a disposable full VM with only fresh virtual disks, a private network and a guest-owned Docker daemon. Copy only tracked source into that guest; do not attach physical disks, production paths/sockets, credentials or old test volumes. Run the same two suite arrays against a fresh guest stack, retain the exact sizing-helper and daemon-identity assertions, and preserve independent source/destination recovery installations. The separate VM implementation below supplies that bootstrap and cleanup path for review; the existing native DR receipt guards do not provision one. Real boot and complete suite execution remain unverified, and no host services/cgroups/daemon changes are authorized.

Before restoring execution, require evidence of actual namespace and device isolation (including inherited restrictions for inner privileged workers), exact source/resource ownership, bounded cancellation/cleanup, and full unchanged suite behavior. A stopped-container inspect alone cannot establish these runtime properties. No privileged mode, host-cgroup bind, broad device rule or reduced test suite is an acceptable fallback.

The intended build remains `docker build -f /src/orchestrator/Dockerfile /src` with canonical worker/VM sources; the worker image retains its worker-directory context. The existing entrypoint's exact constrained sizing-helper check, fresh local Docker-socket check, daemon marker and whole-instance identity checks are retained for a future safe runner. These checks protect against accidental daemon confusion; they cannot repair privileged outer-device exposure.


## Disposable VM alternative: review before launch

`scripts/test-backup-integration-vm.py` provides a separate QEMU/cloud-init/SSH
runner. It preserves both full suite arrays above and runs them sequentially by
default; a failing workspace suite does not suppress the whole-instance suite.
The existing same-host launcher remains blocked. This implementation has only
plan/guard tests so far: **no VM, Docker stack or full acceptance suite has been
started**. Review its printed plan before adding `--execute`.

```sh
python3 scripts/test-backup-integration-vm.py \
  --base-image /path/to/reviewed/ubuntu-24.04-cloud-image.qcow2 \
  --base-sha256 <verified-64-character-SHA256> \
  --run-directory /path/to/new-private-backup-test-run \
  --ssh-port 22941 --suite both
```

After review, the same command with `--execute` exports the clean committed HEAD
and creates a fresh private run directory. It never adopts an existing directory.
It needs Python 3.12+, KVM access, `qemu-system-x86_64`, `qemu-img`, `cloud-localds`,
OpenSSH client/keygen and Git; it changes no host packages, services, permissions,
network interfaces or cgroups. The parent directory must exist with at least
90 GiB free. The reviewed defaults are fixed at **4 vCPUs, 8 GiB RAM and an
80 GiB virtual disk**, with no automatic growth or host-RAM sizing. If those
limits are insufficient, the run fails; changing them requires a new review.

The cloud image must be an ordinary standalone qcow2 file no larger than 1 GiB,
with no backing chain, external data file or encryption. A bounded header check rejects
external references before any QEMU tool opens the image format. The runner copies it into the new directory,
verifies the supplied SHA256, makes that private copy read-only, and uses a new
80 GiB qcow2 overlay. The original image and any prior preflight VM are never
modified. A new NoCloud seed contains only fresh client/public and guest host
keys, a nonce, and guest-local Docker package provisioning. Existing SSH keys,
cloud credentials, `.env`, ignored/untracked files and checkout data are not
copied. The source payload is `git archive` of the captured commit, checked for
escaping paths/links before SSH transfer.

QEMU has no default devices or user configuration, no host directory sharing,
block-device passthrough, host sockets, shared memory, VNC, guest agent, monitor
or QMP endpoint. Its only disks are the fresh overlay and read-only seed/private
base; its only NIC uses user-mode NAT with one SSH forward bound to a newly
reserved `127.0.0.1:<port>`. NAT permits public dependency downloads and can
reach host IP endpoints; this is trusted test source with no production
credentials, not a hostile-network sandbox. No bridge, tap or host firewall
change is needed.

SSH uses the new key only, no agent or ambient SSH config, and a freshly generated
pinned ED25519 guest host key. Guest execution refuses to call Docker until a
private root-owned nonce record matches QEMU's DMI UUID. It captures and rechecks
the guest Docker daemon ID, rejects existing selected resource names, and uses
separate nonce-labelled projects/volumes for workspace and instance suites.
Privileged DinD is permitted **inside this disposable VM only**. The full existing
entrypoint, constrained-helper checks, daemon markers, UI/API assertions and
fresh recovery-installation flow are retained. Native DR flags are not forwarded;
this does not verify Incus/native disaster recovery.

Provisioning has a 15-minute bound and the guest suite command a four-hour bound.
SIGINT, SIGTERM and SIGHUP enter the same bounded cleanup; a signal during process
creation waits until its handle is captured, and repeated cancellation cannot
interrupt cleanup. On completion, failure or interruption, the host terminates only its captured
QEMU process, waits 30 seconds and uses that same process handle for a final kill
if needed. It never searches PID files/names, prunes host Docker or deletes a
parent directory. After confirmed process exit and run-directory identity checks,
it removes only its own disk copies, seed, private keys and transfer archives.
`plan.json`, bounded console/bootstrap/run logs, result JSON and extracted suite
reports remain in the private directory. Report transfer is capped at 1 GiB and
100,000 entries; `.auth` is not included as a separate artifact. A hard host
power loss/SIGKILL can leave this run's files/process for manual inspection;
there is deliberately no broad resume/adoption/cleanup command.

Local validation:

```sh
python3 -m unittest discover -s tests/helpers -p 'test_backup*launcher.py' -v
```

The guards cover unchanged full arrays, side-effect-free plans, disk/network
attachments, private keys/nonce bootstrap, wrong-host/DMI/metadata rejection,
existing-resource/free-space refusal, external-data-file header rejection before QEMU,
actual catchable signals with stub VM cleanup/forced-kill ordering, bounded log capture, and both-suite
execution after a first-suite failure. A successful real VM boot, guest Docker
nesting, complete suite reports and cleanup proof remain the next acceptance
step after plan review. Cloud-init's supported host-key bootstrap is described
in its [SSH module reference](https://docs.cloud-init.io/en/latest/reference/modules.html#ssh).

## Real whole-instance path being prepared

The opt-in test uses the actual production UI/API with no route mocks:

1. Create two ordinary Docker workers in a Docker-disabled environment. Seed workspace and per-worker agent-data volumes with 8,000 binary files in total, numeric owners, permissions, fixed modification times, hardlinks and relative symlinks. Capture their expected content/metadata manifests.
2. Save explicit default-root coverage, stop one worker, archive the other, and save/deselect the archived worker with its old path map still present. Retain independent schedule settings.
3. Start a local whole-instance snapshot through the real instance-backup modal. Require a terminal successful, integrity-verified artifact and an authenticated encrypted `AGENTOR-INSTANCE-BACKUP-1` download. Keep only the fixture-generated recovery material in memory.
4. Stop the fixture source app. Remove only its captured, allowlisted worker/Traefik volumes and exact fixture compute, after checking there are no other consumers. This prevents same-daemon volume-name conflicts without using a second host Docker daemon or changing any production storage.
5. Start a fresh recovery-mode app on a new test DATA volume/network. Import the fixture key and encrypted artifact through their real authenticated APIs; require nested verification/adoption.
6. Run preflight and apply from the real restore UI, including both destructive/external-dependency acknowledgements. Observe an actual stop/restart of the same recovery app container and reauthenticate against the restored database.
7. Require a successful restore job, preserved stopped/archived durable lifecycle intent, no automatic worker activation, retained backup selections/settings, and exact file hashes/UID/GID/mode/mtime/hardlink/symlink manifests in all four restored Docker volumes using network-disabled read-only probes.

Recovery mode intentionally leaves disposable worker compute absent; raw volume checks and durable records are the authority here. The separate real workspace UI case verifies a running restored worker round-trip and exact single-member selection. This test does not claim that Docker restore verifies native VM codecs or host bind-mount contents.

## Existing native portability gates

Existing module suites cover native format/role bounds, exact raw/PAX/ownership handling, metadata inversion and controlled restore failure/rollback. Existing live specs include:

- `api/instance-backup-native-live.spec.ts`: `INCUS_INSTANCE_BACKUP_TEST=true`; actual native capture of stopped canonical data, disabled Docker, attached/detached and deleted-owner managed data, encryption/decryption and content inspection.
- `api/instance-backup-detached-live.spec.ts`: `INCUS_INSTANCE_PREFLIGHT_TEST=true` or `INCUS_INSTANCE_DETACHED_RESTORE_TEST=true`; compiled native preflight/inverse paths.
- `api/instance-native-helper-process.spec.ts`: `INCUS_INSTANCE_HELPER_PROCESS_TEST=true`, with additional explicit public/historical/custom-image gate flags and exact private fixture descriptors; actual controlled helper and public restore paths.

These are not generic nested-Docker gates. Several still bind a prior disposable endpoint (`127.0.0.1:18443`), project name `agentor`, `/workspace/agentor-incus-tls` paths, and/or exact retained fixture IDs. Do **not** simply enable these flags, reuse their old credentials, or point them at the migrated production Incus project. A fresh restricted disposable Incus project/image/network and reviewed fixture descriptor/refactoring are required first. No native live command is safe to prescribe for the current production host from those hard-coded defaults. Native real-VM portability therefore remains a separate pending acceptance gate.

## Evidence and remaining acceptance

Twenty-four local launcher/VM plan cases pass without Docker access, including both full suite arrays, zero-subprocess execution refusal, unsafe namespace/capability/device/mount rejection, device-backed/external/reused-volume rejection, source export and exclusive leases. No test container, daemon, VM, build, mount, cgroup or device was created or changed. There are no runtime reports or cleanup receipts to claim from this change.

Neither acceptance stack has been started. The real whole-instance UI/API spec and repaired real-worker UI spec remain **prepared, not live-validated**, pending a safe execution environment and successful complete runs. Comparative ≥2× complete-backup throughput, single-core/small-volume behavior and native VM portability remain additional gates; the synthetic 2.36× volume-pipeline benchmark does not substitute for them.

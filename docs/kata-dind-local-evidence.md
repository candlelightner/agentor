# Worker-local DinD investigation, 2026-09-28

This evidence is from a disposable **runc** container under this worker's local
Docker daemon. It does not validate Kata, QEMU, guest privilege, host isolation,
or a production host. Kata DinD must remain gated.

Run the repeatable probe with:

```bash
bash scripts/probe-worker-local-dind.sh --run-worker-local
```

The script requires a containerized worker with a local `dockerd` process whose
reported daemon name equals the worker hostname. It uses the existing
`agentor-test-runner:latest` image by its resolved immutable image ID and overrides
the test entrypoint with `dockerd`. It never runs the existing privileged test
runner setup, changes host configuration, or mounts a daemon socket into the
probe. Evidence is retained in a unique `/workspace/kata-dind-probe.*` directory.
The exact labeled disposable container and Docker data volume are removed on
exit; unrelated resources and the existing runner image remain untouched.

The inspected container configuration uses `Privileged=false`, runtime `runc`,
private cgroups and normal isolated namespaces, default seccomp, default devices,
and only `SYS_ADMIN`, `NET_ADMIN`, and `SYS_RESOURCE` added to Docker's default
capabilities. `SYS_MODULE` is explicitly dropped. There are no device mappings,
device-cgroup grants, host namespace sharing, bind mounts, socket mounts, loop
devices, or `--cap-add ALL`. One freshly created named volume is mounted at
`/var/lib/docker`. Configuration assertions run before container start.

## Observed result

The run at 2026-09-28 14:44 UTC retained evidence at
`/workspace/kata-dind-probe.FYL4uUvo` (`result.json`, inspected container JSON,
daemon logs, inner/outer info, filesystem/cgroup observations, pull/run logs).

| Check | Result |
| --- | --- |
| Local outer Docker | 29.7.2; `overlay2`, backing filesystem `extfs`; no Kata alias |
| Existing runner image | `sha256:ae761e3efffa07f2e14147bd9d776fd908b07ee68ed4bf5311d6141b3c10a928` |
| Inner daemon | Docker 29.8.1 started successfully |
| Inner Docker storage | `overlay2`, backing filesystem `extfs`, `Supports d_type=true` |
| Image pull | `alpine:3.23` succeeded; digest `sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0` |
| Nested container run | Failed creating its cgroup: read-only filesystem |
| Build, nested volume, daemon restart, recreation retention | Not reached after failed run |
| Cleanup | Exact disposable container and data volume removed |

The relevant nested-run error was:

```text
unable to apply cgroup configuration: mkdir /sys/fs/cgroup/docker: read-only file system
```

The probe reported cgroup v2, the `cgroupfs` driver, `/proc/self/cgroup` equal to
`0::/`, and a read-only `/sys/fs/cgroup` mount. This identifies an additional
DinD prerequisite: a correctly delegated, writable **guest/private** cgroup
hierarchy. The experiment did not remount cgroups or alter host controllers.
Seccomp was not implicated; the optional `--seccomp-unconfined` diagnostic mode
was therefore not run and is not a suggested production setting.

The named volume's ext filesystem allowed inner daemon startup and image pull
in this runc environment. It says nothing about Kata's virtiofs/block-device
path. No loop-backed ext4 design was selected or tested. Successful nested
build/run/volume/restart/recreate, failures and recovery, cross-host restore,
and Kata physical-host canary evidence remain outstanding.

## Disposable Kata guest prerequisite probe, 2026-09-29

The separately approved VM ran a fresh Kata container from the existing standard
worker image, with its entrypoint replaced by `sleep`. No inner Docker daemon
was started. It added only `SYS_ADMIN`, explicitly dropped `SYS_MODULE`, kept
`Privileged=false`, and set no-new-privileges. It used no network, host namespace,
device mapping, device-cgroup grant, bind mount or socket; a fresh named volume
was mounted at `/var/lib/docker`. The guest remained on kernel `6.18.35`.

Inside a new guest mount namespace with private propagation, a fresh cgroup2
mount accepted creation/removal of one empty test child. The available controller
list was `cpuset cpu io memory hugetlb pids rdma`; subtree control was empty. No
controllers were enabled and no processes were moved. This demonstrates a
guest-private writable cgroup child, **not** resource delegation or working DinD.

An independent tiny overlay mount/copy-up probe on the named volume failed at
`mount` with exit 32; copy-up was not reached. The mount command returned the
generic “wrong fs type, bad option, bad superblock” diagnostic. Guest mountinfo
records virtiofs sharing (`stat -f` reports the generic `fuseblk` name). This is
a failure of this tested storage/permission combination, not proof of a specific
kernel cause. No alternate driver, loop device, formatting, seccomp change,
extra capability or runtime fallback was attempted.

Evidence: VM `/home/kata-test/kata-guest-prerequisites.LmNsQjBt`, local log
`/workspace/kata-vm-guest-prerequisites-2.log`. The exact container
`09ebcb9ef238ec1a233c8c4770f29b97a502fcf4d8e3df4d74692e2118cb2a00`
was removed; its named volume `kata-guest-prerequisites-LmNsQjBt-data` remains.
The initial harness attempt rejected Docker29's `CAP_SYS_ADMIN` spelling before
start; accepting the canonical prefix did not change the requested capability.
Its exact unstarted container was also removed, with evidence/data retained.

The reviewed outside-repository probe's SHA-256 was
`709ca4218a2230be8cc435c044ddd3161e1b4a68ca24f6e010e68aa0f84403a3`.
Both attempts are archived at
`/workspace/kata-vm-guest-prerequisites-evidence.tar.gz`, SHA-256
`fa32e9807091d1145c7978f836d13f0236315f444f98ece3ed36da6320d54363`.
Kata DinD remains blocked; pull/build/run/volumes/restart/recreation and recovery
have not been established by these prerequisites.

### Guest tmpfs comparison

A second reviewed, fresh Kata probe used the same capability recipe but no
volumes. Inside a private mount namespace, a 16 MiB tmpfs supported a tiny overlay
mount and copy-up (exit 0). The earlier named-volume/virtiofs case failed. This
narrows the tested failure to a storage-dependent combination; it does not
establish durable storage or a production Docker data-root design.

The pinned guest kernel configuration has loop, ext4, overlay and tmpfs built
in, with kernel modules disabled. Guest `/proc/devices` listed loop major 7, but
no `/dev/loop*` nodes were present. Loop devices were only inventoried: none was
created, opened, attached, formatted or mounted. An ext4 loop-backed candidate
still requires a separately reviewed guest-only experiment and persistence,
capacity, interruption/recovery and cross-host tests before selection.

Evidence: VM `/home/kata-test/kata-guest-tmpfs.rp6Io7Zz`, local log
`/workspace/kata-vm-guest-tmpfs.log`. Exact container
`7b59bc01d9d238e93e7eb306e9bfa3dc90a393a75a0775736d60e23a6490e78a`
was removed and absence verified. The reviewed probe SHA-256 is
`8819f3c553a66350e14bda0d1441bff3bbdcfc4ad341d725828be15fbbc0ce23`.
Combined synthetic-snapshot and tmpfs evidence is retained locally at
`/workspace/kata-vm-snapshot-tmpfs-evidence.tar.gz`, SHA-256
`5431a09f8015c48ed35a5fe26666f2960a8bda4b4924adf11787229adb327ca1`.
No inner Docker daemon or additional device/cgroup grant was introduced.

### Guest-only loop/ext4 storage diagnostic

A third reviewed, fresh Kata probe in the disposable VM tested only whether a
loop-backed ext4 filesystem inside the guest could support a tiny overlay
copy-up. It used a new labeled container and named volume, `SYS_ADMIN` as the
only added capability, `SYS_MODULE` dropped, no-new-privileges, a private mount
namespace, and network none. Docker inspection recorded `Privileged=false`, no
device passthrough or device-cgroup rules, and no bind, socket, or host namespace
mounts. The sole mount was its new named volume at `/var/lib/docker`.

Inside the Kata guest, the probe wrote a fully allocated 64 MiB regular backing
file in that volume and formatted **the file**, not a VM-host block device. It
created `/dev/loop0` only in the verified guest `/dev` tmpfs after checking the
guest loop devices were unbound. It attached that exact file to the guest loop
device, mounted ext4 in a private guest mount namespace, and passed a tiny
overlay mount and copy-up. The guest command exited 0; the result explicitly
reports `dindValidated=false`. `mkfs.ext4` warned that its long filesystem label
was truncated to `agentor-loop-pro`; this was not an operation failure.

The probe did **not** start an inner Docker daemon, demonstrate durable
stop/recreate or host-restart retention, test resource accounting or capacity
exhaustion, recover an interrupted filesystem initialization, or test cross-host
restore. It does not select or approve loop-backed ext4 for workers and does not
clear the Kata DinD gate. The earlier virtiofs-overlay failure and tmpfs-overlay
success remain separate observations; this result narrows only the guest-loop
storage prerequisite.

Evidence: VM `/home/kata-test/kata-guest-loop.sw4ufNH0`, local log
`/workspace/kata-vm-guest-loop.log`, and local archive
`/workspace/kata-vm-guest-loop-evidence.tar.gz` (SHA-256
`b0a720ba576b75a21221ba5261b49da4ea5b65ea72ade2e0e34bf52adcb48e93`).
The reviewed harness SHA-256 was
`5527d1eb7a465e8392dfc07ce6d05f0531eb6be004d07c3b4512d608c316ecda`.
Exact container `b9e142d6894648f6732a69db3c380ad1b16aea28c77e8e0821327f7124e73676`
was removed and absence verified; the fresh volume
`kata-guest-loop-sw4ufNH0-data` was retained for evidence. The VM's main Docker
process was unchanged, no test containers remained running, and about 13 GiB
was free afterward. No validation flag, additional grant, inner daemon, or
production/outer-host change was made.

### Guest-only DinD attempt: stopped at cgroup mount

The operator subsequently approved a bounded guest-only DinD experiment with
the same permissions, fresh backing storage and private guest cgroups. The
independently reviewed harness used a new 512 MiB file on a new labeled volume,
guest loop0/ext4 and a private mount namespace. It retained the SYS_ADMIN-only
capability addition, SYS_MODULE drop, no-new-privileges, network `none`, no
device mappings/rules, no host namespaces, and no bind or socket mounts.

The ext4 setup completed, but mounting cgroup2 over the existing guest
`/sys/fs/cgroup` failed with exit 32:

```text
mount: /sys/fs/cgroup: none already mounted on /.
```

The sequence stopped before starting containerd or dockerd. Thus no inner image
import, nested container or nested-volume write ran. This is a failed canonical
cgroup-mount attempt, not proof that a fresh mount at another path would fail
(the earlier empty-child prerequisite used a different mount location). Its
kernel cause has not been established. No permissions were added, no fallback
was attempted, and `KATA_DIND_NOT_VALIDATED` remains in force.

Exact outer container
`4afb39236524015086c2f81fbcfb4813c51370ba452bab3f7a0746d7d76f8174`
was removed; subsequent inspection confirmed absence. Volume
`kata-guest-dind-Anfzi8zB-data` and the backing file remain. VM Docker PID 28754
and daemon configuration checksum were unchanged; no test container remained
running after this attempt.

Evidence: VM `/home/kata-test/kata-guest-dind.Anfzi8zB`; local log
`/workspace/kata-vm-guest-dind.log`; archive
`/workspace/kata-vm-guest-dind-evidence.tar.gz`, SHA-256
`7c06ab2dabd140cde698239d80daf9cfc163716ff9ea969f6c4c9d988e8df4d2`.
Executed harness SHA-256:
`d9c0296dbfa2ac209d9d641659a3453a88782bc7659ccc9b7355c8929d58eafb`.

### Original cgroup mount traced: EBUSY confirmed

An independently reviewed bounded diagnostic on 2026-09-29 repeated exactly
one original mount command in a fresh Kata container and private guest mount
namespace. Capabilities and device/namespace grants were unchanged. It used
no volume or inner daemon. The guest's installed strace observed:

```text
mount("none", "/sys/fs/cgroup", "cgroup2", MS_NOSUID|MS_NODEV|MS_NOEXEC, NULL) = -1 EBUSY (Device or resource busy)
```

The command exited 32 and the diagnostic stopped. This confirms EBUSY for
this attempt, rather than EPERM. Linux's same-filesystem/root overmount guard
is consistent with the captured topology; the trace does not identify the
exact kernel branch. Guest mount/libmount packages are `2.39.3-9ubuntu6.6`.
The root virtiofs source is `none`, consistent with libmount's source-name
lookup producing the misleading `none already mounted on /` message. The
cgroup mount is VFS read-only with a read-write superblock. No remount, bind
replacement, alternate hierarchy or permission change was attempted.

The exact container
`45061296b611698a835e40e1dc3db755bb481a34a62aa66d68b058a746a30b8f`
was removed and absence verified. Only the original stopped canary remains;
Docker PID 28754, daemon configuration hash and approximately 13 GiB free
space were unchanged. The diagnostic created no persistent data volume.

Evidence: VM `/home/kata-test/kata-cgroup-metadata.YphXaMGg`, local log
`/workspace/kata-vm-cgroup-trace.log`, and archive
`/workspace/kata-vm-cgroup-trace-evidence.tar.gz`, SHA-256
`428af3ac3ebc4fa27c1efa6a2957b3445954179b73b4e101503dd607b37a01d2`.
Executed harness SHA-256:
`bb10c13aa835c25a8a3ac72416a24c4a144de2e297aeb834a19b38a96f2882c1`.
Eleven offline diagnostic-control tests and syntax checks passed before the
run. This is a confirmed failed mount diagnostic, not DinD acceptance;
`KATA_DIND_NOT_VALIDATED` remains in force.

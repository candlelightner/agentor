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

### Fresh guest cgroup mount and canonical bind prerequisite

The reviewed bounded candidate mounted a fresh cgroup2 view in a private guest
mount namespace, then nonrecursively bound that same guest filesystem onto
`/sys/fs/cgroup`. Two preliminary attempts stopped at verification: `findmnt`
reported both the hidden read-only and visible read-write stacked mounts, so
the single-record assertion failed. Both mount operations succeeded in the
instrumented attempt; neither run reached the empty child or an inner daemon.
These were verification failures, not demonstrated permission denials.

The corrected harness opens the actual directory with a read-only `O_PATH`
descriptor and matches its fdinfo `mnt_id` to the exact mountinfo record. It
checks filesystem/device/root/inode identity and effective mount flags without
assuming listing order or the highest mount ID. Independent review and all
29 offline fixtures passed before execution.

The fresh corrected run exited **0**: canonical mount ID86 was read-write,
with nosuid/nodev/noexec, while the hidden original ID70 remained read-only.
One empty child was created and removed. No controller was enabled, process
moved or inner daemon started. The original container mount namespace remained
unchanged/read-only. The same SYS_ADMIN-only addition, SYS_MODULE drop, private
cgroups, no-new-privileges, network none and no device/socket/bind exposure were
retained. This establishes only the bounded cgroup prerequisite, not DinD.

Exact container
`5c9e6e30a3d7ffe063685bb64eba1e6d43a3aec3c83eeba538d93cbdb65021bb`
was removed and absence checked. Only the original stopped canary remained;
VM Docker PID28754/config checksum and approximately 13 GiB free were unchanged.
No persistent volume was created. Evidence:

- VM `/home/kata-test/kata-cgroup-bind.ijOOQAcL`.
- Log `/workspace/kata-vm-cgroup-bind-3.log`.
- Harness SHA256 `7d7ce8933760c3f9000c6476008f249cd91427154249e6a4d06371eb7fe290d6`.
- Archive `/workspace/kata-vm-cgroup-bind-evidence-3.tar.gz`, SHA256
  `29348a7b36f3c3be3a0aaacc03647a1567fca818af4367afc0cad087ac7e66a1`.

The subsequent inner-daemon harness still requires its own complete review;
this result does not enable `KATA_DIND_NOT_VALIDATED` or select production storage.

### Inner daemon attempt: containerd v4 verification mismatch

After full independent review, harness SHA256
`579ddc558732948da5023931dfd68311b7e2338270063cf734c7b75473109c40`
ran once on fresh 512 MiB fully allocated guest loop/ext4 storage. Private fresh
cgroup mount/bind and empty-child checks passed. Containerd 2.3.6 started on the
explicit private socket, but the harness stopped at `KeyError: 'grpc'`: this
version migrates configuration v3 to v4, moving listener fields under server
plugins. Dockerd, image import and nested-container execution were **not reached**.
This is a harness schema-verification failure, not a demonstrated permission
denial or DinD pass. A corrected pre-start configuration validator requires
separate review before any retry.

The exact container
`bd909754a364c19a9e416eb1eeed87c44ee09e8d8e35869fb843add6a685bcc0`
was removed; volume `kata-guest-dind-bind-iPzJHlW3-data` remains. Docker PID/config
and original stopped-canary inventory were unchanged; about 12 GiB remained.
Two captured subsequent canary inspections equal the saved browser-run baseline.
An earlier unsaved inline comparison returned false; its differing value was
not captured, so that individual comparison remains unexplained.

- VM `/home/kata-test/kata-guest-dind-bind.iPzJHlW3`.
- Log `/workspace/kata-vm-guest-dind-bind.log`.
- Archive `/workspace/kata-vm-guest-dind-bind-evidence.tar.gz`, SHA256
  `b918ac14bd81a6601f171639081b8d81f0d7e5a3f42dc15f832717aca140a0d0`.

A second reviewed fresh run, harness
`fbc5831f4f0042444fcc1070d1edc32ebcec274a71591ec48b04180c4d1c28e9`,
stopped **before containerd or dockerd startup** at the new pre-start config
validator. The input explicitly used native v4 with `imports=[]`, but the dump
retained `imports=['/etc/containerd/conf.d/*.toml']`. Pinned upstream 2.3.6
`LoadConfigWithPlugins` resolves imports from each freshly decoded input config;
`mergeConfig` separately retains the default slice in the output. The dump
display alone is therefore not proof of imported-file access. A further
source-backed correction must independently check the raw no-import input and
the exact known merged output before another run. No permission denial or
working inner daemon is established by this attempt.

Container `f696f1f34a5523165a7402ff57d1c1fe31ff0d562e410ba8fcb9ce580dad5ee8`
was removed; `kata-guest-dind-bind-sJpTlnUX-data` remains. Only the original
stopped canary remained, Docker PID/config stayed unchanged and about 12 GiB
was free. VM evidence `/home/kata-test/kata-guest-dind-bind.sJpTlnUX`; local log
`/workspace/kata-vm-guest-dind-bind-2.log`; archive
`/workspace/kata-vm-guest-dind-bind-evidence-2.tar.gz`, SHA256
`40399a9fb9caaf6fbeedfe229030074c52bcd36330a89cb8227297d1c04efd9a`.

### Inner Docker started; nested runc initialization denied

The third reviewed fresh attempt, harness SHA256
`184bce3f8924aaa6d16da9e242ed5075dce78a1f607882fe7ae97550ba57eb18`,
passed the raw/merged containerd configuration checks. Private containerd2.3.6
and Docker29.8.1 started successfully, with `overlay2`, cgroupfs/v2 and the
fresh 512 MiB guest ext4 data root. Synthetic image import, inner-volume creation
and nested-container creation completed. Nested start then failed:

```text
OCI runtime create failed: runc create failed: unable to start container process:
error during container init: operation not permitted
```

The harness stopped at this denial. The logs do not identify the exact denied
operation, so this does not establish its capability, seccomp, namespace or
filesystem cause. No permission broadening or live retry followed. The nested
workload and volume marker did not run; build/pull, persistence, daemon recovery,
worker recreation, interruption and cross-host acceptance remain unproved.
`KATA_DIND_NOT_VALIDATED` stays closed. Further live denial diagnostics require
operator direction under the existing stop-on-denial boundary.

Exact outer container
`2f2ed8f10fb2f0bae048dc4988a0e76b12823308872afad3c804f991841d7ecc`
was removed and absence verified. Its fresh volume
`kata-guest-dind-bind-Itt4nPrX-data` remains. Only the original stopped canary
remained; VM Docker PID28754/config checksum were unchanged and approximately
11 GiB was free. No VM-host storage or production configuration was changed.

- VM `/home/kata-test/kata-guest-dind-bind.Itt4nPrX`.
- Log `/workspace/kata-vm-guest-dind-bind-3.log`.
- Archive `/workspace/kata-vm-guest-dind-bind-evidence-3.tar.gz`, SHA256
  `473e2f4aa87916466f3a39845a6cfe7f3acd15c0ecc381d47a32c36819803efb`.

### Approved same-permissions trace: process-identity guard stopped the run

The operator approved a separately reviewed, bounded trace without permission
changes. Harness SHA256
`bd87cd1abb4129c3c4c6d19070cf3ef742604a27e6e95cd8fb5deaa5319b59cb`
received independent review; all 21 offline fixtures passed. It requires
preinstalled strace, parent-child tracing with EXITKILL, bounded output/time,
exact process ownership and at most one nested-start attempt. Tracing can
perturb behavior and cannot itself establish untraced DinD acceptance.

The live run exited **1 before dockerd or nested startup**. The smoke trace
completed successfully; private containerd logged successful boot, but the
supervisor did not publish its required process-identity record. Cleanup
cancelled that supervisor and deferred guest mount teardown to exact outer
container removal. This is a harness identity-verification failure under
investigation, not another observation of the original nested-init denial.
The denied nested operation remains unidentified; no permission increase,
untraced fallback or live retry followed.

Exact outer container
`b78d7bf06c9eef94d3bedb7643b5987c0c6f71f79c5f8fe15f895ca49bdc9eff`
was removed; `kata-guest-dind-trace-LT5yDhx4-data` remains. Docker PID28754 and
configuration checksum were unchanged. The original stopped canary's full
inspection matched its saved baseline; approximately 9.9GiB remained free.

- VM evidence: `/home/kata-test/kata-guest-dind-trace.LT5yDhx4`.
- Log: `/workspace/kata-vm-guest-dind-trace.log`.
- Archive: `/workspace/kata-vm-guest-dind-trace-evidence.tar.gz`, SHA256
  `844a41b8e5cc4073d621d92aa7931e717bc994b99a0b09e3b58d1d095772497c`.

DinD and deployment acceptance remain incomplete; the application gate stays
closed.

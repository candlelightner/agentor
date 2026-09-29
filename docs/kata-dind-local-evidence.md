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

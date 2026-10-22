# Hardware device permissions

Agentor can pass host GPUs and USB devices into ordinary workers. USB and Intel mediated GPU access requires platform approval, account entitlement, and an owner assignment. Physical PCI GPUs and native vGPU profiles use the separate platform-admin-only assignment described below. A host bind mount is not sufficient because Docker's device cgroup must also permit the character device.

## Discovery and stable identity

The platform **Hardware** dialog runs a short-lived discovery container using the configured worker image. The probe has no network, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and read-only `/dev` and `/sys` views. It reports DRM render devices, physical PCI GPUs and USB devices; it does not open device nodes.

GPU identity uses the PCI address behind a DRM render node, such as `drm:pci:0000:00:02.0`. All matching DRM card/render nodes are resolved at worker build time. USB identity uses vendor, product, and serial when present. Devices without a serial use their physical sysfs port, which is stable only while connected to the same port. Current `/dev/bus/usb` paths are never stored as authority.

Approved devices remain visible while unplugged, marked **unavailable**. Creating or rebuilding a worker with an unavailable device fails with an instruction to reconnect it. Replugging USB hardware can change its node, so rebuild the worker after reconnecting it.

## Authorization and delegation

1. A platform administrator selects a live device from discovery and adds it to the global catalog.
2. A platform administrator entitles an account to that device.
3. The account owner assigns it to all workers, one direct worker group, or one worker.
4. A worker selects the opaque device ID in New Worker or Worker Settings.

A group administrator can inspect devices explicitly granted to its administrative group and delegate them to descendant groups or workers in that subtree through management MCP. It cannot discover or approve host hardware, entitle accounts, create account-wide grants, cross into sibling groups, or submit raw device paths.

## Docker mapping and revocation

Immediately before create, rebuild, or unarchive, Agentor rechecks the grant, discovers the current nodes for the stable selector, and supplies Docker `HostConfig.Devices` mappings with `rwm` cgroup permission. It also adds the host device-node group IDs through `GroupAdd`, allowing the normal worker user to open render/video/USB nodes when their filesystem mode permits it.

Removing a catalog entry, entitlement, assignment, or applicable group membership removes the device from desired worker state. An affected running worker is stopped, `hardwareDevicesRevoked` and `pendingRebuild` are persisted, and restart is blocked. Rebuild creates a replacement without the revoked Docker mapping and clears the guard. Startup retries any stop that failed during an earlier Docker outage.

## Interfaces

REST:

- `GET|POST /api/hardware-devices`
- `PATCH|DELETE /api/hardware-devices/:id`
- `PUT /api/hardware-devices/entitlements`
- `POST /api/hardware-devices/grants`
- `DELETE /api/hardware-devices/grants/:id`
- worker create/update accepts `hardwareDeviceIds: string[]`

Platform management MCP exposes discovery, catalog, entitlement, and grant operations under `hardware-devices.*`. Group administrative MCP exposes only `hardware-devices.delegations.list|create|delete`. Worker create/update MCP accepts only opaque `hardwareDeviceIds`, never raw device nodes.

The global catalog is stored in `admin/hardware-devices.v1.json`; per-account entitlement and grant ancestry is stored in `users/<userId>/hardware-device-grants.json`. These policy files are included in instance recovery snapshots, while the hardware itself is an external dependency that must exist on the destination host.

Workers with Docker-in-Docker enabled already run as privileged containers, so Docker cannot provide the same device-isolation boundary for them. Explicit assignment still supplies the required device nodes, but use non-Docker workers when the device grant itself must be an enforceable isolation boundary.

Passing an Intel GPU accelerates VAAPI/OpenCL/oneAPI or browser workloads that use it. Agentor's current noVNC path still uses Xvfb, x11vnc, and WebSockets, so device access alone does not turn noVNC encoding into a GPU pipeline.


## Incus VM hardware (opt-in; per-installation hardware acceptance)

The USB VM path accepts only uniquely serial-numbered devices with recognized non-storage interfaces. The existing catalog ID, account entitlement and worker/direct-group assignment remain the authority. Each assignment is exactly `type=usb`, vendor ID, product ID, serial and `required=true`; volatile bus/device numbers and user-supplied device paths never become Incus selectors. Unplugging prevents the next start; replugging the same serial survives node renumbering.

Enable this only through an operator review of the dedicated installation: rerun `setup-incus-host.sh` with its existing exact arguments plus `--enable-usb`, then configure `INCUS_USB_ENABLED=true` on the orchestrator and run `check-incus-host.sh --enable-usb` with the existing checker arguments. The installer verifies installation ownership and existing project/export policy before changing only `restricted.devices.usb` to `allow`. GPU, PCI and Unix device classes remain blocked; no host-root mapping or additional host path is granted. Incus permits USB as a category, so its client certificate remains a trusted control-plane credential; Agentor's catalog/grant validation supplies the exact-device boundary.

USB storage, hubs/controllers, block-device descendants, missing/duplicate serials and unrecognized interface layouts fail closed. All storage is rejected, including unmounted backups and swap/VM disks; mounting status is never treated as permission to detach a disk. A stopped active worker retains its reservation. Archive releases the reservation, while unarchive and rebuild check current grants, discovery, other active workers, live legacy Docker mappings and other Incus instances in the dedicated project. Reservations are visible in the Hardware dialog. External host administrators and other Incus projects remain outside Agentor's control.

Create, start, rebuild, unarchive and migration reauthorize the durable hardware IDs. Migration checks capability before preparing topology or stopping the legacy worker, and rejects unsupported hardware without deleting its grant intent. Isolated restore compute has no USB; authorized devices are added only during stopped operational promotion. Worker exports and backups retain only opaque catalog IDs, which must exist and be independently granted to the destination worker. A portable import with unresolved grants is rejected; an archive cannot authorize raw hardware or create an entitlement. Instance recovery also preserves the catalog and grant files. Revocation durably blocks restart and requires rebuild; unknown or uncached VM shutdown remains explicitly pending until the captured incarnation can be stopped.

Intel GVT-g mediated GPU assignment now has an explicit opt-in implementation. `INCUS_GPU_MDEV_PROFILE` must name an actual `i915-GVTg_V…_…` profile exposed by the current host; empty disables GPU assignment. Discovery requires Intel vendor, the `i915` driver, enabled GVT-g, a `vfio-pci` profile and readable nonnegative capacity. Admission checks the selected profile has free capacity, then emits only `type=gpu`, `gputype=mdev`, the catalog's exact PCI address, and the operator-selected profile. It never guesses a profile, uses volatile DRM card numbers, detaches the physical GPU, or falls back to raw PCI/SR-IOV/native-context.

The operator must separately enable the exact profile through `setup-incus-host.sh --gpu-mdev-profile <actual-profile>` and `check-incus-host.sh --gpu-mdev-profile <actual-profile>`. Setup checks live profile capacity before its first mutation, binds `restricted.devices.gpu=allow` to `user.agentor.gpu-mdev-profile`, and retains blocked PCI/unix devices and low-level VM overrides. Incus project policy has no mdev-only permission: the control plane enforces exact mdev maps; the restricted control-plane certificate remains trusted infrastructure. USB permission remains a separate opt-in. Existing operator configuration may gain these explicit hardware opt-ins, but unrelated configuration changes and implicit disablement are rejected.

GPU grants use the same fresh catalog/entitlement/worker authorization, stopped-worker reservation, conflicting native/legacy mapping checks, migration preflight and revocation fences as USB. A running worker can revalidate its full profile only when its exact Incus device map, volatile mdev UUID and current host profile-instance listing agree. Recreation releases that allocation through Incus before replacement. Incus owns mdev creation, rollback and stop cleanup; Agentor never writes host sysfs. Isolated restore boots remain hardware-free and add the GPU only at authorized operational promotion. Inside the owned guest, startup adds the agent to guest video/render groups and requires read/write access to an i915 render node before worker service startup. That is device readiness, not a measured accelerated workload.

SR-IOV and native-context assignment remain unimplemented. Supported Intel GVT-g behavior depends on the actual driver, kernel, exposed profile and capacity; no host capability is inferred from a model name alone.
See [Intel mediated GPU preparation](intel-mediated-gpu.md) for maintenance,
power ordering and disposable acceptance guidance. Physical USB and remaining
hardware acceptance are tracked in issue #12.

Upstream semantics: [Incus 6.0.6 mdev implementation and exact PCI selector](https://github.com/lxc/incus/blob/v6.0.6/internal/server/device/gpu_mdev.go), [Intel historical GVT-g setup guide](https://github.com/intel/gvt-linux/wiki/GVTg_Setup_Guide), [USB devices](https://linuxcontainers.org/incus/docs/main/reference/devices_usb/), [GPU modes](https://linuxcontainers.org/incus/docs/main/reference/devices_gpu/), [restricted projects](https://linuxcontainers.org/incus/docs/main/reference/projects/).

Legacy USB catalog selectors written by the old shell probe may contain one newline-derived trailing space in each sysfs field. Discovery and approval recognize that exact historical encoding without rewriting catalog IDs, grants or serials. A different serial remains a different device, even with the same vendor/product. Duplicate normalized catalog entries are quarantined; duplicate live identities remain blocked. This fixes existing camera/fingerprint grants becoming falsely unavailable after the probe change, and does not authorize storage or controller passthrough.


### Physical GPU passthrough (P1, separate opt-in)

Physical PCIe GPU assignment uses the existing catalog, exclusive reservations,
revocation and incarnation fences, with platform-admin-only per-VM authority. It emits only
`type=gpu`, `gputype=physical`, and the current PCI address resolved from fresh
sysfs evidence. Worker requests, records, exports and backups keep opaque catalog
IDs; caller-supplied PCI addresses never authorize assignment. Incus owns VFIO
activation and cleanup; Agentor never rebinds a host driver or writes host sysfs.

Discovery also enumerates PCI display devices without DRM nodes. Physical
identity combines vendor/device/subsystem IDs and a trustworthy sysfs/PCI VPD
serial or directly observed NVIDIA GPU UUID. Non-Intel DRM devices retain their
legacy selector alongside the physical selector. Missing or duplicate identity,
an unknown boot-display state, unsafe IOMMU members, and host-driver attachment
block admission. The group may contain only the GPU and its verified PCI bridge
ancestors; unrelated bridges, storage and additional endpoints remain blocked.
The GPU must already be unbound or bound to
`vfio-pci` through separately approved operator maintenance. VGA boot status must
be readable; explicit non-VGA 3D/other-display classes may lack `boot_vga`.
Devices without trustworthy identity evidence remain unsupported. Existing
DRM/mdev catalog identities keep their current behavior.

For NVIDIA GPUs whose UUID is visible only through the host driver, approval
captures a private catalog witness of the host boot ID and the kernel's 64-bit
PCI object inode. Fresh direct UUID observation refreshes this witness. After
operator-approved driver release, the same UUID may be resolved only while the
boot, kernel object and PCI identity still match; the PCI address is always read
fresh. Host reboot, replacement or re-enumeration invalidates that continuity
proof. A fresh direct UUID observation is required before another release; the
enclosure identity, old PCI address or cached UUID alone never establishes GPU
identity. No host driver is rebound by discovery or authorization.

Before initial approval or revalidation, the host driver must report a real GPU
UUID. After driver rebinding it may temporarily report a placeholder until the
operator initializes the idle, host-owned GPU with its normal driver utility.
The probe never initializes or opens a GPU device; placeholder UUIDs fail closed.

The operator enables the installation with its existing exact setup arguments
plus `--enable-physical-gpu`, sets `INCUS_GPU_PHYSICAL_ENABLED=true`, and runs the
checker with `--enable-physical-gpu`. Setup records
`user.agentor.gpu-physical=true` beside `restricted.devices.gpu=allow`. Raw PCI,
unix devices and low-level VM overrides stay blocked. Incus has a category-wide
GPU permission; the trusted control plane enforces the exact catalog device.
Physical and mdev policy can coexist, with each explicitly enabled. Changing
project policy or production GPU ownership still requires operator approval.

Only a global platform administrator can assign or release a physical PCIe
GPU. The Hardware dialog provides one VM selector per approved GPU; the same
operations are available through platform-admin MCP as
`hardware-devices.gpu.list`, `hardware-devices.gpu.assign` and
`hardware-devices.gpu.release`, or `GET/PUT /api/hardware-devices/gpu`.
Assignment uses a catalog binding to one explicit ordinary Incus VM, independent
of account/group grants. Owner grants, delegated grants, portable imports,
clones and generic worker settings cannot create, move or remove this binding.
Existing Intel mediated GPU and USB permissions remain unchanged. The physical
path accepts any vendor with the required identity and isolation evidence, including
consumer GPUs with no native mdev capability.

Stop the VM before assigning or releasing its GPU. Agentor changes only the
captured stopped VM's device configuration, retaining its ordinary root image,
workspace and persistent volumes. Start it through the existing worker
controls. No host driver is detached and no running VM is stopped implicitly.
An uncertain change leaves the worker fenced for recovery; repeat the authorized
operation after checking the stopped VM. An assigned VM cannot be archived or
deleted until a platform administrator releases its GPU.

A stopped active worker retains its physical reservation until explicit admin
release. A retained Incus instance device assignment still blocks a peer,
even if that instance is stopped. BDF renumbering resolves the same serial at
recreation; starting an old layout requires rebuild instead of silently changing
its PCI mapping. Missing devices and uncertain rollback retain existing recovery
fences. No new worker image, guest driver installer, scheduler or GPU job API is
included in P1.

Live acceptance for each Agentor installation requires an approved,
disposable ordinary VM: confirm discovery reads its stable serial and isolation,
exercise admin assign/start/restart/rebuild/stop/release and revocation, verify
conflicting owners are refused, run guest driver and CUDA checks including large
64-bit BAR allocation, and verify clean release and recovery after failure. Review
ownership in other Incus projects and host consumers separately: the restricted
Agentor client inventories only its dedicated project. Recheck storage and
unrelated guest health before and after the cycle. When upstream PCIe bridges
must stay awake during testing, use only temporary operator-approved settings and
restore them afterward; install no permanent power policy. Keep actual identities,
addresses, topology, diagnostics and acceptance receipts private and untracked.


### Native vGPU profiles in Hardware

For host preparation, guest driver compatibility and a disposable CUDA lifecycle
check, see [NVIDIA vGPU setup](nvidia-vgpu.md).

The existing platform GPU opt-in also enables per-worker native mdev assignment.
The Hardware popup lists dynamically discovered profile names, framebuffer sizes
and maximum capacity when sysfs reports them, current available capacity, and
running or stopped worker allocations. Incus device configurations remain the
allocation record; existing catalog metadata stores only administrative authority
and interrupted-change recovery receipts. No allocation database or service is added.

Use the same GPU REST/MCP operations, with an optional `profile` on assignment:
`hardware-devices.gpu.assign({deviceId, workerId, profile})`. Omitting `profile`
selects full physical passthrough. To release one of several vGPU allocations,
provide `workerId` to `hardware-devices.gpu.release`; REST uses
`{deviceId, workerId: null, releaseWorkerId}`. Profile changes require the same
stopped worker and preserve its other devices and data. Stopped configurations
reserve capacity across starts; running instances must have distinct UUIDs found
in current sysfs. Unknown instances, conflicting physical mappings and insufficient
capacity block assignment. Homogeneous profiles are required conservatively;
mixed profiles are not inferred from framebuffer sizes alone.

Host mode is reported from current driver ownership. Full physical passthrough
remains visible when a host vGPU driver owns the GPU, with its maintenance
constraint explained. Agentor never changes host drivers or creates mdevs itself.
Native vGPU guest drivers and licensing belong to the worker; Agentor installs
neither and imposes no Intel render-node setup on a native vGPU guest. Intel's
existing operator-selected GVT-g profile and USB authorization stay unchanged.
The restricted Incus client sees only its installation project; unknown live
sysfs instances fail closed. Operators must also account for stopped assignments
in other projects before reserving a shared host GPU.

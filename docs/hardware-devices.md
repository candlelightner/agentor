# Hardware device permissions

Agentor can pass host GPUs and USB devices into ordinary workers through Docker device mappings. Access starts empty and requires platform approval, account entitlement, and an owner assignment. A host bind mount is not sufficient because Docker's device cgroup must also permit the character device.

## Discovery and stable identity

The platform **Hardware** dialog runs a short-lived discovery container using the configured worker image. The probe has no network, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and read-only `/dev` and `/sys` views. It reports DRM render devices and USB devices; it does not open them.

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


## Incus VM hardware (opt-in; physical acceptance pending)

The implemented VM path accepts only uniquely serial-numbered USB devices with recognized non-storage interfaces. The existing catalog ID, account entitlement and worker/direct-group assignment remain the authority. Each assignment is exactly `type=usb`, vendor ID, product ID, serial and `required=true`; volatile bus/device numbers and user-supplied device paths never become Incus selectors. Unplugging prevents the next start; replugging the same serial survives node renumbering.

Enable this only through an operator review of the dedicated installation: rerun `setup-incus-host.sh` with its existing exact arguments plus `--enable-usb`, then configure `INCUS_USB_ENABLED=true` on the orchestrator and run `check-incus-host.sh --enable-usb` with the existing checker arguments. The installer verifies installation ownership and existing project/export policy before changing only `restricted.devices.usb` to `allow`. GPU, PCI and Unix device classes remain blocked; no host-root mapping or additional host path is granted. Incus permits USB as a category, so its client certificate remains a trusted control-plane credential; Agentor's catalog/grant validation supplies the exact-device boundary.

USB storage, hubs/controllers, block-device descendants, missing/duplicate serials and unrecognized interface layouts fail closed. All storage is rejected, including unmounted backups and swap/VM disks; mounting status is never treated as permission to detach a disk. A stopped active worker retains its reservation. Archive releases the reservation, while unarchive and rebuild check current grants, discovery, other active workers, live legacy Docker mappings and other Incus instances in the dedicated project. Reservations are visible in the Hardware dialog. External host administrators and other Incus projects remain outside Agentor's control.

Create, start, rebuild, unarchive and migration reauthorize the durable hardware IDs. Migration checks capability before preparing topology or stopping the legacy worker, and rejects unsupported hardware without deleting its grant intent. Isolated restore compute has no USB; authorized devices are added only during stopped operational promotion. Worker exports and backups retain only opaque catalog IDs, which must exist and be independently granted to the destination worker. A portable import with unresolved grants is rejected; an archive cannot authorize raw hardware or create an entitlement. Instance recovery also preserves the catalog and grant files. Revocation durably blocks restart and requires rebuild; unknown or uncached VM shutdown remains explicitly pending until the captured incarnation can be stopped.

GPU assignment is **not implemented**. Discovery reports the actual host driver, IOMMU group, boot-VGA state, mdev profiles and SR-IOV capacity. Whole-device GPU passthrough needs a dedicated isolated GPU; shared Intel iGPU acceleration needs separately demonstrated host/guest support. A DRM render node alone proves neither. On the rollout host, read-only inspection found Intel `8086:5917`, `i915`, boot VGA, no IOMMU group, no mdev profiles and zero SR-IOV VFs. Its JMicron USB storage bridge and xHCI root hubs are rejected by the new probe.

Validation in this change uses mocked Incus/Docker operations, persisted grant stores and synthetic sysfs fixtures. Real USB attach/detach, guest usability, revocation and migration round-trips have **not** been run because production migration and host storage are active. Hardware API/UI E2E assertions have been extended, but those full-stack runs and physical acceptance remain required before calling issue #12 complete. Do not use the JMicron disks as acceptance fixtures.

Upstream semantics: [USB devices](https://linuxcontainers.org/incus/docs/main/reference/devices_usb/), [GPU modes](https://linuxcontainers.org/incus/docs/main/reference/devices_gpu/), [restricted projects](https://linuxcontainers.org/incus/docs/main/reference/projects/).

Legacy USB catalog selectors written by the old shell probe may contain one newline-derived trailing space in each sysfs field. Discovery and approval recognize that exact historical encoding without rewriting catalog IDs, grants or serials. A different JMicron serial remains a different device, even with the same vendor/product. Duplicate normalized catalog entries are quarantined; duplicate live identities remain blocked. This fixes existing camera/fingerprint grants becoming falsely unavailable after the probe change, and does not authorize storage or controller passthrough.

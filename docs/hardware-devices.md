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

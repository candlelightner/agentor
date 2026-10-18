# Intel mediated GPU host preparation

Agentor supports the Intel GVT-g mediated-device path when the host exposes a
compatible profile. It does not implement physical GPU/PCI assignment, SR-IOV
or native-context assignment. Device grants still require the catalog,
entitlement and worker/group authorization described in [hardware permissions](hardware-devices.md).

## Host preparation

1. Check the actual GPU, driver, kernel support and exposed mediated profiles.
   A kernel configuration symbol alone is not device readiness.
2. Plan kernel/module changes as host maintenance with local-console access,
   verified backups and a boot rollback plan. Do not unbind the boot GPU or
   reload its display driver while production guests are active.
3. Select an exposed `i915-GVTg_V…_…` profile with the expected `vfio-pci` device
   API and available capacity. Do not fabricate a profile or fall back to raw PCI.
4. Run the owned host installer/checker with `--gpu-mdev-profile <profile>` and
   set the matching `INCUS_GPU_MDEV_PROFILE` on the orchestrator.
5. Exercise a disposable guest as the normal agent user, including its required
   accelerated workload, lifecycle, revocation and capacity release, before
   migrating an existing worker.

## Optional power-ordering unit

Some compatible i915 configurations require the GPU to be runtime-active before
KVMGT loads. The [example systemd unit](../scripts/maintenance/agentor-hp-elitebook-830-g5-gvt.service)
is deliberately guarded for Intel device `8086:5917`, the i915 driver and the
reviewed kernel parameters. It requests active/D0 power before loading KVMGT and
runs before Incus. It is not a portable default for other hardware: review its
exact guards and boot rollback requirements before installation. Agentor does
not install or change host boot settings implicitly.

Keep machine identifiers, disk/USB serials, topology, incident logs and workload
receipts in private operator storage. Devices backing VM storage or backups
must never be used as passthrough acceptance fixtures.

References: [Incus GPU devices](https://linuxcontainers.org/incus/docs/main/reference/devices_gpu/),
[Intel GVT-g setup](https://github.com/intel/gvt-linux/wiki/GVTg_Setup_Guide).

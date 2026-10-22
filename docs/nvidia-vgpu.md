# NVIDIA vGPU setup for Agentor workers

This guide connects an operator-prepared NVIDIA vGPU host to Agentor's existing
Incus worker lifecycle. Agentor discovers native mediated-device (mdev) profiles
and lets global administrators assign them to stopped ordinary worker VMs. Host
driver installation is operator maintenance; guest drivers and licensing belong
to the worker. Agentor never switches host drivers.

## 1. Choose a supported combination

Check NVIDIA's [GPU support table](https://docs.nvidia.com/vgpu/gpus-supported-by-vgpu.html)
and the release notes for your chosen vGPU software branch. Match the GPU, host
distribution/kernel, KVM platform, guest OS/kernel and guest driver compatibility
matrix. A newer release is not automatically compatible with an older GPU. For
example, Tesla P40 appears in the historical branch 16 documentation; check the
support lifecycle before choosing it for a new deployment.

Agentor requires profiles actually exposed through `mdev_supported_types` with
the `vfio-pci` device API. A GPU model name or working host CUDA alone does not
prove readiness. NVIDIA hardware using a different VFIO interface, MIG or direct
SR-IOV assignment is outside this Agentor path. Consumer GPUs without native
vGPU support can use [full physical passthrough](#full-physical-passthrough).

## 2. Prepare the host

Follow the deployment instructions for your selected NVIDIA release, such as
the [Ubuntu/KVM deployment guide](https://docs.nvidia.com/vgpu/deployment/ubuntu-with-kvm/latest/overview.html).
Obtain the NVIDIA vGPU Manager and compatible GRID/vGPU guest driver through
NVIDIA's authorized distribution. A standard desktop or CUDA host driver is not
a substitute for vGPU Manager.

Complete the vendor's virtualization, IOMMU, firmware, kernel-header, module
signing and driver requirements during planned maintenance. Keep a tested boot
and package rollback path. Do not unbind or reload a production GPU while guests
use it. Validate driver/module persistence after an operator-controlled reboot;
review package and kernel upgrades against the supported matrix before applying
them. Agentor's installer does not perform these host changes.

Check discovery on the host (read-only):

```sh
nvidia-smi
incus info --resources
ls /sys/bus/pci/devices/*/mdev_supported_types/
```

Select the GPU's actual PCI address and profile directory from discovery. Read
that profile's `name`, `description`, `device_api` and `available_instances`
files. Do not guess `nvidia-*` IDs from another machine. The expected API is
`vfio-pci`; capacity must be readable. Missing profiles require host-side
diagnosis, not manual creation of sysfs devices. Incus owns mdev creation and
cleanup when the VM starts and stops; see [Incus GPU devices](https://linuxcontainers.org/incus/docs/main/reference/devices_gpu/).

## 3. Enable Agentor's existing GPU opt-in

First complete the normal [Incus rollout](incus-rollout.md). For an existing
installation, rerun `scripts/setup-incus-host.sh` with its **same exact setup
arguments**, adding `--enable-physical-gpu`. Set this orchestrator environment
variable through your normal deployment configuration:

```dotenv
INCUS_GPU_PHYSICAL_ENABLED=true
```

Run `scripts/check-incus-host.sh` with the installation's existing checker
arguments plus `--enable-physical-gpu`. Despite the historical flag name, this
opt-in covers platform-admin native mdev assignments as well as physical GPUs.
It permits the Incus GPU device category while leaving raw PCI devices and
low-level VM overrides blocked. Retain the dedicated project, restricted client
certificate and existing ownership checks; do not make the project unrestricted.
`INCUS_GPU_MDEV_PROFILE` is the separate legacy Intel GVT-g setting and is not
needed for NVIDIA profile selection.

## 4. Assign a profile in Hardware

1. Sign in as a global platform administrator and open **Hardware**. Discover
   and approve the intended GPU in the existing catalog.
2. Under **GPU assignment**, inspect profile names, framebuffer sizes, available
   capacity, active/reserved counts and attached workers. Unreported metadata is
   shown explicitly rather than inferred.
3. Create a disposable ordinary Incus worker through Agentor's normal UI. Stop
   it through the worker controls before assignment.
4. Select that stopped worker and an available native profile, then **Assign**.
   Start the worker through its normal controls.

Agentor configures an Incus `type=gpu`, `gputype=mdev` device with the discovered
PCI selector and profile. For operator inspection, use
`incus --project PROJECT config show VM --expanded`, replacing both placeholders
with values from your own installation. Make allocation changes through Agentor
so its authorization and recovery checks remain in effect.

For example, an exposed P40-24Q profile provides 24 GiB to one VM; an exposed
P40-12Q profile can provide 12 GiB each to two VMs when the host reports capacity
two. These are alternatives on the same GPU. Agentor conservatively requires
the same profile across simultaneous allocations; it does not infer mixed-profile
support from framebuffer arithmetic. Always use live capacity rather than the
example as a hardware guarantee.

A stopped assignment still reserves capacity. To change profile, stop the VM
and assign its new profile; if other VMs reserve an incompatible profile, stop
and release those allocations first. Stop and **Release** each allocation before
archiving or deleting its worker. Release does not switch the host driver.

## 5. Install the guest driver and validate CUDA

Inside the disposable worker, install the compatible GRID/vGPU **guest** driver
for its actual guest kernel, following the selected release's
[NVIDIA user guide](https://docs.nvidia.com/vgpu/latest/grid-vgpu-user-guide/).
Use the matching release's documentation when it differs from the latest guide.
Complete any required guest reboot using Agentor's stop/start controls. Guest
licensing configuration remains the worker operator's responsibility.

Check guest `nvidia-smi` for the expected profile and framebuffer. Then run a real
CUDA workload that allocates device memory, executes a kernel, copies results
back and checks them numerically. Detection alone is not a compute test. Choose
a CUDA toolkit and sample version supporting both the guest driver and GPU
architecture; install toolkit components without replacing the GRID driver.
The [branch 16 KVM release notes](https://docs.nvidia.com/vgpu/16.0/grid-vgpu-release-notes-generic-linux-kvm/index.html)
include CUDA installation restrictions for that branch.

Before using production workers, validate the entire disposable lifecycle:

1. Run the computation, explicitly free GPU resources and let the process exit.
2. Stop the worker, release its allocation and verify Hardware capacity returns.
3. Reassign, start and repeat computation and cleanup. Check host/guest errors.
4. For shared profiles, run both VMs concurrently. Release either stopped VM and
   confirm the other VM can still compute, then repeat in the opposite order.
5. Release all assignments and delete the disposable workers through Agentor.
   Verify the Incus devices and live mdev instances are gone and capacity returns.

No reusable GPU image is required. Temporary guest-root driver installations
are lost on rebuild; arrange guest software through your own supported worker
setup when needed. Keep operational logs and machine identifiers private.

## API, MCP and troubleshooting

The same global-admin operations are available through
`GET/PUT /api/hardware-devices/gpu` and platform-admin MCP
`hardware-devices.gpu.list|assign|release`. Assignment accepts opaque
`deviceId`, `workerId` and the discovered `profile`; release identifies the worker
when the GPU has multiple allocations. See [hardware permissions](hardware-devices.md#native-vgpu-profiles-in-hardware)
for request shapes. Worker owners and group administrators cannot allocate GPUs.

If assignment is blocked, inspect the reason in Hardware: stop the target VM,
release incompatible reservations, or resolve unmanaged allocations. Unknown live
mdev instances fail closed. The restricted Agentor client inventories only its
dedicated project; operators must also account for stopped assignments in other
projects. Do not delete someone else's device to recover capacity. Driver/kernel
errors require host maintenance before retrying GPU lifecycle tests.

## Full physical passthrough

**Full physical passthrough** remains a first-class selection, including for
consumer GPUs without mdev support. It requires exclusive ownership, trustworthy
GPU identity, safe IOMMU isolation and a GPU already unbound or bound to `vfio-pci`
by the operator. A GPU owned by vGPU Manager cannot simultaneously be passed
through whole. Agentor explains this constraint and never changes drivers to
satisfy an allocation. Follow the existing
[physical GPU preparation and assignment rules](hardware-devices.md#physical-gpu-passthrough-p1-separate-opt-in).

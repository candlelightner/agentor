# Remaining hardware worker migration — 2026-10-18

This runbook records the reviewed maintenance sequence and the host/GVT checkpoint below; the temporary GPU maintenance boot and mediated guest attachment succeeded. A public Whisper sample also completed on the disposable guest using Intel/Vulkan0; lifecycle acceptance and real worker migration remain pending. The required outcome is `bachelorarbeit` in an Incus VM with working Intel Vulkan acceleration. Retained Docker compute is rollback material, not the completed outcome.

The owner subsequently retired the JMicron worker from this migration: leave it archived, preserve its workspace/agent/Docker data, plugin, catalog entries and grants, and do not evacuate the SSD, remap its serial or attach its devices. No deletion was requested. This supersedes the earlier requirement to migrate both hardware workers.

## Recorded evidence

Read-only checks inspected the two workers' persisted records/grants, sysfs, boot configuration, mounts, package metadata from the stopped GPU container, and relevant workspace documentation. They did not start a container, probe USB control endpoints, load modules, change settings or access credentials.

| Item | Observed state | Consequence |
| --- | --- | --- |
| GPU worker | `484f104d-4370-4d78-a5d6-dde517161c11`, active legacy record with stopped intent/source; no migration marker | Use its existing ordinary migration path after hardware acceptance; retain the exact source. |
| GPU grant | `5f880e5a-1571-4b2b-8b77-1c94ebb704aa`, `drm:pci:0000:00:02.0` | Preserve this catalog ID, entitlement and worker grant. |
| GPU | Intel `8086:5917`, i915, boot VGA; no physical GPU IOMMU group. The successful maintenance boot exposed `i915-GVTg_V5_4` and `i915-GVTg_V5_8`. | Use the mediated path and the selected real profile; do not detach the boot GPU. |
| Host | HP EliteBook 830 G5; after the OOM reboot, running `6.8.0-147-generic`. The original `139` assessment found `i915.enable_gvt=N`, parameter mode `0400`, and `enable_guc=-1`. | Use the current `147` for the first one-boot parameter trial; do not unbind/reload the boot display driver. |
| Modules | Both installed kernels `6.8.0-139` and `6.8.0-147` include GVT/KVMGT. On `147`, KVMGT loaded in 0.059 seconds after the GPU was resumed before module loading. | No new kernel build or third-party driver was needed. Keep the GPU awake before loading KVMGT. |
| IOMMU | 14 host groups; kernel defaults Intel IOMMU on | The host does not lack IOMMU globally. Missing physical GPU grouping alone does not reject emulated-IOMMU mdev support. |
| Boot recovery | EFI, Secure Boot disabled, GRUB hidden with timeout zero; both kernels have normal and recovery entries. Current `147` has passed the 13 ordinary-worker acceptances after reboot. | Retain `139` as a fallback; switching back is unnecessary for the first GVT trial. |
| Access | SSH socket enabled/active and local tty1 getty enabled; no IPMI device or enabled serial getty found. The owner confirmed local-console access and return to chat when told the maintenance is ready. | Coordinate the ready signal and console presence before reboot. SSH alone cannot recover a failed boot. |
| Protected storage | The original assessment saw USB `152d:0551`, serial `493526338460`, backing the Incus SSD. The later recovery receipt identifies filesystem UUID `17b446d6-0931-49a9-84a9-f5edac5a723f` after reconnection. | Follow the current recovery receipt and stable filesystem UUID, never the old `/dev/sdc2` name or enclosure serial. Verify `/mnt/agentor-vm-ssd` and the `/var/lib/incus` bind after reboot; do not detach either connector/controller. |

The originally observed USB serial differed from the historical catalog/descriptor-read serial `DCC4E54AFFFF`, but the owner reports using only one JBOD enclosure. That difference does **not** establish two physical enclosures. Historical captures and current sysfs both identify port `2-1` and VID/PID `152d:0551`; firmware/descriptor-state provenance remains unresolved. No grant was rebound. This investigation is no longer a migration prerequisite after the owner's retirement instruction.

## Minimum GPU maintenance sequence

Post-reboot update: read-only checks confirm the host is already on `6.8.0-147-generic`; both installed kernels still have `CONFIG_DRM_I915_GVT=y`, `CONFIG_DRM_I915_GVT_KVMGT=m` and `CONFIG_VFIO_MDEV=m`. There is no recorded reason to switch back to `139` for the first trial. Use current `147` with the two temporary i915 parameters below, retaining unchanged `147` and `139` entries for recovery. The prepared trial also includes `ahci.mobile_lpm_policy=1` to carry the current internal-SATA `max_performance` link policy across this boot after observed command timeouts; the cause remains unproven. This does not enable storage passthrough. The owner confirmed console/chat availability for the coordinated maintenance; this update does not initiate it. The SSD recovery receipt is `ssd-reconnection-recovery.private.json` in the private preparation directory; use its stable filesystem identity for the mount checks.

1. Settle active operations, rebuilds and image builds; the owner deferred additional DR cycles to issue #13. Both actual admins have now been transferred, passed basic Agentor access checks and are stopped; the 13 ordinary workers have already passed acceptance on `147`. Save current worker desired states and the source/image/data receipts; verify that backups and their recovery keys remain available. Record the GPU source Docker ID/image and canonical data hashes. Stop/settle guests through their supported lifecycle before the host maintenance; do not finalize migrations or delete retained sources.
2. Tell the owner when maintenance is ready and confirm they are at the EliteBook console and can select a recovery boot. Preserve normal `147` and `139` boot entries. The first trial should use a **one-boot edit** of the current `6.8.0-147-generic` entry, adding `i915.enable_gvt=1 i915.enable_guc=0 ahci.mobile_lpm_policy=1`. The last parameter preserves the existing SATA power-policy mitigation for this trial; it is not a GPU requirement. A temporary edit avoids changing every fallback entry. If console recovery is unavailable at that time, stop here; the current hidden zero-timeout menu and SSH alone are insufficient.
3. After that authorized boot, first verify SSH, host display, root and exact Incus backing mounts. Confirm the intended kernel and parameters. Before loading KVMGT, verify the exact Intel `8086:5917` device at `0000:00:02.0` is bound to i915, write `on` to its `power/control`, and require `power/runtime_status=active` and `power_state=D0`. Only then load the already installed module once with `sudo modprobe kvmgt`; its reported dependencies are i915, vfio, kvm and mdev. The failed first trial and successful corrected order are recorded below. Do not unbind i915, load vfio-pci for the physical GPU, or create an mdev by writing sysfs.
4. Read `/sys/bus/pci/devices/0000:00:02.0/mdev_supported_types`. Require real `i915-GVTg_V…_…` entries with `device_api=vfio-pci`, readable descriptions and positive `available_instances`. Select a profile with enough graphics memory for the real workload, not merely the smallest profile that boots. If none appear, inspect the bounded i915/KVMGT initialization diagnostics and stop the trial. Do not invent a profile or remove IOMMU protections to make checks pass.
5. Integrate/deploy the hardware branch through `500d241e` and its existing safety checks. Run the owned `setup-incus-host.sh` and `check-incus-host.sh` with their exact existing installation/project/storage arguments plus `--gpu-mdev-profile <observed-profile>`, and set the same `INCUS_GPU_MDEV_PROFILE`. Keep USB disabled for this GPU-only task. The profile marker and restricted-project policy must agree before activation.
6. Prove physical GPU behavior in a reviewed disposable owned guest first, with the exact PCI address/profile and captured instance UUID. Keep the real source stopped and preserve its catalog ID, grants, selected IDs and Docker container. Current application admission reserves its GPU for this active stopped worker; do not bypass that rule in application code or archive/delete the source to free the fixture. An explicitly reviewed operator-created fixture may prove the host/guest hardware path, but direct Incus creation does not count as application authorization acceptance. Remove only that captured fixture and prove capacity returns before the real worker starts. The subsequent real migration and lifecycle test must exercise application admission.
7. After the fixture is removed and capacity is restored, migrate the real worker through the supported API. Use the reviewed finite-memory environment clone, retain its exact selected GPU ID, source Docker image and all persistent data, and require retained migration status. Rebuild through the application if its environment/configuration remains pending. Repeat the workload and lifecycle acceptance below on the resulting VM before declaring hardware migration complete.
8. Persist the tested boot parameter/module-loading configuration only after successful host and guest acceptance. Recheck the generated boot entries and initramfs behavior without changing unrelated kernel options. Record the chosen kernel/profile and preserve a boot entry without GVT for recovery.

Linux 6.8 explicitly rejects GVT when GuC submission is enabled; setting `i915.enable_guc=0` makes that requirement explicit for this trial. KVMGT registers an emulated IOMMU device, so a missing physical GPU IOMMU group is not by itself evidence that mediated assignment cannot work. Linux 7.0 still contains the i915 GVT guest path, but source presence does not prove that the deployed HWE guest, host kernel, Mesa and QEMU combination works. [Linux 6.8 host initialization](https://github.com/torvalds/linux/blob/v6.8/drivers/gpu/drm/i915/intel_gvt.c), [KVMGT registration](https://github.com/torvalds/linux/blob/v6.8/drivers/gpu/drm/i915/gvt/kvmgt.c), [Linux 7.0 guest support](https://github.com/torvalds/linux/blob/v7.0/drivers/gpu/drm/i915/i915_vgpu.c).

Do not add `intel_iommu=off`, `intel_iommu=igfx_off`, ACS overrides, `kvm.ignore_msrs`, arbitrary QEMU overrides or a raw physical-GPU fallback. The installed kernel already has Intel IOMMU enabled by default. Intel's historical guide is useful for the GVT enable flag and profile inspection, not a command block to copy unchanged. [Intel GVT-g guide](https://github.com/intel/gvt-linux/wiki/GVTg_Setup_Guide).

## Acceptance that proves the requested hardware works

The worker has an existing Vulkan-enabled whisper.cpp build and a wrapper with explicit `--gpu`. Its workspace documentation records a successful Intel UHD 620/Vulkan0 run on the bundled public 11-second JFK sample. CPU was chosen as the default for a short benchmark, but CPU success does not satisfy this migration's hardware requirement. Do not use private recordings/transcripts as acceptance artifacts.

The wrapper, `build/bin/whisper-cli` and `src/whisper.cpp-1.9.4/samples/jfk.wav` are present. The required `models/ggml-small.bin` is currently absent. Use the publisher's multilingual, nonquantized **small** GGML model, which matches that filename; neither `small.en` nor a quantized variant is the same acceptance asset. The upstream [model instructions](https://github.com/ggml-org/whisper.cpp/blob/v1.8.4/models/README.md) identify this publisher. Its [immutable file pointer](https://huggingface.co/ggerganov/whisper.cpp/raw/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.bin) confirms these bytes:

- Revision: `c521a4b02f422512d734391fdf08bb08c0862f68` in `ggerganov/whisper.cpp`.
- File: `ggml-small.bin`, exactly `487601967` bytes.
- SHA-256: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
- [Immutable model download](https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.bin).

Only in the reviewed owned guest, from the existing Whisper project root as the normal agent user, download to a temporary file and publish without overwriting an existing model:

```bash
set -eu
test -d models && test ! -L models
model_tmp="$(mktemp models/.ggml-small.XXXXXX)"
trap 'rm -f -- "$model_tmp"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 30 --max-time 1800 --output "$model_tmp" \
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.bin'
test "$(wc -c < "$model_tmp")" -eq 487601967
printf '%s  %s\n' \
  '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' "$model_tmp" | sha256sum --check -
ln -- "$model_tmp" models/ggml-small.bin
```

The immutable metadata was checked on 2026-10-18; this documentation update did not download the model or execute inference. Keep the existing pinned public JFK sample. Missing model data must not be mistaken for a GPU failure. The stopped source has ffmpeg, libvulkan1, mesa-vulkan-drivers, libgomp1 and libstdc++6 installed; verify those dependencies and the Intel ICD in the destination rather than assuming conversion preserves Docker upper-layer package changes.

Inside the owned VM, as the normal agent user:

- Require an i915 render device with read/write access and an Intel hardware Vulkan device. `llvmpipe`, lavapipe, software rendering, mere PCI enumeration or a successful CPU run do not pass.
- Run the existing wrapper against the bundled public JFK sample with `--gpu --language en`, under a bounded timeout. Verify success, output text/JSON, Intel/Vulkan0 selection and GPU model allocation in its log. The wrapper currently selects `/usr/share/vulkan/icd.d/intel_icd.json`; verify that exact file exists or update only the wrapper for the installed Intel ICD filename. Preserve original workspace files and record any intentional fix.
- Observe host display/SSH and kernel diagnostics for hangs or reset failures; record the profile's capacity before allocation, while assigned and after removal.
- Exercise supported stop/start, rebuild, archive/unarchive with unchanged data and working GPU after each relevant replacement. Exercise revocation/regrant on the disposable fixture and require denied restart until a correctly authorized rebuild. Do not revoke the real worker merely to test policy.
- Verify the real worker's workspace/agent/DinD content and metadata samples, home/tools, finite memory, editor and desktop proxies, exact hardware map and retained stopped Docker source. Its existing noVNC/Xvfb desktop does not become GPU-encoded by adding a render device.

## Failure and rollback

If the host fails to boot or loses its display/driver, select the unchanged known kernel entry without the temporary GVT parameters at the local console. If it boots but exposes no usable profiles, preserve diagnostics and stop before granting GPU access. If a guest hangs or the workload fails, stop/remove only the captured owned disposable compute, verify mdev capacity returns, and retain source data and receipts. Do not reset or unbind the host GPU while other VMs are active. Restore recorded worker desired states after host health and mount identity have been verified.

The original assessment performed no GVT maintenance or physical acceptance. The later checkpoint below records successful host initialization, mediated attachment and disposable Vulkan execution; real-worker workload/lifecycle acceptance and real GPU migration remain pending. JMicron retirement removes the need for SSD evacuation and USB parity in this rollout; it does not mark the broader USB/storage/serial-less-device work complete.

## Trial preparation checkpoint

On 2026-10-18 the operator installed one separate `agentor-gvt-trial-20261018` entry for the current `6.8.0-147-generic`, saved the original GRUB files privately, regenerated with other-OS probing disabled and passed `grub-script-check`. Normal `GRUB_DEFAULT=0`, both normal kernels and fallback entries remain unchanged. At preparation, `next_entry` was empty: no trial selection or reboot occurred. A one-shot selection is consumed by GRUB and does not provide automatic recovery from a hung boot; coordinate current local-console presence before reboot. Both real admins and all current native guests are stopped, the isolated test VM is off, and the third encrypted backup plus matching keys are verified on the external SSD.

## Host power ordering checkpoint and optional normal-boot unit

On 2026-10-18 the first temporary `6.8.0-147-generic` GVT boot succeeded, but loading KVMGT while `0000:00:02.0` was runtime-suspended in D3hot caused repeated all-ones forcewake/MMIO errors, a prolonged module initialization and host stalls. No guest had been assigned the GPU. The next clean boot used the same kernel and GVT/GuC flags. The operator first changed only this GPU's `power/control` from `auto` to `on`, verified `active`/D0, then loaded KVMGT once. Loading completed in 0.059 seconds; bounded diagnostics showed no MMIO, RCU or storage errors during that trial.

That boot exposed `i915-GVTg_V5_4` (128 MiB low plus 512 MiB high graphics memory; one available instance) and `i915-GVTg_V5_8` (64 plus 384 MiB; two available instances). Owned host setup/check passed with `i915-GVTg_V5_4`. A disposable 4 GiB/two-CPU guest reached running state on guest kernel `7.0.0-38`, with an i915 render node. As the normal agent user, its existing Whisper wrapper completed the public JFK sample in 14.29 seconds with exit status zero and text/SRT/JSON outputs. The log selected `Intel(R) UHD Graphics 620 (KBL GT2)` with Intel Mesa and Vulkan0, allocated a 487.01 MB model and used the Vulkan0 backend. Guest i915 display warnings and missing DMC firmware were still recorded; successful compute does not establish that those warnings are resolved. These observations establish a disposable accelerated compute run, not real-worker workload/lifecycle acceptance, durable normal-boot operation or migration of `bachelorarbeit`; the retained real source and its grants remain unchanged.

The missing runtime-PM acquisition in [Linux 6.8 GVT snapshot initialization](https://github.com/torvalds/linux/blob/v6.8/drivers/gpu/drm/i915/intel_gvt.c) is consistent with this failure and successful ordering workaround. This is an inference from source and the two observed trials, not an identified Ubuntu `147` regression or a general GVT fix. [Kernel power-management documentation](https://www.kernel.org/doc/html/latest/driver-api/pm/devices.html) specifies that `power/control=on` resumes a device and prevents runtime suspend. It does not disable system suspend. Keeping this GPU awake can increase idle power use.

After the full GPU acceptance above, an operator may install the reviewed [host-specific oneshot unit](../scripts/maintenance/agentor-hp-elitebook-830-g5-gvt.service) on this EliteBook. First arrange the separately reviewed normal-boot `i915.enable_gvt=1 i915.enable_guc=0` flags and retain a console-selectable boot without GVT. Do not change unrelated boot parameters. Review existing module-loading configuration: KVMGT must not also be loaded earlier through initramfs, modules-load or another service, because this unit cannot fix an initialization that already started while suspended.

From the reviewed checkout, after acceptance and before the planned normal reboot:

```bash
sudo install -o root -g root -m 0644 \
  scripts/maintenance/agentor-hp-elitebook-830-g5-gvt.service \
  /etc/systemd/system/agentor-hp-elitebook-830-g5-gvt.service
sudo systemctl daemon-reload
sudo systemctl enable agentor-hp-elitebook-830-g5-gvt.service
```

These commands are manual deployment instructions, not installer behavior; they have not been executed for this sample. Enabling creates a dependency from `incus.service`, orders this oneshot before the daemon and does not enable or start Incus, workers or agent sessions. Socket activation may bind the Incus socket earlier, but the daemon's start waits for this unit. Both exact kernel flags are required; a fallback boot without them skips the unit and leaves ordinary Incus startup usable. Exact PCI vendor/device, i915 binding and live module parameters are checked before any power write; failure stops the unit before loading KVMGT. Because Incus only wants this unit, a completed preparation failure allows ordinary Incus startup; a stuck kernel initialization can still delay it and requires host recovery. Existing Agentor profile checks must continue to reject unavailable GPU starts.

The unit has no reset, unbind, physical PCI assignment, mdev creation, USB/storage operation, kernel installation or boot-configuration mutation. It remains active after success and does not put the GPU back into `auto` when Incus stops. Its startup timeout is not a guarantee that a stuck kernel module initialization can be killed; do not retry module loading on a stalled host. Preserve diagnostics and use the reviewed console/reboot recovery procedure.

After the planned reboot, verify unit success, exact kernel flags, GPU `on`/`active`/D0, the selected real profile and host/mount health before starting the required GPU workload. Re-run workload and capacity recovery checks after reboot before relying on durable operation. To withdraw this workaround, settle GPU guests, disable only `agentor-hp-elitebook-830-g5-gvt.service` and select the retained non-GVT boot; disabling the unit alone neither unloads KVMGT nor restores runtime power management in the current boot.

The sample unit and documentation received static review only. No service installation, enablement, additional module load, build/test or VM action was performed for this change.

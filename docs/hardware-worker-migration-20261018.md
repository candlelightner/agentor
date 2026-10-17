# Remaining hardware worker migration — 2026-10-18

This is a reviewed maintenance proposal, not an executed host change. The required outcome is `bachelorarbeit` in an Incus VM with working Intel Vulkan acceleration. Retained Docker compute is rollback material, not the completed outcome.

The owner subsequently retired the JMicron worker from this migration: leave it archived, preserve its workspace/agent/Docker data, plugin, catalog entries and grants, and do not evacuate the SSD, remap its serial or attach its devices. No deletion was requested. This supersedes the earlier requirement to migrate both hardware workers.

## Recorded evidence

Read-only checks inspected the two workers' persisted records/grants, sysfs, boot configuration, mounts, package metadata from the stopped GPU container, and relevant workspace documentation. They did not start a container, probe USB control endpoints, load modules, change settings or access credentials.

| Item | Observed state | Consequence |
| --- | --- | --- |
| GPU worker | `484f104d-4370-4d78-a5d6-dde517161c11`, active legacy record with stopped intent/source; no migration marker | Use its existing ordinary migration path after hardware acceptance; retain the exact source. |
| GPU grant | `5f880e5a-1571-4b2b-8b77-1c94ebb704aa`, `drm:pci:0000:00:02.0` | Preserve this catalog ID, entitlement and worker grant. |
| GPU | Intel `8086:5917`, i915, boot VGA; no GPU IOMMU group or mediated profiles | Physical PCI assignment is unsuitable. Test the already implemented mediated path. |
| Host | HP EliteBook 830 G5, running `6.8.0-139-generic`; `i915.enable_gvt=N`, parameter mode `0400`; `enable_guc=-1` | A live parameter write is unavailable; do not unbind/reload the boot display driver. |
| Modules | Both installed kernels `6.8.0-139` and `6.8.0-147` have GVT enabled in their build configuration and KVMGT as a module; KVMGT is installed, currently unloaded | No new kernel build or third-party driver is needed for the first trial. Actual profile creation remains unproven. |
| IOMMU | 14 host groups; kernel defaults Intel IOMMU on | The host does not lack IOMMU globally. Missing physical GPU grouping alone does not reject emulated-IOMMU mdev support. |
| Boot recovery | EFI, Secure Boot disabled, GRUB hidden with timeout zero, default entry selects the newer `147`; both kernels have recovery entries | Explicitly choose the known `139` for the first test; do not accidentally combine it with a host kernel upgrade. |
| Access | SSH socket enabled/active and local tty1 getty enabled; no IPMI device or enabled serial getty found | Verify working local console access with the operator before reboot. SSH alone cannot recover a failed boot. |
| Protected storage | The original assessment saw USB `152d:0551`, serial `493526338460`, backing the Incus SSD. The later recovery receipt identifies filesystem UUID `17b446d6-0931-49a9-84a9-f5edac5a723f` after reconnection. | Follow the current recovery receipt and stable filesystem UUID, never the old `/dev/sdc2` name or enclosure serial. Verify `/mnt/agentor-vm-ssd` and the `/var/lib/incus` bind after reboot; do not detach either connector/controller. |

The originally observed USB serial differed from the historical catalog/descriptor-read serial `DCC4E54AFFFF`, but the owner reports using only one JBOD enclosure. That difference does **not** establish two physical enclosures. Historical captures and current sysfs both identify port `2-1` and VID/PID `152d:0551`; firmware/descriptor-state provenance remains unresolved. No grant was rebound. This investigation is no longer a migration prerequisite after the owner's retirement instruction.

## Minimum GPU maintenance sequence

The kernel/module evidence above is the recorded pre-maintenance assessment; this update performed no fresh host probe. It supports one controlled trial on the known `139` kernel without installing a kernel, changing IOMMU flags or reloading the display driver. Local-console recovery has **not** been confirmed, so the reboot remains blocked until an operator demonstrates it. The later SSD recovery receipt is `ssd-reconnection-recovery.private.json` in the private preparation directory; use its stable filesystem identity for the mount checks.

1. Finish ordinary migrations, rebuilds and image builds. Save current worker desired states and the source/image/data receipts; verify that backups and their recovery keys remain available. Record the GPU source Docker ID/image and canonical data hashes. Stop/settle guests through their supported lifecycle before the host maintenance; do not finalize migrations or delete retained sources.
2. Confirm an operator can actually use the EliteBook console and select a recovery boot. Preserve normal `139` and `147` boot entries. The first trial should use a **one-boot edit** of the known `6.8.0-139-generic` entry, adding `i915.enable_gvt=1 i915.enable_guc=0`. A temporary edit avoids changing every fallback entry. If console recovery cannot be demonstrated, stop here; the current hidden zero-timeout menu and SSH alone are insufficient.
3. After that authorized boot, first verify SSH, host display, root and exact Incus backing mounts. Confirm the intended kernel and parameters. Load the already installed module once with `sudo modprobe kvmgt`; its reported dependencies are i915, vfio, kvm and mdev. Do not unbind i915, load vfio-pci for the physical GPU, or create an mdev by writing sysfs.
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

No host boot, module enablement, mdev creation, GPU attachment, Vulkan execution, lifecycle hardware acceptance or real GPU migration was performed during this assessment. The missing model can be restored in the disposable guest; console access and actual GVT/HWE/Vulkan compatibility still require the maintenance execution above. JMicron retirement removes the need for SSD evacuation and USB parity in this rollout; it does not mark the broader USB/storage/serial-less-device work complete.

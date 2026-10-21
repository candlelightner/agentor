import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HARDWARE_DEVICE_PROBE } from '../../orchestrator/server/utils/hardware-device-probe';
import type { HardwareDeviceCandidate } from '../../orchestrator/shared/types';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentor-pci-gpu-'));
  const script = HARDWARE_DEVICE_PROBE.replace("root = Path('/host')", 'import sys\nroot = Path(sys.argv[1])');
  const read = () => JSON.parse(execFileSync('python3', ['-c', script, root], { encoding: 'utf8', timeout: 5000 })) as HardwareDeviceCandidate[];
  const add = async (address = '0000:01:00.0', serial = 'synthetic-gpu-001', group = '12') => {
    const pci = join(root, 'sys/bus/pci/devices', address), iommu = join(root, 'sys/kernel/iommu_groups', group);
    await mkdir(pci, { recursive: true }); await mkdir(join(iommu, 'devices'), { recursive: true });
    for (const [key, value] of Object.entries({ class: '0x030000', vendor: '0x1234', device: '0x5678',
      subsystem_vendor: '0xabcd', subsystem_device: '0xef01', serial, boot_vga: '0' })) await writeFile(join(pci, key), value);
    await symlink(iommu, join(pci, 'iommu_group')); await symlink(pci, join(iommu, 'devices', address));
    return { pci, iommu };
  };
  return { root, read, add, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('physical GPU discovery needs no DRM and serial identity survives PCI renumbering', async () => {
  const f = await fixture(); try {
    const { pci, iommu } = await f.add();
    const initial = f.read()[0]!;
    expect(initial).toMatchObject({ selector: 'pci-gpu:1234:5678:abcd:ef01:synthetic-gpu-001', deviceNodes: [], groupIds: [],
      incus: { supported: true, mode: 'gpu-physical', evidence: { pciAddress: '0000:01:00.0', driver: '',
        iommuGroup: '12', iommuMembers: ['0000:01:00.0'], bootVga: false } } });
    const moved = join(f.root, 'sys/bus/pci/devices/0000:07:00.0'); await rename(pci, moved);
    await rm(join(iommu, 'devices/0000:01:00.0')); await symlink(moved, join(iommu, 'devices/0000:07:00.0'));
    expect(f.read()[0]).toMatchObject({ selector: initial.selector,
      incus: { supported: true, evidence: { pciAddress: '0000:07:00.0', iommuMembers: ['0000:07:00.0'] } } });
    const driver = join(f.root, 'sys/bus/pci/drivers/vfio-pci'); await mkdir(driver, { recursive: true });
    await symlink(driver, join(moved, 'driver'));
    expect(f.read()[0]?.incus).toMatchObject({ supported: true, evidence: { driver: 'vfio-pci' } });
    await rm(join(moved, 'boot_vga'));
    for (const gpuClass of ['0x030200', '0x038000']) {
      await writeFile(join(moved, 'class'), gpuClass);
      expect(f.read()[0]?.incus).toMatchObject({ supported: true, evidence: { bootVga: false } });
    }
    await writeFile(join(moved, 'boot_vga'), '1'); expect(f.read()[0]?.incus?.supported).toBe(false);
    await writeFile(join(moved, 'boot_vga'), '0');
    await writeFile(join(moved, 'serial'), 'replacement-gpu'); expect(f.read()[0]?.selector).not.toBe(initial.selector);
  } finally { await f.cleanup(); }
});

test('physical GPU discovery rejects missing identity, boot/host ownership and unsafe IOMMU evidence', async () => {
  for (const failure of ['serial', 'subsystem_device', 'boot_vga', 'boot', 'driver', 'broken-driver', 'iommu', 'group-member']) {
    const f = await fixture(); try {
      const { pci, iommu } = await f.add();
      if (['serial', 'subsystem_device', 'boot_vga'].includes(failure)) await rm(join(pci, failure));
      if (failure === 'boot') await writeFile(join(pci, 'boot_vga'), '1');
      if (failure === 'driver') {
        const path = join(f.root, 'sys/bus/pci/drivers/host-gpu'); await mkdir(path, { recursive: true });
        await symlink(path, join(pci, 'driver'));
      }
      if (failure === 'broken-driver') await symlink(join(f.root, 'missing-driver'), join(pci, 'driver'));
      if (failure === 'iommu') await rm(join(pci, 'iommu_group'));
      if (failure === 'group-member') await symlink(pci, join(iommu, 'devices/0000:01:00.1'));
      expect(f.read()[0]?.incus?.supported, failure).toBe(false);
    } finally { await f.cleanup(); }
  }
  const f = await fixture(); try {
    await f.add(); await f.add('0000:02:00.0', 'synthetic-gpu-001', '13');
    expect(f.read().every(candidate => candidate.incus?.supported === false)).toBe(true);
    expect(f.read()[0]?.incus?.reason).toContain('ambiguous');
  } finally { await f.cleanup(); }
});

test('physical GPU reads bounded VPD serial records and rejects malformed or duplicate serial evidence', async () => {
  const f = await fixture(); try {
    const { pci } = await f.add(); await rm(join(pci, 'serial'));
    const serial = Buffer.from('vpd-gpu-001'), field = Buffer.concat([Buffer.from([0x53, 0x4e, serial.length]), serial]);
    const vpd = Buffer.concat([Buffer.from([0x90, field.length, 0]), field, Buffer.from([0x78])]);
    await writeFile(join(pci, 'vpd'), vpd);
    expect(f.read()[0]).toMatchObject({ serial: 'vpd-gpu-001', incus: { supported: true } });
    for (const invalid of [vpd.subarray(0, -3), Buffer.from([0x90, 0xff, 0xff]), Buffer.concat([vpd, Buffer.alloc(4096)]),
      Buffer.concat([Buffer.from([0x90, field.length * 2, 0]), field, field, Buffer.from([0x78])])]) {
      await writeFile(join(pci, 'vpd'), invalid); expect(f.read()[0]?.incus?.supported).toBe(false);
    }
  } finally { await f.cleanup(); }
});

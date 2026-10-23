import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function runStorage(mode: 'ready' | 'delayed' | 'missing' | 'ambiguous' | 'unformatted' | 'wrong-filesystem') {
  const root = await mkdtemp(join(tmpdir(), 'agentor-storage-wait-'));
  try {
    const source = await readFile(new URL('../../worker/vm/agentor-docker-storage.sh', import.meta.url), 'utf8');
    const disk = join(root, 'disk'), alias = join(root, 'alias'), second = join(root, 'second');
    await writeFile(join(root, 'config'), JSON.stringify({ serial: 'incus_docker', volume: 'fixture-docker', initialize: false }));
    await symlink(disk, alias);
    if (mode !== 'missing' && mode !== 'delayed') await writeFile(disk, 'preserved-fixture');
    if (mode === 'ambiguous') { await writeFile(join(root, 'other'), 'other-fixture'); await symlink(join(root, 'other'), second); }
    const script = source.replace('/run/agentor/docker-storage.json', join(root, 'config'))
      .replaceAll('/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker', alias)
      .replaceAll('/dev/disk/by-id/virtio-incus_docker', second).replaceAll('/var/lib/docker', join(root, 'mount'));
    await writeFile(join(root, 'storage.sh'), script);
    // Simulate block nodes and mount inspection without privileged devices or writes.
    const environment = String.raw`
test() { if [[ "$1" == -b ]]; then [[ -f "$2" ]]; else builtin test "$@"; fi; }
stat() { printf '0:600\n'; }
udevadm() { echo unexpected-global-udev-wait >&2; return 99; }
lsblk() { printf 'disk\n'; }
blkid() { case "$FIXTURE_MODE" in unformatted) :;; wrong-filesystem) echo xfs;; *) echo ext4;; esac; }
mountpoint() { return 0; }
findmnt() { if [[ " $* " == *' FSTYPE '* ]]; then echo ext4; else printf '%s\n' "$FIXTURE_ROOT/disk"; fi; }
mount() { echo unexpected-mount >&2; return 98; }
mkfs.ext4() { echo unexpected-format >&2; return 97; }
wipefs() { echo unexpected-format-probe >&2; return 96; }
sleep() { if [[ "$FIXTURE_MODE" == delayed ]]; then printf preserved-fixture > "$FIXTURE_ROOT/disk"; SECONDS=$((SECONDS + 1)); else SECONDS=$((SECONDS + 31)); fi; }
`;
    await writeFile(join(root, 'environment'), environment);
    const result = spawnSync('bash', [join(root, 'storage.sh')], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, BASH_ENV: join(root, 'environment'), FIXTURE_MODE: mode, FIXTURE_ROOT: root } });
    if (result.error) throw result.error;
    expect(result.stderr).not.toMatch(/unexpected-global|unexpected-mount|unexpected-format/);
    if (mode !== 'missing' && mode !== 'delayed') expect(await readFile(disk, 'utf8')).toBe('preserved-fixture');
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
for (const mode of ['ready', 'delayed'] as const) test(`owned Docker disk ${mode}: unrelated udev activity does not block existing ext4 data`, async () => {
  const result = await runStorage(mode); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('storage preparation complete');
});
for (const [mode, message] of [['missing', 'absent after 30 seconds'], ['ambiguous', 'Ambiguous Docker block device'],
  ['unformatted', 'Initialization not authorized'], ['wrong-filesystem', 'refusing to overwrite existing xfs']] as const)
  test(`owned Docker disk ${mode}: stops without mounting or formatting`, async () => {
    const result = await runStorage(mode); expect(result.status).toBe(1); expect(result.stderr).toContain(message);
  });

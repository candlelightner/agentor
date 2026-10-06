import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, open, writeFile, readFile, lstat, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { IncusClient, type IncusImage } from '../../orchestrator/server/utils/incus-client';
import { INCUS_CONVERSION_RAW_BYTES, type IncusConvertedRaw } from '../../orchestrator/server/utils/incus-image-converter';
import { normalizeAndImportIncusImage, type IncusImageArtifactHooks } from '../../orchestrator/server/utils/incus-image-artifact';

async function fixture(run: (f: { raw: IncusConvertedRaw; scratch: string; parent: string; root: string;
  client: IncusClient; hooks: IncusImageArtifactHooks; acknowledgements: Array<Parameters<IncusImageArtifactHooks['acknowledgeImport']>[0]>;
  fail: (mode: string) => void; qemuPrefix: Buffer;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-parent-image-artifact-'));
  const parent = join(root, 'incus-image-' + randomUUID()); await mkdir(parent, { mode: 0o700 });
  const rawPath = join(parent, 'disk.raw'), scratch = join(parent, 'normalized');
  const file = await open(rawPath, 'wx', 0o600); await file.truncate(INCUS_CONVERSION_RAW_BYTES);
  // A plausible hostile qcow header/backing filename must remain opaque bytes
  // under -f raw. The parent never follows/probes this alleged backing file.
  const qemuPrefix = Buffer.alloc(4096); qemuPrefix.write('QFI'); qemuPrefix[3] = 0xfb;
  qemuPrefix.writeUInt32BE(2, 4); qemuPrefix.writeBigUInt64BE(512n, 8); qemuPrefix.writeUInt32BE(48, 16);
  qemuPrefix.write('/never-follow-guest-selected-backing-file', 512);
  await file.write(qemuPrefix, 0, qemuPrefix.length, 0); const stat = await file.stat(); await file.close();
  const raw: IncusConvertedRaw = { rawPath, rawBytes: INCUS_CONVERSION_RAW_BYTES,
    rawIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size }, sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64) };
  const client = new IncusClient({ endpoint: 'https://fixture.invalid', project: 'agentor-images' });
  const acknowledgements: Array<Parameters<IncusImageArtifactHooks['acknowledgeImport']>[0]> = [];
  let failure: string | undefined;
  const hooks: IncusImageArtifactHooks = { validateAuthority: async () => {
    if (failure === 'revoked') throw new Error('Current source permission revoked');
  }, acknowledgeImport: async ack => { acknowledgements.push(structuredClone(ack)); } };
  client.importImage = async (metadataPath, qcowPath, accepted) => {
    expect(acknowledgements.at(-1)).toEqual({ pending: true });
    await expect(lstat(rawPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const data = gunzipSync(await readFile(metadataPath));
    expect(data.subarray(0, 100).toString('utf8').replace(/\0.*/, '')).toBe('metadata.yaml');
    const size = parseInt(data.subarray(124, 136).toString('ascii').replace(/\0.*/, '').trim(), 8);
    const yaml = data.subarray(512, 512 + size).toString('utf8'), properties: Record<string, string> = {};
    for (const line of yaml.split('\n')) { const match = /^  ([a-z_]+): (".*")$/.exec(line); if (match) properties[match[1]!] = JSON.parse(match[2]!); }
    expect(properties).toMatchObject({ source_image_id: raw.sourceImageId, recipe_id: raw.recipeId,
      bootstrap_generation: '3', converter_version: 'v0.4.0', source_architecture: 'amd64' });
    expect(yaml).toContain('type: "virtual-machine"');
    expect((await readFile(qcowPath)).subarray(0, 4)).toEqual(Buffer.from([0x51, 0x46, 0x49, 0xfb]));
    await accepted?.('/1.0/operations/' + 'c'.repeat(8) + '-cccc-cccc-cccc-' + 'c'.repeat(12));
    if (failure === 'unknown') throw new Error('Unknown accepted image operation');
    if (failure === 'metadata') properties.recipe_id = 'd'.repeat(64);
    const image: IncusImage = { fingerprint: 'e'.repeat(64), type: 'virtual-machine', architecture: 'x86_64', size: 1, aliases: [], properties };
    return image;
  };
  try { await run({ raw, scratch, parent, root, client, hooks, acknowledgements, qemuPrefix, fail: mode => { failure = mode; } }); }
  finally { client.dispose(); await rm(root, { recursive: true, force: true }); }
}

test('actual trusted qemu FD normalization treats hostile qcow-looking RAW as opaque and cleans only acknowledged owned artifacts', async () => {
  test.setTimeout(60_000);
  await fixture(async f => {
    const original = f.client.importImage;
    f.client.importImage = async (...args) => {
      const info = JSON.parse(execFileSync('qemu-img', ['info', '-f', 'qcow2', '--output=json', args[1]], { encoding: 'utf8' }));
      expect(info['virtual-size']).toBe(INCUS_CONVERSION_RAW_BYTES); expect(info['backing-filename']).toBeUndefined();
      const decoded = join(f.root, 'decoded');
      execFileSync('qemu-img', ['dd', '-f', 'qcow2', 'if=' + args[1], 'of=' + decoded, 'bs=4096', 'count=1'], { stdio: 'ignore' });
      expect(await readFile(decoded)).toEqual(f.qemuPrefix);
      return original(...args);
    };
    expect((await normalizeAndImportIncusImage(f.client, f.raw, f.scratch, f.hooks)).type).toBe('virtual-machine');
    expect(f.acknowledgements.map(ack => ack.pending)).toEqual([true, true, false]);
    expect(f.acknowledgements.at(-1)?.fingerprint).toBe('e'.repeat(64));
    expect(await readdir(f.parent)).toEqual([]); // Source RAW + normalized artifacts only; parent retained.
  });
});

test('RAW identity/owned scratch confinement and revocation reject before dispatch or source deletion', async () => {
  for (const wrong of ['inode', 'scratch', 'symlink', 'revoked']) await fixture(async f => {
    if (wrong === 'inode') f.raw.rawIdentity.ino++;
    if (wrong === 'scratch') f.scratch = join(f.parent, 'not-normalized');
    if (wrong === 'symlink') { await symlink(f.parent, f.scratch); }
    if (wrong === 'revoked') f.fail('revoked');
    await expect(normalizeAndImportIncusImage(f.client, f.raw, f.scratch, f.hooks)).rejects.toThrow();
    expect(f.acknowledgements).toEqual([]); expect((await lstat(f.raw.rawPath)).size).toBe(INCUS_CONVERSION_RAW_BYTES);
  });
});

test('unknown import or mismatched trusted metadata retains exact normalized artifacts/private acknowledgement without publication', async () => {
  for (const failure of ['unknown', 'metadata']) await fixture(async f => {
    f.fail(failure);
    await expect(normalizeAndImportIncusImage(f.client, f.raw, f.scratch, f.hooks)).rejects.toThrow();
    expect((await lstat(join(f.scratch, 'disk.qcow2'))).size).toBeGreaterThan(0);
    expect((await lstat(join(f.scratch, 'metadata.tar.gz'))).size).toBeGreaterThan(0);
    expect(f.acknowledgements.at(-1)?.pending).toBe(failure === 'unknown');
  });
});

test('unexpected cleanup sibling survives; success cleanup never selects files by a glob or recursive directory removal', async () => {
  await fixture(async f => {
    const imported = f.client.importImage;
    f.client.importImage = async (...args) => { const image = await imported(...args);
      await writeFile(join(f.scratch, 'unexpected-sibling'), 'retain me'); return image; };
    await expect(normalizeAndImportIncusImage(f.client, f.raw, f.scratch, f.hooks)).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(await readFile(join(f.scratch, 'unexpected-sibling'), 'utf8')).toBe('retain me');
    expect(await readdir(f.scratch)).toEqual(['unexpected-sibling']);
  });
});

test('normalization cancellation kills and awaits the trusted tool before closing owned descriptors', async () => {
  await fixture(async f => {
    const binaries = join(f.root, 'bin'), pidFile = join(f.root, 'pid'); await mkdir(binaries);
    await writeFile(join(binaries, 'qemu-img'), '#!/bin/sh\nprintf "%s" "$$" > "$AGENTOR_QEMU_TEST_PID"\nexec sleep 600\n', { mode: 0o700 });
    const priorPath = process.env.PATH, priorPid = process.env.AGENTOR_QEMU_TEST_PID;
    process.env.PATH = binaries + ':' + priorPath; process.env.AGENTOR_QEMU_TEST_PID = pidFile;
    const controller = new AbortController();
    const checking = setInterval(() => { void lstat(pidFile).then(() => controller.abort()).catch(() => {}); }, 10);
    try {
      await expect(normalizeAndImportIncusImage(f.client, f.raw, f.scratch, f.hooks, controller.signal)).rejects.toThrow('normalization cancelled');
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow(); expect(f.acknowledgements).toEqual([]);
      expect((await lstat(f.raw.rawPath)).size).toBe(INCUS_CONVERSION_RAW_BYTES);
    } finally { clearInterval(checking); process.env.PATH = priorPath;
      if (priorPid === undefined) delete process.env.AGENTOR_QEMU_TEST_PID; else process.env.AGENTOR_QEMU_TEST_PID = priorPid; }
  });
});

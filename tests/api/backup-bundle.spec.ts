import { test, expect } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import {
  packWorkspaceBackups,
  unpackWorkspaceBackups,
} from '../../orchestrator/server/utils/backup-bundle';
import {
  MAX_BUNDLE_TOTAL_BYTES,
  MAX_INNER_ARCHIVE_BYTES,
} from '../../orchestrator/server/utils/worker-export';

const orchestratorRequire = createRequire(
  new URL('../../orchestrator/package.json', import.meta.url),
);
const tar = orchestratorRequire('tar-stream') as { pack(): any };

async function writeTar(
  path: string,
  entries: Array<{ name: string; body: string }>,
) {
  const pack = tar.pack();
  const completed = pipeline(pack, createWriteStream(path));
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name: entry.name, type: 'file', size: Buffer.byteLength(entry.body) },
        entry.body,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await completed;
}

test.describe('backup bundle boundary', () => {
  let root = '';

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentor-backup-bundle-'));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('round-trips a selective subset using historical URL-safe workspace IDs', async () => {
    const firstId = 'legacy_worker-A_123';
    const secondId = 'pre_uuid_worker_02';
    const first = join(root, 'first.worker.tar');
    const second = join(root, 'second.worker.tar');
    const bundle = join(root, 'bundle.tar');
    const extracted = join(root, 'extracted');
    await writeFile(first, 'first payload');
    await writeFile(second, 'second payload');

    await packWorkspaceBackups(
      [
        { id: firstId, path: first },
        { id: secondId, path: second },
      ],
      bundle,
    );
    const selected = await unpackWorkspaceBackups(
      bundle,
      [firstId, secondId],
      [secondId],
      extracted,
    );

    expect(selected.map((entry) => entry.id)).toEqual([secondId]);
    expect(await readFile(selected[0]!.path, 'utf8')).toBe('second payload');
  });

  test('rejects empty, duplicate, unsafe, and non-regular pack inputs', async () => {
    const regular = join(root, 'regular.tar');
    const directory = join(root, 'directory');
    const link = join(root, 'link.tar');
    await writeFile(regular, 'payload');
    await mkdir(directory);
    await symlink(regular, link);

    await expect(packWorkspaceBackups([], join(root, 'empty.tar'))).rejects.toThrow(
      /at least one/i,
    );
    await expect(
      packWorkspaceBackups(
        [
          { id: 'same-id', path: regular },
          { id: 'same-id', path: regular },
        ],
        join(root, 'duplicate.tar'),
      ),
    ).rejects.toThrow(/duplicate/i);
    await expect(
      packWorkspaceBackups(
        [{ id: '../escape', path: regular }],
        join(root, 'unsafe.tar'),
      ),
    ).rejects.toThrow(/invalid/i);
    await expect(
      packWorkspaceBackups(
        [{ id: 'safe-directory', path: directory }],
        join(root, 'directory-output.tar'),
      ),
    ).rejects.toThrow(/regular file/i);
    await expect(
      packWorkspaceBackups(
        [{ id: 'safe-link', path: link }],
        join(root, 'link-output.tar'),
      ),
    ).rejects.toThrow(/regular file/i);
  });

  test('rejects oversized nested and outer bundles before streaming sparse payloads', async () => {
    const oversizedMember = join(root, 'oversized-member.tar');
    const oversizedOuter = join(root, 'oversized-outer.tar');
    await writeFile(oversizedMember, '');
    await truncate(oversizedMember, MAX_BUNDLE_TOTAL_BYTES + 1);
    await expect(
      packWorkspaceBackups(
        [
          { id: 'worker-a', path: oversizedMember },
          { id: 'worker-b', path: oversizedMember },
        ],
        join(root, 'should-not-exist.tar'),
      ),
    ).rejects.toThrow(/size limit/i);

    await writeFile(oversizedOuter, '');
    await truncate(
      oversizedOuter,
      MAX_INNER_ARCHIVE_BYTES + 64 * 1024 * 1024 + 1,
    );
    await expect(
      unpackWorkspaceBackups(
        oversizedOuter,
        ['worker-a', 'worker-b'],
        ['worker-a'],
        join(root, 'oversized-extract'),
      ),
    ).rejects.toThrow(/size limit/i);
  });

  test('aborts malformed extraction without consuming later entries or leaving writers active', async () => {
    const firstId = 'legacy_worker_A';
    const secondId = 'legacy_worker_B';
    const bundle = join(root, 'malformed.tar');
    const extracted = join(root, 'extracted');
    const manifest = JSON.stringify({
      version: 1,
      workspaces: [
        { id: firstId, file: `workspaces/${firstId}.tar` },
        { id: secondId, file: `workspaces/${secondId}.tar` },
      ],
    });
    await writeTar(bundle, [
      { name: 'unexpected-entry', body: 'reject immediately' },
      { name: 'backup-manifest.json', body: manifest },
      { name: `workspaces/${firstId}.tar`, body: 'must not be written' },
      { name: `workspaces/${secondId}.tar`, body: 'must not be written' },
    ]);

    await expect(
      Promise.race([
        unpackWorkspaceBackups(
          bundle,
          [firstId, secondId],
          [secondId],
          extracted,
        ),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('extraction did not settle')),
            2_000,
          );
          timer.unref?.();
        }),
      ]),
    ).rejects.toThrow(/invalid multi-workspace backup bundle/i);

    await expect(lstat(join(extracted, `${secondId}.tar`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Removing the source immediately also verifies no background reader keeps
    // the operation alive after the public promise has rejected.
    await rm(bundle);
    await expect(lstat(bundle)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

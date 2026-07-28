import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser, type CreatedUser } from '../helpers/test-users';
import { TerminalWsClient } from '../helpers/terminal-ws';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const UNAUTH_OPTS = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

/** A one-level directory listing entry, mirroring the server's `FileEntry`. */
interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: string;
  linkTarget?: string;
  linkEscapes?: boolean;
}

interface FileListing {
  path: string;
  entries: FileEntry[];
}

/**
 * Run `command` in a FRESH tmux window on the worker (a plain bash shell as the
 * `agent` user, isolated from the main window's init script) and wait for a
 * computed marker. Returns the ANSI-stripped buffer.
 *
 * The marker is a value the shell COMPUTES at runtime (a random token echoed
 * only on success), never a literal label embedded in the command — the worker
 * shell echoes the typed command back, so asserting on a literal would pass off
 * the echoed text. We emit `RC=<n>` followed by a unique marker so the assertion
 * is on the command's outcome, not its source.
 */
async function execInWorker(
  request: APIRequestContext,
  containerId: string,
  command: string,
  timeoutMs = 30_000,
): Promise<string> {
  const api = new ApiClient(request);
  let idx: number | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const { status, body } = await api.createPane(containerId);
    if (status === 201 && typeof body.index === 'number') {
      idx = body.index;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (idx === undefined) throw new Error('createPane never succeeded — tmux not ready');
  const windowIndex = idx;
  const ws = new TerminalWsClient(containerId, String(windowIndex));
  try {
    await ws.connect();
    await ws.waitForOutput(/[$#>]\s*$/, 15_000);
    ws.clearBuffer();
    const marker = `MK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ws.sendLine(`${command}; echo "${marker}=$?"`);
    return await ws.waitForOutput(new RegExp(`${marker}=\\d`), timeoutMs);
  } finally {
    ws.close();
    await api.deletePane(containerId, windowIndex).catch(() => {});
  }
}

/** Extract the `RC=<n>` value the shell emitted at the end of an `execInWorker`
 *  run. Asserts the marker line is present so a missing outcome fails loudly
 *  rather than silently passing. */
function exitCodeOf(buffer: string, marker: string): number {
  const m = buffer.match(new RegExp(`${marker}=(\\d+)`));
  if (!m) throw new Error(`marker ${marker} not found in buffer`);
  return Number(m[1]);
}

/** Find an entry by basename in a listing. */
function findEntry(listing: FileListing, name: string): FileEntry | undefined {
  return listing.entries.find((e) => e.name === name);
}

/** Names of a listing, in order (dirs first, then by name). */
function namesOf(listing: FileListing): string[] {
  return listing.entries.map((e) => e.name);
}

// ─── Minimal ZIP central-directory reader ─────────────────────────────────
//
// The download endpoint streams a true ZIP (archiver/zip). Node has no built-in
// unzip, so we parse the End Of Central Directory (EOCD) record and the central
// directory to recover the archive's file names + sizes. This is enough to
// assert on relative names, hidden files, and duplicate-free descendant
// selection without a third-party dependency.

interface ZipEntry { name: string; size: number; isDirectory: boolean; }

function readZipEntries(buf: Buffer): ZipEntry[] {
  // EOCD signature 0x06054b50 — scan from the end (the archive may have a
  // trailing comment, so we search backwards for the signature).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD record not found — not a ZIP archive');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central-directory entry at ${p}`);
    const isDirectory = (buf.readUInt16LE(p + 38) & 0x10) !== 0;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // uncompressed size lives at p+24; for stored (method 0) entries compSize
    // equals the uncompressed size, which is what we report.
    entries.push({ name, size: isDirectory ? 0 : compSize, isDirectory });
    p += 46 + nameLen + extraLen + commentLen;
    void method;
  }
  return entries;
}

/** Assert `buf` starts with the ZIP local-file `PK\x03\x04` signature. */
function expectZipSignature(buf: Buffer) {
  expect(buf.length).toBeGreaterThan(0);
  expect(buf[0]).toBe(0x50); // P
  expect(buf[1]).toBe(0x4b); // K
  expect(buf[2]).toBe(0x03);
  expect(buf[3]).toBe(0x04);
}

// ─── Test suite ───────────────────────────────────────────────────────────
//
// One worker, one worker (tmux) window per setup command, serial tests so the
// shared container's filesystem state is predictable. Cleanup runs in
// afterAll + finally blocks so a failure mid-suite never leaks the worker or
// the secondary test user.

test.describe.serial('Workspace file manager API', () => {
  // Shared admin-owned worker (the default project authenticates as admin).
  let workerId: string;
  // A second, regular user + their own worker, for the 403 cross-user case.
  let otherUser: CreatedUser;
  let otherWorkerId: string;
  let otherCtx: APIRequestContext;
  // Unauthenticated context for the 401 case.
  let unauthCtx: APIRequestContext;

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request, { displayName: `wf-${Date.now()}` })).id;
    // Wait for tmux readiness so the first execInWorker does not race the
    // entrypoint. A successful pane create+delete is the readiness signal.
    const api = new ApiClient(request);
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const { status, body } = await api.createPane(workerId);
      if (status === 201 && typeof body.index === 'number') {
        await api.deletePane(workerId, body.index).catch(() => {});
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Secondary user + worker for the cross-user 403 case. If user creation
    // is unavailable (e.g. better-auth admin endpoint disabled) the 403 test
    // self-skips; the rest of the suite still runs.
    try {
      otherUser = await createTestUser('WF Other');
      otherCtx = await playwrightRequest.newContext(UNAUTH_OPTS);
      const otherApi = new ApiClient(otherCtx);
      const signIn = await otherApi.signInEmail(otherUser.email, otherUser.password);
      if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status}`);
      otherWorkerId = (await createWorker(otherCtx, { displayName: `wf-other-${Date.now()}` })).id;
    } catch (e) {
      // Will trigger test.skip in the 403 test.
    }

    unauthCtx = await playwrightRequest.newContext(UNAUTH_OPTS);
  });

  test.afterAll(async ({ request }) => {
    if (workerId) await cleanupWorker(request, workerId);
    if (otherWorkerId) await cleanupWorker(otherCtx, otherWorkerId).catch(() => {});
    if (otherCtx) await otherCtx.dispose();
    if (unauthCtx) await unauthCtx.dispose();
    if (otherUser) await deleteTestUser(otherUser.id).catch(() => {});
  });

  // ─── Listings ─────────────────────────────────────────────────────────

  test('lazy root listing is empty on a fresh workspace', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.listFiles(workerId);
    expect(status).toBe(200);
    const listing = body as FileListing;
    expect(listing.path).toBe('');
    expect(Array.isArray(listing.entries)).toBe(true);
    // A brand-new workspace has no user entries. (Some images seed hidden
    // dotfiles; we only assert there are no non-hidden entries.)
    expect(listing.entries.filter((e) => !e.name.startsWith('.')).length).toBe(0);
  });

  test('nested listing returns one level with metadata and dirs-first ordering', async ({ request }) => {
    const api = new ApiClient(request);
    // Seed a nested tree: dir/ with a file + a child dir, plus a sibling file.
    const stamp = Date.now();
    await api.mkdirFiles(workerId, `nested-${stamp}/child`);
    await api.uploadFiles(workerId, [
      { name: `nested-${stamp}/a.txt`, content: Buffer.from('aaa') },
      { name: `nested-${stamp}/z.txt`, content: Buffer.from('zzz') },
    ]);

    const { status, body } = await api.listFiles(workerId, `nested-${stamp}`);
    expect(status).toBe(200);
    const listing = body as FileListing;
    expect(listing.path).toBe(`nested-${stamp}`);
    const names = namesOf(listing);
    // Directories first, then by name: child (dir), a.txt, z.txt.
    expect(names).toEqual(['child', 'a.txt', 'z.txt']);
    const a = findEntry(listing, 'a.txt')!;
    expect(a.type).toBe('file');
    expect(a.size).toBe(3);
    expect(a.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const child = findEntry(listing, 'child')!;
    expect(child.type).toBe('directory');
    expect(child.size).toBe(0);
  });

  test('empty directory listing returns an empty entries array', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.mkdirFiles(workerId, `empty-${stamp}`);
    const { status, body } = await api.listFiles(workerId, `empty-${stamp}`);
    expect(status).toBe(200);
    expect((body as FileListing).entries).toEqual([]);
  });

  test('hidden files are included in a listing', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [
      { name: `.hidden-${stamp}`, content: Buffer.from('h') },
      { name: `visible-${stamp}.txt`, content: Buffer.from('v') },
    ]);
    const { status, body } = await api.listFiles(workerId);
    expect(status).toBe(200);
    const names = namesOf(body as FileListing);
    expect(names).toContain(`.hidden-${stamp}`);
    expect(names).toContain(`visible-${stamp}.txt`);
  });

  // ─── 400 path validation ──────────────────────────────────────────────

  test('list rejects parent traversal (..) with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.listFiles(workerId, '../etc');
    expect(status).toBe(400);
  });

  test('list rejects an absolute path with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.listFiles(workerId, '/etc');
    expect(status).toBe(400);
  });

  test('list rejects a backslash path with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.listFiles(workerId, 'a\\b');
    expect(status).toBe(400);
  });

  test('mkdir rejects parent traversal with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.mkdirFiles(workerId, '../evil');
    expect(status).toBe(400);
  });

  test('mkdir rejects an absolute path with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.mkdirFiles(workerId, '/etc/evil');
    expect(status).toBe(400);
  });

  test('move rejects parent traversal in a source with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.mkdirFiles(workerId, `mvtrav-${stamp}`);
    const { status } = await api.moveFiles(workerId, ['../etc'], `mvtrav-${stamp}`);
    expect(status).toBe(400);
  });

  test('rename rejects a name with a path separator (400)', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [{ name: `rn-${stamp}.txt`, content: Buffer.from('x') }]);
    const { status } = await api.renameFile(workerId, `rn-${stamp}.txt`, 'a/b');
    expect(status).toBe(400);
  });

  test('rename rejects a backslash name with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [{ name: `rnb-${stamp}.txt`, content: Buffer.from('x') }]);
    const { status } = await api.renameFile(workerId, `rnb-${stamp}.txt`, 'a\\b');
    expect(status).toBe(400);
  });

  test('delete rejects the workspace root with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.deleteFiles(workerId, ['']);
    expect(status).toBe(400);
  });

  // ─── 404 missing ──────────────────────────────────────────────────────

  test('list of a missing path returns 404', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.listFiles(workerId, `nope-${Date.now()}`);
    expect(status).toBe(404);
  });

  test('download of a missing path returns 404', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.downloadFiles(workerId, [`missing-${Date.now()}`]);
    expect(status).toBe(404);
  });

  test('rename of a missing source returns 404', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.renameFile(workerId, `missing-${Date.now()}`, 'renamed.txt');
    expect(status).toBe(404);
  });

  // ─── 409 stopped worker ────────────────────────────────────────────────

  test('operations on a stopped worker return 409', async ({ request }) => {
    const api = new ApiClient(request);
    const stopped = await createWorker(request, { displayName: `wf-stopped-${Date.now()}` });
    try {
      await api.stopContainer(stopped.id);
      const list = await api.listFiles(stopped.id);
      expect(list.status).toBe(409);
      const mkdir = await api.mkdirFiles(stopped.id, 'x');
      expect(mkdir.status).toBe(409);
      const up = await api.uploadFiles(stopped.id, [{ name: 'x.txt', content: Buffer.from('x') }]);
      expect(up.status).toBe(409);
      const dl = await api.downloadFiles(stopped.id, ['x']);
      expect(dl.status).toBe(409);
    } finally {
      await cleanupWorker(request, stopped.id);
    }
  });

  // ─── 401 unauthenticated ──────────────────────────────────────────────

  test('unauthenticated list/upload/download are rejected with 401', async () => {
    const api = new ApiClient(unauthCtx);
    const list = await api.listFiles(workerId);
    expect(list.status).toBe(401);
    const up = await api.uploadFiles(workerId, [{ name: 'x.txt', content: Buffer.from('x') }]);
    expect(up.status).toBe(401);
    const dl = await api.downloadFiles(workerId, ['x']);
    expect(dl.status).toBe(401);
    const mkdir = await api.mkdirFiles(workerId, 'x');
    expect(mkdir.status).toBe(401);
  });

  // ─── 403 cross-user ───────────────────────────────────────────────────

  test('a different user cannot access another user\'s worker files (403)', async () => {
    test.skip(!otherWorkerId, 'secondary user/worker unavailable — skipping 403 cross-user test');
    const api = new ApiClient(otherCtx);
    // otherUser owns otherWorkerId; accessing the admin's workerId must 403.
    const list = await api.listFiles(workerId);
    expect(list.status).toBe(403);
    const up = await api.uploadFiles(workerId, [{ name: 'x.txt', content: Buffer.from('x') }]);
    expect(up.status).toBe(403);
    const dl = await api.downloadFiles(workerId, ['x']);
    expect(dl.status).toBe(403);
  });

  // ─── Escaping symlink containment ─────────────────────────────────────
  //
  // Create `link -> /etc` inside /workspace via a fresh tmux window (the file
  // API itself refuses to create escaping symlinks, so this is the only way
  // to stage the attack). Every operation that would traverse through `link`
  // must be rejected (400 escapes) BEFORE any byte is read/written.

  test('escaping symlink: list/stat/upload/mkdir/move/download through it are rejected', async ({ request }) => {
    const api = new ApiClient(request);
    const link = `esc-${Date.now()}`;
    // Stage the escaping symlink as the agent user.
    await execInWorker(request, workerId, `ln -s /etc /workspace/${link}`);

    // list through the escaping symlink -> 400 (escapes), never /etc contents.
    const list = await api.listFiles(workerId, link);
    expect(list.status).toBe(400);

    // upload into a nested path under the escaping symlink -> 400.
    const up = await api.uploadFiles(workerId, [{ name: 'passwd', content: Buffer.from('pwn') }], { dest: `${link}/sub` });
    expect(up.status).toBe(400);

    // mkdir under the escaping symlink -> 400.
    const mkdir = await api.mkdirFiles(workerId, `${link}/sub`);
    expect(mkdir.status).toBe(400);

    // move an in-workspace file INTO a path under the escaping symlink -> 400.
    const src = `mvsrc-${Date.now()}`;
    await api.uploadFiles(workerId, [{ name: `${src}.txt`, content: Buffer.from('s') }]);
    await api.mkdirFiles(workerId, `${link}-dest`);
    const mv = await api.moveFiles(workerId, [`${src}.txt`], link);
    expect(mv.status).toBe(400);

    // download through the escaping symlink -> 400 (never leaks /etc contents).
    const dl = await api.downloadFiles(workerId, [`${link}/hostname`]);
    expect(dl.status).toBe(400);

    // delete through the escaping symlink -> 400 (refuses before any rm).
    const del = await api.deleteFiles(workerId, [`${link}/hostname`]);
    expect(del.status).toBe(400);

    // The API deliberately blocks management of an escaping symlink itself;
    // remove it through the worker shell so suite cleanup does not weaken that
    // containment policy.
    await execInWorker(request, workerId, `rm -f /workspace/${link} /workspace/${src}.txt; rm -rf /workspace/${link}-dest`);
  });

  test('in-workspace symlink is listed with linkTarget and linkEscapes=false', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const target = `lkt-${stamp}`;
    const link = `lkl-${stamp}`;
    await api.mkdirFiles(workerId, target);
    await execInWorker(request, workerId, `ln -s /workspace/${target} /workspace/${link}`);
    try {
      const { status, body } = await api.listFiles(workerId);
      expect(status).toBe(200);
      const entry = findEntry(body as FileListing, link);
      expect(entry).toBeTruthy();
      expect(entry!.type).toBe('symlink');
      expect(entry!.linkTarget).toBe(`/workspace/${target}`);
      expect(entry!.linkEscapes).toBeFalsy();
      // Listing through the in-workspace symlink returns the target's contents.
      const nested = await api.listFiles(workerId, link);
      expect(nested.status).toBe(200);
    } finally {
      await api.deleteFiles(workerId, [link, target]).catch(() => {});
    }
  });

  test('deleting an in-workspace symlink removes the link, not its target', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const target = `delt-${stamp}`;
    const link = `dell-${stamp}`;
    await api.mkdirFiles(workerId, `${target}/keep.txt`.replace('/keep.txt', ''));
    await api.uploadFiles(workerId, [{ name: `${target}/keep.txt`, content: Buffer.from('keep') }]);
    await execInWorker(request, workerId, `ln -s /workspace/${target} /workspace/${link}`);
    try {
      const del = await api.deleteFiles(workerId, [link]);
      expect(del.status).toBe(200);
      expect((del.body as { deleted: number }).deleted).toBe(1);
      // The link is gone but the target directory + its file survive.
      const { status, body } = await api.listFiles(workerId, target);
      expect(status).toBe(200);
      expect(namesOf(body as FileListing)).toContain('keep.txt');
    } finally {
      await api.deleteFiles(workerId, [link, target]).catch(() => {});
    }
  });

  // ─── Upload ───────────────────────────────────────────────────────────

  test('upload multiple files to an exact nested destination', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `up-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    const { status, body } = await api.uploadFiles(workerId, [
      { name: 'a.txt', content: Buffer.from('A') },
      { name: 'b.txt', content: Buffer.from('BB') },
      { name: 'c.txt', content: Buffer.from('CCC') },
    ], { dest });
    expect(status).toBe(200);
    expect((body as { uploaded: number }).uploaded).toBe(3);
    const { body: listing } = await api.listFiles(workerId, dest);
    expect(namesOf(listing as FileListing).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  test('upload preserves relative folder names from the part filename', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `uprel-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    const { status, body } = await api.uploadFiles(workerId, [
      { name: 'docs/readme.md', content: Buffer.from('# hi') },
      { name: 'docs/nested/deep.txt', content: Buffer.from('deep') },
      { name: 'root.txt', content: Buffer.from('r') },
    ], { dest });
    expect(status).toBe(200);
    expect((body as { uploaded: number }).uploaded).toBe(3);
    const { body: top } = await api.listFiles(workerId, dest);
    expect(namesOf(top as FileListing).sort()).toEqual(['docs', 'root.txt']);
    const { body: docs } = await api.listFiles(workerId, `${dest}/docs`);
    expect(namesOf(docs as FileListing).sort()).toEqual(['nested', 'readme.md']);
    const { body: deep } = await api.listFiles(workerId, `${dest}/docs/nested`);
    expect(namesOf(deep as FileListing)).toEqual(['deep.txt']);
  });

  test('upload an empty file succeeds', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const { status, body } = await api.uploadFiles(workerId, [
      { name: `empty-${stamp}.txt`, content: Buffer.alloc(0) },
    ]);
    expect(status).toBe(200);
    expect((body as { uploaded: number }).uploaded).toBe(1);
    const { body: listing } = await api.listFiles(workerId);
    const e = findEntry(listing as FileListing, `empty-${stamp}.txt`);
    expect(e).toBeTruthy();
    expect(e!.size).toBe(0);
  });

  test('upload up to the 100 MiB total cap is accepted', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    // One 50 MiB file is well under the 100 MiB total cap but exercises the
    // large-payload path pragmatically (a full 100 MiB upload would slow the
    // serial suite; 50 MiB confirms the cap is not a smaller default).
    const big = Buffer.alloc(50 * 1024 * 1024, 0x41);
    const { status, body } = await api.uploadFiles(workerId, [
      { name: `big-${stamp}.bin`, content: big },
    ]);
    expect(status).toBe(200);
    expect((body as { uploaded: number }).uploaded).toBe(1);
    const { body: listing } = await api.listFiles(workerId);
    const e = findEntry(listing as FileListing, `big-${stamp}.bin`);
    expect(e!.size).toBe(50 * 1024 * 1024);
  });

  test('upload beyond the 100 MiB total cap is rejected with 413', async ({ request }) => {
    const api = new ApiClient(request);
    // Two 60 MiB files = 120 MiB > 100 MiB cap.
    const big = Buffer.alloc(60 * 1024 * 1024, 0x42);
    const { status } = await api.uploadFiles(workerId, [
      { name: `over1-${Date.now()}.bin`, content: big },
      { name: `over2-${Date.now()}.bin`, content: big },
    ]);
    expect(status).toBe(413);
  });

  test('upload beyond the 1000-entry cap is rejected with 413', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const files = Array.from({ length: 1001 }, (_, index) => ({
      name: `entry-cap-${stamp}/${index}.txt`,
      content: Buffer.alloc(0),
    }));
    const { status } = await api.uploadFiles(workerId, files);
    expect(status).toBe(413);
  });

  test('upload overwrite=false conflicts are reported via 409 before any write', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `owc-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    await api.uploadFiles(workerId, [{ name: 'a.txt', content: Buffer.from('orig') }], { dest });
    const { status, body } = await api.uploadFiles(workerId, [
      { name: 'a.txt', content: Buffer.from('new') },
      { name: 'b.txt', content: Buffer.from('bb') },
    ], { dest });
    expect(status).toBe(409);
    const conflicts = (body as { conflicts?: string[] }).conflicts ?? [];
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toContain('a.txt');
    // The original content survived (no byte was written).
    const dl = await api.downloadFiles(workerId, [`${dest}/a.txt`]);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).toString('utf8')).toBe('orig');
  });

  test('upload overwrite=true replaces existing files', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `owt-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    await api.uploadFiles(workerId, [{ name: 'a.txt', content: Buffer.from('orig') }], { dest });
    const { status, body } = await api.uploadFiles(workerId, [
      { name: 'a.txt', content: Buffer.from('REPLACED') },
    ], { dest, overwrite: true });
    expect(status).toBe(200);
    expect((body as { uploaded: number }).uploaded).toBe(1);
    const dl = await api.downloadFiles(workerId, [`${dest}/a.txt`]);
    expect(Buffer.from(dl.body).toString('utf8')).toBe('REPLACED');
  });

  // ─── Mkdir ────────────────────────────────────────────────────────────

  test('mkdir creates nested parents', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const { status } = await api.mkdirFiles(workerId, `mk-${stamp}/a/b/c`);
    expect(status).toBe(200);
    const { body } = await api.listFiles(workerId, `mk-${stamp}/a/b`);
    expect(namesOf(body as FileListing)).toContain('c');
  });

  test('mkdir is idempotent on an existing directory', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dir = `mki-${stamp}`;
    expect((await api.mkdirFiles(workerId, dir)).status).toBe(200);
    expect((await api.mkdirFiles(workerId, dir)).status).toBe(200);
  });

  test('mkdir conflicts with an existing file (409)', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const file = `mkf-${stamp}.txt`;
    await api.uploadFiles(workerId, [{ name: file, content: Buffer.from('x') }]);
    const { status } = await api.mkdirFiles(workerId, file);
    expect(status).toBe(409);
  });

  // ─── Rename ────────────────────────────────────────────────────────────

  test('rename a file within the same parent', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const src = `rnf-${stamp}.txt`;
    await api.uploadFiles(workerId, [{ name: src, content: Buffer.from('x') }]);
    const { status } = await api.renameFile(workerId, src, `rnf-${stamp}-renamed.txt`);
    expect(status).toBe(200);
    const { body } = await api.listFiles(workerId);
    const names = namesOf(body as FileListing);
    expect(names).toContain(`rnf-${stamp}-renamed.txt`);
    expect(names).not.toContain(src);
  });

  test('rename a folder within the same parent', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const src = `rnd-${stamp}`;
    await api.mkdirFiles(workerId, `${src}/inner`);
    const { status } = await api.renameFile(workerId, src, `${src}-renamed`);
    expect(status).toBe(200);
    const { body } = await api.listFiles(workerId, `${src}-renamed`);
    expect(namesOf(body as FileListing)).toContain('inner');
  });

  test('rename to an existing name collides with 409', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [
      { name: `rnc1-${stamp}.txt`, content: Buffer.from('1') },
      { name: `rnc2-${stamp}.txt`, content: Buffer.from('2') },
    ]);
    const { status } = await api.renameFile(workerId, `rnc1-${stamp}.txt`, `rnc2-${stamp}.txt`);
    expect(status).toBe(409);
  });

  test('rename with an invalid (empty) name is rejected with 400', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [{ name: `rne-${stamp}.txt`, content: Buffer.from('x') }]);
    const { status } = await api.renameFile(workerId, `rne-${stamp}.txt`, '');
    expect(status).toBe(400);
  });

  // ─── Move ─────────────────────────────────────────────────────────────

  test('move multiple files to a nested destination', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `mvmd-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    await api.uploadFiles(workerId, [
      { name: `mvs1-${stamp}.txt`, content: Buffer.from('1') },
      { name: `mvs2-${stamp}.txt`, content: Buffer.from('2') },
    ]);
    const { status, body } = await api.moveFiles(
      workerId,
      [`mvs1-${stamp}.txt`, `mvs2-${stamp}.txt`],
      dest,
    );
    expect(status).toBe(200);
    expect((body as { moved: number }).moved).toBe(2);
    const { body: listing } = await api.listFiles(workerId, dest);
    expect(namesOf(listing as FileListing).sort()).toEqual([`mvs1-${stamp}.txt`, `mvs2-${stamp}.txt`]);
  });

  test('move multiple files to the root destination', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const src = `mvrsrc-${stamp}`;
    await api.mkdirFiles(workerId, src);
    await api.uploadFiles(workerId, [
      { name: `${src}/a.txt`, content: Buffer.from('a') },
      { name: `${src}/b.txt`, content: Buffer.from('b') },
    ]);
    const { status, body } = await api.moveFiles(workerId, [`${src}/a.txt`, `${src}/b.txt`], '');
    expect(status).toBe(200);
    expect((body as { moved: number }).moved).toBe(2);
    const { body: root } = await api.listFiles(workerId);
    expect(namesOf(root as FileListing)).toContain('a.txt');
    expect(namesOf(root as FileListing)).toContain('b.txt');
  });

  test('move with overwrite=false reports conflicts via 409 before any move', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `mvc-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    await api.uploadFiles(workerId, [
      { name: `${dest}/a.txt`, content: Buffer.from('dest-orig') },
      { name: `mva-${stamp}.txt`, content: Buffer.from('src-orig') },
    ]);
    const { status, body } = await api.moveFiles(workerId, [`mva-${stamp}.txt`], dest);
    expect(status).toBe(409);
    const conflicts = (body as { conflicts?: { source: string; target: string }[] }).conflicts ?? [];
    // The conflict is on `a.txt` (the destination already has it); the source
    // `mva-*.txt` would move cleanly but the whole batch is rejected up front.
    expect(conflicts.some((c) => c.target.endsWith('a.txt'))).toBe(true);
    // Neither file was moved/overwritten.
    const dl = await api.downloadFiles(workerId, [`${dest}/a.txt`]);
    expect(Buffer.from(dl.body).toString('utf8')).toBe('dest-orig');
    const { body: root } = await api.listFiles(workerId);
    expect(namesOf(root as FileListing)).toContain(`mva-${stamp}.txt`);
  });

  test('move with overwrite=true replaces conflicting targets', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dest = `mvo-${stamp}`;
    await api.mkdirFiles(workerId, dest);
    await api.uploadFiles(workerId, [
      { name: `${dest}/a.txt`, content: Buffer.from('dest-orig') },
      { name: `mvo-src-${stamp}.txt`, content: Buffer.from('src-new') },
    ]);
    const { status, body } = await api.moveFiles(workerId, [`mvo-src-${stamp}.txt`], dest, true);
    expect(status).toBe(200);
    expect((body as { moved: number }).moved).toBe(1);
    const dl = await api.downloadFiles(workerId, [`${dest}/a.txt`]);
    expect(Buffer.from(dl.body).toString('utf8')).toBe('src-new');

    // Directory targets are replaced as a whole after explicit overwrite.
    const sourceParent = `mvo-parent-${stamp}`;
    await api.mkdirFiles(workerId, `${sourceParent}/tree`);
    await api.mkdirFiles(workerId, `${dest}/tree`);
    await api.uploadFiles(workerId, [
      { name: `${sourceParent}/tree/new.txt`, content: Buffer.from('new-tree') },
      { name: `${dest}/tree/old.txt`, content: Buffer.from('old-tree') },
    ]);
    const dirMove = await api.moveFiles(workerId, [`${sourceParent}/tree`], dest, true);
    expect(dirMove.status).toBe(200);
    expect((dirMove.body as { moved: number }).moved).toBe(1);
    const replaced = await api.downloadFiles(workerId, [`${dest}/tree/new.txt`]);
    expect(Buffer.from(replaced.body).toString('utf8')).toBe('new-tree');
    expect((await api.downloadFiles(workerId, [`${dest}/tree/old.txt`])).status).toBe(404);
  });

  test('move of a directory into its own descendant fails (self/descendant)', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const parent = `mvp-${stamp}`;
    await api.mkdirFiles(workerId, `${parent}/child`);
    // Moving `parent` into `parent/child` — GNU mv refuses (cannot move into
    // a subdirectory of itself). The API maps the failed move to 409.
    const { status } = await api.moveFiles(workerId, [parent], `${parent}/child`);
    expect(status).toBe(409);
  });

  // ─── Delete ───────────────────────────────────────────────────────────

  test('delete multiple files', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [
      { name: `dm1-${stamp}.txt`, content: Buffer.from('1') },
      { name: `dm2-${stamp}.txt`, content: Buffer.from('2') },
    ]);
    const { status, body } = await api.deleteFiles(workerId, [`dm1-${stamp}.txt`, `dm2-${stamp}.txt`]);
    expect(status).toBe(200);
    expect((body as { deleted: number }).deleted).toBe(2);
    const { body: listing } = await api.listFiles(workerId);
    const names = namesOf(listing as FileListing);
    expect(names).not.toContain(`dm1-${stamp}.txt`);
    expect(names).not.toContain(`dm2-${stamp}.txt`);
  });

  test('delete a folder recursively', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dir = `df-${stamp}`;
    await api.mkdirFiles(workerId, `${dir}/sub`);
    await api.uploadFiles(workerId, [{ name: `${dir}/sub/x.txt`, content: Buffer.from('x') }]);
    const { status, body } = await api.deleteFiles(workerId, [dir]);
    expect(status).toBe(200);
    expect((body as { deleted: number }).deleted).toBe(1);
    const { status: listStatus } = await api.listFiles(workerId, dir);
    expect(listStatus).toBe(404);
  });

  test('delete is idempotent (missing paths ignored)', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.deleteFiles(workerId, [`nope-${Date.now()}`]);
    expect(status).toBe(200);
    expect((body as { deleted: number }).deleted).toBe(0);
  });

  test('delete rejects the workspace root', async ({ request }) => {
    const api = new ApiClient(request);
    // Root as '.' normalises to '' which is rejected by normalizeClientPathList
    // with allowRoot=false -> 400.
    const { status } = await api.deleteFiles(workerId, ['.']);
    expect(status).toBe(400);
  });

  // ─── Download (single file + ZIP) ─────────────────────────────────────

  test('single-file download returns exact bytes, content-length, and disposition', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const payload = Buffer.from(`exact-bytes-${stamp}-payload`);
    await api.uploadFiles(workerId, [{ name: `dl-${stamp}.txt`, content: payload }]);
    const { status, headers, body } = await api.downloadFiles(workerId, [`dl-${stamp}.txt`]);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('application/octet-stream');
    expect(headers['content-length']).toBe(String(payload.length));
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['content-disposition']).toContain(`dl-${stamp}.txt`);
    expect(Buffer.from(body).equals(payload)).toBe(true);
  });

  test('folder download is a true ZIP with PK signature and relative names', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dir = `zipf-${stamp}`;
    await api.mkdirFiles(workerId, `${dir}/sub`);
    await api.uploadFiles(workerId, [
      { name: `${dir}/top.txt`, content: Buffer.from('top') },
      { name: `${dir}/sub/inner.txt`, content: Buffer.from('inner') },
      { name: `${dir}/.hidden`, content: Buffer.from('h') },
    ]);
    const { status, headers, body } = await api.downloadFiles(workerId, [dir]);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('application/zip');
    expect(headers['content-disposition']).toContain('workspace-download.zip');
    const buf = Buffer.from(body);
    expectZipSignature(buf);
    const entries = readZipEntries(buf);
    const names = entries.map((e) => e.name);
    // Relative names rooted at the selected folder, including hidden files.
    expect(names.some((n) => n.startsWith(`${dir}/top.txt`))).toBe(true);
    expect(names.some((n) => n.startsWith(`${dir}/sub/inner.txt`))).toBe(true);
    expect(names.some((n) => n.startsWith(`${dir}/.hidden`))).toBe(true);
    expect(names.some((n) => n.startsWith(`${dir}/sub/`))).toBe(true);
  });

  test('multi-file download is a true ZIP with selected relative names', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    await api.uploadFiles(workerId, [
      { name: `mz1-${stamp}.txt`, content: Buffer.from('1') },
      { name: `mz2-${stamp}.txt`, content: Buffer.from('2') },
    ]);
    const { status, headers, body } = await api.downloadFiles(workerId, [`mz1-${stamp}.txt`, `mz2-${stamp}.txt`]);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('application/zip');
    const buf = Buffer.from(body);
    expectZipSignature(buf);
    const names = readZipEntries(buf).map((e) => e.name);
    expect(names).toContain(`mz1-${stamp}.txt`);
    expect(names).toContain(`mz2-${stamp}.txt`);
  });

  test('redundant descendant selection does not duplicate archive entries', async ({ request }) => {
    const api = new ApiClient(request);
    const stamp = Date.now();
    const dir = `dup-${stamp}`;
    await api.mkdirFiles(workerId, dir);
    await api.uploadFiles(workerId, [{ name: `${dir}/child.txt`, content: Buffer.from('c') }]);
    // Select both the folder and a file inside it; the file must appear once.
    const { status, body } = await api.downloadFiles(workerId, [dir, `${dir}/child.txt`]);
    expect(status).toBe(200);
    const names = readZipEntries(Buffer.from(body)).map((e) => e.name);
    const childHits = names.filter((n) => n === `${dir}/child.txt`);
    expect(childHits.length).toBe(1);
  });

  test('escaping symlink never leaks target contents in a ZIP download', async ({ request }) => {
    const api = new ApiClient(request);
    const link = `zesc-${Date.now()}`;
    await execInWorker(request, workerId, `ln -s /etc /workspace/${link}`);
    try {
      // Selecting the escaping symlink directly is rejected (400) — the probe
      // refuses it before any tar is fetched, so /etc can never enter the ZIP.
      const { status } = await api.downloadFiles(workerId, [link]);
      expect(status).toBe(400);
      // And a multi-selection that includes the escaping symlink alongside a
      // real file is also rejected wholesale (400), never a partial archive.
      const real = `zreal-${Date.now()}`;
      await api.uploadFiles(workerId, [{ name: `${real}.txt`, content: Buffer.from('r') }]);
      const multi = await api.downloadFiles(workerId, [link, `${real}.txt`]);
      expect(multi.status).toBe(400);
    } finally {
      await api.deleteFiles(workerId, [link]).catch(() => {});
    }
  });
});

import { expect, test } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LinuxCapacityCandidateReader, readBoundedLinuxCapacityHelper, type LinuxCapacityReaderPolicy } from '../../orchestrator/server/utils/worker-runtime-capacity-linux-reader';
import { BoundedCapacityCandidateScanner } from '../../orchestrator/server/utils/worker-runtime-capacity-candidate-scan';
import type { CandidateScanRoot } from '../../orchestrator/server/utils/worker-runtime-capacity-candidate-map';
import { encodeCapacityRpcFrame } from '../../orchestrator/server/utils/worker-runtime-capacity-rpc-schema';
import * as deadline from '../../orchestrator/server/utils/operation-deadline';
import * as rpcSchema from '../../orchestrator/server/utils/worker-runtime-capacity-rpc-schema';
import ts from 'typescript';
import { createRequire } from 'node:module';

const execute = promisify(execFile);
const source = resolve('../orchestrator/server/utils/worker-runtime-capacity-linux-helper.c');
const commandEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
let directory: string, helper: string;
const signal = () => new AbortController().signal;
test.beforeAll(async () => {
  directory = await fs.mkdtemp('/workspace/capacity-linux-test-'); helper = join(directory, 'native-helper');
  await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', helper], { env: commandEnvironment });
  await fs.chmod(helper, 0o500);
});
test.afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

async function native(commands: string[], executable = helper): Promise<any[]> {
  const child = spawn(executable, [], { env: commandEnvironment, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; let size = 0;
  child.stdout.on('data', bytes => { size += bytes.length; if (size > 65536) child.kill('SIGKILL'); else stdout.push(bytes); });
  child.stderr.resume(); child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const result = new Promise<void>((yes, no) => { child.on('error', no); child.on('close', code => code === 0 ? yes() : no(new Error('Synthetic helper did not finish'))); });
  child.stdin.end(commands.join('\n') + '\n');
  try { await result; return Buffer.concat(stdout).toString('utf8').trim().split('\n').map(line => JSON.parse(line)); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const tree = await fs.mkdtemp(join(directory, 'tree-'));
  const [opened] = await native(['ROOT\t' + tree, 'QUIT']);
  expect(opened.ok).toBe(true);
  const root: CandidateScanRoot = { id: 'enrolled-fixture', path: tree, filesystemId: opened.identity.filesystemId,
    mountId: opened.identity.mountId, inode: opened.identity.inode, projectId: '1' };
  const policy: LinuxCapacityReaderPolicy = { helper: { path: helper, sha256: 'sha256:' + createHash('sha256').update(await fs.readFile(helper)).digest('hex'), uid: process.getuid!() },
    roots: [root], operationTimeoutMs: 1000, sessionTimeoutMs: 5000 };
  return { tree, root, policy };
}
const canonical = (value: unknown) => encodeCapacityRpcFrame(value).subarray(4).toString('utf8');
async function readerWithFilesystem(open: unknown, spawn: unknown) {
  // Load an isolated copy with explicit boundaries; never patch global native fs.
  const source = await fs.readFile(resolve('../orchestrator/server/utils/worker-runtime-capacity-linux-reader.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const nativeRequire = createRequire(resolve('package.json')), exports: any = {};
  const require = (name: string) => name === 'node:fs/promises' ? { open } : name === 'node:child_process' ? { spawn } :
    name === './operation-deadline' ? deadline : name === './worker-runtime-capacity-rpc-schema' ? rpcSchema : nativeRequire(name);
  new Function('require', 'exports', compiled)(require, exports);
  return exports.LinuxCapacityCandidateReader as typeof LinuxCapacityCandidateReader;
}

test('helper acquisition preserves both read and close failure settlements before retirement', async () => {
  const f = await fixture();
  let finishRead!: () => void, finishClose!: () => void, enteredClose!: () => void, spawned = false;
  const closeEntered = new Promise<void>(resolve => { enteredClose = resolve; });
  const readLate = new Promise<void>(resolve => { finishRead = resolve; });
  const closeLate = new Promise<void>(resolve => { finishClose = resolve; });
  const readError = new Error('synthetic read failure');
  Object.defineProperty(readError, deadline.operationSettlement, { value: readLate });
  const closeError = Object.assign(new Error('synthetic close failure'), { [deadline.operationSettlement]: closeLate });
  const file = {
    stat: async () => ({ isFile: () => true, size: 4n, uid: BigInt(process.getuid!()), mode: 0o100500n, nlink: 1n }),
    read: async () => { throw readError; }, close: async () => { enteredClose(); throw closeError; },
  };
  const Reader = await readerWithFilesystem(async () => file, () => { spawned = true; throw new Error('unexpected spawn'); });
  let error: any, settled = false;
  try {
    const acquisition = Reader.create(f.policy).catch(value => { error = value; });
    const settlement = acquisition.then(async () => { await error?.[deadline.operationSettlement]; settled = true; });
    await closeEntered;
    expect(spawned).toBe(false);
    finishClose(); await closeLate; await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finishRead(); await settlement; expect(settled).toBe(true); expect(error).toBeDefined();
  } finally { finishRead(); finishClose(); }
});

test('verification timeout settlement retains late read failure settlement after descriptor close', async () => {
  const f = await fixture();
  let failRead!: () => void, finishLate!: () => void, spawned = false;
  const late = new Promise<void>(resolve => { finishLate = resolve; });
  const readError = Object.assign(new Error('synthetic late read failure'), { [deadline.operationSettlement]: late });
  const read = new Promise<never>((_resolve, reject) => { failRead = () => reject(readError); });
  const file = {
    stat: async () => ({ isFile: () => true, size: 4n, uid: BigInt(process.getuid!()), mode: 0o100500n, nlink: 1n }),
    read: () => read, close: async () => {},
  };
  const Reader = await readerWithFilesystem(async () => file, () => { spawned = true; throw new Error('unexpected spawn'); });
  let error: any, settled = false;
  try {
    await Reader.create({ ...f.policy, operationTimeoutMs: 25 }).catch(value => { error = value; });
    expect(error.code).toBe('DOCKER_OPERATION_TIMEOUT'); expect(spawned).toBe(false);
    const settlement = error[deadline.operationSettlement];
    void settlement.then(() => { settled = true; });
    failRead(); await read.catch(() => {});
    // Let all verifier/close/deadline promise continuations finish.
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finishLate(); await settlement;
  } finally { failRead(); finishLate(); }
});

test('post-spawn close retry preserves the first exposed close failure lifetime', async () => {
  const f = await fixture();
  let finishFirst!: () => void, finishSecond!: () => void, enteredClose!: () => void, closes = 0;
  const closeEntered = new Promise<void>(resolve => { enteredClose = resolve; });
  const firstLate = new Promise<void>(resolve => { finishFirst = resolve; });
  const secondLate = new Promise<void>(resolve => { finishSecond = resolve; });
  const firstError = Object.assign(new Error('synthetic first close failure'), { [deadline.operationSettlement]: firstLate });
  const secondError = Object.assign(new Error('synthetic retry close failure'), { [deadline.operationSettlement]: secondLate });
  const Reader = await readerWithFilesystem(async (...args: Parameters<typeof fs.open>) => {
    const real = await fs.open(...args);
    return { fd: real.fd, stat: real.stat.bind(real), read: real.read.bind(real), close: async () => {
      await real.close(); enteredClose(); throw ++closes === 1 ? firstError : secondError;
    } };
  }, spawn);
  let error: any, settled = false;
  try {
    const acquisition = Reader.create(f.policy).catch(value => { error = value; });
    const settlement = acquisition.then(async () => { await error?.[deadline.operationSettlement]; settled = true; });
    await closeEntered;
    finishSecond(); await secondLate; await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finishFirst(); await settlement; expect(error).toBeDefined();
    expect(closes).toBeGreaterThanOrEqual(1); expect(closes).toBeLessThanOrEqual(2);
  } finally { finishFirst(); finishSecond(); }
});
async function fakeHelper(f: Awaited<ReturnType<typeof fixture>>, behavior: string) {
  const path = join(f.tree, 'fake-helper.c'), binary = join(f.tree, 'fake-helper');
  const ping = canonical({ ok: true, version: 1 });
  const opened = canonical({ ok: true, handle: '1', identity: { filesystemId: f.root.filesystemId, inode: f.root.inode, kind: 'directory', mountId: f.root.mountId } });
  const code = `#define _GNU_SOURCE\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n#include <stdlib.h>\nint main(void) { char line[2048]; while (fgets(line, sizeof(line), stdin)) {
    if (!strcmp(line, "PING\\n")) { puts(${JSON.stringify(ping)}); fflush(stdout); }
    else { ${behavior} }
  } return 0; }\n`;
  await fs.writeFile(path, code); await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', path, '-o', binary], { env: commandEnvironment });
  await fs.chmod(binary, 0o500);
  return { ...f.policy, helper: { path: binary, uid: process.getuid!(), sha256: 'sha256:' + createHash('sha256').update(await fs.readFile(binary)).digest('hex') }, opened };
}

test('native enrollment observes real dev/statfs identity, statx mount and inode without claiming project metadata', async () => {
  const f = await fixture();
  const stats = await fs.stat(f.tree, { bigint: true });
  expect(f.root.inode).toBe(String(stats.ino)); expect(f.root.mountId).toMatch(/^[1-9][0-9]*$/);
  expect(f.root.filesystemId).toMatch(/^linuxfs:[0-9]+:[0-9]+:[a-f0-9]{16}$/);
  const [, metadata] = await native(['ROOT\t' + f.tree, 'STAT\t1', 'QUIT']);
  if ((await fs.statfs(f.tree)).type !== 0x58465342) expect(metadata).toEqual({ ok: false, reason: 'unsupported' });
  else expect(metadata.ok === true || metadata.reason === 'unsupported').toBe(true);
});

test('real reader produces incomplete on unsupported native metadata, with exact handle and helper cleanup', async () => {
  const f = await fixture(), reader = await LinuxCapacityCandidateReader.create(f.policy);
  const scanner = new BoundedCapacityCandidateScanner(reader);
  try {
    const [, actual] = await native(['ROOT\t' + f.tree, 'STAT\t1', 'QUIT']);
    const result = await scanner.scan([f.root], { timeoutMs: 1000, maxVisitedEntries: 100, maxDepth: 8, maxNameBytes: 4096 });
    expect(result.admissionReady).toBe(false);
    if (!actual.ok) expect(result).toMatchObject({ status: 'incomplete', reason: actual.reason });
    await scanner.settlement();
  } finally { await scanner.settlement(); await reader.dispose(); }
  expect(reader.isHeld()).toBe(true); await reader.settlement();
});

test('native root opens reject ancestor/final symlinks and child opens reject traversal, symlinks and FIFO', async () => {
  const f = await fixture();
  await fs.mkdir(join(f.tree, 'directory')); await fs.writeFile(join(f.tree, 'file'), 'fixture');
  await fs.symlink(f.tree, join(f.tree, 'root-link')); await fs.symlink('file', join(f.tree, 'file-link'));
  await execute('mkfifo', [join(f.tree, 'fifo')], { env: commandEnvironment });
  const results = await native([
    'ROOT\t' + join(f.tree, 'root-link'), 'ROOT\t' + join(f.tree, 'root-link', 'directory'),
    'ROOT\t' + f.tree, 'CHILD\t1\t..', 'CHILD\t1\tfile-link', 'CHILD\t1\tfifo',
    'CHILD\t1\tdirectory/file', 'CHILD\t1\tdirectory', 'CLOSE\t2', 'CLOSE\t1', 'QUIT',
  ]);
  for (const index of [0, 1, 3, 4, 5, 6]) expect(results[index]).toEqual({ ok: false, reason: 'unsupported' });
  expect(results[7]).toMatchObject({ ok: true, identity: { kind: 'directory' } });
  expect(results[8]).toEqual({ ok: true });
});

test('opened root handle retains original directory after pathname substitution', async () => {
  const f = await fixture(); await fs.writeFile(join(f.tree, 'original'), 'fixture');
  const reader = await LinuxCapacityCandidateReader.create(f.policy), handle = await reader.openRoot(f.root, signal());
  try {
    await fs.rename(f.tree, f.tree + '-retained'); await fs.mkdir(f.tree); await fs.writeFile(join(f.tree, 'replacement'), 'fixture');
    expect(await reader.readDirectory(handle, null, 64, signal())).toEqual({ names: ['original'], next: null });
    const child = await reader.openChild(handle, 'original', signal()); await reader.close(child);
    await reader.close(handle);
  } finally { await reader.dispose(); }
});

test('reader rejects changed root inode and waits for helper descriptor cleanup', async () => {
  const f = await fixture(), reader = await LinuxCapacityCandidateReader.create(f.policy);
  await fs.rename(f.tree, f.tree + '-retained'); await fs.mkdir(f.tree);
  try { await expect(reader.openRoot(f.root, signal())).rejects.toMatchObject({ scanReason: 'changed' }); expect(reader.isHeld()).toBe(true); await reader.settlement(); }
  finally { await reader.dispose(); }
});

test('root registry is detached from callers and request-selected paths never reach native open', async () => {
  const f = await fixture(), original = structuredClone(f.root), reader = await LinuxCapacityCandidateReader.create(f.policy);
  try {
    f.policy.roots[0].path = join(f.tree, 'untrusted');
    await expect(reader.openRoot(f.root, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    await expect(reader.openRoot({ ...original, projectId: '2' }, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    expect(reader.isHeld()).toBe(false);
    const handle = await reader.openRoot(original, signal()); await reader.close(handle);
  } finally { await reader.dispose(); }
});

test('opaque handles reject forged, foreign and stale objects; child inode differs legitimately', async () => {
  const f = await fixture(); await fs.writeFile(join(f.tree, 'file'), 'fixture');
  const reader = await LinuxCapacityCandidateReader.create(f.policy), other = await LinuxCapacityCandidateReader.create(f.policy);
  try {
    const handle = await reader.openRoot(f.root, signal());
    await expect(reader.stat({ kind: 'linux-capacity-handle' }, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    await expect(other.stat(handle, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    const child = await reader.openChild(handle, 'file', signal()); await reader.close(child);
    await reader.close(handle); await expect(reader.close(handle)).rejects.toMatchObject({ scanReason: 'unsupported' });
  } finally { await reader.dispose(); await other.dispose(); }
});

test('bounded directory pages use exact-handle cursors and reject replay/reset and invalid names', async () => {
  const f = await fixture(); for (const item of ['a', 'b', 'c']) await fs.writeFile(join(f.tree, item), 'fixture');
  const reader = await LinuxCapacityCandidateReader.create(f.policy), handle = await reader.openRoot(f.root, signal());
  try {
    const first = await reader.readDirectory(handle, null, 1, signal()) as any;
    expect(first.names).toHaveLength(1); expect(first.next).toBe('1');
    await expect(reader.readDirectory(handle, '2', 1, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    await expect(reader.readDirectory(handle, null, 1, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    const second = await reader.readDirectory(handle, first.next, 64, signal()) as any;
    expect([...first.names, ...second.names].sort()).toEqual(['a', 'b', 'c']); expect(second.next).toBeNull();
    for (const invalid of ['..', 'a/b', 'a\n', 'a\t', '']) await expect(reader.openChild(handle, invalid, signal())).rejects.toMatchObject({ scanReason: 'unsupported' });
    await reader.close(handle);
  } finally { await reader.dispose(); }
});

test('helper pin rejects digest replacement, non-ELF, permissive mode and over-budget ELF before execution', async () => {
  const f = await fixture();
  await expect(LinuxCapacityCandidateReader.create({ ...f.policy, helper: { ...f.policy.helper, sha256: 'sha256:' + '0'.repeat(64) } })).rejects.toMatchObject({ scanReason: 'changed' });
  for (const [filename, content, mode] of [
    ['not-elf', Buffer.from('#!/bin/sh\nexit 0\n'), 0o500], ['too-large', Buffer.alloc(1048577), 0o500], ['bad-mode', await fs.readFile(helper), 0o522],
  ] as const) {
    const path = join(f.tree, filename); await fs.writeFile(path, content, { mode });
    // Creation mode is filtered by umask; test the actual unsafe permissions.
    await fs.chmod(path, mode);
    await expect(LinuxCapacityCandidateReader.create({ ...f.policy, helper: { path, uid: process.getuid!(), sha256: 'sha256:' + createHash('sha256').update(content).digest('hex') } })).rejects.toMatchObject({ scanReason: filename === 'not-elf' ? 'changed' : 'unsupported' });
  }
});

for (const change of ['growth', 'truncation', 'abort', 'partial', 'limit'] as const) test(`pinned helper fixed-buffer read handles ${change} without unbounded allocation`, async () => {
  const controller = new AbortController(), calls: Array<{ allocated: number; requested: number; position: number }> = [];
  const content = Buffer.alloc(change === 'growth' ? 1025 : change === 'truncation' ? 1023 : 1024, 42);
  const file = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
    calls.push({ allocated: buffer.length, requested: length, position });
    if (change === 'abort') controller.abort();
    const bytesRead = Math.min(length, Math.max(0, content.length - position), change === 'partial' ? 13 : length);
    content.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer };
  } } as any;
  const operation = readBoundedLinuxCapacityHelper(file, change === 'limit' ? 1048577 : 1024, controller.signal);
  if (change === 'partial') expect(await operation).toEqual(content);
  else await expect(operation).rejects.toBeDefined();
  expect(calls.every(call => call.allocated <= 1024 && call.requested <= 1024)).toBe(true);
  if (change === 'growth') expect(calls.at(-1)).toEqual({ allocated: 1, requested: 1, position: 1024 });
  if (change === 'limit') expect(calls).toEqual([]);
});

test('pre-aborted native operation permanently holds reader until actual child/stdio cleanup', async () => {
  const f = await fixture(), reader = await LinuxCapacityCandidateReader.create(f.policy), controller = new AbortController(); controller.abort();
  try { await expect(reader.openRoot(f.root, controller.signal)).rejects.toMatchObject({ scanReason: 'cancelled' }); expect(reader.isHeld()).toBe(true); await reader.settlement(); }
  finally { await reader.dispose(); }
});

test('operation timeout retires the sole helper and prevents replacement walkers', async () => {
  const f = await fixture(), fake = await fakeHelper(f, 'for (;;) pause();');
  const { opened: _unused, ...policy } = fake;
  const reader = await LinuxCapacityCandidateReader.create({ ...policy, operationTimeoutMs: 25, sessionTimeoutMs: 1000 });
  try {
    await expect(reader.openRoot(f.root, signal())).rejects.toMatchObject({ scanReason: 'timeout' });
    await reader.settlement(); expect(reader.isHeld()).toBe(true);
    await expect(reader.openRoot(f.root, signal())).rejects.toMatchObject({ scanReason: 'timeout' });
  } finally { await reader.dispose(); }
});

test('scanner timeout returns promptly but settlement waits for actual inherited pipe closure after child exit', async () => {
  const f = await fixture();
  // This adversarial TEST helper forks one short-lived fixture process solely
  // to retain stdio after its parent is killed. Production helper never forks.
  const fake = await fakeHelper(f, 'pid_t sidecar = fork(); if (sidecar == 0) { usleep(250000); _exit(0); } for (;;) pause();');
  const { opened: _unused, ...policy } = fake;
  const reader = await LinuxCapacityCandidateReader.create(policy), scanner = new BoundedCapacityCandidateScanner(reader);
  let settled = false;
  try {
    const result = await scanner.scan([f.root], { timeoutMs: 50, maxVisitedEntries: 100, maxDepth: 8, maxNameBytes: 4096 });
    void scanner.settlement().then(() => { settled = true; });
    expect(result).toMatchObject({ status: 'incomplete', reason: 'timeout', admissionReady: false });
    expect(settled).toBe(false); expect(reader.isHeld()).toBe(true);
    await scanner.settlement(); expect(settled).toBe(true); await reader.settlement();
    await expect(scanner.scan([f.root], { timeoutMs: 100, maxVisitedEntries: 100, maxDepth: 8, maxNameBytes: 4096 })).rejects.toBeDefined();
  } finally { await scanner.settlement(); await reader.dispose(); }
});

test('helper session has an absolute deadline even when idle and disposal is idempotent', async () => {
  const f = await fixture(), reader = await LinuxCapacityCandidateReader.create({ ...f.policy, operationTimeoutMs: 100, sessionTimeoutMs: 100 });
  await reader.settlement(); expect(reader.isHeld()).toBe(true);
  await expect(reader.openRoot(f.root, signal())).rejects.toMatchObject({ scanReason: 'timeout' });
  await reader.dispose(); await reader.dispose();
});

test('native protocol is bounded and never promotes special/unsupported nodes to invented counts', async () => {
  const f = await fixture();
  const replies = await native(['ROOT\t' + f.tree, 'DIR\t1\t-\t65', 'CHILD\t1\t' + 'x'.repeat(256), 'CLOSE\t1', 'CLOSE\t1', 'QUIT']);
  expect(replies[1]).toEqual({ ok: false, reason: 'unsupported' }); expect(replies[2]).toEqual({ ok: false, reason: 'unsupported' });
  expect(replies[3]).toEqual({ ok: true }); expect(replies[4]).toEqual({ ok: false, reason: 'unsupported' });
  expect(await native(['x'.repeat(3000)])).toEqual([{ ok: false, reason: 'limit' }]);
});

test('native xattr/ACL byte observations read actual disposable metadata without exposing values', async () => {
  const f = await fixture(), path = join(f.tree, 'metadata.c'), binary = join(f.tree, 'metadata-helper');
  const code = `#define main capacity_helper_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(int argc, char **argv) {
    if (argc != 2) return 2; int fd = open(argv[1], O_RDONLY | O_NOATIME); if (fd < 0) return 3;
    if (fsetxattr(fd, "user.fixture", "abcde", 5, 0)) return 4;
    uint64_t attrs, acls; bool ok = metadata(fd, &attrs, &acls); close(fd);
    if (!ok) return 5; printf("%" PRIu64 " %" PRIu64 "\\n", attrs, acls); return 0;
  }\n`;
  await fs.writeFile(path, code); await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wno-misleading-indentation', source === path ? '-Werror' : '-Werror', path, '-o', binary], { env: commandEnvironment });
  const file = join(f.tree, 'metadata-fixture'); await fs.writeFile(file, 'fixture');
  const result = await execute(binary, [file], { env: commandEnvironment });
  expect(result.stdout.trim()).toBe(`${Buffer.byteLength('user.fixture') + 1 + 5} 0`);
});

test('native supported STAT reply carries the real statx mount identity required by the reader', async () => {
  const f = await fixture(), path = join(f.tree, 'stat-contract.c'), binary = join(f.tree, 'stat-contract-helper');
  // Inject only filesystem type/project/xattr responses into this disposable
  // translation unit. This checks serialization, not native XFS acceptance.
  // stat_reply still reads real fixture inode/mount/timestamps through statx.
  const code = `#define fstatfs fixture_fstatfs\n#define ioctl fixture_ioctl\n#define flistxattr fixture_flistxattr\n#define main capacity_helper_main\n#include ${JSON.stringify(source)}\n#undef main\n
    int fixture_fstatfs(int fd, struct statfs *sf) { (void)fd; memset(sf, 0, sizeof(*sf)); sf->f_type = XFS_SUPER_MAGIC; return 0; }
    int fixture_ioctl(int fd, unsigned long request, ...) { (void)fd; (void)request; va_list args; va_start(args, request);
      struct fsxattr *value = va_arg(args, struct fsxattr *); va_end(args); memset(value, 0, sizeof(*value)); value->fsx_projid = 1; return 0; }
    ssize_t fixture_flistxattr(int fd, char *names, size_t size) { (void)fd; (void)names; (void)size; return 0; }
    int main(int argc, char **argv) { if (argc != 2) return 2; int fd = open(argv[1], O_RDONLY | O_NOATIME);
      if (fd < 0) return 3; struct entry e = { .fd = fd }; stat_reply(&e); close(fd); return 0; }\n`;
  await fs.writeFile(path, '#include <stdarg.h>\n' + code);
  await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wno-misleading-indentation', '-Werror', path, '-o', binary], { env: commandEnvironment });
  const result = JSON.parse((await execute(binary, [f.tree], { env: commandEnvironment })).stdout);
  expect(result.ok).toBe(true);
  expect(result.value.mountId).toBe(f.root.mountId);
  expect(result.value.inode).toBe(f.root.inode);
});

for (const mode of ['name-count', 'value-bound', 'total-bound']) test(`native metadata rejects synthetic ${mode} exhaustion instead of reporting partial bytes`, async () => {
  const f = await fixture(), path = join(f.tree, 'limit.c'), binary = join(f.tree, 'limit-helper');
  const names = mode === 'name-count' ? 257 : mode === 'total-bound' ? 17 : 1;
  const fakeGet = mode === 'value-bound' ? 'errno = ERANGE; return -1;' : `return ${mode === 'total-bound' ? 65536 : 0};`;
  const code = `#define flistxattr fixture_flistxattr\n#define fgetxattr fixture_fgetxattr\n#define main capacity_helper_main\n#include ${JSON.stringify(source)}\n#undef main\n
    ssize_t fixture_flistxattr(int fd, char *list, size_t size) { (void)fd; size_t offset = 0; for (int i = 0; i < ${names}; i++) {
      int count = snprintf(list + offset, size - offset, "user.f%d", i); offset += (size_t)count + 1; } return (ssize_t)offset; }
    ssize_t fixture_fgetxattr(int fd, const char *name, void *value, size_t size) { (void)fd; (void)name; (void)value; (void)size; ${fakeGet} }
    int main(void) { uint64_t attrs, acls; if (metadata(0, &attrs, &acls)) return 2; error_reply(); return 0; }\n`;
  await fs.writeFile(path, code); await execute('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', path, '-o', binary], { env: commandEnvironment });
  expect(await native(['unused'], binary)).toEqual([{ ok: false, reason: 'limit' }]);
});

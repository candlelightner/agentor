import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { INCUS_DOCKER_BACKUP_SCRIPT, openIncusDockerArchive } from '../../orchestrator/server/utils/incus-docker-archive';
import type { IncusClient, IncusStreamExecSession } from '../../orchestrator/server/utils/incus-client';

const NAME = 'agentor-worker-fixture';
const VOLUME = 'agentor-worker-fixture-docker';
const BOOT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function session(): IncusStreamExecSession & { complete: (code: number) => void; fail: (error: Error) => void; closes: () => number } {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  for (const stream of [stdin, stdout, stderr]) stream.on('error', () => {});
  let settled = false, closes = 0, resolve!: (code: number) => void, reject!: (error: Error) => void;
  const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
  const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
  return { stdin, stdout, stderr, result, operationId: 'mock-operation', sendSignal() {},
    complete(code) { if (!settled) { settled = true; resolve(code); } }, fail,
    close() { closes++; fail(new Error('mock capture cancelled')); stdin.destroy(); stdout.destroy(); stderr.destroy(); },
    closes: () => closes };
}
function fixture() {
  const capture = session(), cleanup = session(), executions: any[][] = [], pushes: any[][] = [], streams: any[][] = [];
  let validations = 0, validateErrorAt = 0, mkdirCode = 0, pushError: Error | undefined, setupError: Error | undefined;
  let finalProof: Promise<void> | undefined;
  const validate = async () => {
    validations++;
    if (validations === validateErrorAt) throw new Error('native incarnation/source proof changed');
    if (validations === 4 && finalProof) await finalProof;
  };
  const exec: IncusClient['exec'] = async (...args) => {
    executions.push(args); return { returnCode: mkdirCode, stdout: '', stderr: '' };
  };
  const pushFile: IncusClient['pushFile'] = async (...args) => {
    pushes.push(args); if (pushError) throw pushError;
  };
  const execStream: IncusClient['execStream'] = async (...args) => {
    streams.push(args);
    if (args[1][0] === '/usr/bin/systemd-run') {
      if (setupError) throw setupError;
      args[2]?.signal?.addEventListener('abort', () => capture.close(), { once: true });
      return capture;
    }
    return cleanup;
  };
  const client = { exec, pushFile, execStream } as unknown as IncusClient;
  return { capture, cleanup, executions, pushes, streams, validate, validations: () => validations,
    rejectProofAt: (call: number) => { validateErrorAt = call; },
    setFinalProof: (promise: Promise<void>) => { finalProof = promise; },
    rejectMkdir: () => { mkdirCode = 1; }, rejectPush: (error: Error) => { pushError = error; },
    rejectSetup: (error: Error) => { setupError = error; },
    open: (signal?: AbortSignal) => openIncusDockerArchive(client, NAME, VOLUME, BOOT, validate, signal),
    restored: (output = '{"restored":true}', code = 0) => { cleanup.stdout.end(output); cleanup.stderr.end(); cleanup.complete(code); },
    dispose: () => { capture.close(); cleanup.close(); } };
}

test('Docker binary EOF waits for cleanup exit and repeated native source proof before lifecycle release', async () => {
  const f = fixture(); try {
    const output = await f.open(), reading = collect(output), binary = Buffer.from([0, 255, 128, 13, 10]);
    let ended = false; output.once('end', () => { ended = true; });
    f.capture.stdout.end(binary); f.capture.complete(0); await tick();
    expect(ended).toBe(false); expect(f.streams).toHaveLength(2); expect(f.validations()).toBe(3);
    let release!: () => void; f.setFinalProof(new Promise<void>(resolve => { release = resolve; }));
    f.restored(); await tick(); expect(ended).toBe(false); expect(f.validations()).toBe(4);
    release(); expect(await reading).toEqual(binary); expect(ended).toBe(true);
    expect(f.cleanup.closes()).toBe(1); expect(f.capture.stdin.writableEnded).toBe(true);
    expect(f.cleanup.stdin.writableEnded).toBe(true);
  } finally { f.dispose(); }
});

test('transient unit is quiet and bounded, owns its control group and has independently uncancelled post-stop cleanup', async () => {
  const f = fixture(), controller = new AbortController(); try {
    const output = await f.open(controller.signal), reading = collect(output); reading.catch(() => {});
    const [name, command, options] = f.streams[0]; expect(name).toBe(NAME);
    expect(command.slice(0, 5)).toEqual(['/usr/bin/systemd-run', '--quiet', '--pipe', '--wait', '--collect']);
    expect(command).toContain('KillMode=control-group'); expect(command).toContain('RuntimeMaxSec=600');
    expect(command).toContain('TimeoutStopSec=120'); expect(command).toContain('Type=exec');
    const script = f.pushes[0][1], nonce = script.split('/docker-backup-')[1].split('/')[0];
    expect(command).toContain('--unit=agentor-docker-backup-' + nonce + '.service');
    expect(command).toContain(`ExecStopPost=/usr/bin/python3 ${script} cleanup ${nonce} ${VOLUME} ${BOOT}`);
    expect(f.executions).toEqual([[NAME, ['/usr/bin/mkdir', '-m', '700', '--', script.slice(0, script.lastIndexOf('/'))]]]);
    expect(f.pushes[0]).toEqual([NAME, script, INCUS_DOCKER_BACKUP_SCRIPT, { uid: 0, gid: 0, mode: 0o600 }]);
    expect(options).toMatchObject({ user: 0, group: 0, cwd: '/', timeoutMs: 15 * 60_000,
      environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    expect(options.signal).toBe(controller.signal);
    f.capture.stdout.end(); f.capture.complete(0); await tick();
    expect(f.streams[1][1]).toEqual(['/usr/bin/python3', script, 'cancel', nonce, VOLUME, BOOT]);
    expect(f.streams[1][2]).not.toHaveProperty('signal'); expect(f.streams[1][2].timeoutMs).toBe(370_000);
    f.restored(); await reading;
  } finally { f.dispose(); }
});

for (const mode of ['abort', 'destroy'] as const) test(`${mode} waits for uncancelled recovery before stream close`, async () => {
  const f = fixture(), controller = new AbortController(); try {
    const output = await f.open(controller.signal), reading = collect(output); reading.catch(() => {});
    let closed = false; const closedPromise = new Promise<void>(resolve => output.once('close', () => { closed = true; resolve(); }));
    if (mode === 'abort') controller.abort(); else output.destroy(new Error('caller closed Docker archive'));
    await tick(); expect(closed).toBe(false); expect(f.streams).toHaveLength(2);
    expect(f.streams[1][2]).not.toHaveProperty('signal');
    expect(f.cleanup.closes()).toBe(0); f.restored();
    await expect(reading).rejects.toThrow(mode === 'destroy' ? /caller closed/ : /cancelled|abort/i);
    await closedPromise; expect(closed).toBe(true); expect(f.cleanup.closes()).toBe(1); expect(f.validations()).toBe(4);
    expect(f.streams.filter(args => args[1][0] === '/usr/bin/systemd-run')).toHaveLength(1);
  } finally { f.dispose(); }
});

test('capture nonzero exit restores prior state exactly once and never returns successful EOF', async () => {
  const f = fixture(); try {
    const output = await f.open(), reading = collect(output); reading.catch(() => {});
    f.capture.stdout.end(Buffer.from([0, 255])); f.capture.complete(23); await tick();
    expect(f.streams).toHaveLength(2); f.restored();
    await expect(reading).rejects.toThrow(/Native Docker capture failed/);
    expect(f.streams).toHaveLength(2); expect(f.cleanup.closes()).toBe(1);
  } finally { f.dispose(); }
});

test('native proof failure before cleanup prevents any second guest mutation and surfaces recovery authority failure', async () => {
  const f = fixture(); try {
    const output = await f.open(), reading = collect(output); reading.catch(() => {});
    f.rejectProofAt(3); f.capture.stdout.end(); f.capture.complete(0);
    await expect(reading).rejects.toThrow(/cleanup unresolved.*native Docker recovery/);
    expect(f.streams).toHaveLength(1); expect(f.executions).toHaveLength(1); expect(f.pushes).toHaveLength(1);
    expect(f.cleanup.closes()).toBe(0); expect(f.validations()).toBe(3);
  } finally { f.dispose(); }
});

test('proof failure after cleanup also rejects successful EOF without retrying guest mutation', async () => {
  const f = fixture(); try {
    const output = await f.open(), reading = collect(output); reading.catch(() => {});
    f.rejectProofAt(4); f.capture.stdout.end(); f.capture.complete(0); await tick(); f.restored();
    await expect(reading).rejects.toThrow(/cleanup unresolved.*native Docker recovery/);
    expect(f.streams).toHaveLength(2); expect(f.cleanup.closes()).toBe(1); expect(f.validations()).toBe(4);
  } finally { f.dispose(); }
});

test('cleanup excessive output, nonzero exit and malformed/incomplete JSON remain actionable failures', async () => {
  for (const [output, code] of [['x'.repeat(4097), 0], ['{"restored":true}', 2], ['not-json', 0],
    ['null', 0], ['{}', 0], ['{"restored":"true"}', 0]] as const) {
    const f = fixture(); try {
      const stream = await f.open(), reading = collect(stream); reading.catch(() => {});
      f.capture.stdout.end(); f.capture.complete(0); await tick(); f.restored(output, code);
      await expect(reading).rejects.toThrow(/cleanup unresolved.*native Docker recovery/);
      expect(f.streams).toHaveLength(2); expect(f.cleanup.closes()).toBe(1);
    } finally { f.dispose(); }
  }
});

test('lost capture setup invokes revocation cleanup once without repeating capture or inheriting caller cancellation', async () => {
  const f = fixture(), setupError = new Error('lost capture acknowledgement'), controller = new AbortController(); try {
    f.rejectSetup(setupError); const pending = f.open(controller.signal); pending.catch(() => {});
    await tick(); controller.abort(); expect(f.streams).toHaveLength(2);
    expect(f.streams[1][1][2]).toBe('cancel'); expect(f.streams[1][2]).not.toHaveProperty('signal');
    f.restored(); await expect(pending).rejects.toBe(setupError);
    expect(f.streams).toHaveLength(2); expect(f.cleanup.closes()).toBe(1);
  } finally { f.dispose(); }
});

test('setup cleanup revocation failure is surfaced and never causes an implicit capture retry', async () => {
  for (const failure of ['proof', 'cleanup'] as const) {
    const f = fixture(); try {
      f.rejectSetup(new Error('late setup')); if (failure === 'proof') f.rejectProofAt(3);
      const pending = f.open(); pending.catch(() => {}); await tick();
      if (failure === 'cleanup') f.restored('{}');
      await expect(pending).rejects.toThrow(/startup\/cleanup authority unresolved.*native Docker recovery/);
      expect(f.streams.filter(args => args[1][0] === '/usr/bin/systemd-run')).toHaveLength(1);
      expect(f.streams).toHaveLength(failure === 'proof' ? 1 : 2);
    } finally { f.dispose(); }
  }
});

test('pre-admission, cancelled admission and pre-capture preparation failures do not start units', async () => {
  for (const failure of ['proof', 'abort', 'mkdir', 'push'] as const) {
    const f = fixture(), controller = new AbortController(); try {
      if (failure === 'proof') f.rejectProofAt(1);
      if (failure === 'abort') controller.abort();
      if (failure === 'mkdir') f.rejectMkdir();
      if (failure === 'push') f.rejectPush(new Error('script push failed'));
      await expect(f.open(controller.signal)).rejects.toThrow(); expect(f.streams).toEqual([]);
      expect(f.executions).toHaveLength(failure === 'proof' || failure === 'abort' ? 0 : 1);
    } finally { f.dispose(); }
  }
});

test('guest Python parses without execution and fixed capture never sources secrets or formats a device', () => {
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: INCUS_DOCKER_BACKUP_SCRIPT });
  expect(INCUS_DOCKER_BACKUP_SCRIPT).toContain("'/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_incus_docker'");
  expect(INCUS_DOCKER_BACKUP_SCRIPT).toContain("'phase':'capturing'");
  expect(INCUS_DOCKER_BACKUP_SCRIPT).toContain("os.path.lexists(base+'/revoked')");
  expect(INCUS_DOCKER_BACKUP_SCRIPT).toContain("info.get('LiveRestoreEnabled') is not False");
  expect(INCUS_DOCKER_BACKUP_SCRIPT).toContain("'/usr/bin/tar','--format=pax','--numeric-owner','--xattrs'");
  expect(INCUS_DOCKER_BACKUP_SCRIPT).not.toMatch(/mkfs|wipefs|fsck|docker-storage\.sh|worker\.env|account-credentials|secret/i);
});

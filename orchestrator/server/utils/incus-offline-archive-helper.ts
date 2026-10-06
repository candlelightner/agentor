import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient, IncusRequestRejected, type IncusInstance } from './incus-client';
import { incusImageIdentity } from './incus-worker-image';
import { isOperationHelperActive, registerOperationHelper } from './operation-helper-registry';
import { isDeepStrictEqual } from 'node:util';

type Owner = { id: string; userId: string; containerName: string };
type Sources = { workspace: string; agents: string; managed?: never } |
  { managed: string; workspace?: never; agents?: never } | { docker: string; copy: boolean } |
  { workspaceRestore: true };
type Kind = 'create' | 'start' | 'stop' | 'delete' | 'copy' | 'delete-copy';
type Recovery = { version: 1; id: string; installation: string; owner: Owner; sources: Sources;
  fingerprint: string; instance?: string; copy?: { created_at: string; config: Record<string, string> };
  pending?: { kind: Kind; operation?: string }; writerSettled?: boolean };
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const operation = /^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const temporaryReceipt = /^([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/;
const owners = new Set<string>();
const fail = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;
const safeName = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

/** Whole-instance preflight must not drop unresolved private cleanup authority
 * from the source. These local receipts are never portable backup metadata. */
export async function assertOfflineArchiveHelpersSettled(dataDir: string) {
  let directory: FileHandle;
  try { directory = await open(join(dataDir, 'incus-backup-helpers'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw fail('Inspect the private offline helper directory before instance backup.'); }
  try {
    const info = await directory.stat();
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw fail('Offline helper recovery directory is not private.');
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    try {
      if (await entries.read()) throw fail('Resolve offline backup helper cleanup before creating an instance snapshot.');
    } finally { await entries.close(); }
  } finally { await directory.close(); }
}

/** One pinned, networkless guest with readonly backup sources or one fixed
 * workspace writer. The same private cleanup receipt fences unknown results;
 * it is not a backup transaction journal or arbitrary writable helper. */
export class IncusOfflineArchiveHelper {
  constructor(private config: Config, private client: IncusClient, private installation: string) {}

  private canonicalWriterOwner(owner: Owner): boolean {
    return !!owner && uuid.test(owner.id) && safeName(owner.userId) && safeName(owner.containerName) &&
      typeof this.config.containerPrefix === 'string' && /^[A-Za-z0-9_-]+$/.test(this.config.containerPrefix) &&
      owner.containerName === `${this.config.containerPrefix}-${owner.id}`;
  }

  private validate(value: unknown): asserts value is Recovery {
    const v = value as Recovery;
    const keys = v?.sources && Object.keys(v.sources).sort().join(',');
    const validSources = keys === 'agents,workspace' && 'workspace' in v.sources
      ? safeName(v.sources.workspace) && safeName(v.sources.agents) && v.sources.workspace !== v.sources.agents
      : keys === 'managed' && 'managed' in v.sources ? safeName(v.sources.managed)
      : keys === 'workspaceRestore' && 'workspaceRestore' in v.sources && v.sources.workspaceRestore === true
      ? this.canonicalWriterOwner(v.owner)
      : keys === 'copy,docker' && 'docker' in v.sources && safeName(v.sources.docker) && typeof v.sources.copy === 'boolean';
    const writer = keys === 'workspaceRestore';
    if (!v || v.version !== 1 || !uuid.test(v.id ?? '') || v.installation !== this.installation ||
        !uuid.test(v.owner?.id ?? '') || !safeName(v.owner?.userId) || !safeName(v.owner?.containerName) ||
        !validSources || (writer ? typeof v.writerSettled !== 'boolean' : Object.hasOwn(v, 'writerSettled')) ||
        !/^[a-f0-9]{64}$/.test(v.fingerprint ?? '') || v.instance !== undefined && !uuid.test(v.instance) ||
        v.copy && (!('docker' in v.sources) || !v.sources.copy || !Number.isFinite(Date.parse(v.copy.created_at)) ||
          !v.copy.config || Object.keys(v.copy.config).length > 16 ||
          Object.values(v.copy.config).some(value => typeof value !== 'string' || value.length > 2048)) ||
        v.pending && (!['create', 'start', 'stop', 'delete', 'copy', 'delete-copy'].includes(v.pending.kind) ||
          v.pending.operation !== undefined && !operation.test(v.pending.operation)))
      throw fail('Offline backup helper recovery authority is malformed; retain it for operator recovery.');
  }

  /** Same bounded no-follow receipt reader as helper admission. It neither
   * replays mutations nor infers settlement from absent compute or an IP. */
  private async scanReceipts(dir: FileHandle, visit: (state: Recovery) => void): Promise<void> {
    const entries = await opendir(`/proc/self/fd/${dir.fd}`);
    let count = 0;
    for await (const item of entries) {
      if (++count > 1024) throw fail('Offline helper recovery directory exceeds its bounded inventory.');
      const entry = item.name, temporary = temporaryReceipt.exec(entry);
      if (temporary && item.isFile() && isOperationHelperActive(temporary[1])) continue;
      if (temporary) {
        try { await lstat(`/proc/self/fd/${dir.fd}/${entry}`); }
        catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(entry)) throw fail('Offline helper recovery requires operator inspection.');
      let file: FileHandle;
      try { file = await open(`/proc/self/fd/${dir.fd}/${entry}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
          throw fail('Offline helper recovery record is unsafe.');
        const bytes = Buffer.alloc(8193), read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 8192) throw fail('Offline helper recovery record is too large.');
        const previous: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')); this.validate(previous);
        if (entry !== `${previous.id}.json`) throw fail('Offline helper recovery identity changed.');
        visit(previous);
      } finally { await file.close(); }
    }
  }

  /** Read-only integration fence. Even known callback success cannot waive an
   * unresolved helper cleanup receipt; only acknowledged cleanup removes it. */
  async assertWorkspaceReplacementSettled(owner: Owner): Promise<void> {
    owner = { ...owner };
    if (!uuid.test(this.installation) || !this.canonicalWriterOwner(owner))
      throw fail('Workspace replacement owner identity is malformed.');
    const key = `${this.config.dataDir}:${owner.id}`;
    const assertUnclaimed = () => {
      if (owners.has(key)) throw fail('An offline helper actively owns this worker; retain the worker data fence.');
    };
    // A claim predates receipt fsync. Active .tmp entries intentionally remain
    // unreadable to peers, so disk enumeration alone cannot prove settlement.
    assertUnclaimed();
    let dir: FileHandle;
    try { dir = await open(join(this.config.dataDir, 'incus-backup-helpers'),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT') { assertUnclaimed(); return; }
      throw fail('Offline helper recovery directory is unavailable.'); }
    try {
      const info = await dir.stat();
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw fail('Offline helper recovery directory is not private.');
      await this.scanReceipts(dir, state => {
        if (state.owner.id === owner.id && 'workspaceRestore' in state.sources)
          throw fail('Unsettled workspace replacement exists; retain the worker data fence.');
      });
    } finally { await dir.close(); }
    assertUnclaimed();
  }

  private name(state: Recovery) { return `abk-${state.id}`; }
  private copyName(state: Recovery) { return `adb-${state.id}`; }
  private copyConfiguration(state: Recovery) {
    if (!('docker' in state.sources) || !state.sources.copy) throw fail('Invalid Docker backup copy authority.');
    return { 'user.agentor.installation': this.installation, 'user.agentor.helper': 'offline-backup-copy',
      'user.agentor.operation': state.id, 'user.agentor.worker': state.owner.id,
      'user.agentor.owner': state.owner.userId, 'user.agentor.source': state.sources.docker };
  }
  private async inspectCopy(state: Recovery, helperAttached: boolean, allowMissing = false) {
    let value;
    try { value = await this.client.getCustomVolume(this.config.incusStoragePool, this.copyName(state)); }
    catch (error) { if (allowMissing && missing(error)) return; throw error; }
    const expected = this.copyConfiguration(state), references = helperAttached ? [`/1.0/instances/${this.name(state)}`] : [];
    if (value.name !== this.copyName(state) || value.project !== this.config.incusProject ||
        value.type !== 'custom' || value.content_type !== 'block' || !Number.isFinite(Date.parse(value.created_at)) ||
        !Object.entries(expected).every(([key, item]) => value.config[key] === item) ||
        Object.keys(value.config).some(key => !(key in expected) && !['size', 'volatile.uuid'].includes(key)) ||
        state.copy && (value.created_at !== state.copy.created_at || !isDeepStrictEqual(value.config, state.copy.config)) ||
        !Array.isArray(value.used_by) || value.used_by.length !== references.length)
      throw fail('Offline Docker copy ownership/type/configuration changed; resources retained.');
    const paths = value.used_by.map(ref => {
      const url = new URL(ref, this.client.endpoint);
      if (url.origin !== new URL(this.client.endpoint).origin || url.username || url.password || url.hash ||
          url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project')) throw fail('Offline Docker copy reference is foreign.');
      return url.pathname;
    });
    if (!isDeepStrictEqual(paths.sort(), references.sort())) throw fail('Offline Docker copy references changed.');
    return value;
  }
  private devices(state: Recovery) {
    const devices: Record<string, Record<string, string>> = {
      root: { type: 'disk', path: '/', pool: this.config.incusStoragePool } };
    if ('workspaceRestore' in state.sources) {
      devices.workspace = { type: 'disk', pool: this.config.incusStoragePool,
        source: state.owner.containerName + '-workspace', path: '/target', readonly: 'false' };
      return devices;
    }
    if ('docker' in state.sources) {
      devices.docker = { type: 'disk', pool: this.config.incusStoragePool, readonly: 'true',
        source: state.sources.copy ? this.copyName(state) : state.sources.docker };
      return devices;
    }
    const mounts = state.sources.managed !== undefined ? { managed: [state.sources.managed, '/volume'] }
      : { workspace: [state.sources.workspace!, '/workspace'], agents: [state.sources.agents!, '/home/agent/.agent-data'] };
    for (const [key, [source, path]] of Object.entries(mounts))
      devices[key] = { type: 'disk', source, path, pool: this.config.incusStoragePool, readonly: 'true' };
    return devices;
  }
  private metadata(state: Recovery) {
    return { 'user.agentor.installation': this.installation,
      'user.agentor.helper': 'workspaceRestore' in state.sources ? 'workspace-replace' : 'offline-backup',
      'user.agentor.operation': state.id, 'user.agentor.worker': state.owner.id,
      'user.agentor.owner': state.owner.userId, 'user.agentor.image': state.fingerprint };
  }
  private configuration(state: Recovery) {
    return { ...this.metadata(state), 'security.secureboot': 'false', 'boot.autostart': 'false',
      'limits.cpu': '1', 'limits.memory': '1GiB' };
  }
  private async inspect(state: Recovery, allowMissing = false): Promise<IncusInstance | undefined> {
    let value: IncusInstance;
    try { value = await this.client.getInstance(this.name(state)); }
    catch (error) { if (allowMissing && missing(error)) return; throw error; }
    const configuration = this.configuration(state), expected = this.devices(state);
    const sameConfig = (config: Record<string, string>) =>
      Object.entries(configuration).every(([key, item]) => config[key] === item) &&
      Object.keys(config).every(key => key in configuration || key.startsWith('volatile.') || key.startsWith('image.')) &&
      config['volatile.base_image'] === state.fingerprint && config['volatile.uuid'] === state.instance;
    const sameDevices = (devices: unknown) => !!devices && typeof devices === 'object' &&
      Object.keys(devices).length === Object.keys(expected).length &&
      Object.entries(expected).every(([name, fields]) => {
        const actual = (devices as Record<string, Record<string, string>>)[name];
        return actual && Object.keys(actual).length === Object.keys(fields).length &&
          Object.entries(fields).every(([key, item]) => actual[key] === item);
      });
    if (!state.instance || value.name !== this.name(state) || value.name === state.owner.containerName ||
        value.type !== 'virtual-machine' || value.config['volatile.uuid'] !== state.instance ||
        value.profiles?.length !== 0 || !sameDevices(value.devices) ||
        value.expanded_devices && !sameDevices(value.expanded_devices) ||
        !sameConfig(value.config) || value.expanded_config && !sameConfig(value.expanded_config))
      throw fail('Offline backup helper incarnation or read-only isolation changed; resources retained.');
    return value;
  }

  async withGuest<T>(owner: Owner, sources: Sources, assertSource: (helperName?: string) => Promise<void>,
    signal: AbortSignal | undefined, capture: (helperName: string, assertHelper: () => Promise<void>) => Promise<T>): Promise<T> {
    // Capture fixed primitive fields before awaits; caller object mutation
    // cannot turn this writer into a Docker copy or change its owner later.
    owner = { ...owner }; sources = { ...sources };
    // Claim before any await: concurrent callers cannot race recovery discovery.
    const key = `${this.config.dataDir}:${owner.id}`, id = randomUUID();
    if (owners.has(key)) throw fail('An offline backup helper already owns this worker.');
    owners.add(key); const release = registerOperationHelper(id);
    let dir: FileHandle | undefined, state: Recovery | undefined, reserved = false, submitted = false, writerMayRun = false;
    let primaryFailure: unknown, primaryFailed = false;
    const path = () => `/proc/self/fd/${dir!.fd}/${id}.json`;
    const persist = async (next: Recovery) => {
      this.validate(next);
      const temporary = `/proc/self/fd/${dir!.fd}/${id}.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
      finally { await file.close(); }
      // Failure leaves the prior receipt (and possibly a bounded temporary file).
      await rename(temporary, path()); await dir!.sync(); state = next;
    };
    const submit = async (kind: Kind, call: (accepted: (path?: string) => Promise<void>) => Promise<unknown>) => {
      await persist({ ...state!, pending: { kind } });
      if (kind !== 'copy' && kind !== 'delete-copy') submitted = true;
      try {
        await call(async acknowledged => {
          if (acknowledged !== undefined && !operation.test(acknowledged)) throw fail('Invalid accepted helper operation.');
          await persist({ ...state!, pending: acknowledged ? { kind, operation: acknowledged }
            : kind === 'copy' ? { kind } : undefined });
        });
      } catch (error) {
        if (error instanceof IncusRequestRejected) { await persist({ ...state!, pending: undefined });
          if (kind === 'create') submitted = false; }
        throw error;
      }
      // Keep the copy's submission proof until its exact created_at/config
      // acknowledgement has been captured, including synchronous responses.
      if (kind !== 'copy') await persist({ ...state!, pending: undefined });
    };
    const assertHelper = async () => { signal?.throwIfAborted();
      if ((await this.inspect(state!))?.status !== 'Running') throw fail('Offline backup helper is not running.');
      if (state!.copy) await this.inspectCopy(state!, true);
    };
    const cleanup = async () => {
      if (!reserved) return;
      if (state!.pending) {
        if (!state!.pending.operation) throw fail('Offline backup helper acknowledgement is unknown; recovery retained.');
        const observed = await this.client.request<{ status: string; status_code: number }>('GET', state!.pending.operation);
        if (!['Success', 'Failure', 'Cancelled'].includes(observed.status) || observed.status_code < 200)
          throw fail('Offline backup helper operation is unresolved; recovery retained.');
        // Terminal readback cannot manufacture create/copy authority.
        if (state!.pending.kind === 'copy' && !state!.copy)
          throw fail('Offline Docker copy acknowledgement was not captured; recovery retained.');
        if (state!.pending.kind !== 'copy' && state!.pending.kind !== 'delete-copy' && !state!.instance)
          throw fail('Offline backup helper incarnation was not captured; recovery retained.');
        await persist({ ...state!, pending: undefined });
      }
      if (submitted && !state!.instance) throw fail('Offline backup helper incarnation was not captured; recovery retained.');
      if (state!.instance) {
        let helper = await this.inspect(state!, true);
        if (helper && helper.status !== 'Stopped') {
          if (helper.status !== 'Running') throw fail('Offline backup helper state is uncertain; recovery retained.');
          await submit('stop', accepted => this.client.stopInstance(helper!.name, { force: true, timeout: 30 }, accepted));
          helper = await this.inspect(state!, true);
        }
        if (helper) {
          if (helper.status !== 'Stopped') throw fail('Offline backup helper is not stopped; recovery retained.');
          await submit('delete', accepted => this.client.deleteInstance(helper!.name, accepted));
          if (await this.inspect(state!, true)) throw fail('Offline backup helper removal is incomplete.');
        }
      }
      if ('docker' in state!.sources && state!.sources.copy) {
        await assertSource();
        // Only after exact helper removal can a copy be unreferenced. Before
        // acknowledgement, never adopt coincidentally same-named storage.
        if (state!.copy && await this.inspectCopy(state!, false, true)) {
          await submit('delete-copy', accepted => this.client.deleteCustomVolume(this.config.incusStoragePool,
            this.copyName(state!), accepted));
          if (await this.inspectCopy(state!, false, true)) throw fail('Offline Docker copy removal is incomplete.');
        }
      }
      // Source proof after known removal excludes the helper's former reference.
      await assertSource();
      if ('workspaceRestore' in state!.sources && writerMayRun && !state!.writerSettled)
        throw fail('Workspace replacement callback is unsettled; helper removed but data fence retained.');
      await unlink(path()); await dir!.sync(); reserved = false;
    };
    try {
      if (!uuid.test(this.installation)) throw fail('Offline backup installation identity is unavailable.');
      const directory = join(this.config.dataDir, 'incus-backup-helpers');
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await dir.stat();
      if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw fail('Offline helper recovery directory is not private.');
      await this.scanReceipts(dir, previous => {
        if (previous.owner.id === owner.id) throw fail('Unresolved offline backup helper exists; recover it before retrying.');
      });
      signal?.throwIfAborted(); await assertSource();
      const alias = await this.client.getImageAlias(this.config.incusWorkerImage);
      const image = incusImageIdentity(await this.client.getImage(alias.target));
      if (image.fingerprint !== alias.target) throw fail('Trusted helper image fingerprint changed.');
      state = { version: 1, id, installation: this.installation, owner: { ...owner }, sources: { ...sources }, fingerprint: image.fingerprint,
        ...('workspaceRestore' in sources ? { writerSettled: false } : {}) };
      this.validate(state); await persist(state); reserved = true;
      await assertSource(); signal?.throwIfAborted();
      if ('docker' in sources && sources.copy) {
        try { await this.client.getCustomVolume(this.config.incusStoragePool, this.copyName(state));
          throw fail('Offline Docker backup requires absent temporary copy storage.');
        } catch (error) { if (!missing(error)) throw error; }
        await submit('copy', accepted => this.client.copyCustomVolume(this.config.incusStoragePool, sources.docker,
          this.copyName(state!), this.copyConfiguration(state!), accepted));
        const copied = await this.inspectCopy(state, false);
        if (!copied) throw fail('Offline Docker copy acknowledgement is unavailable.');
        await persist({ ...state!, copy: { created_at: copied.created_at, config: copied.config }, pending: undefined });
        await assertSource(); signal?.throwIfAborted();
      }
      let created: IncusInstance | undefined;
      await submit('create', async accepted => { created = await this.client.createInstance({
        name: this.name(state!), type: 'virtual-machine', profiles: [],
        source: { type: 'image', fingerprint: state!.fingerprint }, devices: this.devices(state!),
        config: this.configuration(state!) }, accepted); });
      if (!uuid.test(created?.config['volatile.uuid'] ?? '')) throw fail('Helper create omitted its incarnation.');
      await persist({ ...state, instance: created!.config['volatile.uuid'] });
      signal?.throwIfAborted(); await this.inspect(state!);
      try { await submit('start', accepted => {
        if ('workspaceRestore' in sources) writerMayRun = true;
        return this.client.startInstance(this.name(state!), accepted);
      }); }
      catch (error) { if (error instanceof IncusRequestRejected) writerMayRun = false; throw error; }
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        await assertHelper();
        try {
          const session = await this.client.execStream(this.name(state), ['true'], { command: [], user: 0, group: 0,
            cwd: '/', signal, timeoutMs: 5000 });
          try { session.stdin.end(); session.stdout.resume(); session.stderr.resume(); ready = await session.result === 0; }
          finally { session.close(); }
        } catch { signal?.throwIfAborted(); }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw fail('Offline backup guest agent did not become ready.');
      await assertHelper(); await assertSource(this.name(state));
      const result = await capture(this.name(state), assertHelper);
      await assertHelper(); await assertSource(this.name(state));
      if ('workspaceRestore' in sources) await persist({ ...state!, writerSettled: true });
      return result;
    } catch (error) {
      primaryFailed = true; primaryFailure = error; throw error;
    } finally {
      try {
        try { await cleanup(); }
        catch (error) {
          // Keep quarantine/cleanup failure authoritative. Its private cause
          // preserves the original diagnostic without logging archive content
          // or treating a failed callback as known filesystem settlement.
          if (primaryFailed && error instanceof Error) error.cause = primaryFailure;
          throw error;
        }
      } finally { await dir?.close(); release(); owners.delete(key); }
    }
  }
}

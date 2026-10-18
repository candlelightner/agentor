import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import type { IncusAdminWorkspaceRuntime } from './incus-admin-workspace-runtime';
import { administrativeRuntimeOwner } from './admin-native-identity';
import { IncusAdminBackup, assertAdministrativeSnapshotSettled } from './incus-admin-backup';
import { openIncusCanonicalArchive } from './incus-canonical-archive';
import { INCUS_SELECTED_ARCHIVE_SCRIPT, nativeSelectedBackupPath } from './incus-selected-archive';
import { snapshotIncusWorkerBackupRuntime } from './worker-backup-runtime';
import { BUNDLE_FILES, WORKER_EXPORT_VERSION, PORTABLE_MANAGED_VOLUME_EXPORT_VERSION, packBundle,
  writeGzipFile, writeManifest, type WorkerExportManifest } from './worker-export';
import { snapshotWorkerPlugins, writePortablePluginConfiguration } from './plugin-portability';
import { useEnvironmentStore, usePluginDefinitionStore, usePluginInstallationStore } from './services';
import { DEFAULT_ENVIRONMENT_ID } from './environments';
import { writePortableManagedVolumePayload, MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES } from './portable-managed-volume-archive';
import { portableManagedVolumeArchiveName } from './portable-managed-volume-format';

/** Same selected-tree codec as ordinary VMs; authority is exclusively the
 * dedicated administrative record and exact owned storage/NIC/incarnation. */
export async function openAdministrativeSelectedArchive(runtime: IncusAdminWorkspaceRuntime,
  record: Readonly<AdministrativeWorkspaceRecord>, selected: string, validatePrincipal: () => Promise<void>, signal?: AbortSignal, wrapper?: 'volume'): Promise<Readable> {
  selected = nativeSelectedBackupPath(selected);
  if (record.status !== 'running') throw Object.assign(new Error('Explicit native paths require a running administrative workspace'), { statusCode: 409 });
  await validatePrincipal();
  const initial = await runtime.assertOwned(record);
  if (initial.status !== 'Running') throw new Error('Administrative backup compute state changed');
  const bootId = async () => {
    const result = await runtime.client.exec(initial.name, ['/bin/cat', '/proc/sys/kernel/random/boot_id']);
    if (result.returnCode || !/^[a-f0-9-]{36}\n?$/.test(result.stdout)) throw new Error('Administrative guest boot identity is unavailable');
    return result.stdout;
  };
  const boot = await bootId();
  const validate = async () => {
    signal?.throwIfAborted(); await validatePrincipal();
    const current = await runtime.assertOwned(record);
    if (!isDeepStrictEqual(current, initial) || await bootId() !== boot) throw new Error('Administrative selected source changed');
  };
  await validate();
  const mounts = Object.values(initial.devices).filter(device => device.type === 'disk' && device.path && device.path !== '/').map(device => device.path!);
  const session = await runtime.client.execStream(initial.name,
    ['/usr/bin/python3', '-c', INCUS_SELECTED_ARCHIVE_SCRIPT, selected, JSON.stringify({ mounts, credentials: false, ...(wrapper ? { wrapper } : {}) })],
    { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, signal, timeoutMs: 10 * 60_000 });
  const output = new PassThrough(); output.on('error', () => {}); output.once('close', () => session.close());
  session.stderr.resume(); session.stdout.on('error', error => output.destroy(error)); session.stdout.pipe(output, { end: false }); session.stdin.end();
  void Promise.all([session.result, finished(session.stdout, { cleanup: true })]).then(async ([code]) => {
    if (code) throw new Error('Administrative selected archive failed');
    await validate(); output.end();
  }).catch(error => output.destroy(error));
  return output;
}

async function portableSelections(runtime: IncusAdminWorkspaceRuntime, record: Readonly<AdministrativeWorkspaceRecord>) {
  const result = [];
  for (const value of await runtime.storage.selectedRecords(record)) {
    if (!value.seeded) { result.push({ record: value, volume: undefined }); continue; }
    const volume = await runtime.storage.inspectSelectedVolume(record, value);
    if (!volume || volume.used_by.length !== 1) throw new Error('Administrative portable selected storage is unavailable');
    result.push({ record: value, volume });
  }
  return result;
}

/** Caller holds the dedicated store transaction, never a human/ordinary-worker
 * fence. This bundle describes portable data; it grants no administrative role. */
export async function exportAdministrativeWorkspaceBundle(config: Config, runtime: IncusAdminWorkspaceRuntime,
  record: Readonly<AdministrativeWorkspaceRecord>, destination: string, signal: AbortSignal,
  validatePrincipal: () => Promise<void>, options: { includeWorkspace: boolean; includeAgents: boolean; includeManagedVolumes: boolean },
  backup = new IncusAdminBackup(config, runtime)) {
  record = structuredClone(record); assertAdministrativeSnapshotSettled(record);
  if (record.runtimeKind !== 'incus-vm') throw new Error('Administrative portable backup requires native authority');
  const owner = administrativeRuntimeOwner(record), directory = join(config.dataDir, 'tmp', `admin-portable-${randomUUID()}`);
  const validate = async () => { signal.throwIfAborted(); await validatePrincipal(); await runtime.validateAuthority(record, record.nativeRuntime!.incarnation); };
  await validate();
  const initial = await runtime.assertOwned(record);
  if (initial.status !== (record.status === 'running' ? 'Running' : 'Stopped')) throw new Error('Administrative backup compute state changed');
  const selected = await portableSelections(runtime, record);
  const exclusions = selected.filter(item => item.record.seeded).map(item => item.record.target);
  const check = async () => {
    await validate();
    if (!isDeepStrictEqual(await runtime.assertOwned(record), initial) || !isDeepStrictEqual(await portableSelections(runtime, record), selected))
      throw new Error('Administrative portable storage authority changed');
  };
  await check();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const files: Array<{ name: string; path: string }> = [];
    const outputs = { ...(options.includeWorkspace ? { workspace: join(directory, BUNDLE_FILES.workspace) } : {}),
      ...(options.includeAgents ? { agents: join(directory, BUNDLE_FILES.agents) } : {}) };
    if (Object.keys(outputs).length) {
      if (record.status === 'stopped') await backup.capture(record, outputs, { exclusions, signal });
      else for (const role of ['workspace', 'agents'] as const) if (outputs[role])
        await writeGzipFile(await openIncusCanonicalArchive(runtime.client, initial.name, role, check, { exclusions, signal }), outputs[role]!, signal);
      await check();
      for (const [role, path] of Object.entries(outputs)) files.push({ name: BUNDLE_FILES[role as 'workspace'|'agents'], path });
    }
    const entries = [];
    if (options.includeManagedVolumes) {
      const archives = []; let total = 0;
      for (const [index, item] of selected.filter(item => item.record.seeded).entries()) {
        await check(); const gzip = join(directory, `managed-${index}.gz`), raw = join(directory, `managed-${index}.tar`);
        const limit = new Transform({ transform(chunk, _encoding, done) {
          total += chunk.length; done(total > MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES ? new Error('Administrative managed payload exceeds byte limit') : null, chunk);
        } });
        if (record.status === 'running') await pipeline(await openAdministrativeSelectedArchive(runtime, record, item.record.target, check, signal, 'volume'), limit, createWriteStream(raw, { mode: 0o600 }), { signal });
        else {
          await backup.capturePortableSelected(record, item.record.id, gzip, signal); await check();
          await pipeline(createReadStream(gzip), createGunzip(), limit, createWriteStream(raw, { mode: 0o600 }), { signal });
        }
        const entry = { target: item.record.target, name: item.record.name, archive: portableManagedVolumeArchiveName(index) };
        entries.push(entry); archives.push({ entry, archivePath: raw });
      }
      const path = join(directory, BUNDLE_FILES.managedVolumes);
      await writePortableManagedVolumePayload(archives, path, { signal }); files.push({ name: BUNDLE_FILES.managedVolumes, path });
    }
    const plugins = snapshotWorkerPlugins(owner.userId, owner.id, usePluginDefinitionStore(), usePluginInstallationStore());
    const hasPlugins = Boolean(plugins.definitions.length || plugins.installations.length);
    if (hasPlugins) {
      const path = join(directory, BUNDLE_FILES.plugins); await writePortablePluginConfiguration(path, plugins); files.push({ name: BUNDLE_FILES.plugins, path });
    }
    const environment = useEnvironmentStore().getById(DEFAULT_ENVIRONMENT_ID);
    if (!environment) throw new Error('Default environment is unavailable');
    const displayName = owner.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR';
    const manifest: WorkerExportManifest = { version: options.includeManagedVolumes ? PORTABLE_MANAGED_VOLUME_EXPORT_VERSION : WORKER_EXPORT_VERSION,
      exportedAt: new Date().toISOString(), runtime: snapshotIncusWorkerBackupRuntime(record.nativeRuntime!.image),
      source: { id: owner.id, displayName, containerName: record.nativeRuntime!.name, imageName: record.nativeRuntime!.image.sourceImageId },
      worker: { displayName, repos: [], mounts: [], initScript: record.startupScript ?? '', workerSelfApiAccess: 'deny' },
      environment: { ...environment, envVars: '' }, portMappings: [], domainMappings: [],
      contents: { rootfs: false, workspace: options.includeWorkspace, agents: options.includeAgents,
        ...(hasPlugins ? { plugins: true } : {}), ...(options.includeManagedVolumes ? { managedVolumes: true } : {}) },
      localPersistence: selected.map(item => ({ path: item.record.target, included: options.includeManagedVolumes && item.record.seeded })),
      ...(options.includeManagedVolumes ? { managedVolumes: entries } : {}) };
    const path = join(directory, BUNDLE_FILES.manifest); await writeManifest(manifest, path); files.unshift({ name: BUNDLE_FILES.manifest, path });
    await check(); await pipeline(packBundle(files), createWriteStream(destination, { mode: 0o600 }), { signal }); await check();
  } catch (error) { await rm(destination, { force: true }).catch(() => {}); throw error; }
  finally { await rm(directory, { recursive: true, force: true }); }
}

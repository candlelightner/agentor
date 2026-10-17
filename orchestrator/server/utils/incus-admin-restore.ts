import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { ManagedVolumeStore, type StoredManagedVolume } from './managed-volume-store';
import { administrativeRuntimeOwner, validateAdminNativeState } from './admin-native-identity';
import { IncusAdminWorkspaceStorage } from './incus-admin-workspace-storage';
import { IncusClient, type IncusCustomVolume } from './incus-client';
import { IncusOfflineArchiveHelper } from './incus-offline-archive-helper';
import { administrativeArchiveHelperOwner } from './incus-admin-backup';
import { INCUS_CANONICAL_RESTORE_SCRIPT } from './incus-canonical-restore';
import { validateIncusCanonicalRestoreArchive, validateIncusLegacyAdministrativeRestoreArchive, validatePortableManagedVolumeArchive } from './portable-managed-volume-archive';

export interface AdministrativeRestorePayloads {
  workspace: string;
  agents?: string;
  /** Internal historical instance codec; never a request-selected tar transform. */
  legacySourceWrapper?: true;
  managed: Array<{ record: StoredManagedVolume; archivePath: string }>;
}

/** Shared inverse for the controlled instance helper and explicit legacy mover.
 * Caller publishes a dedicated stopped migration/restore fence and allocates
 * fresh nonce-owned volumes first. No admin compute, network or credential is
 * created here. A failed writer retains the existing helper recovery receipt. */
export async function restoreAdministrativeArchives(config: Config, client: IncusClient,
  input: Readonly<AdministrativeWorkspaceRecord>, payloads: AdministrativeRestorePayloads,
  validateAuthority: () => Promise<void>, signal?: AbortSignal,
  helper = new IncusOfflineArchiveHelper(config, client, input.nativeRuntime!.installationId)): Promise<void> {
  const record = structuredClone(input), owner = administrativeRuntimeOwner(record), native = record.nativeRuntime;
  validateAdminNativeState(record);
  if (record.runtimeKind !== 'incus-vm' || record.status !== 'stopped' || !native || native.incarnation || native.pending ||
      native.deleting || native.storageInitialized || payloads.managed.length > 32)
    throw new Error('Administrative restore requires fresh stopped uninitialized storage authority');
  const storage = new IncusAdminWorkspaceStorage(config, client, async () => { const store = new ManagedVolumeStore(config.dataDir); await store.init(); return store; }), names = storage.names(native);
  const sources = { workspace: names.workspace, agents: names.agents, managed: {} as Record<string, string> };
  const baselines = new Map<string, IncusCustomVolume>();
  const capture = async (name: string, metadata: Record<string, string>) => {
    await validateAuthority();
    const volume = await client.getCustomVolume(config.incusStoragePool, name);
    if (volume.name !== name || volume.project !== config.incusProject || volume.type !== 'custom' ||
        volume.content_type !== 'filesystem' || !Number.isFinite(Date.parse(volume.created_at)) ||
        !Array.isArray(volume.used_by) || volume.used_by.length ||
        Object.entries(metadata).some(([key, value]) => volume.config[key] !== value) || baselines.has(name))
      throw new Error('Administrative restore destination is not fresh owned filesystem storage');
    baselines.set(name, structuredClone(volume));
  };
  for (const role of ['workspace', 'agents'] as const) await capture(names[role], storage.metadata(record, native, role));
  if (payloads.legacySourceWrapper) {
    await validateIncusLegacyAdministrativeRestoreArchive(payloads.workspace);
    if (payloads.agents) await validateIncusLegacyAdministrativeRestoreArchive(payloads.agents);
  } else {
    await validateIncusCanonicalRestoreArchive(payloads.workspace, 'workspace');
    if (payloads.agents) await validateIncusCanonicalRestoreArchive(payloads.agents, 'agents');
  }
  for (const item of payloads.managed) {
    const v = item.record;
    if (v.userId !== owner.userId || v.workerId !== owner.id || v.storageRuntimeKind !== 'incus-vm' || v.purpose !== 'persistent-path' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.id) || v.dockerName !== 'agentor-persist-' + v.id ||
        v.seeded || v.state !== 'pending' || v.operation || sources.managed[v.id])
      throw new Error('Administrative selected restore authority is invalid');
    await validatePortableManagedVolumeArchive(item.archivePath, { target: v.target, requirePosixUstar: true });
    await capture(v.dockerName, { 'user.agentor.installation': native.installationId, 'user.agentor.owner': owner.userId,
      'user.agentor.id': owner.id, 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target });
    sources.managed[v.id] = v.dockerName;
  }
  const assertSource = async (helperName?: string) => {
    await validateAuthority(); signal?.throwIfAborted();
    for (const [name, baseline] of baselines) {
      const current = await client.getCustomVolume(config.incusStoragePool, name);
      const refs = (current.used_by ?? []).map(ref => {
        const url = new URL(ref, client.endpoint);
        if (url.origin !== new URL(client.endpoint).origin || url.username || url.password || url.hash ||
            url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== config.incusProject ||
            [...url.searchParams.keys()].some(key => key !== 'project')) throw new Error('Administrative restore reference is foreign');
        return url.pathname;
      });
      if (!isDeepStrictEqual({ ...current, used_by: undefined }, { ...baseline, used_by: undefined }) ||
          !isDeepStrictEqual(refs, helperName ? ['/1.0/instances/' + helperName] : []))
        throw new Error('Administrative restore storage authority changed');
    }
    await validateAuthority();
  };
  await helper.withGuest(administrativeArchiveHelperOwner(record), { administrativeRestore: sources }, assertSource, signal,
    async (name, assertHelper) => {
      for (const item of [{ role: 'workspace', archivePath: payloads.workspace }, { role: 'agents', archivePath: payloads.agents },
        ...payloads.managed.map(item => ({ role: 'managed:' + item.record.id, archivePath: item.archivePath }))]) {
        await assertHelper(); await assertSource(name);
        const session = await client.execStream(name, ['/usr/bin/python3', '-c', INCUS_CANONICAL_RESTORE_SCRIPT, item.role,
          ...(item.archivePath ? payloads.legacySourceWrapper && !item.role.startsWith('managed:') ? ['legacy-source'] : [] : ['empty'])], { command: [], user: 0, group: 0, cwd: '/', signal, timeoutMs: 60 * 60_000 });
        session.stdout.resume(); session.stderr.resume();
        try {
          const result = session.result.then(code => { if (code !== 0) throw new Error('Administrative canonical extraction failed'); });
          if (item.archivePath) await Promise.all([pipeline(createReadStream(item.archivePath), session.stdin, { signal }), result]);
          else { session.stdin.end(); await result; }
        } finally { session.close(); }
        await assertHelper(); await assertSource(name);
      }
    });
  await assertSource(); // Helper cleanup must settle before storageInitialized can be acknowledged.
}

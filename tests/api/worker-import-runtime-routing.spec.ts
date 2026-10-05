import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { BUNDLE_FILES, packBundle, writeManifest } from '../../orchestrator/server/utils/worker-export';
import type { WorkerImportOrigin } from '../../orchestrator/server/utils/worker-import-runtime-policy';
import type { Config } from '../../orchestrator/server/utils/config';
import { getAuthDb, isPlatformAdminUser, migrateAuth } from '../../orchestrator/server/utils/auth';
import { withOwnerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { randomUUID } from 'node:crypto';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { BackupStore } from '../../orchestrator/server/utils/backup-store';

const native = { version: 1, kind: 'incus-vm', source: { sourceImageId: 'sha256:' + 'a'.repeat(64),
  recipeId: 'b'.repeat(64), architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' } };

async function fixture(run: (importBundle: (runtime: any, origin: WorkerImportOrigin, rootfs?: boolean, opts?: any) => Promise<unknown>, calls: string[], manager: ContainerManager, dataDir: string) => Promise<void>, enabled = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-import-authority-'));
  const calls: string[] = [];
  const manager = new ContainerManager(new Proxy({}, { get: () => () => {
    calls.push('Docker'); throw new Error('Native import policy must not call Docker');
  } }) as any, { dataDir, incusEnabled: enabled } as Config);
  (manager as any).resolveAuthorizedHostMounts = async () => {
    calls.push('legacy-preflight'); throw new Error('Reached legacy import preflight');
  };
  try {
    await run(async (runtime, origin, rootfs = false, opts = {}) => {
      const manifest = join(dataDir, 'manifest.json'), bundle = join(dataDir, 'bundle.tar');
      await writeManifest({ version: 3, exportedAt: '2026-01-01T00:00:00.000Z',
        source: { id: 'source', displayName: 'source', containerName: 'source', imageName: 'worker' },
        worker: { displayName: 'restored', repos: [], mounts: [], initScript: '' },
        environment: { id: 'default', name: 'Default' }, portMappings: [], domainMappings: [],
        contents: { rootfs, workspace: false, agents: false }, ...(runtime ? { runtime } : {}) } as any, manifest);
      const members = [{ name: BUNDLE_FILES.manifest, path: manifest }];
      if (rootfs) {
        const path = join(dataDir, 'rootfs.tar.gz'); await writeFile(path, gzipSync(Buffer.alloc(1024)));
        members.push({ name: BUNDLE_FILES.rootfs, path });
      }
      await pipeline(packBundle(members), createWriteStream(bundle, { mode: 0o600 }));
      return (manager as any).importWorkerForOwner('import-policy-owner', bundle, opts, origin);
    }, calls, manager, dataDir);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test('portable historical or forged legacy metadata cannot enter Docker when Incus is enabled', async () => {
  await fixture(async (importBundle, calls) => {
    for (const runtime of [undefined, { version: 1, kind: 'legacy-docker', privileged: true, adminLegacyAuthorized: true }])
      await expect(importBundle(runtime, { kind: 'portable' })).rejects.toMatchObject({ code: 'INCUS_RESTORE_CAPABILITY_PENDING' });
    expect(calls).toEqual([]);
  });
});

test('captured disposable rootfs is rejected before backend selection unless deliberately ignored', async () => {
  await fixture(async (importBundle, calls) => {
    await expect(importBundle(undefined, { kind: 'portable' }, true)).rejects.toMatchObject({ code: 'INCUS_CAPTURED_ROOTFS_UNSUPPORTED' });
    for (const imageResolution of [{ mode: 'workspace-only' }, { mode: 'replacement', imageDefinitionId: 'catalog', imageVersion: 'v1' }])
      await expect(importBundle(undefined, { kind: 'portable' }, true, { imageResolution }))
        .rejects.toMatchObject({ code: 'INCUS_RESTORE_CAPABILITY_PENDING' });
    expect(calls).toEqual([]);
  });
});

test('native backup and portable descriptors cannot downgrade when Incus is disabled', async () => {
  await fixture(async (importBundle, calls) => {
    for (const origin of [{ kind: 'portable' }, { kind: 'backup', provenance: 'local' }] as WorkerImportOrigin[])
      await expect(importBundle(native, origin)).rejects.toMatchObject({ code: 'INCUS_RUNTIME_DISABLED' });
    expect(calls).toEqual([]);
  }, false);
});

test('only persisted historical provenance or explicit trusted authorization permits legacy backup reconstruction', async () => {
  await fixture(async (importBundle, calls) => {
    await expect(importBundle(undefined, { kind: 'backup', provenance: 'remote-adopted' }))
      .rejects.toMatchObject({ code: 'REMOTE_LEGACY_RESTORE_AUTH_REQUIRED' });
    expect(calls).toEqual([]);
    for (const origin of [{ kind: 'backup' }, { kind: 'backup', provenance: 'local' }] as WorkerImportOrigin[])
      await expect(importBundle(undefined, origin)).rejects.toThrow('Reached legacy import preflight');
    expect(calls).toEqual(['legacy-preflight', 'legacy-preflight']);
  });
});

test('public portable entry ignores extra runtime-authority flags while backup entry has separate internal provenance', async () => {
  const manager = new ContainerManager({} as any, {} as Config);
  const received: WorkerImportOrigin[] = [];
  (manager as any).importWorkerWithOrigin = async (_owner: string, _path: string, _opts: unknown, origin: WorkerImportOrigin) => {
    received.push(origin); return { id: 'fixture' };
  };
  await manager.importWorker('owner', '/bundle', { provenance: 'local', origin: { kind: 'backup' }, adminLegacyAuthorized: true } as any);
  await manager.importWorkerFromBackup('owner', '/bundle', { provenance: 'remote-adopted', adminLegacyAuthorized: true } as any);
  expect(received).toEqual([{ kind: 'portable' }, { kind: 'backup', provenance: 'remote-adopted' }]);
});

test('admin approval revoked while waiting for the owner fence cannot authorize later legacy compute', async () => {
  await migrateAuth(); // Isolated DATA_DIR from module config, never real platform auth.
  const actor = randomUUID(), owner = 'queued-import-' + randomUUID(), now = new Date().toISOString();
  const db = getAuthDb();
  db.prepare('INSERT INTO user (id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(actor, 'Restore fixture', actor + '@fixture.invalid', 0, 'admin', now, now);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const blocked = withOwnerLifecycleMutation(owner, async () => { entered(); await waiting; });
  try {
    await admitted;
    expect(isPlatformAdminUser(actor)).toBe(true);
    await fixture(async (_importBundle, calls, manager, dataDir) => {
      (manager as any).assertOwnerExists = async () => {};
      const manifest = join(dataDir, 'queued-manifest.json'), bundle = join(dataDir, 'queued.tar');
      await writeManifest({ version: 3, exportedAt: now,
        source: { id: 'source', displayName: 'source', containerName: 'source', imageName: 'worker' },
        worker: { displayName: 'restored', repos: [], mounts: [], initScript: '' },
        environment: { id: 'default', name: 'Default' }, portMappings: [], domainMappings: [],
        contents: { rootfs: false, workspace: false, agents: false } } as any, manifest);
      await pipeline(packBundle([{ name: BUNDLE_FILES.manifest, path: manifest }]), createWriteStream(bundle, { mode: 0o600 }));
      await expect(manager.importWorkerFromBackup('approved-import-' + randomUUID(), bundle, {
        provenance: 'remote-adopted', runtimePrincipal: { kind: 'admin-user', userId: actor },
      })).rejects.toThrow('Reached legacy import preflight');
      expect(calls).toEqual(['legacy-preflight']); calls.length = 0;
      const pending = manager.importWorkerFromBackup(owner, bundle, {
        provenance: 'remote-adopted', runtimePrincipal: { kind: 'admin-user', userId: actor },
      });
      const denied = expect(pending).rejects.toMatchObject({ code: 'BACKUP_RESTORE_RUNTIME_AUTH_REVOKED' });
      db.prepare('UPDATE user SET role=? WHERE id=?').run('user', actor);
      release(); await blocked; await denied;
      expect(calls).toEqual([]);
    });
  } finally { release(); await blocked; db.prepare('DELETE FROM user WHERE id=?').run(actor); }
});

test('slow Docker image preparation cannot carry a revoked restore grant into privileged container creation', async () => {
  await migrateAuth();
  const actor = randomUUID(), now = new Date().toISOString(), db = getAuthDb();
  db.prepare('INSERT INTO user (id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(actor, 'Docker restore fixture', actor + '@fixture.invalid', 0, 'admin', now, now);
  const docker = new DockerService({ workerImagePrefix: '', workerImage: 'fixture:latest' } as Config);
  const calls: string[] = [];
  (docker as any).docker = { createContainer: () => { calls.push('create'); throw new Error('Revoked grant reached Docker create'); } };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  docker.ensureImage = async () => { calls.push('image'); entered(); await waiting; };
  try {
    const pending = docker.createWorkerContainer({ userId: 'restore-owner', id: randomUUID(), containerName: 'restore-fixture',
      environmentJson: { networkMode: 'full' }, capabilitiesJson: [], instructionsJson: [], workerJson: { id: 'fixture' },
      userEnv: { envVars: [] }, dockerEnabled: true, start: false,
      restoreRuntimePrincipal: { kind: 'admin-user', userId: actor },
    } as any);
    const denied = expect(pending).rejects.toMatchObject({ code: 'BACKUP_RESTORE_RUNTIME_AUTH_REVOKED' });
    await preparing; db.prepare('UPDATE user SET role=? WHERE id=?').run('user', actor); release(); await denied;
    expect(calls).toEqual(['image']);
  } finally { release(); db.prepare('DELETE FROM user WHERE id=?').run(actor); }
});

test('restore principal persists privately, changes the request fingerprint and cannot survive demotion on retry', async () => {
  await migrateAuth();
  const actor = randomUUID(), now = new Date().toISOString(), db = getAuthDb();
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-restore-principal-store-'));
  db.prepare('INSERT INTO user (id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(actor, 'Restore principal fixture', actor + '@fixture.invalid', 0, 'admin', now, now);
  const owner = 'restore-principal-owner', workspace = 'source-workspace';
  const artifact: any = { id: randomUUID(), userId: owner, workspaceId: workspace, provider: 'local',
    providerObjectId: 'backup.enc', includeManagedVolumes: false };
  const captured: any[] = [], calls: string[] = [];
  const fake: any = {
    init: async () => {}, assertOwnerAvailable() {}, store: { findArtifact: () => artifact },
    artifactWorkspaceIds: () => [workspace], selectRestoreWorkspaceIds: () => [workspace],
    assertRestoreRuntimePrincipal: (BackupManager.prototype as any).assertRestoreRuntimePrincipal,
    preflightRestoreDependencies: async () => { calls.push('dependencies'); return []; },
    restorePinOwner: () => 'pin', pinRestoreArtifact() { calls.push('pin'); }, releaseRestoreArtifactPin() {},
    beginRestoreExecution: () => ({ controller: new AbortController(), finish() {} }), assertRestoreActive() {},
    claimStartJob: async (job: unknown) => { captured.push(structuredClone(job)); return { created: true, job }; },
    enqueue() { calls.push('enqueue'); },
  };
  try {
    const principal = { kind: 'admin-user' as const, userId: actor };
    const without = await BackupManager.prototype.createRestore.call(fake, owner, artifact, 'new', undefined, undefined, undefined, 'same-request');
    const authorized = await BackupManager.prototype.createRestore.call(fake, owner, artifact, 'new', undefined, undefined, undefined, 'same-request', undefined, principal);
    expect(without.requestFingerprint).not.toBe(authorized.requestFingerprint);
    expect(authorized).not.toHaveProperty('restoreRuntimePrincipal');
    expect(captured[1].restoreRuntimePrincipal).toEqual(principal);
    const store = new BackupStore(dataDir); await store.init();
    await store.update(owner, data => { data.jobs.push(captured[1]); });
    const reloaded = new BackupStore(dataDir); await reloaded.init();
    expect(reloaded.findJob(captured[1].id)?.restoreRuntimePrincipal).toEqual(principal);
    captured[1].status = 'failed';
    fake.store.findJob = () => structuredClone(captured[1]); fake.getArtifact = async () => artifact; fake.retryClaims = new Set();
    calls.length = 0;
    db.prepare('UPDATE user SET role=? WHERE id=?').run('user', actor);
    await expect(BackupManager.prototype.retry.call(fake, { ...authorized, status: 'failed' }))
      .rejects.toMatchObject({ code: 'BACKUP_RESTORE_RUNTIME_AUTH_REVOKED' });
    expect(calls).toEqual([]); expect(fake.retryClaims.size).toBe(0);
  } finally { db.prepare('DELETE FROM user WHERE id=?').run(actor); await rm(dataDir, { recursive: true, force: true }); }
});

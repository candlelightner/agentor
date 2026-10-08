import { test, expect } from '@playwright/test';
import type { LegacyMigrationDockerClient } from '../../orchestrator/server/utils/legacy-incus-migration-capture';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore, type WorkerIncusMigration, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import type { Config } from '../../orchestrator/server/utils/config';
import type { ContainerInfo } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });
const Docker = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('dockerode') as { prototype: LegacyMigrationDockerClient };

for (const scenario of ['directory', 'foreign-parent', 'foreign-source', 'controller-extra-parent', 'canonical-missing',
  'traefik-reader', 'traefik-wrong-image', 'traefik-wrong-network', 'traefik-wrong-name', 'traefik-wrong-label',
  'traefik-rw', 'traefik-extra-source', 'traefik-extra-parent', 'traefik-extra-volume'] as const)
  test(`explicit migration finalization ${scenario} preserves canonical authority and bounds legacy deletion`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-finalize-'));
    const getContainer = Docker.prototype.getContainer, listContainers = Docker.prototype.listContainers;
    const getImage = Docker.prototype.getImage, getVolume = Docker.prototype.getVolume;
    try {
      const id = randomUUID(), userId = 'migration-owner', stamp = new Date(0).toISOString();
      const path = join(dir, 'users', userId, 'workspaces', id);
      await mkdir(path, { recursive: true, mode: 0o700 }); await writeFile(join(path, 'data'), 'retained-source');
      const stat = await lstat(path), sourceId = 'a'.repeat(64), controllerId = 'b'.repeat(64);
      const imageId = 'sha256:' + 'c'.repeat(64), incarnation = randomUUID();
      const hostData = '/fixture/operator-data', hostSource = join(hostData, 'users', userId, 'workspaces', id);
      const dataMount = { Type: 'bind', Source: hostData, Destination: dir, RW: true };
      const source = { Id: sourceId, Created: stamp, Image: imageId, Config: { Labels: { 'agentor.id': id } },
        State: { Running: false, Paused: false, Restarting: false, Pid: 0 } };
      const controller = { Id: controllerId, Image: imageId, Mounts: [dataMount], State: { Running: true } };
      type Reference = { Id: string; Names?: string[]; Labels?: Record<string, string>;
        Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean; Name?: string }> };
      const references: Reference[] = [{ Id: controllerId, Mounts: [dataMount] }];
      if (scenario === 'foreign-parent') references.push({ Id: 'd'.repeat(64), Mounts: [{ ...dataMount, Destination: '/foreign' }] });
      if (scenario === 'foreign-source') references.push({ Id: 'd'.repeat(64), Mounts: [{ ...dataMount, Source: hostSource, Destination: '/foreign' }] });
      if (scenario === 'controller-extra-parent') references[0]!.Mounts.push({ ...dataMount, Source: '/fixture', Destination: '/foreign' });
      const proxyId = 'e'.repeat(64), proxyImage = 'sha256:' + 'f'.repeat(64), proxyData = { ...dataMount, Destination: '/data', RW: false };
      const proxy = { Id: proxyId, Name: '/agentor-traefik', Image: proxyImage, Config: { Labels: { 'agentor.managed': 'traefik' } },
        HostConfig: { NetworkMode: 'fixture-control' }, Mounts: [proxyData], State: { Running: true } };
      if (scenario.startsWith('traefik-')) {
        references.push({ Id: proxyId, Names: ['/agentor-traefik'], Labels: { 'agentor.managed': 'traefik' }, Mounts: proxy.Mounts });
        if (scenario === 'traefik-wrong-image') proxy.Image = imageId;
        if (scenario === 'traefik-wrong-network') proxy.HostConfig.NetworkMode = 'foreign';
        if (scenario === 'traefik-wrong-name') proxy.Name = '/lookalike-traefik';
        if (scenario === 'traefik-wrong-label') proxy.Config.Labels['agentor.managed'] = 'foreign';
        if (scenario === 'traefik-rw') proxyData.RW = true;
        if (scenario === 'traefik-extra-source') proxy.Mounts.push({ ...proxyData, Source: hostSource, Destination: '/extra-source' });
        if (scenario === 'traefik-extra-parent') proxy.Mounts.push({ ...proxyData, Source: '/fixture', Destination: '/extra-parent' });
        if (scenario === 'traefik-extra-volume') references.at(-1)!.Mounts.push({ Type: 'volume', Name: 'retained-volume-' + id,
          Source: '/var/lib/docker/volumes/retained-volume-' + id + '/_data', Destination: '/extra-volume', RW: false });
      }
      let removed = false, volumeRemoved = false, canonicalChecks = 0;
      Docker.prototype.getContainer = ((target: string) => ({
        inspect: async () => target === sourceId ? source : target === proxyId ? proxy : controller,
        remove: async (options: object) => { expect(target).toBe(sourceId); expect(options).not.toHaveProperty('force'); removed = true; },
      })) as unknown as typeof getContainer;
      Docker.prototype.listContainers = (async () => references) as unknown as typeof listContainers;
      Docker.prototype.getImage = ((reference: string) => ({ inspect: async () => {
        expect(reference).toBe('traefik:v3'); return { Id: proxyImage };
      } })) as unknown as typeof getImage;
      Docker.prototype.getVolume = ((name: string) => ({ inspect: async () => ({ Name: name, CreatedAt: stamp, Driver: 'local', Options: {} }),
        remove: async () => { volumeRemoved = true; } })) as unknown as typeof getVolume;
      const store = new WorkerStore(dir); await store.init();
      const record: WorkerRecord = { id, userId, displayName: 'Migrated', status: 'active', runtimeKind: 'legacy-docker', createdAt: stamp, updatedAt: stamp };
      await store.upsert(record);
      const marker: WorkerIncusMigration = { nonce: randomUUID(), phase: 'preparing', source: {
        containerId: sourceId, imageId, createdAt: stamp, wasRunning: true }, sourceDirectories: [{ path, dev: stat.dev, ino: stat.ino }] };
      if (scenario === 'traefik-extra-volume') marker.sourceVolumes = [{ name: 'retained-volume-' + id, createdAt: stamp }];
      const preparing = await store.transitionIncusMigration(userId, id, undefined, marker);
      const validated = await store.transitionIncusMigration(userId, id, preparing.incusMigration!, {
        ...preparing.incusMigration!, phase: 'validated', destinationIncarnation: incarnation });
      await store.cutoverIncusMigration(userId, id, validated.incusMigration!);
      const manager = new ContainerManager({} as any, { dataDir: dir, containerPrefix: 'agentor-worker',
        traefikImage: 'traefik:v3', dockerNetwork: 'fixture-control' } as Config);
      manager.setWorkerStore(store); (manager as any).storageManager = { dataHostPath: hostData };
      (manager as any).incusRuntime = { backupRuntime: async () => { canonicalChecks++;
        if (scenario === 'canonical-missing') throw new Error('Canonical native storage is missing'); } };
      manager.registerExternal({ ...record, runtimeKind: 'incus-vm', status: 'running', containerId: 'incus:' + incarnation,
        containerName: 'agentor-worker-' + id, imageName: 'native', imageId } as ContainerInfo);
      if (scenario === 'directory' || scenario === 'traefik-reader') {
        await manager.finalizeLegacyMigration(id, async () => {});
        expect(removed).toBe(true); await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(store.get(userId, id)?.incusMigration).toBeUndefined();
      } else {
        await expect(manager.finalizeLegacyMigration(id, async () => {})).rejects.toThrow();
        expect(removed).toBe(false); expect(await readFile(join(path, 'data'), 'utf8')).toBe('retained-source');
        expect(volumeRemoved).toBe(false);
        expect(store.get(userId, id)?.incusMigration?.phase).toBe('retained');
      }
      expect(canonicalChecks).toBe(1); expect(store.get(userId, id)?.runtimeKind).toBe('incus-vm');
    } finally {
      Docker.prototype.getContainer = getContainer; Docker.prototype.listContainers = listContainers;
      Docker.prototype.getImage = getImage; Docker.prototype.getVolume = getVolume;
      await rm(dir, { recursive: true, force: true });
    }
  });

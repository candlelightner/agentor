import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
function ownerRecord(group = false): AdministrativeWorkspaceRecord {
  return { schemaVersion: 1, id: randomUUID(), kind: group ? 'group-administrative' : 'administrative', trusted: true,
    status: 'stopped', runtimeKind: 'incus-vm', ownerId: 'account-owner', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...(group ? { groupId: 'legacy_group' } : {}) };
}

import { remapAdministrativeOwnerMetadata } from '../../orchestrator/server/utils/admin-owner-metadata-remap';
import { PluginDefinitionStore } from '../../orchestrator/server/utils/plugin-definition-store';
import { PluginInstallationStore } from '../../orchestrator/server/utils/plugin-installation-store';
import { definitionVisibleToPluginSelf } from '../../orchestrator/server/utils/plugin-scope';

const pluginManifest = { schemaVersion: 1, name: 'Private admin fixture', slug: 'admin-fixture', description: 'Private desired admin plugin fixture', version: '1',
  lifecycle: { start: { argv: ['true'], mode: 'background' } },
  resources: { display: { mode: 'isolated' } },
  environment: { envKeys: ['SAFE_NAME'], secretKeys: ['SAFE_SECRET'] } };

test('global native owner metadata remap preserves installation IDs/config and desktop state while private definitions remain visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-owner-remap-'));
  try {
    const r = ownerRecord(), definitions = new PluginDefinitionStore(root), installations = new PluginInstallationStore(root);
    const groups = new WorkerGroupStore(root), originals = [];
    for (const scope of ['owner', 'group', 'worker'] as const) {
      const definition = await definitions.create({ scope, ownerId: 'account-owner', ...(scope === 'group' ? { groupId: 'private-group' } : {}),
        ...(scope === 'worker' ? { workerId: r.id } : {}), manifest: pluginManifest });
      const installation = await installations.create({ userId: 'account-owner', workerId: r.id, definitionId: definition.id,
        definitionVersion: '1', definitionHash: definition.definitionHash, envKeys: ['SAFE_NAME'], secretKeys: ['SAFE_SECRET'] });
      const reserved = await installations.reserveResources('account-owner', installation.id, definition.manifest);
      const observed = await installations.setObserved('account-owner', installation.id, { state: 'stopped', ready: false, checkedAt: new Date(0).toISOString(),
        desktop: { mode: 'isolated', display: reserved.allocations!.display!, state: 'disabled', viewerReady: false } });
      originals.push({ installation: observed, definition });
    }
    const ordinary = await installations.create({ userId: 'account-owner', workerId: 'ordinary-worker', definitionId: originals[0]!.definition.id,
      definitionVersion: '1', definitionHash: originals[0]!.definition.definitionHash });
    const raw = await readFile(join(root, 'users', 'account-owner', 'plugin-installations.json'));
    const evidence = join(root, 'one-off-private-evidence');
    expect(await remapAdministrativeOwnerMetadata(root, r, evidence, async () => {})).toEqual({ moved: 3, definitions: 3 });
    const current = new PluginInstallationStore(root), currentDefinitions = new PluginDefinitionStore(root);
    await Promise.all([current.init(), currentDefinitions.init()]);
    expect(current.listForWorker('account-owner', r.id)).toEqual([]); expect(current.getById(ordinary.id)).toEqual(ordinary);
    for (const { installation, definition } of originals) {
      const moved = current.getById(installation.id)!;
      expect({ ...moved, userId: installation.userId, definitionId: installation.definitionId }).toEqual(installation);
      const cloned = currentDefinitions.getById(moved.definitionId)!;
      expect(cloned.definitionHash).toBe(definition.definitionHash); expect(cloned.manifest).toEqual(definition.manifest);
      expect(definitionVisibleToPluginSelf(cloned, { kind: 'platform-admin', workspaceId: r.id }, groups)).toBe(true);
      expect(currentDefinitions.getById(definition.id)).toEqual(definition);
    }
    expect(await readFile(join(evidence, '0.private.json'))).toEqual(raw);
    expect((await readFile(join(evidence, 'receipt.private.json'), 'utf8'))).toContain(r.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owner remap does not change group namespaces and refuses ambiguous target or revoked authority before writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-owner-remap-deny-'));
  try {
    expect(await remapAdministrativeOwnerMetadata(root, ownerRecord(true), join(root, 'group-evidence'), async () => {})).toEqual({ moved: 0, definitions: 0 });
    const r = ownerRecord(), definitions = new PluginDefinitionStore(root), installations = new PluginInstallationStore(root);
    const definition = await definitions.create({ scope: 'owner', ownerId: 'account-owner', manifest: pluginManifest });
    const input = { workerId: r.id, definitionId: definition.id, definitionVersion: '1', definitionHash: definition.definitionHash };
    await installations.create({ ...input, userId: 'account-owner' }); await installations.create({ ...input, userId: '__agentor_admin__' });
    const before = await readFile(join(root, 'users', 'account-owner', 'plugin-installations.json'));
    await expect(remapAdministrativeOwnerMetadata(root, r, join(root, 'conflict-evidence'), async () => {})).rejects.toThrow('multiple namespaces');
    await expect(remapAdministrativeOwnerMetadata(root, r, join(root, 'revoked-evidence'), async () => { throw Error('revoked'); })).rejects.toThrow('revoked');
    expect(await readFile(join(root, 'users', 'account-owner', 'plugin-installations.json'))).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed namespace publication retains byte-exact private recovery evidence without duplicate active installation IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-owner-remap-write-'));
  const prototype = PluginInstallationStore.prototype as any, original = prototype.setItem;
  try {
    const r = ownerRecord(), definitions = new PluginDefinitionStore(root), installations = new PluginInstallationStore(root);
    const definition = await definitions.create({ scope: 'owner', ownerId: 'account-owner', manifest: pluginManifest });
    const installation = await installations.create({ userId: 'account-owner', workerId: r.id, definitionId: definition.id,
      definitionVersion: '1', definitionHash: definition.definitionHash });
    const raw = await readFile(join(root, 'users', 'account-owner', 'plugin-installations.json'));
    prototype.setItem = async function(userId: string, value: unknown) {
      if (userId === '__agentor_admin__') throw Error('destination write failed'); return original.call(this,userId,value);
    };
    const evidence = join(root, 'private-evidence');
    await expect(remapAdministrativeOwnerMetadata(root, r, evidence, async () => {})).rejects.toThrow('destination write failed');
    expect(await readFile(join(evidence, '0.private.json'))).toEqual(raw);
    const current = new PluginInstallationStore(root); await current.init();
    expect(current.list().filter(item => item.id === installation.id)).toEqual([]);
    expect(JSON.parse(await readFile(join(evidence, 'receipt.private.json'), 'utf8')).workspaceId).toBe(r.id);
  } finally { prototype.setItem = original; await rm(root, { recursive: true, force: true }); }
});

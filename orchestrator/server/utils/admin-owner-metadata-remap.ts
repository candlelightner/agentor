import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner } from './admin-native-identity';
import { PluginDefinitionStore } from './plugin-definition-store';
import { PluginInstallationStore, type PluginInstallationRecord } from './plugin-installation-store';

class AdministrativeInstallationStore extends PluginInstallationStore {
  put(record: PluginInstallationRecord) { return this.setItem(record.userId, record); }
}

/** One-time desired-state migration used by cold DR and the explicit legacy
 * mover. Caller holds the dedicated stopped lifecycle fence and reloads live
 * plugin stores after success. Private evidence is outside active namespaces;
 * partial failure keeps that fence for manual recovery, never an auto-retry. */
export async function remapAdministrativeOwnerMetadata(dataDir: string, input: Readonly<AdministrativeWorkspaceRecord>,
  evidenceDirectory: string, validateAuthority: () => Promise<void>) {
  const record = structuredClone(input), owner = administrativeRuntimeOwner(record), destination = '__agentor_admin__';
  if (record.kind !== 'administrative' || !record.ownerId || record.ownerId === destination) return { moved: 0, definitions: 0 };
  if (record.status !== 'stopped' || record.runtimeKind !== 'incus-vm' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.ownerId))
    throw new Error('Administrative owner remap requires dedicated stopped native authority');
  await validateAuthority();
  const installations = new AdministrativeInstallationStore(dataDir), definitions = new PluginDefinitionStore(dataDir);
  await Promise.all([installations.init(), definitions.init()]);
  // Explicit reads reject quarantined owners instead of losing desired state.
  await Promise.all([installations.loadUser(record.ownerId), installations.loadUser(destination),
    definitions.loadUser(record.ownerId), definitions.loadUser(destination)]);
  const source = installations.listForWorker(record.ownerId, owner.id);
  if (!source.length) return { moved: 0, definitions: 0 };
  if (installations.listForWorker(destination, owner.id).length || source.some(item =>
      installations.list().some(other => other.id === item.id && other.userId !== record.ownerId)))
    throw new Error('Administrative desired plugin identities already occupy multiple namespaces');
  const pinned = new Map<string, ReturnType<PluginDefinitionStore['getById']>>();
  for (const item of source) {
    const definition = definitions.getById(item.definitionId);
    if (!definition || definition.definitionHash !== item.definitionHash || definition.manifest.version !== item.definitionVersion ||
        definition.scope !== 'platform' && definition.userId !== record.ownerId && definition.userId !== destination ||
        definition.scope === 'worker' && definition.workerId !== owner.id)
      throw new Error('Administrative desired plugin definition authority is unavailable');
    pinned.set(definition.id, definition);
  }
  await mkdir(evidenceDirectory, { mode: 0o700 }); // Fresh explicit run, never hide an earlier receipt.
  const paths = [...new Set([record.ownerId, destination])].flatMap(userId =>
    ['plugin-installations.json', 'plugin-definitions.json'].map(file => ({ userId, file })));
  const originals: Array<{ path: string; evidence?: string }> = [];
  for (const [index, item] of paths.entries()) {
    const path = join('users', item.userId, item.file); let file;
    try { file = await open(join(dataDir, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: any) { if (error.code === 'ENOENT') { originals.push({ path }); continue; } throw error; }
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Administrative metadata source is unsafe');
      const evidence = index + '.private.json'; await writeFile(join(evidenceDirectory, evidence), await file.readFile(), { flag: 'wx', mode: 0o600 });
      originals.push({ path, evidence });
    } finally { await file.close(); }
  }
  await writeFile(join(evidenceDirectory, 'receipt.private.json'), JSON.stringify({ version: 1, workspaceId: owner.id,
    fromOwner: record.ownerId, toOwner: destination, originals }), { flag: 'wx', mode: 0o600 });
  const mapped = new Map<string, string>();
  for (const definition of pinned.values()) {
    await validateAuthority();
    if (definition!.scope === 'platform' || definition!.scope === 'worker' && definition!.userId === destination) {
      mapped.set(definition!.id, definition!.id); continue;
    }
    // Keep shared owner/group definitions for ordinary workers. A private
    // worker-scoped clone is visible under the trusted platform-admin role.
    const clone = await definitions.create({ scope: 'worker', ownerId: destination, workerId: owner.id, manifest: definition!.manifest });
    if (clone.definitionHash !== definition!.definitionHash) throw new Error('Administrative plugin clone changed its pinned definition');
    mapped.set(definition!.id, clone.id);
  }
  for (const installation of source) {
    await validateAuthority();
    // Delete source first: no active store ever has two copies of the same id.
    // Exact raw bytes above are the private recovery evidence for a failed run.
    await installations.delete(record.ownerId, installation.id);
    await installations.put({ ...installation, userId: destination, definitionId: mapped.get(installation.definitionId)! });
  }
  const verified = new AdministrativeInstallationStore(dataDir); await Promise.all([verified.loadUser(record.ownerId), verified.loadUser(destination)]);
  if (verified.listForWorker(record.ownerId, owner.id).length || verified.listForWorker(destination, owner.id).length !== source.length)
    throw new Error('Administrative desired plugin namespace transfer is unconfirmed');
  return { moved: source.length, definitions: [...mapped].filter(([oldId, newId]) => oldId !== newId).length };
}

import type { Config } from "./config";
import type { IncusClient, IncusCustomVolume, IncusDevice } from "./incus-client";
import { validateIncusImageIdentity, sameIncusImageSource, type IncusWorkerImageIdentity } from './incus-worker-image';

type Role = "workspace" | "agents" | "docker";
export interface IncusStorageOwner { id: string; userId: string; containerName: string }

/** Only core worker storage: deliberately independent of disposable VM/root
 * lifetime. Managed volumes/account shares have their own existing ownership. */
export class IncusWorkerStorage {
  constructor(private client: IncusClient, private config: Config, private installationId: string) {}

  private name(owner: IncusStorageOwner, role: Role): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(owner.id) || owner.containerName !== `${this.config.containerPrefix}-${owner.id}`)
      throw new Error("Invalid Incus worker storage identity");
    return `${owner.containerName}-${role}`;
  }

  private async find(owner: IncusStorageOwner, role: Role): Promise<IncusCustomVolume | undefined> {
    try { return await this.client.getCustomVolume(this.config.incusStoragePool, this.name(owner, role)); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined;
      throw error;
    }
  }

  /** Inventory only: absence never authorizes allocating replacement data. */
  async inspectVolume(owner: IncusStorageOwner, role: Role): Promise<IncusCustomVolume | undefined> {
    const volume = await this.find(owner, role);
    if (volume) this.validate(volume, owner, role);
    return volume;
  }

  /** Restore destinations are new identities. Never adopt even an owned but
   * previously populated volume, including after an ambiguous create reply. */
  async freshRestoreDevices(owner: IncusStorageOwner): Promise<Record<string, IncusDevice>> {
    for (const role of ['workspace', 'agents', 'docker'] as const)
      if (await this.find(owner, role)) throw new Error('Incus restore requires absent destination storage');
    const devices: Record<string, IncusDevice> = {};
    for (const role of ['workspace', 'agents'] as const) {
      const name = this.name(owner, role);
      await this.client.createCustomVolume(this.config.incusStoragePool, {
        name, content_type: 'filesystem', config: {
          'user.agentor.installation': this.installationId, 'user.agentor.id': owner.id,
          'user.agentor.owner': owner.userId, 'user.agentor.storage-role': role,
        },
      });
      const volume = await this.find(owner, role);
      if (!volume) throw new Error('Fresh Incus restore storage is missing');
      this.validate(volume, owner, role);
      if (volume.used_by?.length) throw new Error('Fresh Incus restore storage is already attached');
      devices[role] = { type: 'disk', pool: this.config.incusStoragePool, source: name,
        path: role === 'workspace' ? '/restore/workspace' : '/restore/.agent-data' };
    }
    return devices;
  }

  private validate(volume: IncusCustomVolume, owner: IncusStorageOwner, role: Role): void {
    const c = volume.config;
    if (volume.name !== this.name(owner, role) || volume.type !== "custom" ||
        volume.content_type !== (role === "docker" ? "block" : "filesystem") ||
        c["user.agentor.installation"] !== this.installationId || c["user.agentor.id"] !== owner.id ||
        c["user.agentor.owner"] !== owner.userId || c["user.agentor.storage-role"] !== role)
      throw new Error("Incus persistent volume ownership/type is ambiguous; refusing to use it");
    if ((volume.used_by ?? []).some((ref) => {
      const url = new URL(ref, this.client.endpoint);
      return url.pathname !== `/1.0/instances/${owner.containerName}` || url.searchParams.get("project") !== this.config.incusProject;
    })) throw new Error("Incus worker volume is attached to another runtime");
  }

  private async ensure(owner: IncusStorageOwner, role: Role): Promise<IncusCustomVolume> {
    let volume = await this.find(owner, role);
    if (!volume) {
      try {
        await this.client.createCustomVolume(this.config.incusStoragePool, {
          name: this.name(owner, role), content_type: role === "docker" ? "block" : "filesystem",
          config: {
            "user.agentor.installation": this.installationId, "user.agentor.id": owner.id,
            "user.agentor.owner": owner.userId, "user.agentor.storage-role": role,
            ...(role === "docker" ? { size: this.config.incusDockerVolumeSize,
              "user.agentor.allow-initialization": "true" } : {}),
          },
        });
      } catch (error) {
        // A concurrent/retried create converges only through an ownership
        // check. Do not retry ambiguous transport errors as a second write.
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      }
      volume = await this.find(owner, role);
    }
    if (!volume) throw new Error("Incus persistent volume was not created");
    this.validate(volume, owner, role);
    return volume;
  }

  async devices(owner: IncusStorageOwner, dockerEnabled: boolean, existing?: { docker: boolean }): Promise<Record<string, IncusDevice>> {
    const requireExisting = async (role: Role) => {
      const volume = await this.find(owner, role);
      if (!volume) throw new Error(`Existing Incus ${role} volume is missing; explicit recovery is required`);
      this.validate(volume, owner, role);
      return volume;
    };
    // Starting known compute is not authority to replace missing canonical
    // data with an empty volume. Validate both private roots before any write.
    for (const role of ["workspace", "agents"] as const) {
      if (existing) await requireExisting(role);
      else await this.ensure(owner, role);
    }
    const workspace = await requireExisting('workspace');
    const retainedDocker = this.expectsDocker(workspace);
    // Once allocated, disabling Docker must never turn lost canonical Docker
    // data into authority to create an empty replacement. The private-volume
    // marker survives deletion of disposable compute and is never cleared.
    if (retainedDocker) await requireExisting('docker');
    const devices: Record<string, IncusDevice> = {
      workspace: { type: "disk", pool: this.config.incusStoragePool, source: this.name(owner, "workspace"), path: "/workspace" },
      agents: { type: "disk", pool: this.config.incusStoragePool, source: this.name(owner, "agents"), path: "/home/agent/.agent-data" },
    };
    const docker = existing?.docker ? await requireExisting("docker")
      : dockerEnabled ? await this.ensure(owner, "docker") : await this.find(owner, "docker");
    if (docker) {
      this.validate(docker, owner, "docker");
      if (!retainedDocker) await this.client.updateCustomVolume(this.config.incusStoragePool, workspace.name,
        { ...workspace.config, 'user.agentor.docker-data': 'true' });
      // Fixed device name, hence fixed guest serial; never guess an unused disk.
      devices.docker = { type: "disk", pool: this.config.incusStoragePool, source: this.name(owner, "docker") };
    }
    return devices;
  }

  async dockerInitializationAllowed(owner: IncusStorageOwner): Promise<boolean> {
    const volume = await this.find(owner, "docker");
    if (!volume) throw new Error("Authoritative Docker volume is missing");
    this.validate(volume, owner, "docker");
    return volume.config["user.agentor.allow-initialization"] === "true";
  }

  /** Metadata preservation survives compute disposal. Partial writes must
   * never permit a later recursive ownership repair over restored data. */
  async preserveOwnership(owner: IncusStorageOwner): Promise<boolean> {
    const flags: Array<string | undefined> = [];
    for (const role of ['workspace', 'agents'] as const) {
      const volume = await this.inspectVolume(owner, role);
      if (!volume) throw new Error(`Existing Incus ${role} volume is missing; explicit recovery is required`);
      flags.push(volume.config['user.agentor.preserve-ownership']);
    }
    if (flags.every(flag => flag === undefined)) return false;
    if (flags.every(flag => flag === 'true')) return true;
    throw new Error('Incus canonical ownership metadata is malformed or incomplete; explicit recovery is required');
  }

  async markPreserveOwnership(owner: IncusStorageOwner): Promise<void> {
    const volumes: IncusCustomVolume[] = [];
    for (const role of ['workspace', 'agents'] as const) {
      const volume = await this.inspectVolume(owner, role);
      if (!volume) throw new Error(`Existing Incus ${role} volume is missing; explicit recovery is required`);
      const flag = volume.config['user.agentor.preserve-ownership'];
      if (flag !== undefined && flag !== 'true') throw new Error('Incus canonical ownership metadata is malformed');
      volumes.push(volume);
    }
    for (const volume of volumes) if (volume.config['user.agentor.preserve-ownership'] !== 'true')
      await this.client.updateCustomVolume(this.config.incusStoragePool, volume.name,
        { ...volume.config, 'user.agentor.preserve-ownership': 'true' });
    if (!await this.preserveOwnership(owner)) throw new Error('Incus canonical ownership preservation was not persisted');
  }

  /** Read-only reconstruction preflight. Missing known data is an error, never
   * permission to allocate an empty replacement. */
  async verifyExisting(owner: IncusStorageOwner, dockerRequired = false): Promise<{ docker: boolean }> {
    let docker = false;
    for (const role of ['workspace', 'agents', 'docker'] as const) {
      const volume = await this.find(owner, role);
      if (!volume && (role !== 'docker' || dockerRequired))
        throw new Error('Existing Incus ' + role + ' volume is missing; explicit recovery is required');
      if (volume) {
        this.validate(volume, owner, role);
        if (role === 'workspace') dockerRequired ||= this.expectsDocker(volume);
        if (role === 'docker') docker = true;
      }
    }
    return { docker };
  }

  private expectsDocker(workspace: IncusCustomVolume): boolean {
    const marker = workspace.config['user.agentor.docker-data'];
    if (marker !== undefined && marker !== 'true')
      throw new Error('Incus retained Docker storage metadata is ambiguous; explicit recovery is required');
    return marker === 'true';
  }

  /** Failed first creation may not have allocated all canonical roots yet.
   * This read-only check is never a rebuild/unarchive allocation preflight. */
  async verifyPartialInitial(owner: IncusStorageOwner): Promise<void> {
    for (const role of ['workspace', 'agents', 'docker'] as const) {
      const volume = await this.find(owner, role);
      if (!volume) continue;
      this.validate(volume, owner, role);
      if (volume.used_by?.length)
        throw new Error('Incus initial storage is still attached; explicit recovery is required');
      if (role === 'workspace') {
        this.expectsDocker(volume);
        this.readImageIdentity(volume);
      }
    }
  }

  async imageIdentity(owner: IncusStorageOwner): Promise<IncusWorkerImageIdentity | undefined> {
    const workspace = await this.find(owner, 'workspace');
    if (!workspace) return undefined;
    this.validate(workspace, owner, 'workspace');
    return this.readImageIdentity(workspace);
  }

  private readImageIdentity(workspace: IncusCustomVolume): IncusWorkerImageIdentity | undefined {
    const stored = workspace.config['user.agentor.image-source'];
    if (stored === undefined) return undefined;
    if (typeof stored !== 'string' || stored.length > 2048)
      throw new Error('Incus worker image metadata is invalid; explicit recovery is required');
    try { return validateIncusImageIdentity(JSON.parse(stored)); }
    catch { throw new Error('Incus worker image metadata is invalid; explicit recovery is required'); }
  }

  async recordImageIdentity(owner: IncusStorageOwner, identity: IncusWorkerImageIdentity): Promise<void> {
    const normalized = validateIncusImageIdentity(identity);
    const workspace = await this.find(owner, 'workspace');
    if (!workspace) throw new Error('Existing Incus workspace volume is missing; explicit recovery is required');
    this.validate(workspace, owner, 'workspace');
    const previous = await this.imageIdentity(owner);
    if (previous && !sameIncusImageSource(previous, normalized))
      throw new Error('Incus reconstruction image source changed; explicit image selection is required');
    const serialized = JSON.stringify(normalized);
    if (workspace.config['user.agentor.image-source'] !== serialized)
      await this.client.updateCustomVolume(this.config.incusStoragePool, workspace.name,
        { ...workspace.config, 'user.agentor.image-source': serialized });
  }

  async markDockerInitialized(owner: IncusStorageOwner): Promise<void> {
    const volume = await this.find(owner, "docker");
    if (!volume) throw new Error("Authoritative Docker volume is missing");
    this.validate(volume, owner, "docker");
    await this.client.updateCustomVolume(this.config.incusStoragePool, volume.name,
      { ...volume.config, "user.agentor.allow-initialization": "false" });
  }

  async remove(owner: IncusStorageOwner): Promise<void> {
    const volumes: IncusCustomVolume[] = [];
    // Validate the entire bounded set before any irreversible deletion.
    for (const role of ["workspace", "agents", "docker"] as const) {
      const volume = await this.find(owner, role);
      if (!volume) continue;
      this.validate(volume, owner, role);
      if (volume.used_by?.length) throw new Error("Refusing to delete attached Incus worker storage");
      volumes.push(volume);
    }
    for (const volume of volumes) await this.client.deleteCustomVolume(this.config.incusStoragePool, volume.name);
  }
}

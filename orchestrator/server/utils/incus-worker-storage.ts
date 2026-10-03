import type { Config } from "./config";
import type { IncusClient, IncusCustomVolume, IncusDevice } from "./incus-client";

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
    const devices: Record<string, IncusDevice> = {
      workspace: { type: "disk", pool: this.config.incusStoragePool, source: this.name(owner, "workspace"), path: "/workspace" },
      agents: { type: "disk", pool: this.config.incusStoragePool, source: this.name(owner, "agents"), path: "/home/agent/.agent-data" },
    };
    const docker = existing?.docker ? await requireExisting("docker")
      : dockerEnabled ? await this.ensure(owner, "docker") : await this.find(owner, "docker");
    if (docker) {
      this.validate(docker, owner, "docker");
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

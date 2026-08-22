import Docker from "dockerode";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config";
import type { ContainerInfo } from "../../shared/types";
import { normalizeBackupPaths, isParentPath } from "./backup-paths";
import { sanitizeBackupPathTarPayload } from "./worker-export";

const MANAGED_LABEL = "agentor.persistent-backup-path";
const WORKER_LABEL = "agentor.worker-id";

export interface PersistentPathMount {
  source: string;
  target: string;
}

type WorkerResolver = (id: string) => ContainerInfo | undefined;
type DirectoryProbe = (id: string, path: string) => Promise<boolean>;

/**
 * Converts explicit backup directory selections into local Docker volumes.
 * The volume is populated while the old container is still intact; only a
 * later rebuild attaches it at the selected absolute path. Files, `/`, and
 * paths already covered by another persistent mount remain backup-only.
 */
export class PersistentBackupPathManager {
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" });

  constructor(
    private readonly config: Config,
    private readonly resolveWorker: WorkerResolver,
    private readonly isDirectory: DirectoryProbe,
  ) {}

  async reconcileSelections(
    userId: string,
    selected: Record<string, string[]> | undefined,
  ): Promise<void> {
    for (const [workerId, rawPaths] of Object.entries(selected || {})) {
      const worker = this.resolveWorker(workerId);
      if (!worker || worker.userId !== userId)
        throw Object.assign(new Error("Workspace not found"), { statusCode: 404 });
      await this.prepareWorker(worker, rawPaths);
    }
  }

  async prepareWorker(
    worker: Pick<ContainerInfo, "id" | "containerId" | "status">,
    rawPaths: string[] | undefined,
  ): Promise<PersistentPathMount[]> {
    const paths = normalizeBackupPaths(rawPaths || []);
    let inspection: Docker.ContainerInspectInfo | undefined;
    try {
      inspection = await this.docker.getContainer(worker.containerId).inspect();
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }

    for (const path of paths) {
      if (path === "/") continue;
      const name = persistentPathVolumeName(worker.id, path);
      if (inspection && pathCoveredByMount(inspection.Mounts || [], path, name))
        continue;
      const exists = await this.volumeExists(name);
      if (exists && inspection && volumeMountedAt(inspection.Mounts || [], name, path))
        continue;
      if (!inspection?.State.Running) {
        if (exists) continue;
        // Docker exec-based type/readability probing and getArchive need a
        // running source. Refuse before changing the backup configuration.
        throw Object.assign(
          new Error(`Start workspace ${worker.id} before making ${path} rebuild-persistent`),
          { statusCode: 409 },
        );
      }
      if (!(await this.isDirectory(worker.id, path))) continue;
      await this.seedVolume(inspection, worker.id, path, name, exists);
    }
    return this.mountsForSelections(worker.id, paths);
  }

  async mountsForSelections(
    workerId: string,
    rawPaths: string[] | undefined,
  ): Promise<PersistentPathMount[]> {
    const mounts: PersistentPathMount[] = [];
    for (const target of normalizeBackupPaths(rawPaths || [])) {
      if (target === "/") continue;
      const source = persistentPathVolumeName(workerId, target);
      if (await this.volumeExists(source)) mounts.push({ source, target });
    }
    return mounts;
  }

  async removeWorkerVolumes(workerId: string): Promise<void> {
    const result = await this.docker.listVolumes({
      filters: { label: [`${MANAGED_LABEL}=true`, `${WORKER_LABEL}=${workerId}`] },
    });
    for (const volume of result.Volumes || []) {
      if (!volume.Name) continue;
      await this.docker.getVolume(volume.Name).remove({ force: true });
    }
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error: any) {
      if (error?.statusCode === 404) return false;
      throw error;
    }
  }

  private async seedVolume(
    source: Docker.ContainerInspectInfo,
    workerId: string,
    selectedPath: string,
    volumeName: string,
    replace: boolean,
  ): Promise<void> {
    const tmpRoot = join(this.config.dataDir, "tmp");
    await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(tmpRoot, "persistent-path-"));
    const raw = join(dir, "source.tar");
    const safe = join(dir, "safe.tar");
    let helper: Docker.Container | undefined;
    let created = false;
    try {
      const archive = await this.docker
        .getContainer(source.Id)
        .getArchive({ path: selectedPath });
      await pipeline(archive as any, createWriteStream(raw, { mode: 0o600 }));
      await sanitizeBackupPathTarPayload(raw, safe, selectedPath);

      if (!replace) {
        await this.docker.createVolume({
          Name: volumeName,
          Labels: { [MANAGED_LABEL]: "true", [WORKER_LABEL]: workerId },
        });
        created = true;
      }
      helper = await this.docker.createContainer({
        Image: source.Config.Image,
        name: `agentor-persistent-path-${randomUUID()}`,
        Entrypoint: ["sleep"],
        Cmd: ["60"],
        User: "0:0",
        NetworkDisabled: true,
        Labels: { [MANAGED_LABEL]: "helper", [WORKER_LABEL]: workerId },
        HostConfig: {
          NetworkMode: "none",
          // Docker rejects putArchive for a read-only rootfs even when every
          // archive member resolves into the writable volume below. The
          // helper remains stopped throughout extraction, networkless, and
          // the sanitizer confines the wrapper to selectedPath.
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 32,
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500_000_000,
          Init: true,
          Mounts: [
            {
              Type: "volume",
              Source: volumeName,
              Target: selectedPath,
              VolumeOptions: { NoCopy: true },
            },
          ] as any,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
          LogConfig: { Type: "none", Config: {} },
        },
      });
      // putArchive works on a stopped container. The sanitized Docker archive
      // retains the selected directory's basename; extracting at its parent
      // writes through the exact-path volume mount without buffering in Node.
      await helper.putArchive(createReadStream(safe) as any, {
        path: posix.dirname(selectedPath),
      });
    } catch (error) {
      if (created)
        await this.docker.getVolume(volumeName).remove({ force: true }).catch(() => {});
      throw error;
    } finally {
      if (helper) await helper.remove({ force: true }).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function persistentPathVolumeName(workerId: string, target: string): string {
  const digest = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return `agentor-persist-${workerId}-${digest}`;
}

type InspectedMount = Docker.ContainerInspectInfo["Mounts"][number];

function volumeMountedAt(
  mounts: InspectedMount[],
  volumeName: string,
  target: string,
) {
  return mounts.some(
    (mount) =>
      mount.Type === "volume" &&
      mount.Name === volumeName &&
      mount.Destination === target,
  );
}

function pathCoveredByMount(
  mounts: InspectedMount[],
  target: string,
  managedVolume: string,
) {
  return mounts.some((mount) => {
    if (!mount.Destination) return false;
    if (mount.Destination === target) return true;
    if (!isParentPath(mount.Destination, target)) return false;
    // An exact managed mount is already the desired result. Any other parent
    // volume/bind means the path is persistent without another overlapping
    // Agentor volume (workspace, agent-data, DinD, user bind, Kilo, etc.).
    return mount.Name !== managedVolume;
  });
}

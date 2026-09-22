import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as tar from "tar-stream";
import { sanitizeBackupPathTarPayload } from "./worker-export";
import { withOperationDeadline } from "./operation-deadline";
import { pathsOverlap, validatePersistenceTarget, volumeError, type StoredManagedVolume } from "./managed-volume-store";

const READ_TIMEOUT = 15_000;
const HELPER_TIMEOUT = 150_000;
export const VOLUME_LABEL = "agentor.volume-id";
export const HELPER_LABEL = "agentor.volume-helper";

export class ManagedVolumeRuntime {
  constructor(readonly docker: Docker, private readonly dataDir: string) {}

  async inspect(containerId: string) {
    return withOperationDeadline(this.docker.getContainer(containerId).inspect(), READ_TIMEOUT, "Inspect volume worker");
  }

  async trustedImage() {
    if (!process.env.HOSTNAME) throw volumeError(503, "Orchestrator image identity is unavailable.");
    // Resolve the running orchestrator's immutable image, not a worker-supplied
    // image or mutable registry tag. Helpers never inherit orchestrator secrets.
    return (await this.inspect(process.env.HOSTNAME)).Image;
  }

  async inspectVolume(v: StoredManagedVolume) {
    try {
      const found = await withOperationDeadline(this.docker.getVolume(v.dockerName).inspect(), READ_TIMEOUT, "Inspect managed volume");
      const labels = found.Labels ?? {};
      const owned = v.purpose === "legacy-backup-path"
        ? labels["agentor.persistent-backup-path"] === "true" && labels["agentor.worker-id"] === v.workerId
        : labels[VOLUME_LABEL] === v.id && labels["agentor.owner-id"] === v.userId && labels["agentor.worker-id"] === v.workerId;
      if (!owned || found.Driver !== "local" || Object.keys(found.Options ?? {}).length)
        throw volumeError(409, "Volume ownership or local driver configuration does not match its durable record.");
      return found;
    } catch (error: any) {
      if (error?.statusCode === 404) return undefined;
      throw error;
    }
  }

  async ensureVolume(v: StoredManagedVolume) {
    const found = await this.inspectVolume(v);
    if (found) return;
    if (v.seeded) throw volumeError(409, "Required persistent volume is missing. Restore it before starting the worker; no empty replacement was created.");
    await withOperationDeadline(this.docker.createVolume({ Name: v.dockerName, Driver: "local", Labels: {
      [VOLUME_LABEL]: v.id, "agentor.owner-id": v.userId, "agentor.worker-id": v.workerId,
    } }), READ_TIMEOUT, "Create managed volume");
    await this.inspectVolume(v);
  }

  async validateTarget(containerId: string, target: string, allowVolume?: string) {
    validatePersistenceTarget(target);
    const inspection = await this.inspect(containerId);
    for (const mount of inspection.Mounts ?? []) {
      if (mount.Name === allowVolume && mount.Destination === target) continue;
      if (!pathsOverlap(target, mount.Destination)) continue;
      if (target === mount.Destination || target.startsWith(`${mount.Destination}/`))
        throw volumeError(409, `Already persistent under ${mount.Destination}; no additional volume is needed.`);
      throw volumeError(409, "The directory contains an existing mount; overlapping mounts are not allowed.");
    }
    // Docker resolves archive paths in the container root. Check every parent
    // and reject aliases, not just a symlink at the final component.
    let current = "";
    for (const component of target.slice(1).split("/")) {
      current += `/${component}`;
      try {
        const response = await withOperationDeadline(this.docker.getContainer(containerId).infoArchive({ path: current }), READ_TIMEOUT, "Validate persistence directory");
        const encoded = response.headers?.["x-docker-container-path-stat"];
        response.resume?.();
        if (typeof encoded !== "string") throw volumeError(503, "Docker did not return directory metadata.");
        const info = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (info.linkTarget || !(Number(info.mode) & 0x80000000))
          throw volumeError(409, "Persistent paths must be directories with no symlink components.");
      } catch (error: any) {
        if (error?.statusCode === 404) break;
        throw error;
      }
    }
    return inspection;
  }

  /** Called with the source stopped: a consistent copy, not a live snapshot. */
  async seed(containerId: string, v: StoredManagedVolume) {
    if (v.seeded) { await this.ensureVolume(v); return; }
    const inspection = await this.validateTarget(containerId, v.target);
    if (inspection.State.Running) throw volumeError(409, "Stop the worker before copying a directory for recreation.");
    // A prior partial copy is never reused or merged. Its source is retained;
    // the service must explicitly handle the failed staging volume on retry.
    if (await this.inspectVolume(v)) throw volumeError(409, "An uncommitted staging volume exists. Inspect the failed operation before retrying.");
    const image = await this.trustedImage();
    await mkdir(join(this.dataDir, "tmp"), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(this.dataDir, "tmp", "volume-seed-"));
    let helper: Docker.Container | undefined;
    try {
      const raw = join(temporary, "source.tar"), safe = join(temporary, "safe.tar");
      try {
        const stream = await this.docker.getContainer(containerId).getArchive({ path: v.target });
        let copied = 0;
        const bounded = new Transform({ transform(chunk, _encoding, callback) {
          copied += chunk.length;
          callback(copied > 20 * 1024 ** 3
            ? volumeError(409, "Directory archive exceeds the 20 GiB migration limit. Reduce its size before retrying; original data was retained.")
            : null, chunk);
        } });
        await pipeline(stream as any, bounded, createWriteStream(raw, { mode: 0o600 }), { signal: AbortSignal.timeout(HELPER_TIMEOUT) });
      } catch (error: any) {
        if (error?.statusCode !== 404) throw error;
        const pack = tar.pack();
        pack.entry({ name: posix.basename(v.target), type: "directory", uid: 1000, gid: 1000, mode: 0o755 });
        pack.finalize();
        await pipeline(pack, createWriteStream(raw, { mode: 0o600 }));
      }
      await sanitizeBackupPathTarPayload(raw, safe, v.target);
      await this.ensureVolume(v);
      helper = await this.docker.createContainer({
        Image: image, Entrypoint: ["/bin/true"], Cmd: [], User: "0:0", NetworkDisabled: true,
        Labels: { [HELPER_LABEL]: "seed", [VOLUME_LABEL]: v.id },
        HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 16, Memory: 128 * 1024 * 1024,
          Mounts: [{ Type: "volume", Source: v.dockerName, Target: v.target, VolumeOptions: { NoCopy: true } }] as any,
          LogConfig: { Type: "none", Config: {} } },
      });
      await withOperationDeadline(helper.putArchive(createReadStream(safe) as any, { path: posix.dirname(v.target) }), HELPER_TIMEOUT, "Seed persistent volume");
    } finally {
      if (helper) await helper.remove({ force: true }).catch(() => {});
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Worker is paused by the service after journaling recovery information. */
  async mountLive(containerId: string, v: StoredManagedVolume, probe = false): Promise<boolean> {
    const worker = await this.inspect(containerId);
    if (!worker.State.Running || (!probe && !worker.State.Paused)) throw volumeError(409, "The worker must be frozen before live mounting.");
    if (worker.HostConfig.UsernsMode || worker.HostConfig.PidMode && worker.HostConfig.PidMode !== "private")
      throw volumeError(409, "Live mounting is not supported for this namespace configuration. Choose recreation.");
    await this.ensureVolume(v);
    const helper = await this.docker.createContainer({
      name: `agentor-volume-helper-${randomUUID()}`,
      Image: await this.trustedImage(), User: "0:0", WorkingDir: "/",
      Entrypoint: ["python3", "-I", "/app/.output/server/volume-mount-helper.py"],
      Cmd: [v.target, probe ? "probe" : v.seeded ? "seeded" : "new"], Env: [], NetworkDisabled: true,
      Labels: { [HELPER_LABEL]: "live", [VOLUME_LABEL]: v.id, "agentor.worker-id": v.workerId },
      HostConfig: { Privileged: true, PidMode: `container:${containerId}`, NetworkMode: "none",
        // PID-namespace sharing plus domain cgroup controllers is unsupported
        // on some nested Docker hosts. The trusted single-process Python
        // helper enforces AS/CPU/FD limits itself; no child execution occurs.
        ReadonlyRootfs: true,
        Mounts: [{ Type: "volume", Source: v.dockerName, Target: "/volume", VolumeOptions: { NoCopy: true } }] as any,
        LogConfig: { Type: "json-file", Config: { "max-size": "16k", "max-file": "1" } },
      },
    });
    try {
      await helper.start();
      const result = await withOperationDeadline(helper.wait(), HELPER_TIMEOUT, "Live volume mount");
      const logs = await helper.logs({ stdout: true, stderr: false, tail: 3 });
      if (result.StatusCode !== 0) {
        const line = logs.toString().split("\n").find((line: string) => line.includes('{"ok": false'));
        let message = "Live mounting failed. Choose recreation or inspect the worker runtime.";
        try { const parsed = JSON.parse(line!.slice(line!.indexOf("{"))); if (typeof parsed.error === "string") message = parsed.error.slice(0, 300); } catch {}
        throw volumeError(409, message);
      }
      if (!probe) return true;
      const line = logs.toString().split("\n").find((line: string) => line.includes('{"ok": true'));
      try { return JSON.parse(line!.slice(line!.indexOf("{"))).mounted === true; }
      catch { throw volumeError(503, "Cannot verify the live mount. Worker state was preserved."); }
    } finally {
      // Await helper removal before the caller unfreezes the worker, including
      // timeout paths: no copying/mounting may continue after writers resume.
      await withOperationDeadline(helper.remove({ force: true }), READ_TIMEOUT, "Remove volume helper");
    }
  }

  async removeStaging(v: StoredManagedVolume) {
    if (v.seeded) throw volumeError(409, "Populated volumes cannot be removed as staging.");
    if (!await this.inspectVolume(v)) return;
    // Never force-remove a volume. Docker also refuses actual attachments;
    // caller has independently proven no transient namespace mount remains.
    await this.docker.getVolume(v.dockerName).remove();
  }

  async removeHelpers(v: StoredManagedVolume) {
    const helpers = await this.docker.listContainers({ all: true, filters: { label: [`${VOLUME_LABEL}=${v.id}`, HELPER_LABEL] } });
    for (const helper of helpers) await this.docker.getContainer(helper.Id).remove({ force: true });
  }
}

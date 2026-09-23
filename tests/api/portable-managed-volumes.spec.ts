import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../helpers/api-client";
import { cleanupWorker, createWorker, waitForWorkerRunning } from "../helpers/worker-lifecycle";
import { createTestUser, deleteTestUser, type CreatedUser } from "../helpers/test-users";
import {
  PortableManagedVolumeRuntime,
  PORTABLE_VOLUME_HELPER_LABEL,
} from "../../orchestrator/server/utils/portable-managed-volume-runtime";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

interface TarMember { name: string; body: Buffer; raw: Buffer }

function tarMembers(archive: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid test tar bundle");
    const dataOffset = offset + 512;
    const next = dataOffset + Math.ceil(size / 512) * 512;
    if (next > archive.length) throw new Error("Truncated test tar bundle");
    members.push({
      name: prefix ? `${prefix}/${name}` : name,
      body: archive.subarray(dataOffset, dataOffset + size),
      raw: archive.subarray(offset, next),
    });
    offset = next;
  }
  return members;
}

function tarMember(archive: Buffer, name: string): Buffer {
  const member = tarMembers(archive).find((candidate) => candidate.name === name);
  if (!member) throw new Error(`Tar member not found: ${name}`);
  return member.body;
}

function withoutTarMember(archive: Buffer, name: string): Buffer {
  const retained = tarMembers(archive).filter((member) => member.name !== name);
  return Buffer.concat([...retained.map((member) => member.raw), Buffer.alloc(1024)]);
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
}

async function responseBody(response: APIResponse): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function waitForVolume(request: APIRequestContext, id: string): Promise<any> {
  let volume: any;
  await expect.poll(async () => {
    const response = await request.get(`/api/volumes/${id}`);
    volume = await response.json();
    return volume.operation?.stage;
  }, { timeout: 180_000, intervals: [500, 1000, 2000] }).toMatch(/complete|failed/);
  expect(volume.operation, JSON.stringify(volume)).toMatchObject({ stage: "complete" });
  return volume;
}

async function exportWorker(request: APIRequestContext, workerId: string, includeManagedVolumes?: boolean): Promise<Buffer> {
  const suffix = includeManagedVolumes === undefined
    ? ""
    : `&includeManagedVolumes=${includeManagedVolumes ? "true" : "false"}`;
  const response = await request.get(`/api/containers/${workerId}/export?includeRootfs=false${suffix}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.body();
}

async function importWorker(request: APIRequestContext, bundle: Buffer, displayName: string): Promise<any> {
  const response = await request.post(`/api/containers/import?displayName=${encodeURIComponent(displayName)}`, {
    headers: { "Content-Type": "application/x-tar" },
    data: bundle,
    timeout: 300_000,
  });
  expect(response.status(), await response.text()).toBe(201);
  const worker = await response.json();
  await waitForWorkerRunning(request, worker.id, 120_000);
  return worker;
}

async function storage(request: APIRequestContext, workerId: string): Promise<any> {
  const response = await request.get(`/api/containers/${workerId}/storage`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

function populatePortableData(containerName: string): void {
  const script = String.raw`import hashlib,json,os,pathlib,sys
a=pathlib.Path('/home/agent/portable-a'); b=pathlib.Path('/home/agent/portable-b')
(a/'nested').mkdir(parents=True,exist_ok=True); b.mkdir(parents=True,exist_ok=True)
payload=bytes(range(256))*16
(a/'nested'/'payload.bin').write_bytes(payload)
(a/'nested'/('long-'+('segment-'*20)+'payload.bin')).write_bytes(b'long-path-data')
os.chmod(a/'nested',0o751); os.chown(a/'nested',234,345)
os.chmod(a/'nested'/'payload.bin',0o640); os.chown(a/'nested'/'payload.bin',123,456)
for p in [a/'nested'/'relative-link',a/'nested'/'absolute-link',a/'nested'/'hard-link']:
 try: p.unlink()
 except FileNotFoundError: pass
os.symlink('payload.bin',a/'nested'/'relative-link')
os.symlink('/home/agent/portable-a/nested/payload.bin',a/'nested'/'absolute-link')
os.link(a/'nested'/'payload.bin',a/'nested'/'hard-link')
(b/'notes.txt').write_text('second portable volume\n',encoding='utf8')
os.chmod(b/'notes.txt',0o604); os.chown(b/'notes.txt',321,654)`;
  docker("exec", "--user", "0:0", containerName, "python3", "-c", script);
}

function portableDataSnapshot(containerName: string): any {
  const script = String.raw`import hashlib,json,os,pathlib,stat
a=pathlib.Path('/home/agent/portable-a/nested'); f=a/'payload.bin'; h=a/'hard-link'; s=a/'relative-link'; absolute=a/'absolute-link'; long_file=a/('long-'+('segment-'*20)+'payload.bin'); b=pathlib.Path('/home/agent/portable-b/notes.txt')
fs=os.stat(f); hs=os.stat(h); ds=os.stat(a); bs=os.stat(b)
print(json.dumps({'payloadSha256':hashlib.sha256(f.read_bytes()).hexdigest(),'longPathSha256':hashlib.sha256(long_file.read_bytes()).hexdigest(),'payloadMode':stat.S_IMODE(fs.st_mode),'payloadUid':fs.st_uid,'payloadGid':fs.st_gid,'directoryMode':stat.S_IMODE(ds.st_mode),'directoryUid':ds.st_uid,'directoryGid':ds.st_gid,'hardlinkSameInode':fs.st_ino==hs.st_ino,'hardlinkCount':fs.st_nlink,'symlinkTarget':os.readlink(s),'absoluteSymlinkTarget':os.readlink(absolute),'secondText':b.read_text(encoding='utf8'),'secondMode':stat.S_IMODE(bs.st_mode),'secondUid':bs.st_uid,'secondGid':bs.st_gid}))`;
  return JSON.parse(docker("exec", "--user", "0:0", containerName, "python3", "-c", script));
}

async function waitForBackupJob(request: APIRequestContext, jobId: string): Promise<any> {
  let job: any;
  await expect.poll(async () => {
    const response = await request.get(`/api/backup-jobs/${jobId}`);
    job = await response.json();
    return job.status;
  }, { timeout: 300_000, intervals: [500, 1000, 2000] }).toMatch(/succeeded|failed|cancelled/);
  return job;
}

test.describe.serial("Portable managed-volume API acceptance", () => {
  test.skip(!existsSync("/src/orchestrator"), "Requires the isolated Docker test runner");
  test.describe.configure({ timeout: 600_000 });

  let owner: CreatedUser;
  let ownerRequest: APIRequestContext;
  let environmentId = "";
  let source: Awaited<ReturnType<typeof createWorker>>;
  let runningBundle: Buffer;
  const workerIds = new Set<string>();
  const archivedWorkerIds = new Set<string>();
  const volumeIds = new Set<string>();

  test.beforeAll(async () => {
    owner = await createTestUser("Portable volume owner");
    ownerRequest = await playwrightRequest.newContext(EMPTY_AUTH);
    expect((await new ApiClient(ownerRequest).signInEmail(owner.email, owner.password)).status).toBe(200);
    const environment = await new ApiClient(ownerRequest).createEnvironment({
      name: `Portable volumes ${Date.now()}`,
      dockerEnabled: false,
    });
    expect(environment.status, JSON.stringify(environment.body)).toBe(201);
    environmentId = environment.body.id;
    source = await createWorker(ownerRequest, {
      displayName: `portable-source-${Date.now()}`,
      environmentId,
    });
    workerIds.add(source.id);

    for (const [target, name] of [
      ["/home/agent/portable-a", "Portable A"],
      ["/home/agent/portable-b", "Portable B"],
    ]) {
      const response = await ownerRequest.post(`/api/containers/${source.id}/storage`, {
        data: { action: "add", target, name, mode: "recreate" },
      });
      expect(response.status(), await response.text()).toBe(200);
      const volume = await response.json();
      volumeIds.add(volume.id);
      await waitForVolume(ownerRequest, volume.id);
    }
    populatePortableData(source.containerName);
    const policy = await ownerRequest.post(`/api/containers/${source.id}/storage`, {
      data: { action: "policy", policy: { selfService: true, allowSelfRecreate: true, allowLiveMount: true } },
    });
    expect(policy.status(), await policy.text()).toBe(200);
  });

  test.afterAll(async () => {
    for (const workerId of [...workerIds].reverse())
      await cleanupWorker(ownerRequest, workerId).catch(() => {});
    for (const workerId of archivedWorkerIds)
      await new ApiClient(ownerRequest).deleteArchivedWorker(workerId).catch(() => {});
    for (const volumeId of volumeIds)
      await ownerRequest.post(`/api/volumes/${volumeId}`, { data: { action: "delete", confirmed: true } }).catch(() => {});
    if (environmentId) await ownerRequest.delete(`/api/environments/${environmentId}`).catch(() => {});
    await ownerRequest?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("running opt-in round trip preserves two volumes, metadata, safe links, and mints fresh authority", async () => {
    const before = portableDataSnapshot(source.containerName);
    const sourceStorage = await storage(ownerRequest, source.id);
    const sourceInspection = JSON.parse(docker("inspect", source.containerName))[0];
    const sourceMountNames = sourceInspection.Mounts
      .filter((mount: any) => ["/home/agent/portable-a", "/home/agent/portable-b"].includes(mount.Destination))
      .map((mount: any) => mount.Name);
    expect(sourceMountNames).toHaveLength(2);

    runningBundle = await exportWorker(ownerRequest, source.id, true);
    const manifest = JSON.parse(tarMember(runningBundle, "manifest.json").toString("utf8"));
    expect(manifest).toMatchObject({
      version: 6,
      contents: { managedVolumes: true },
      managedVolumes: [
        { target: "/home/agent/portable-a", name: "Portable A", archive: "volumes/0.tar" },
        { target: "/home/agent/portable-b", name: "Portable B", archive: "volumes/1.tar" },
      ],
    });
    expect(tarMembers(runningBundle).map((member) => member.name)).toContain("managed-volumes.tar.gz");
    expect(manifest.localPersistence).toEqual(expect.arrayContaining([
      { path: "/home/agent/portable-a", included: true },
      { path: "/home/agent/portable-b", included: true },
    ]));
    const bundleText = runningBundle.toString("latin1");
    for (const privateIdentity of [
      ...sourceStorage.volumes.map((volume: any) => volume.id),
      ...sourceMountNames,
    ]) expect(bundleText).not.toContain(privateIdentity);
    expect(portableDataSnapshot(source.containerName)).toEqual(before);

    const imported = await importWorker(ownerRequest, runningBundle, "portable-running-import");
    workerIds.add(imported.id);
    const importedStorage = await storage(ownerRequest, imported.id);
    for (const volume of importedStorage.volumes) volumeIds.add(volume.id);
    expect(importedStorage.policy).toEqual({
      userId: owner.id,
      workerId: imported.id,
      selfService: false,
      allowSelfRecreate: false,
      allowLiveMount: false,
    });
    expect(importedStorage.volumes.map((volume: any) => ({
      target: volume.target, name: volume.name, purpose: volume.purpose,
      attached: volume.attached, state: volume.state,
    }))).toEqual([
      { target: "/home/agent/portable-a", name: "Portable A", purpose: "persistent-path", attached: true, state: "ready" },
      { target: "/home/agent/portable-b", name: "Portable B", purpose: "persistent-path", attached: true, state: "ready" },
    ]);
    expect(importedStorage.volumes.map((volume: any) => volume.id)).not.toEqual(sourceStorage.volumes.map((volume: any) => volume.id));
    expect(portableDataSnapshot(imported.containerName)).toEqual(before);

    const importedInspection = JSON.parse(docker("inspect", imported.containerName))[0];
    const importedMounts = importedInspection.Mounts.filter((mount: any) =>
      ["/home/agent/portable-a", "/home/agent/portable-b"].includes(mount.Destination));
    expect(importedMounts).toHaveLength(2);
    expect(importedMounts.map((mount: any) => mount.Name)).not.toEqual(sourceMountNames);
    const physical = importedMounts.map((mount: any) => JSON.parse(docker("volume", "inspect", mount.Name))[0]);
    expect(new Set(physical.map((volume: any) => volume.Labels["agentor.portable-import-id"])).size).toBe(1);
    for (const volume of physical) {
      const record = importedStorage.volumes.find((candidate: any) => candidate.target ===
        importedMounts.find((mount: any) => mount.Name === volume.Name)?.Destination);
      expect(volume).toMatchObject({ Name: `agentor-persist-${record.id}`, Driver: "local" });
      expect(volume.Options ?? {}).toEqual({});
      expect(volume.Labels).toMatchObject({
        "agentor.volume-id": record.id,
        "agentor.owner-id": owner.id,
        "agentor.worker-id": imported.id,
      });
      expect(volume.Labels["agentor.portable-import-id"]).toEqual(expect.any(String));
    }
  });

  test("stopped opt-in capture restores the same data without starting or changing the source", async () => {
    const beforeData = portableDataSnapshot(source.containerName);
    const beforeContainer = JSON.parse(docker("inspect", source.containerName))[0];
    expect((await new ApiClient(ownerRequest).stopContainer(source.id)).status).toBe(200);
    const stopped = JSON.parse(docker("inspect", source.containerName))[0];
    expect(stopped.State.Running).toBe(false);
    const bundle = await exportWorker(ownerRequest, source.id, true);
    expect(JSON.parse(tarMember(bundle, "manifest.json").toString("utf8"))).toMatchObject({
      version: 6,
      contents: { managedVolumes: true },
    });
    const afterCapture = JSON.parse(docker("inspect", source.containerName))[0];
    expect(afterCapture.Id).toBe(beforeContainer.Id);
    expect(afterCapture.State.Running).toBe(false);
    const imported = await importWorker(ownerRequest, bundle, "portable-stopped-import");
    workerIds.add(imported.id);
    const importedStorage = await storage(ownerRequest, imported.id);
    for (const volume of importedStorage.volumes) volumeIds.add(volume.id);
    expect(portableDataSnapshot(imported.containerName)).toEqual(beforeData);
    expect((await new ApiClient(ownerRequest).restartContainer(source.id)).status).toBe(200);
    await waitForWorkerRunning(ownerRequest, source.id, 120_000);
    expect(portableDataSnapshot(source.containerName)).toEqual(beforeData);
  });

  test("legacy default export stays v5 and extract-repack-import never gains portable fields", async () => {
    const legacy = await exportWorker(ownerRequest, source.id);
    const firstManifest = JSON.parse(tarMember(legacy, "manifest.json").toString("utf8"));
    expect(firstManifest.version).toBe(5);
    expect(firstManifest.contents).not.toHaveProperty("managedVolumes");
    expect(firstManifest).not.toHaveProperty("managedVolumes");
    expect(tarMembers(legacy).map((member) => member.name)).not.toContain("managed-volumes.tar.gz");

    const imported = await importWorker(ownerRequest, legacy, "portable-legacy-repack");
    workerIds.add(imported.id);
    const repacked = await exportWorker(ownerRequest, imported.id);
    const secondManifest = JSON.parse(tarMember(repacked, "manifest.json").toString("utf8"));
    expect(secondManifest.version).toBe(5);
    expect(secondManifest.contents).not.toHaveProperty("managedVolumes");
    expect(secondManifest).not.toHaveProperty("managedVolumes");
    expect(tarMembers(repacked).map((member) => member.name)).not.toContain("managed-volumes.tar.gz");
  });

  test("destination probe creates and removes a never-started configless imported image container", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-configless-portable-probe-"));
    const rootfs = join(dir, "rootfs");
    const archive = join(dir, "rootfs.tar");
    const image = `agentor-portable-configless-probe:${randomUUID()}`;
    const helperFilter = `label=${PORTABLE_VOLUME_HELPER_LABEL}=true`;
    let probeInspection: any;
    let probeId = "";
    let starts = 0;
    try {
      await mkdir(join(rootfs, "home", "agent"), { recursive: true });
      await writeFile(join(rootfs, "home", "agent", "marker"), "configless\n");
      execFileSync("tar", ["-C", rootfs, "-cf", archive, "."], { timeout: 60_000 });
      docker("import", archive, image);
      const imageInspection = JSON.parse(docker("image", "inspect", image))[0];
      expect(imageInspection.Config.Entrypoint ?? []).toEqual([]);
      expect(imageInspection.Config.Cmd ?? []).toEqual([]);

      const helpersBefore = docker("ps", "-aq", "--filter", helperFilter);
      const runtime = new PortableManagedVolumeRuntime(join(dir, "runtime"));
      const actualDocker = (runtime as any).docker;
      const createContainer = actualDocker.createContainer.bind(actualDocker);
      actualDocker.createContainer = async (options: any) => {
        const container = await createContainer(options);
        probeId = container.id;
        probeInspection = await container.inspect();
        const start = container.start.bind(container);
        container.start = async (...args: any[]) => { starts += 1; return start(...args); };
        return container;
      };

      await (runtime as any).validateImageTargetsWithProbe(
        { image, userId: owner.id, workerId: source.id },
        randomUUID(),
        [{ target: "/home/agent/portable-probe" }],
      );
      expect(probeInspection).toMatchObject({
        Config: {
          Image: image,
          Entrypoint: ["/bin/true"],
          NetworkDisabled: true,
        },
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 8,
          Memory: 64 * 1024 * 1024,
          NanoCpus: 250_000_000,
        },
        State: { Running: false },
        Mounts: [],
      });
      expect(probeInspection.Config.Cmd ?? []).toEqual([]);
      expect(starts).toBe(0);
      expect(docker("ps", "-aq", "--filter", helperFilter)).toBe(helpersBefore);
    } finally {
      if (probeId) try { docker("rm", "-f", probeId); } catch {}
      try { docker("image", "rm", "-f", image); } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("archived backup opt-in restores managed data while the original remains archived", async () => {
    const archived = await createWorker(ownerRequest, {
      displayName: `portable-archived-${Date.now()}`,
      environmentId,
    });
    let restoredId = "";
    const add = await ownerRequest.post(`/api/containers/${archived.id}/storage`, {
      data: { action: "add", target: "/home/agent/portable-archived", name: "Archived data", mode: "recreate" },
    });
    expect(add.status(), await add.text()).toBe(200);
    const archivedVolume = await add.json(); volumeIds.add(archivedVolume.id);
    await waitForVolume(ownerRequest, archivedVolume.id);
    docker("exec", archived.containerName, "python3", "-c",
      "from pathlib import Path; p=Path('/home/agent/portable-archived'); (p/'marker').write_text('archived-volume-data')");
    expect((await new ApiClient(ownerRequest).archiveContainer(archived.id)).status).toBe(200);
    archivedWorkerIds.add(archived.id);

    const provider = await ownerRequest.post("/api/backup-providers/fake/connect", {
      data: { testMode: true, chunkSize: 64 * 1024 },
    });
    expect([200, 201, 409]).toContain(provider.status());
    const start = await ownerRequest.post("/api/backups", {
      data: { workspaceIds: [archived.id], providerId: "fake", includeManagedVolumes: true },
    });
    expect(start.status(), await start.text()).toBe(202);
    const backup = await waitForBackupJob(ownerRequest, (await start.json()).id);
    expect(backup.status, backup.error).toBe("succeeded");
    expect(backup.includeManagedVolumes).toBe(true);
    const restoreResponse = await ownerRequest.post(`/api/backups/${backup.backupId}/restore`, {
      data: { target: "new" },
    });
    expect(restoreResponse.status(), await restoreResponse.text()).toBe(202);
    const restore = await waitForBackupJob(ownerRequest, (await restoreResponse.json()).jobId);
    expect(restore.status, restore.error).toBe("succeeded");
    restoredId = restore.workerId;
    workerIds.add(restoredId);
    await waitForWorkerRunning(ownerRequest, restoredId, 120_000);
    const restored = (await new ApiClient(ownerRequest).listContainers()).body.find((worker: any) => worker.id === restoredId);
    expect(docker("exec", restored.containerName, "cat", "/home/agent/portable-archived/marker")).toBe("archived-volume-data");
    const restoredStorage = await storage(ownerRequest, restoredId);
    for (const volume of restoredStorage.volumes) volumeIds.add(volume.id);
    expect(restoredStorage.policy).toMatchObject({ selfService: false, allowSelfRecreate: false, allowLiveMount: false });
    const archivedInventory = await (await ownerRequest.get("/api/workspaces")).json();
    expect(archivedInventory.find((entry: any) => entry.workerId === archived.id)?.state).toBe("archived");
  });

  test("strict agreement and authorization fail before creating destination workers", async () => {
    const invalidFlag = await ownerRequest.get(`/api/containers/${source.id}/export?includeRootfs=false&includeManagedVolumes=1`);
    expect(invalidFlag.status()).toBe(400);

    const anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    const outsider = await createTestUser("Portable volume outsider");
    const outsiderRequest = await playwrightRequest.newContext(EMPTY_AUTH);
    try {
      expect((await anonymous.get(`/api/containers/${source.id}/export?includeManagedVolumes=true`)).status()).toBe(401);
      expect((await new ApiClient(outsiderRequest).signInEmail(outsider.email, outsider.password)).status).toBe(200);
      expect((await outsiderRequest.get(`/api/containers/${source.id}/export?includeManagedVolumes=true`)).status()).toBe(403);

      const before = (await new ApiClient(ownerRequest).listContainers()).body.map((worker: any) => worker.id).sort();
      const missingPayload = withoutTarMember(runningBundle, "managed-volumes.tar.gz");
      const rejected = await ownerRequest.post("/api/containers/import?displayName=must-not-exist", {
        headers: { "Content-Type": "application/x-tar" },
        data: missingPayload,
      });
      expect(rejected.status(), JSON.stringify(await responseBody(rejected))).toBe(400);
      const after = (await new ApiClient(ownerRequest).listContainers()).body.map((worker: any) => worker.id).sort();
      expect(after).toEqual(before);
    } finally {
      await anonymous.dispose();
      await outsiderRequest.dispose();
      await deleteTestUser(outsider.id).catch(() => {});
    }
  });
});

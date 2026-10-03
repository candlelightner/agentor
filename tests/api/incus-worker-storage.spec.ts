import { test, expect } from "@playwright/test";
import { IncusWorkerStorage } from "../../orchestrator/server/utils/incus-worker-storage";
import type { Config } from "../../orchestrator/server/utils/config";

const owner = { id: "worker", userId: "owner", containerName: "agentor-worker-worker" };
const config = { containerPrefix: "agentor-worker", incusProject: "agentor", incusStoragePool: "pool",
  incusDockerVolumeSize: "4GiB" } as Config;

function fixture() {
  const volumes = new Map<string, any>();
  const writes: string[] = [];
  const client = {
    endpoint: "https://incus.invalid",
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes.has(name)) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return structuredClone(volumes.get(name));
    },
    createCustomVolume: async (_pool: string, spec: any) => {
      writes.push(`create:${spec.name}`);
      volumes.set(spec.name, { ...spec, type: "custom", used_by: [] });
    },
    updateCustomVolume: async (_pool: string, name: string, value: any) => { volumes.get(name).config = value; },
    deleteCustomVolume: async (_pool: string, name: string) => { writes.push(`delete:${name}`); volumes.delete(name); },
  };
  return { volumes, writes, storage: new IncusWorkerStorage(client as any, config, "installation") };
}

test("filesystem persistence is separate from disposable root and Docker capability", async () => {
  const { storage, volumes } = fixture();
  const devices = await storage.devices(owner, false);
  expect(devices.workspace).toEqual({ type: "disk", pool: "pool", source: `${owner.containerName}-workspace`, path: "/workspace" });
  expect(devices.agents.path).toBe("/home/agent/.agent-data");
  expect(devices.docker).toBeUndefined();
  expect(volumes.size).toBe(2);
});

test("Docker block storage remains on disable and is reused on re-enable", async () => {
  const { storage, volumes, writes } = fixture();
  const devices = await storage.devices(owner, true);
  const block = volumes.get(`${owner.containerName}-docker`);
  expect(block.content_type).toBe("block");
  expect(block.config.size).toBe("4GiB");
  expect(await storage.dockerInitializationAllowed(owner)).toBe(true);
  await storage.markDockerInitialized(owner);
  expect(await storage.dockerInitializationAllowed(owner)).toBe(false);
  expect((await storage.devices(owner, false)).docker).toEqual(devices.docker);
  expect((await storage.devices(owner, true)).docker).toEqual(devices.docker);
  expect(writes).toHaveLength(3);
});

test("foreign volume ownership fails closed without creating or deleting data", async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, true);
  volumes.get(`${owner.containerName}-agents`).config["user.agentor.installation"] = "foreign";
  writes.length = 0;
  await expect(storage.devices(owner, true)).rejects.toThrow("ownership/type");
  await expect(storage.remove(owner)).rejects.toThrow("ownership/type");
  expect(writes).toEqual([]);
});

test("an active attachment on another instance or project cannot be shared", async () => {
  const { storage, volumes } = fixture();
  await storage.devices(owner, true);
  const block = volumes.get(`${owner.containerName}-docker`);
  for (const ref of ["/1.0/instances/foreign?project=agentor", `/1.0/instances/${owner.containerName}?project=foreign`]) {
    block.used_by = [ref];
    await expect(storage.devices(owner, true)).rejects.toThrow("another runtime");
  }
  block.used_by = [`/1.0/instances/${owner.containerName}?project=agentor`];
  await storage.devices(owner, true);
  await expect(storage.remove(owner)).rejects.toThrow("attached");
});

test("permanent deletion removes only detached core worker-owned volumes", async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, true);
  volumes.set("managed-shared", { name: "managed-shared" });
  await storage.remove(owner);
  expect([...volumes.keys()]).toEqual(["managed-shared"]);
  expect(writes.filter((op) => op.startsWith("delete:"))).toHaveLength(3);
  await storage.remove(owner);
});

test("mismatched worker names and filesystem/block types are rejected", async () => {
  const { storage, volumes } = fixture();
  await expect(storage.devices({ ...owner, containerName: "foreign" }, true)).rejects.toThrow("identity");
  await storage.devices(owner, true);
  volumes.get(`${owner.containerName}-docker`).content_type = "filesystem";
  await expect(storage.devices(owner, true)).rejects.toThrow("ownership/type");
});

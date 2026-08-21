import { expect, test } from "@playwright/test";
import { ContainerManager } from "../../orchestrator/server/utils/container";

test("managed runtimes without authoritative worker records stay quarantined", async () => {
  const errors: string[] = [];
  (globalThis as any).useLogger = () => ({
    error(message: string) { errors.push(message); },
    warn() {},
    info() {},
    debug() {},
  });
  const docker = {
    listContainers: async () => [{
      Id: "docker-container-id",
      Names: ["/agentor-worker-worker-missing"],
      Image: "agentor-worker:latest",
      ImageID: "sha256:image",
      State: "running",
      Labels: { "agentor.id": "worker-missing" },
    }],
  };
  const manager = new ContainerManager(
    docker as any,
    { containerPrefix: "agentor-worker" } as any,
  );
  manager.setWorkerStore({
    list: () => [],
    findById: () => undefined,
  } as any);

  await manager.sync();

  expect(manager.list()).toEqual([]);
  expect(errors).toEqual([
    expect.stringContaining("authoritative worker record worker-missing is unavailable"),
  ]);
});

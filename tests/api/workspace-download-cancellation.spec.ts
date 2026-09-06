import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "@playwright/test";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { withOperationDeadline } from "../../orchestrator/server/utils/operation-deadline";
import { requestCancellation } from "../../orchestrator/server/utils/request-cancellation";
import { cleanupStaleDockerHelpers } from "../../orchestrator/server/utils/storage-visibility";
import { packBundle } from "../../orchestrator/server/utils/worker-export";
import { demuxSingleFileFromTar } from "../../orchestrator/server/utils/workspace-zip";
import { registerOperationHelper } from "../../orchestrator/server/utils/operation-helper-registry";

function cancellableEvent() {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  return { event: { node: { req, res } } as any, req, res };
}

test("a disconnect during workspace-download preparation cancels the bounded Docker operation", async () => {
  const { event, req } = cancellableEvent();
  const cancellation = requestCancellation(event);
  let resolveUnderlying!: () => void;
  const underlying = new Promise<void>((resolve) => { resolveUnderlying = resolve; });
  const preparation = withOperationDeadline(
    underlying,
    5_000,
    "Docker workspace-helper creation",
    cancellation.signal,
  );

  req.emit("aborted");

  await expect(preparation).rejects.toMatchObject({
    code: "OPERATION_ABORTED",
    statusCode: 499,
    data: { operation: "Docker workspace-helper creation", retryable: true },
  });
  expect(cancellation.signal.aborted).toBe(true);
  // The late Docker completion is deliberately observed by the deadline
  // wrapper, rather than becoming an unhandled rejection after cancellation.
  resolveUnderlying();
  cancellation.detach();
});

test("Docker operation deadlines return structured safe timeout diagnostics", async () => {
  await expect(
    withOperationDeadline(
      new Promise<void>(() => {}),
      10,
      "Docker worker inspection",
    ),
  ).rejects.toMatchObject({
    code: "DOCKER_OPERATION_TIMEOUT",
    statusCode: 504,
    data: {
      operation: "Docker worker inspection",
      timeoutMs: 10,
      retryable: true,
    },
  });
});

test("a signal aborted before deadline setup rejects immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    withOperationDeadline(
      Promise.resolve(),
      5_000,
      "Docker workspace-helper start",
      controller.signal,
    ),
  ).rejects.toMatchObject({
    code: "OPERATION_ABORTED",
    statusCode: 499,
    data: { operation: "Docker workspace-helper start", retryable: true },
  });
});

test("response-close cancellation covers streaming and detaches after finalization", () => {
  const streaming = cancellableEvent();
  const cancellation = requestCancellation(streaming.event);
  streaming.res.emit("close");
  expect(cancellation.signal.aborted).toBe(true);

  const finalized = cancellableEvent();
  const finalizedCancellation = requestCancellation(finalized.event);
  finalized.res.writableEnded = true;
  finalized.res.emit("close");
  expect(finalizedCancellation.signal.aborted).toBe(false);
  finalizedCancellation.detach();
  finalized.req.emit("aborted");
  expect(finalizedCancellation.signal.aborted).toBe(false);
});

test("streaming cancellation destroys both the response and Docker tar source", async () => {
  const controller = new AbortController();
  const dockerTar = new PassThrough();
  const response = demuxSingleFileFromTar(dockerTar, 1, controller.signal);
  const closed = new Promise<void>((resolve) => response.once("close", resolve));

  controller.abort();
  await closed;

  expect(response.destroyed).toBe(true);
  expect(dockerTar.destroyed).toBe(true);
});

test("an abort racing with archive materialization is replayed to the new streams", async () => {
  const controller = new AbortController();
  controller.abort();
  const dockerTar = new PassThrough();
  const response = demuxSingleFileFromTar(dockerTar, 1, controller.signal);
  await new Promise<void>((resolve) => response.once("close", resolve));

  expect(response.destroyed).toBe(true);
  expect(dockerTar.destroyed).toBe(true);
});

test("the worker-card workspace download forwards cancellation into Docker archive preparation", async () => {
  const controller = new AbortController();
  const dockerTar = new PassThrough();
  const info = {
    id: "worker-1",
    containerId: "docker-1",
    status: "running",
  };
  let receivedSignal: AbortSignal | undefined;
  const manager = {
    containers: new Map([[info.id, info]]),
    assertRunning: (id: string) => {
      expect(id).toBe(info.id);
      return info;
    },
    dockerService: {
      getWorkspaceArchive: async (
        containerId: string,
        signal?: AbortSignal,
      ) => {
        expect(containerId).toBe("docker-1");
        receivedSignal = signal;
        return dockerTar;
      },
    },
  };

  await expect(
    (ContainerManager.prototype as any).downloadWorkspace.call(
      manager,
      info.id,
      controller.signal,
    ),
  ).resolves.toBe(dockerTar);
  expect(receivedSignal).toBe(controller.signal);
});

test("finalization cancellation closes the active staging-file stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-export-finalize-"));
  const staged = join(dir, "large-staging-file");
  await writeFile(staged, Buffer.alloc(8 * 1024 * 1024, 0x61));
  try {
    const bundle = packBundle([{ name: "payload", path: staged }]);
    const closed = new Promise<void>((resolve) => bundle.once("close", resolve));
    bundle.once("data", () => bundle.destroy());
    bundle.resume();

    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("bundle cancellation did not settle")), 2_000),
      ),
    ]);
    expect(bundle.destroyed).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale-helper cleanup times out each helper independently and a retry remains usable", async () => {
  const stale = new Set(["stale-fast", "stale-slow", "stale-running"]);
  const removeCalls: string[] = [];
  let listCalls = 0;
  let slowAttempts = 0;
  const docker = {
    listContainers: async () => {
      listCalls++;
      return [
      ...["stale-fast", "stale-slow"].filter((id) => stale.has(id)).map((Id) => ({ Id, Names: [`/agentor-workspace-reader-${Id}`], State: "exited" })),
      ...["stale-running"].filter((id) => stale.has(id)).map((Id) => ({
        Id,
        Names: [`/agentor-workspace-reader-${Id}`],
        State: "running",
        Labels: { "agentor.helper.operation-id": Id },
      })),
      {
        Id: "active-helper",
        Names: ["/agentor-workspace-reader-active-helper"],
        State: "running",
        Created: Math.floor(Date.now() / 1000),
        Labels: { "agentor.helper.operation-id": "active-operation" },
      },
      ];
    },
    getContainer: (id: string) => ({
      remove: async () => {
        removeCalls.push(id);
        if (id === "stale-slow" && ++slowAttempts === 1)
          return new Promise<void>(() => {});
        stale.delete(id);
      },
    }),
  };

  const releaseActive = registerOperationHelper("active-operation");
  const first = await cleanupStaleDockerHelpers(docker as any, 200);
  expect(listCalls).toBe(2);
  expect(first).toEqual({
    attempted: 3,
    removed: 2,
    failures: [{ helperName: "agentor-workspace-reader-stale-slow", code: "DOCKER_OPERATION_TIMEOUT" }],
  });
  expect(removeCalls).toEqual(expect.arrayContaining([
    "stale-fast",
    "stale-slow",
    "stale-running",
  ]));
  expect(removeCalls).not.toContain("active-helper");

  // A timed-out helper does not poison the cleanup path: it can be retried,
  // and a subsequent sweep is idempotently empty.
  await expect(cleanupStaleDockerHelpers(docker as any, 200)).resolves.toEqual({
    attempted: 1,
    removed: 1,
    failures: [],
  });
  await expect(cleanupStaleDockerHelpers(docker as any, 200)).resolves.toEqual({
    attempted: 0,
    removed: 0,
    failures: [],
  });
  releaseActive();
});

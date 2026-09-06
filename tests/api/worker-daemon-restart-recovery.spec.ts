import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import {
  cleanupWorker,
  createWorker,
  waitForWorkerRunning,
} from "../helpers/worker-lifecycle";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
} from "../global-setup";

const run = promisify(execFile);
const IS_ISOLATED_DIND = existsSync("/opt/test-stack/stack.yml");

async function command(file: string, args: string[], timeout = 5_000) {
  return run(file, args, { timeout, maxBuffer: 1024 * 1024 });
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

/** Restart only the test-runner's nested daemon. The Playwright process runs
 * outside that daemon, so it remains alive while all inner containers stop.
 * Production Docker/containerd is never addressed by this test. */
async function restartIsolatedDockerDaemon() {
  const { stdout } = await command("pgrep", ["-xo", "dockerd"]);
  const pid = Number(stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("Could not resolve the isolated dockerd process");
  process.kill(pid, "SIGTERM");
  await waitUntil(
    async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    45_000,
    "The isolated dockerd did not stop cleanly",
  );

  const logFd = openSync("/var/log/dockerd-restart-test.log", "a", 0o600);
  try {
    const daemon = spawn("dockerd", [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    daemon.unref();
  } finally {
    closeSync(logFd);
  }
  await waitUntil(
    async () => {
      await command("docker", ["info"], 2_000);
      return true;
    },
    60_000,
    "The isolated dockerd did not become ready after restart",
  );
}

test.describe.serial("worker convergence after a Docker daemon restart", () => {
  test.skip(!IS_ISOLATED_DIND, "requires the disposable Docker-in-Docker test runner");

  test("secret-bearing desired workers wait for Agentor and stopped workers remain stopped", async ({ request }) => {
    test.setTimeout(300_000);
    const groupResponse = await request.post("/api/worker-groups", {
      data: { name: `daemon-restart-${Date.now()}` },
    });
    expect(groupResponse.status()).toBe(201);
    const group = await groupResponse.json();
    const secretKey = `DAEMON_RESTART_${Date.now()}`;
    const secretValue = `runtime-${randomUUID()}`;
    let managedWorkerId = "";
    let stoppedWorkerId = "";
    try {
      const configured = await request.put(
        `/api/worker-groups/${group.id}/env-var-keys`,
        { data: { entries: [{ key: secretKey, value: secretValue }] } },
      );
      expect(configured.status()).toBe(200);
      expect(JSON.stringify(await configured.json())).not.toContain(secretValue);

      const managed = await createWorker(request, {
        displayName: `daemon-managed-${Date.now()}`,
        workerGroupId: group.id,
      });
      managedWorkerId = managed.id;
      const stopped = await createWorker(request, {
        displayName: `daemon-stopped-${Date.now()}`,
      });
      stoppedWorkerId = stopped.id;
      const api = new ApiClient(request);
      expect((await api.stopContainer(stoppedWorkerId)).status).toBe(200);

      const managedName = `agentor-worker-${managedWorkerId}`;
      expect(
        (await command("docker", ["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", managedName])).stdout.trim(),
      ).toBe("no");
      const before = await api.listContainers();
      expect(before.body.find((item: any) => item.id === managedWorkerId)).toMatchObject({
        status: "running",
        desiredRuntimeStatus: "running",
      });
      expect(before.body.find((item: any) => item.id === stoppedWorkerId)).toMatchObject({
        status: "stopped",
        desiredRuntimeStatus: "stopped",
      });

      // Simulate a pre-migration runtime from the incident. Docker will start
      // it directly after the daemon returns, with an empty tmpfs and no
      // secret-handshake marker. Agentor must not accept a successful
      // `docker exec true` as proof that this runtime was bootstrapped.
      await command("docker", [
        "update",
        "--restart=unless-stopped",
        managedName,
      ]);

      await restartIsolatedDockerDaemon();
      await waitUntil(
        async () => (await request.get("/api/health", { timeout: 2_000 })).status() === 200,
        120_000,
        "The orchestrator did not return after the daemon restart",
      );
      // Reauthenticate against the restarted server instead of assuming its
      // previous session cookie remains current.
      expect(
        (await new ApiClient(request).signInEmail(
          TEST_ADMIN_EMAIL,
          TEST_ADMIN_PASSWORD,
        )).status,
      ).toBe(200);
      await waitForWorkerRunning(request, managedWorkerId, 120_000);

      const after = await api.listContainers();
      expect(after.body.find((item: any) => item.id === managedWorkerId)).toMatchObject({
        status: "running",
        desiredRuntimeStatus: "running",
      });
      expect(after.body.find((item: any) => item.id === stoppedWorkerId)).toMatchObject({
        status: "stopped",
        desiredRuntimeStatus: "stopped",
      });
      const materializedHash = (
        await command("docker", [
          "exec",
          managedName,
          "sh",
          "-lc",
          `tmux show-environment -g ${secretKey} | sha256sum`,
        ])
      ).stdout.trim().split(/\s+/, 1)[0];
      const expectedHash = createHash("sha256")
        .update(`${secretKey}=${secretValue}\n`)
        .digest("hex");
      expect(materializedHash).toBe(expectedHash);
    } finally {
      if (managedWorkerId)
        await cleanupWorker(request, managedWorkerId).catch(() => undefined);
      if (stoppedWorkerId)
        await cleanupWorker(request, stoppedWorkerId).catch(() => undefined);
      await request.delete(`/api/worker-groups/${group.id}`).catch(() => undefined);
    }
  });
});

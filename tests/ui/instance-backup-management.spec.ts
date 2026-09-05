import { expect, test, type Page } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";

const artifact = {
  id: "instance-artifact-1",
  provider: "google-drive",
  providerObjectId: "drive-object-1",
  createdAt: "2026-08-31T12:00:00.000Z",
  size: 8_192,
  sha256: "a".repeat(64),
  keyFingerprint: `sha256:${"b".repeat(64)}`,
  sourceInstallationId: "installation-source",
  formatVersion: 1,
  integrityStatus: "verified",
  provenance: "remote-adopted",
  manifest: {
    kind: "agentor-instance-backup",
    formatVersion: 1,
    backupId: "instance-artifact-1",
    sourceInstallationId: "installation-source",
    createdAt: "2026-08-31T12:00:00.000Z",
    agentorVersion: "2.0.0",
    storage: { mode: "volume", containerPrefix: "agentor" },
    options: {
      includeWorkers: true,
      includeAgentData: true,
      includeDockerVolumes: true,
      includeLocalBackups: false,
      includeLogs: false,
    },
    volumes: [
      {
        name: "agentor-workspace-example",
        kind: "worker-workspace",
        workerId: "worker-source",
        archive: "volumes/workspace.tar.gz",
        sha256: "c".repeat(64),
        size: 4_096,
      },
    ],
    plugins: {
      platformDefinitionCount: 2,
      ownerDefinitionCount: 3,
      installationCount: 4,
    },
    hostMounts: {
      configuredPaths: ["/srv/agentor/project"],
      contentsIncluded: false,
    },
    images: {
      definitions: 5,
      immutableDigests: [`sha256:${"d".repeat(64)}`],
      layersIncluded: false,
    },
    excludedDataPaths: ["tmp"],
  },
};

const remote = {
  id: "remote-instance-1",
  provider: "google-drive",
  providerObjectId: "drive-object-remote",
  discoveredAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-09-01T00:01:00.000Z",
  state: "ready-to-adopt",
  keyFingerprint: artifact.keyFingerprint,
  keyAvailable: true,
  sourceInstallationId: "installation-source",
  formatVersion: 1,
  restorable: false,
  remote: {
    name: "agentor-instance-source.backup",
    createdAt: "2026-08-31T12:00:00.000Z",
    size: 8_192,
  },
};

async function mockInstanceBackups(page: Page) {
  await page.route("**/api/backup-providers", (route) =>
    route.fulfill({
      json: [
        { id: "local", type: "local", connected: true },
        { id: "google", type: "google-drive", connected: true },
      ],
    }),
  );
  await page.route("**/api/backups/recovery-key", (route) =>
    route.fulfill({
      json: {
        keys: [
          {
            fingerprint: artifact.keyFingerprint,
            active: true,
            source: "generated",
          },
        ],
      },
    }),
  );
  await page.route("**/api/admin/instance-backups", (route) =>
    route.fulfill({
      json: {
        jobs: [],
        artifacts: [artifact],
        remoteBackups: [remote],
        options: artifact.manifest.options,
      },
    }),
  );
  await page.route(
    "**/api/admin/instance-backups/artifacts/instance-artifact-1",
    (route) => route.fulfill({ json: artifact }),
  );
  await page.route(
    "**/api/admin/instance-backups/remote/remote-instance-1",
    (route) => route.fulfill({ json: remote }),
  );
}

async function openInstanceRecovery(page: Page) {
  await goToDashboard(page);
  await page.getByTestId("open-instance-backups").click();
  return page.getByTestId("instance-backup-management");
}

test.beforeEach(async ({ page }) => mockInstanceBackups(page));

test("starts a Google Drive instance snapshot asynchronously with explicit portable scope", async ({
  page,
}) => {
  let body: any;
  await page.route("**/api/admin/instance-backups", async (route) => {
    if (route.request().method() === "POST") {
      body = await route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: {
          accepted: true,
          jobId: "instance-create-job",
          state: "queued",
          job: {
            id: "instance-create-job",
            operation: "create",
            provider: "google-drive",
            status: "queued",
            phase: "queued",
            progress: 0,
            bytesProcessed: 0,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        jobs: [],
        artifacts: [artifact],
        remoteBackups: [remote],
        options: artifact.manifest.options,
      },
    });
  });

  const modal = await openInstanceRecovery(page);
  await modal
    .getByLabel("Instance backup destination")
    .selectOption("google-drive");
  await modal.getByLabel("Existing local worker backups").check();
  await modal.getByRole("button", { name: "Start instance backup" }).click();

  await expect.poll(() => body).toBeTruthy();
  expect(body.provider).toBe("google-drive");
  expect(body.requestId).toMatch(/^ui-instance-create-/);
  expect(body.options).toMatchObject({
    includeWorkers: true,
    includeAgentData: true,
    includeDockerVolumes: true,
    includeLocalBackups: true,
    includeLogs: false,
  });
  await expect(modal.getByTestId("instance-job-instance-create-job")).toContainText(
    "create · queued",
  );
});

test("reuses one request identity when a start response is transport-uncertain", async ({
  page,
}) => {
  const identities: string[] = [];
  const headerIdentities: string[] = [];
  let attempts = 0;
  await page.route("**/api/admin/instance-backups", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts += 1;
    const body = await route.request().postDataJSON();
    identities.push(body.requestId);
    headerIdentities.push(
      (await route.request().allHeaders())["idempotency-key"] ?? "",
    );
    if (attempts === 1)
      return route.fulfill({
        status: 504,
        json: { statusMessage: "Response delivery was uncertain" },
      });
    return route.fulfill({
      status: 202,
      json: {
        accepted: true,
        jobId: "same-durable-job",
        state: "queued",
        job: {
          id: "same-durable-job",
          operation: "create",
          provider: "local",
          status: "queued",
          phase: "queued",
          progress: 0,
          bytesProcessed: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });
  });

  const modal = await openInstanceRecovery(page);
  const start = modal.getByRole("button", { name: "Start instance backup" });
  await start.click();
  await expect(modal).toContainText("Response delivery was uncertain");
  await start.click();

  await expect.poll(() => attempts).toBe(2);
  expect(identities[0]).toMatch(/^ui-instance-create-/);
  expect(identities[1]).toBe(identities[0]);
  expect(headerIdentities).toEqual(identities);
  await expect(modal.getByTestId("instance-job-same-durable-job")).toContainText(
    "create · queued",
  );
});

test("discovers, inspects and adopts a remote instance artifact with a matching key", async ({
  page,
}) => {
  let discoveryBody: any;
  let adoptionBody: any;
  await page.route("**/api/admin/instance-backups/remote", async (route) => {
    if (route.request().method() === "POST") {
      discoveryBody = await route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: { accepted: true, jobId: "discovery-job", state: "queued" },
      });
    }
    return route.fallback();
  });
  await page.route(
    "**/api/admin/instance-backups/remote/remote-instance-1/adopt",
    async (route) => {
      adoptionBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        json: { accepted: true, jobId: "adoption-job", state: "queued" },
      });
    },
  );

  const modal = await openInstanceRecovery(page);
  await modal
    .getByLabel("Instance backup destination")
    .selectOption("google-drive");
  await modal.getByRole("button", { name: "Scan provider" }).click();
  await expect.poll(() => discoveryBody).toBeTruthy();
  expect(discoveryBody).toMatchObject({ provider: "google-drive" });
  expect(discoveryBody.requestId).toMatch(/^ui-instance-discovery-/);

  const card = modal.getByTestId("remote-instance-backup-remote-instance-1");
  await expect(card).toContainText("ready-to-adopt");
  await expect(card).toContainText("available");
  await card.getByRole("button", { name: "Inspect" }).click();
  await expect(modal.getByTestId("remote-instance-details")).toContainText(
    "installation-source",
  );
  await card.getByRole("button", { name: "Adopt and verify" }).click();
  await expect.poll(() => adoptionBody).toBeTruthy();
  expect(adoptionBody.requestId).toMatch(/^ui-instance-adoption-/);
});

test("shows plugin and external dependency inventory and requires preflight plus both restore acknowledgements", async ({
  page,
}) => {
  let preflightQueries: URLSearchParams | undefined;
  let restoreBody: any;
  await page.route(
    "**/api/admin/instance-backups/artifacts/instance-artifact-1/preflight**",
    (route) => {
      preflightQueries = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          ready: true,
          blockers: [],
          warnings: [
            "Docker image layers are not embedded. Pull immutable registry digests or rebuild custom images after restore.",
          ],
          sourceInstallationId: "installation-source",
          sourceStorageMode: "volume",
          destinationStorageMode: "volume",
          sourceContainerPrefix: "agentor",
          destinationContainerPrefix: "agentor",
          volumeConflicts: [],
          hostMountPaths: ["/srv/agentor/project"],
          imageDigestsNotEmbedded: artifact.manifest.images.immutableDigests,
        },
      });
    },
  );
  await page.route(
    "**/api/admin/instance-backups/artifacts/instance-artifact-1/restore",
    async (route) => {
      restoreBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        json: {
          accepted: true,
          jobId: "restore-instance-job",
          state: "queued",
        },
      });
    },
  );

  const modal = await openInstanceRecovery(page);
  await modal
    .getByTestId("instance-artifact-instance-artifact-1")
    .getByRole("button", { name: "Inspect & restore" })
    .click();
  const panel = modal.getByTestId("instance-restore-panel");

  await expect(panel.getByTestId("instance-manifest-summary")).toContainText(
    "2 platform + 3 scoped definitions",
  );
  await expect(panel.getByTestId("instance-manifest-summary")).toContainText(
    "4 desired installation records",
  );
  await expect(panel).toContainText(/image layers(?: are)? not embedded/i);
  await expect(panel).toContainText(/host contents not embedded/i);
  await expect(panel.getByTestId("instance-restore-preflight")).toContainText(
    "Destination is ready",
  );
  expect(preflightQueries?.get("restoreDockerVolumes")).toBe("true");
  expect(preflightQueries?.get("restoreHostMountPolicies")).toBe("false");

  const restore = panel.getByRole("button", {
    name: "Apply verified snapshot and restart Agentor",
  });
  await expect(restore).toBeDisabled();
  await panel
    .getByLabel(/current Agentor database and control-plane data/)
    .check();
  await expect(restore).toBeDisabled();
  await panel
    .getByLabel(/separately supplied or recorded required external configuration/)
    .check();
  await expect(restore).toBeEnabled();
  await restore.click();

  await expect.poll(() => restoreBody).toBeTruthy();
  expect(restoreBody.requestId).toMatch(/^ui-instance-restore-/);
  expect(restoreBody.options).toEqual({
    restoreDockerVolumes: true,
    restoreHostMountPolicies: false,
    confirmReplaceControlPlane: true,
    confirmExternalDependencies: true,
  });
});

test("renders preflight blockers and keeps destructive restore disabled", async ({
  page,
}) => {
  await page.route(
    "**/api/admin/instance-backups/artifacts/instance-artifact-1/preflight**",
    (route) =>
      route.fulfill({
        json: {
          ready: false,
          blockers: [
            "The destination installation already contains workers or administrative workspaces.",
          ],
          warnings: [],
          sourceInstallationId: "installation-source",
          sourceStorageMode: "volume",
          destinationStorageMode: "volume",
          sourceContainerPrefix: "agentor",
          destinationContainerPrefix: "agentor",
          volumeConflicts: [],
          hostMountPaths: [],
          imageDigestsNotEmbedded: [],
        },
      }),
  );

  const modal = await openInstanceRecovery(page);
  await modal
    .getByTestId("instance-artifact-instance-artifact-1")
    .getByRole("button", { name: "Inspect & restore" })
    .click();
  const panel = modal.getByTestId("instance-restore-panel");
  await expect(panel.getByTestId("instance-restore-preflight")).toContainText(
    "already contains workers",
  );
  await panel
    .getByLabel(/current Agentor database and control-plane data/)
    .check();
  await panel
    .getByLabel(/separately supplied or recorded required external configuration/)
    .check();
  await expect(
    panel.getByRole("button", {
      name: "Apply verified snapshot and restart Agentor",
    }),
  ).toBeDisabled();
});

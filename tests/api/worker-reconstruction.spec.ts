import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkerReconstruction,
  resolveWorkerReconstruction,
  snapshotWorkerReconstruction,
} from "../../orchestrator/server/utils/worker-reconstruction";
import {
  readWorkerReconstruction,
  writeWorkerReconstruction,
} from "../../orchestrator/server/utils/worker-export";

test("reconstruction payload is versioned, secret-free, and supports platform defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-reconstruction-"));
  try {
    const payload = snapshotWorkerReconstruction({}, undefined);
    payload.requiredSecretNames = ["DEPLOY_TOKEN"];
    const file = join(dir, "reconstruction.json");
    await writeWorkerReconstruction(file, payload);
    expect(await readWorkerReconstruction(file)).toEqual({
      schemaVersion: 1, image: { kind: "platform-default" }, requiredSecretNames: ["DEPLOY_TOKEN"],
    });
    expect((await readFile(file, "utf8"))).not.toContain("secret-value");
    await expect(resolveWorkerReconstruction("nobody", payload)).resolves.toEqual({ state: "platform-default" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reconstruction rejects malformed custom image identities before import", () => {
  expect(() => parseWorkerReconstruction({ schemaVersion: 1, image: { kind: "custom", definitionId: "id", version: "v1", digest: "not-a-digest", definition: {}, imageVersion: {} }, requiredSecretNames: [] })).toThrow("Invalid worker reconstruction metadata");
});

test("reconstruction canonicalizes an embedded image recipe and drops unknown fields", () => {
  const parsed = parseWorkerReconstruction({
    schemaVersion: 1,
    image: {
      kind: "custom", definitionId: "recipe", version: "v1",
      digest: `sha256:${"b".repeat(64)}`,
      definition: {
        name: "Portable recipe", description: "", baseImage: "agentor-worker:approved-current",
        dockerfileFragment: "", contextFiles: [], provisioningMode: "safe",
        archiveControlledExtra: "must not survive",
      },
      imageVersion: { baseImage: "agentor-worker:approved-current", contextFiles: [], provisioningMode: "safe", extra: true },
    },
    requiredSecretNames: ["ONE", "ONE"],
    outerExtra: "must not survive",
  });
  expect(parsed).toEqual({
    schemaVersion: 1,
    image: {
      kind: "custom", definitionId: "recipe", version: "v1",
      digest: `sha256:${"b".repeat(64)}`,
      definition: {
        name: "Portable recipe", description: "", baseImage: "agentor-worker:approved-current",
        dockerfileFragment: "", contextFiles: [], provisioningMode: "safe",
      },
      imageVersion: { baseImage: "agentor-worker:approved-current", provisioningMode: "safe" },
    },
    requiredSecretNames: ["ONE"],
  });
});

test("an imported per-worker image is never mislabeled as the platform default", async () => {
  const payload = snapshotWorkerReconstruction({
    importedImage: "agentor-import-worker-a:latest",
    imageId: `sha256:${"a".repeat(64)}`,
  });
  expect(payload.image).toEqual({
    kind: "unmanaged",
    runtimeImage: "agentor-import-worker-a:latest",
    digest: `sha256:${"a".repeat(64)}`,
  });
  await expect(resolveWorkerReconstruction("owner-a", payload)).resolves.toMatchObject({
    state: "unresolved",
    code: "IMAGE_DEPENDENCY_UNRESOLVED",
  });
});

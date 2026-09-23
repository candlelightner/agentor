import { expect, test } from "@playwright/test";
import {
  deterministicPortableManagedVolumeId,
  planPortableManagedVolumeCapture,
  planPortableManagedVolumeImport,
  portablePathsOverlap,
  type PortableManagedVolumeCaptureObservation,
  type PortableManagedVolumeImportConflicts,
} from "../../orchestrator/server/utils/portable-managed-volume-plan";

const observation = (overrides: Partial<PortableManagedVolumeCaptureObservation> = {}): PortableManagedVolumeCaptureObservation => ({
  volumeId: "source-private-id",
  dockerName: "source-private-name",
  target: "/srv/data",
  name: "Application data",
  purpose: "persistent-path",
  attached: true,
  seeded: true,
  state: "ready",
  physicalExists: true,
  labelsVerified: true,
  driver: "local",
  options: null,
  mountSourceVerified: true,
  mountDestinationVerified: true,
  operationDrift: false,
  recoveryDrift: false,
  ...overrides,
});

const noConflicts = (): PortableManagedVolumeImportConflicts => ({
  protectedPaths: ["/proc", "/etc"],
  workspacePaths: ["/workspace"],
  agentDataPaths: ["/home/agent/.agent-data"],
  dockerDataPaths: ["/var/lib/docker"],
  hostGrantPaths: [],
  destinationMountPaths: [],
  selectedBackupPaths: [],
});

test("capture includes only verified attached persistent volumes and exposes exclusions", () => {
  const result = planPortableManagedVolumeCapture([
    observation({ target: "/z", name: "z" }),
    observation({ target: "/a", name: "a", volumeId: "a-id", dockerName: "a-docker" }),
    observation({ target: "/detached", attached: false }),
    observation({ target: "/legacy", purpose: "legacy-backup-path" }),
  ]);
  expect(result.items.map((item) => item.entry)).toEqual([
    { target: "/a", name: "a", archive: "volumes/0.tar" },
    { target: "/z", name: "z", archive: "volumes/1.tar" },
  ]);
  expect(result.items[0]?.source).toEqual({ volumeId: "a-id", dockerName: "a-docker" });
  expect(result.exclusions).toEqual(expect.arrayContaining([
    expect.objectContaining({ target: "/detached", reason: "detached" }),
    expect.objectContaining({ target: "/legacy", reason: "legacy-backup-path" }),
  ]));
});

test("any opted-in attached inconsistency fails the capture plan", () => {
  const corruptions: Array<Partial<PortableManagedVolumeCaptureObservation>> = [
    { seeded: false }, { state: "preparing" }, { physicalExists: false },
    { labelsVerified: false }, { driver: "nfs" }, { options: { device: "/host" } },
    { mountSourceVerified: false }, { mountDestinationVerified: false },
    { operationDrift: true }, { recoveryDrift: true },
  ];
  for (const corruption of corruptions)
    expect(() => planPortableManagedVolumeCapture([observation(corruption)])).toThrow(/inconsistent attached target/i);
});

test("import allocates deterministic fresh UUIDs, Docker names, and positive labels", () => {
  const input = {
    operationId: "import-operation-1",
    userId: "owner-a",
    workerId: "new-worker-a",
    entries: [{ target: "/srv/data", name: "data", archive: "volumes/0.tar" }],
    conflicts: noConflicts(),
  };
  const first = planPortableManagedVolumeImport(input);
  const second = planPortableManagedVolumeImport(input);
  expect(first).toEqual(second);
  expect(first[0]?.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(first[0]?.dockerName).toBe(`agentor-persist-${first[0]?.id}`);
  expect(first[0]?.labels).toEqual({
    "agentor.volume-id": first[0]?.id,
    "agentor.owner-id": "owner-a",
    "agentor.worker-id": "new-worker-a",
    "agentor.portable-import-id": "import-operation-1",
  });
  expect(deterministicPortableManagedVolumeId("import-operation-2", 0)).not.toBe(first[0]?.id);
});

test("root overlaps everything and every destination conflict category is enforced", () => {
  expect(portablePathsOverlap("/", "/anything")).toBe(true);
  expect(portablePathsOverlap("/srv", "/srv/data")).toBe(true);
  expect(portablePathsOverlap("/srv/a", "/srv/b")).toBe(false);
  for (const category of Object.keys(noConflicts()) as Array<keyof PortableManagedVolumeImportConflicts>) {
    const conflicts = noConflicts();
    conflicts[category] = ["/srv"];
    expect(() => planPortableManagedVolumeImport({
      operationId: "operation", userId: "owner", workerId: "worker",
      entries: [{ target: "/srv/data", name: "data", archive: "volumes/0.tar" }],
      conflicts,
    })).toThrow(/overlaps destination storage/i);
  }
  expect(() => planPortableManagedVolumeImport({
    operationId: "operation", userId: "owner", workerId: "worker",
    entries: [{ target: "/", name: "root", archive: "volumes/0.tar" }],
    conflicts: noConflicts(),
  })).toThrow(/overlaps destination storage|target \/ is not allowed/i);
});

test("import rejects overlap among portable targets", () => {
  expect(() => planPortableManagedVolumeImport({
    operationId: "operation", userId: "owner", workerId: "worker",
    entries: [
      { target: "/srv", name: "parent", archive: "volumes/0.tar" },
      { target: "/srv/data", name: "child", archive: "volumes/1.tar" },
    ],
    conflicts: noConflicts(),
  })).toThrow(/another imported volume/i);
});

test("import rejects root even when every caller-supplied conflict set is empty", () => {
  const conflicts = noConflicts();
  for (const key of Object.keys(conflicts) as Array<keyof PortableManagedVolumeImportConflicts>) conflicts[key] = [];
  expect(() => planPortableManagedVolumeImport({
    operationId: "operation", userId: "owner", workerId: "worker",
    entries: [{ target: "/", name: "root", archive: "volumes/0.tar" }],
    conflicts,
  })).toThrow(/target \/ is not allowed/i);
});

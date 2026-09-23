import { createHash } from "node:crypto";
import {
  MAX_PORTABLE_MANAGED_VOLUMES,
  isCanonicalPortableManagedVolumeTarget,
  parsePortableManagedVolumeEntries,
  portableManagedVolumeArchiveName,
  type PortableManagedVolumeEntry,
} from "./portable-managed-volume-format";

export interface PortableManagedVolumeCaptureObservation {
  volumeId: string;
  dockerName: string;
  target: string;
  name: string;
  purpose: "persistent-path" | "legacy-backup-path";
  attached: boolean;
  seeded: boolean;
  state: string;
  physicalExists: boolean;
  labelsVerified: boolean;
  driver: string;
  options: Record<string, string> | null;
  mountSourceVerified: boolean;
  mountDestinationVerified: boolean;
  operationDrift: boolean;
  recoveryDrift: boolean;
}

export interface PortableManagedVolumeCaptureItem {
  entry: PortableManagedVolumeEntry;
  /** Server-private source handles; neither value belongs in the manifest. */
  source: { volumeId: string; dockerName: string };
}

export interface PortableManagedVolumeCaptureExclusion {
  target: string;
  name: string;
  reason: "detached" | "legacy-backup-path";
}

export interface PortableManagedVolumeCapturePlan {
  items: PortableManagedVolumeCaptureItem[];
  exclusions: PortableManagedVolumeCaptureExclusion[];
}

export function planPortableManagedVolumeCapture(
  observations: readonly PortableManagedVolumeCaptureObservation[],
): PortableManagedVolumeCapturePlan {
  const items: PortableManagedVolumeCaptureItem[] = [];
  const exclusions: PortableManagedVolumeCaptureExclusion[] = [];
  const ordered = [...observations].sort((left, right) => left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
  for (const observation of ordered) {
    if (!observation.attached) {
      exclusions.push({ target: observation.target, name: observation.name, reason: "detached" });
      continue;
    }
    if (observation.purpose !== "persistent-path") {
      exclusions.push({ target: observation.target, name: observation.name, reason: "legacy-backup-path" });
      continue;
    }
    if (!observation.seeded || observation.state !== "ready" || !observation.physicalExists ||
        !observation.labelsVerified || observation.driver !== "local" ||
        (observation.options !== null && Object.keys(observation.options).length !== 0) ||
        !observation.mountSourceVerified || !observation.mountDestinationVerified ||
        observation.operationDrift || observation.recoveryDrift)
      throw new Error(`Portable managed-volume capture refused inconsistent attached target ${observation.target}`);
    if (items.length >= MAX_PORTABLE_MANAGED_VOLUMES)
      throw new Error("Portable managed-volume capture contains more than 32 eligible volumes");
    items.push({
      entry: {
        target: observation.target,
        name: observation.name,
        archive: portableManagedVolumeArchiveName(items.length),
      },
      source: { volumeId: observation.volumeId, dockerName: observation.dockerName },
    });
  }
  // Apply the same strict manifest validation at the planning boundary.
  parsePortableManagedVolumeEntries(items.map((item) => item.entry));
  return { items, exclusions };
}

export interface PortableManagedVolumeImportConflicts {
  protectedPaths: readonly string[];
  workspacePaths: readonly string[];
  agentDataPaths: readonly string[];
  dockerDataPaths: readonly string[];
  hostGrantPaths: readonly string[];
  destinationMountPaths: readonly string[];
  selectedBackupPaths: readonly string[];
}

export interface PortableManagedVolumeImportIntent extends PortableManagedVolumeEntry {
  id: string;
  dockerName: string;
  labels: {
    "agentor.volume-id": string;
    "agentor.owner-id": string;
    "agentor.worker-id": string;
    "agentor.portable-import-id": string;
  };
}

export interface PortableManagedVolumeImportPlanInput {
  operationId: string;
  userId: string;
  workerId: string;
  entries: readonly PortableManagedVolumeEntry[];
  conflicts: PortableManagedVolumeImportConflicts;
}

export function planPortableManagedVolumeImport(
  input: PortableManagedVolumeImportPlanInput,
): PortableManagedVolumeImportIntent[] {
  requireIdentifier(input.operationId, "operationId");
  requireIdentifier(input.userId, "userId");
  requireIdentifier(input.workerId, "workerId");
  const entries = parsePortableManagedVolumeEntries(input.entries);
  const conflictKeys: Array<keyof PortableManagedVolumeImportConflicts> = [
    "protectedPaths", "workspacePaths", "agentDataPaths", "dockerDataPaths",
    "hostGrantPaths", "destinationMountPaths", "selectedBackupPaths",
  ];
  if (!input.conflicts || typeof input.conflicts !== "object" ||
      Object.keys(input.conflicts).sort().join("\0") !== [...conflictKeys].sort().join("\0") ||
      conflictKeys.some((key) => !Array.isArray(input.conflicts[key])))
    throw new Error("Portable managed-volume import requires every destination conflict category");
  const conflictPaths = conflictKeys.flatMap((key) => [...input.conflicts[key]]);
  for (const path of conflictPaths)
    if (!isCanonicalPortableManagedVolumeTarget(path))
      throw new Error("Portable managed-volume import conflict paths must be canonical absolute paths");

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.target === "/")
      throw new Error("Portable managed-volume target / is not allowed");
    if (conflictPaths.some((path) => portablePathsOverlap(entry.target, path)))
      throw new Error(`Portable managed-volume target ${entry.target} overlaps destination storage`);
    if (entries.slice(0, index).some((other) => portablePathsOverlap(entry.target, other.target)))
      throw new Error(`Portable managed-volume target ${entry.target} overlaps another imported volume`);
  }

  return entries.map((entry, index) => {
    const id = deterministicPortableManagedVolumeId(input.operationId, index);
    return {
      ...entry,
      id,
      dockerName: `agentor-persist-${id}`,
      labels: {
        "agentor.volume-id": id,
        "agentor.owner-id": input.userId,
        "agentor.worker-id": input.workerId,
        "agentor.portable-import-id": input.operationId,
      },
    };
  });
}

export function portablePathsOverlap(left: string, right: string): boolean {
  if (left === "/" || right === "/") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function deterministicPortableManagedVolumeId(operationId: string, index: number): string {
  requireIdentifier(operationId, "operationId");
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PORTABLE_MANAGED_VOLUMES)
    throw new Error("Invalid portable managed-volume index");
  const bytes = createHash("sha256").update(operationId).update("\0").update(String(index)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid portable managed-volume ${name}`);
}

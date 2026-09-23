import { posix } from "node:path";

export const MANAGED_VOLUMES_BUNDLE_MEMBER = "managed-volumes.tar.gz";
export const MAX_PORTABLE_MANAGED_VOLUMES = 32;
export const PORTABLE_MANAGED_VOLUME_ROOT = "volume/";

export interface PortableManagedVolumeEntry {
  target: string;
  name: string;
  archive: string;
}

export interface PortableManagedVolumeFormatInput {
  version: unknown;
  contentsManagedVolumes: unknown;
  managedVolumes: unknown;
  /** Coverage metadata only. It is deliberately ignored as mount authority. */
  localPersistence?: unknown;
  payloadPresent: boolean;
}

export function portableManagedVolumeArchiveName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_PORTABLE_MANAGED_VOLUMES)
    throw new Error("Invalid portable managed-volume archive index");
  return `volumes/${index}.tar`;
}

export function parsePortableManagedVolumeEntries(value: unknown): PortableManagedVolumeEntry[] {
  if (!Array.isArray(value) || value.length > MAX_PORTABLE_MANAGED_VOLUMES)
    throw invalidFormat("managedVolumes must be an array with at most 32 entries");

  const targets = new Set<string>();
  return value.map((candidate, index) => {
    if (!isExactRecord(candidate, ["target", "name", "archive"]))
      throw invalidFormat(`managedVolumes[${index}] must contain only target, name, and archive`);
    const target = parseCanonicalTarget(candidate.target, index);
    if (targets.has(target))
      throw invalidFormat(`managedVolumes contains duplicate target ${target}`);
    targets.add(target);

    if (typeof candidate.name !== "string" || candidate.name !== candidate.name.trim() ||
        candidate.name.length < 1 || candidate.name.length > 100 || !isPrintable(candidate.name))
      throw invalidFormat(`managedVolumes[${index}].name must contain 1-100 printable characters`);
    const archive = portableManagedVolumeArchiveName(index);
    if (candidate.archive !== archive)
      throw invalidFormat(`managedVolumes[${index}].archive must be ${archive}`);
    return { target, name: candidate.name, archive };
  });
}

/**
 * Resolve the portable-volume projection of a worker bundle. Versions 1-5
 * cannot smuggle the new fields or payload. Version 6 is always the explicit,
 * opted-in form, including when the manifest contains zero eligible volumes.
 */
export function resolvePortableManagedVolumeFormat(input: PortableManagedVolumeFormatInput): PortableManagedVolumeEntry[] {
  const version = input.version;
  if (!Number.isInteger(version) || typeof version !== "number" || version < 1 || version > 6)
    throw invalidFormat("unsupported worker export version");

  if (version <= 5) {
    if (input.contentsManagedVolumes !== undefined || input.managedVolumes !== undefined || input.payloadPresent)
      throw invalidFormat("portable managed-volume fields require worker export version 6");
    return [];
  }

  if (input.contentsManagedVolumes !== true || !input.payloadPresent || !Array.isArray(input.managedVolumes))
    throw invalidFormat("version 6 requires managedVolumes metadata and payload to agree");
  return parsePortableManagedVolumeEntries(input.managedVolumes);
}

export function isCanonicalPortableManagedVolumeTarget(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") &&
    (value === "/" || !value.endsWith("/")) && !/[\u0000-\u001f\u007f\\:]/.test(value) &&
    posix.normalize(value) === value;
}

function parseCanonicalTarget(value: unknown, index: number): string {
  if (!isCanonicalPortableManagedVolumeTarget(value))
    throw invalidFormat(`managedVolumes[${index}].target must be a canonical absolute path`);
  return value;
}

function isPrintable(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as object).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function invalidFormat(detail: string): Error {
  return new Error(`Invalid worker export: ${detail}`);
}

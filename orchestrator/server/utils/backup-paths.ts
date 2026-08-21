/**
 * Path selections are deliberately absolute: unlike the normal workspace file
 * manager, backup is an explicit portable-copy operation and may include a
 * readable file outside /workspace.  This module is the single validation
 * boundary for those selections; callers must still authorize the worker
 * before invoking it.
 */
import { posix as path } from "node:path";

export const BACKUP_DEFAULT_PATHS = ["/workspace", "/home/agent/.agent-data"] as const;
export const MAX_BACKUP_PATHS = 32;

export interface BackupPathEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: string;
  readable: boolean;
  linkTarget?: string;
}

export function normalizeBackupPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_BACKUP_PATHS)
    throw Object.assign(new Error(`paths must contain at most ${MAX_BACKUP_PATHS} absolute paths`), { statusCode: 400 });
  const paths = value.map(normalizeBackupPath);
  // A parent selection already includes its descendants. Keeping only the
  // parent avoids duplicate bytes and makes restoration deterministic.
  return [...new Set(paths)].filter((candidate, _index, all) =>
    !all.some((parent) => parent !== candidate && isParentPath(parent, candidate)),
  );
}

export function normalizeBackupPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))
    throw Object.assign(new Error("Invalid backup path"), { statusCode: 400 });
  if (!value.startsWith("/") || value.includes("\\"))
    throw Object.assign(new Error("Backup paths must be absolute POSIX paths"), { statusCode: 400 });
  const normalized = path.normalize(value);
  if (!normalized.startsWith("/") || normalized.split("/").includes(".."))
    throw Object.assign(new Error("Invalid backup path"), { statusCode: 400 });
  return normalized;
}

export function isParentPath(parent: string, child: string): boolean {
  return parent === "/" || child.startsWith(`${parent}/`);
}

/** Paths which are already represented by the legacy portable export. */
export function extraBackupPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return [];
  // Exact default roots are represented by the legacy filtered export. A
  // descendant is different: selecting e.g. an authentication file beneath
  // agent-data is an explicit opt-in and must not be silently filtered.
  return paths.filter((candidate) => !BACKUP_DEFAULT_PATHS.includes(candidate as any));
}

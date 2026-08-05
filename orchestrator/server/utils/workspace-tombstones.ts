import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceTombstone { schemaVersion: 1; id: string; workerId: string; userId: string; displayName: string; backend: 'directory' | 'volume'; createdAt?: string; deletedAt: string }
let loaded: Promise<void> | undefined;
let entries: WorkspaceTombstone[] = [];
let saves = Promise.resolve();
const dataDir = process.env.DATA_DIR || '/data';
const path = () => join(dataDir, 'workspace-tombstones.json');

async function load() {
  try {
    const parsed = JSON.parse(await readFile(path(), 'utf8'));
    if (parsed?.schemaVersion === 1 && Array.isArray(parsed.entries)) entries = parsed.entries;
  } catch { /* first boot or unreadable legacy state */ }
}
async function persist() {
  saves = saves.then(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const target = path(), temporary = `${target}.tmp.${process.pid}`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, entries }, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  });
  return saves;
}
export async function listWorkspaceTombstones() { await (loaded ??= load()); return structuredClone(entries); }
export async function recordWorkspaceTombstone(value: Omit<WorkspaceTombstone, 'schemaVersion' | 'id' | 'deletedAt'>) {
  await (loaded ??= load());
  const deletedAt = new Date().toISOString();
  entries = entries.filter((entry) => entry.workerId !== value.workerId);
  entries.push({ schemaVersion: 1, id: `deleted-${value.workerId}`, ...value, deletedAt });
  await persist();
}
export async function removeWorkspaceTombstonesForUser(userId: string) {
  await (loaded ??= load());
  const next = entries.filter((entry) => entry.userId !== userId);
  if (next.length === entries.length) return;
  entries = next;
  await persist();
}

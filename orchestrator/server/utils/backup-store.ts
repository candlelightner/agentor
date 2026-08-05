import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupArtifact, BackupConfig, BackupJob } from './backup-types';

interface UserBackupData { schemaVersion: 1; config?: BackupConfig; jobs: BackupJob[]; artifacts: BackupArtifact[] }
export class BackupStore {
  private data = new Map<string, UserBackupData>(); private queues = new Map<string, Promise<void>>(); private initialized?: Promise<void>;
  constructor(private dataDir: string) {}
  init() { return this.initialized ??= this.load(); }
  get(userId: string) { return this.data.get(userId) ?? { schemaVersion: 1 as const, jobs: [], artifacts: [] }; }
  all() { return [...this.data.values()]; }
  userIds() { return [...this.data.keys()]; }
  forget(userId: string) { this.data.delete(userId); }
  findJob(id: string) { for (const value of this.data.values()) { const job = value.jobs.find((x) => x.id === id); if (job) return job; } }
  findArtifact(id: string) { for (const value of this.data.values()) { const artifact = value.artifacts.find((x) => x.id === id); if (artifact) return artifact; } }
  async save(userId: string, value: UserBackupData) { this.data.set(userId, value); await this.persist(userId); }
  private async load() { let users: string[] = []; try { users = await readdir(join(this.dataDir, 'users')); } catch { return; }
    for (const userId of users) try { const value = JSON.parse(await readFile(join(this.dataDir, 'users', userId, 'backups.json'), 'utf8')); if (value?.schemaVersion === 1) this.data.set(userId, value); } catch {} }
  private persist(userId: string) { const previous = this.queues.get(userId) ?? Promise.resolve(); const next = previous.then(async () => { const dir = join(this.dataDir, 'users', userId); await mkdir(dir, { recursive: true, mode: 0o700 }); const target = join(dir, 'backups.json'); const tmp = `${target}.tmp.${process.pid}`; await writeFile(tmp, JSON.stringify(this.get(userId), null, 2), { mode: 0o600 }); await rename(tmp, target); }); this.queues.set(userId, next.catch(() => {})); return next; }
}

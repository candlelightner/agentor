import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createError, type H3Event } from "h3";
import { useConfig } from "./services";

const scrypt = promisify(scryptCallback);
const FILE = "worker-protection-locks.v1.json";
const MIN_PASSWORD_LENGTH = 8;

interface LockRecord { workerId: string; salt: string; hash: string; createdAt: string; updatedAt: string }
interface State { schemaVersion: 1; locks: LockRecord[] }

/** Password-verifier store for optional worker mutation locks.  This deliberately
 * exposes only lock state: neither a password nor its verifier leaves here. */
export class WorkerProtectionLockStore {
  private state: State = { schemaVersion: 1, locks: [] };
  private loading?: Promise<void>;
  constructor(private readonly dataDir: string) {}
  private get path() { return join(this.dataDir, FILE); }
  async init() { if (!this.loading) this.loading = this.load(); return this.loading; }
  async isLocked(workerId: string) { await this.init(); return this.state.locks.some(x => x.workerId === workerId); }
  async public(workerId: string) { return { workerId, protected: await this.isLocked(workerId) }; }
  async set(workerId: string, password: unknown, currentPassword?: unknown) {
    await this.init();
    const existing = this.state.locks.find(x => x.workerId === workerId);
    if (existing) await this.verify(workerId, currentPassword);
    const plain = validatePassword(password);
    const salt = randomUUID(); const hash = (await derive(plain, salt)).toString("hex"); const stamp = new Date().toISOString();
    const record: LockRecord = { workerId, salt, hash, createdAt: existing?.createdAt || stamp, updatedAt: stamp };
    const previous = this.state.locks;
    this.state.locks = [...previous.filter(x => x.workerId !== workerId), record];
    try { await this.persist(); } catch (error) { this.state.locks = previous; throw error; }
    return this.public(workerId);
  }
  async remove(workerId: string, password: unknown) { await this.verify(workerId, password); const previous = this.state.locks; this.state.locks = previous.filter(x => x.workerId !== workerId); try { await this.persist(); } catch (error) { this.state.locks = previous; throw error; } return this.public(workerId); }
  async verify(workerId: string, password: unknown) {
    await this.init(); const record = this.state.locks.find(x => x.workerId === workerId);
    if (!record) return true;
    if (typeof password !== "string" || !password) throw locked();
    const actual = await derive(password, record.salt); const expected = Buffer.from(record.hash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw locked();
    return true;
  }
  async removeForDeletedWorker(workerId: string) { await this.init(); if (!this.state.locks.some(x => x.workerId === workerId)) return; const previous = this.state.locks; this.state.locks = previous.filter(x => x.workerId !== workerId); try { await this.persist(); } catch (error) { this.state.locks = previous; throw error; } }
  private async load() { try { const parsed = JSON.parse(await readFile(this.path, "utf8")); if (parsed?.schemaVersion === 1 && Array.isArray(parsed.locks)) this.state = { schemaVersion: 1, locks: parsed.locks.filter(valid) }; } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
  private async persist() { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const tmp = `${this.path}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await rename(tmp, this.path); }
}
function valid(x: any): x is LockRecord { return x && typeof x.workerId === "string" && typeof x.salt === "string" && /^[a-f0-9]{128}$/i.test(x.hash); }
function validatePassword(value: unknown) { if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH || value.length > 1024) throw createError({ statusCode: 400, statusMessage: `Lock password must be ${MIN_PASSWORD_LENGTH}-1024 characters` }); return value; }
async function derive(password: string, salt: string) { return (await scrypt(password, salt, 64)) as Buffer; }
function locked() { return createError({ statusCode: 423, statusMessage: "Worker is protected: supply the correct lock password" }); }

/** Reusable route/MCP guard.  Password comes only from the current request/tool
 * arguments; it is not persisted, logged, returned, or added to worker state. */
export async function requireWorkerMutationUnlock(event: H3Event, workerId: string) {
  const body: Record<string, unknown> = await readBody<Record<string, unknown>>(event).catch(() => ({}));
  await useWorkerProtectionLockStore().verify(workerId, body.lockPassword);
  return body || {};
}

/** Verify every protected worker affected by a bulk mutation.  Callers pass a
 * transient workerId -> password map; it is deliberately never persisted. */
export async function verifyWorkerMutationUnlocks(workerIds: Iterable<string>, passwords: unknown) {
  const supplied = passwords && typeof passwords === "object" && !Array.isArray(passwords)
    ? passwords as Record<string, unknown> : {};
  const locks = useWorkerProtectionLockStore();
  for (const id of new Set(workerIds)) await locks.verify(id, supplied[id]);
}

let singleton: WorkerProtectionLockStore | undefined;
export function useWorkerProtectionLockStore() { return (singleton ??= new WorkerProtectionLockStore(useConfig().dataDir)); }

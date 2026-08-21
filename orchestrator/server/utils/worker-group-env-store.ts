import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { decryptWorkerValue, encryptWorkerValue, type EncryptedWorkerValue } from "./worker-config-crypto";
import { isAllowedUserEnvKey } from "./user-env-store";
import { assertSafeUserId } from "./user-id";

interface StoredGroupEnvEntry { key: string; encrypted: EncryptedWorkerValue }
export interface StoredGroupEnvRecord { groupId: string; entries: StoredGroupEnvEntry[] }

/** Private encrypted group-variable storage. Public projections contain names
 * and configured state only; plaintext exists only at the container boundary. */
export class WorkerGroupEnvStore {
  private records = new Map<string, Map<string, StoredGroupEnvRecord>>();
  private initialized = new Set<string>();
  private loads = new Map<string, Promise<void>>();
  private queues = new Map<string,Promise<void>>();
  constructor(private readonly config: Config) {}

  async publicList(userId: string, groupId: string) {
    await this.load(userId);
    return (this.records.get(userId)?.get(groupId)?.entries ?? []).map(({ key }) => ({ key, configured: true as const }));
  }

  async set(userId: string, groupId: string, variables: unknown) {
    assertSafeUserId(userId);
    if (!Array.isArray(variables) || variables.some((item) => !item || typeof item !== "object" || typeof (item as any).key !== "string" || typeof (item as any).value !== "string"))
      throw Object.assign(new Error("variables must contain key/value strings"), { statusCode: 400 });
    return this.mutate(userId,async()=>{
    const current = this.records.get(userId)?.get(groupId)?.entries ?? [];
    const map = new Map(current.map((entry) => [entry.key, entry]));
    for (const raw of variables as Array<{ key: string; value: string }>) {
      const key = raw.key.trim();
      if (!isAllowedUserEnvKey(key)) throw Object.assign(new Error("Invalid group environment variable key"), { statusCode: 400 });
      map.set(key, { key, encrypted: await encryptWorkerValue(this.config, raw.value, aad(userId, groupId, key)) });
    }
    this.owner(userId).set(groupId, { groupId, entries: [...map.values()].sort((a,b)=>a.key.localeCompare(b.key)) });
    await this.persist(userId);
    return (this.records.get(userId)?.get(groupId)?.entries??[]).map(({key})=>({key,configured:true as const}));
    });
  }

  async delete(userId: string, groupId: string, keys: unknown) {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw Object.assign(new Error("keys must be strings"), { statusCode: 400 });
    return this.mutate(userId,async()=>{
    const record = this.records.get(userId)?.get(groupId);
    if (record) record.entries = record.entries.filter((entry) => !(keys as string[]).includes(entry.key));
    await this.persist(userId);
    return { deleted: [...new Set(keys as string[])] };
    });
  }

  async resolve(userId: string, groupId: string) {
    await this.load(userId);
    const entries = this.records.get(userId)?.get(groupId)?.entries ?? [];
    return Promise.all(entries.map(async ({ key, encrypted }) => ({ key, value: await decryptWorkerValue(this.config, encrypted, aad(userId, groupId, key)) })));
  }
  async remove(userId:string,groupId:string){return this.mutate(userId,async()=>{this.records.get(userId)?.delete(groupId);await this.persist(userId);});}
  async take(userId:string,groupId:string){return this.mutate(userId,async()=>{const record=this.records.get(userId)?.get(groupId);this.records.get(userId)?.delete(groupId);await this.persist(userId);return record?structuredClone(record):undefined;});}
  async restore(userId:string,record:StoredGroupEnvRecord|undefined){if(!record)return;return this.mutate(userId,async()=>{this.owner(userId).set(record.groupId,structuredClone(record));await this.persist(userId);});}

  private owner(userId: string) { let map=this.records.get(userId);if(!map){map=new Map();this.records.set(userId,map);}return map; }
  private path(userId:string){assertSafeUserId(userId);return join(this.config.dataDir,"users",userId,"worker-group-env.json");}
  private async load(userId:string){
    if(this.initialized.has(userId))return;
    const active=this.loads.get(userId);if(active)return active;
    const loading=(async()=>{try{const parsed=JSON.parse(await readFile(this.path(userId),"utf8")) as StoredGroupEnvRecord[];for(const record of parsed)this.owner(userId).set(record.groupId,record);}catch(error:any){if(error?.code!=="ENOENT")throw error;}this.initialized.add(userId);})();
    this.loads.set(userId,loading);
    try{await loading;}finally{if(this.loads.get(userId)===loading)this.loads.delete(userId);}
  }
  private async persist(userId:string){const path=this.path(userId);await mkdir(join(this.config.dataDir,"users",userId),{recursive:true,mode:0o700});const tmp=`${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;await writeFile(tmp,JSON.stringify([...this.owner(userId).values()]),{mode:0o600});await rename(tmp,path);}
  private mutate<T>(userId:string,operation:()=>Promise<T>):Promise<T>{const prior=this.queues.get(userId)??Promise.resolve();const result=prior.catch(()=>undefined).then(async()=>{await this.load(userId);const existing=this.records.get(userId);const previous=existing?new Map([...existing].map(([key,value])=>[key,structuredClone(value)])):undefined;try{return await operation();}catch(error){if(previous)this.records.set(userId,previous);else this.records.delete(userId);throw error;}});const tail=result.then(()=>undefined,()=>undefined);this.queues.set(userId,tail);void tail.finally(()=>{if(this.queues.get(userId)===tail)this.queues.delete(userId);});return result;}
}
function aad(userId:string,groupId:string,key:string){return `group-env:${userId}:${groupId}:${key}`;}

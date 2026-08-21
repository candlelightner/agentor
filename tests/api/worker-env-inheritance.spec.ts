import { expect,test,request as playwrightRequest } from "@playwright/test";
import { normalizeExcludedGlobalEnvVarKeys } from "../../orchestrator/server/utils/user-env-store";
import { ManagementWorkerDomain } from "../../orchestrator/server/utils/management-worker-domain";
import { markWorkerEnvPending,mergeGroupEnvLevels } from "../../orchestrator/server/utils/worker-group-env";
import { createTestUser,deleteTestUser } from "../helpers/test-users";
import { ApiClient } from "../helpers/api-client";
import { WorkerGroupEnvStore } from "../../orchestrator/server/utils/worker-group-env-store";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";

class GatedWorkerStore extends WorkerStore {
  private blockOnce?: { entered: () => void; wait: Promise<void> };

  gateNextPersist() {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.blockOnce = { entered: () => entered(), wait };
    return { entered: enteredPromise, release };
  }

  protected override async persistUser(userId:string):Promise<void>{
    const gate=this.blockOnce;
    if(gate){this.blockOnce=undefined;gate.entered();await gate.wait;}
    await super.persistUser(userId);
  }
}

const env={userId:"owner",createdAt:"",updatedAt:"",envVars:[{key:"CUSTOM_KEY",value:"never-serialize-this"}]};

test("global exclusions accept unset predefined and configured custom names only",()=>{
  expect(normalizeExcludedGlobalEnvVarKeys(env,["CUSTOM_KEY","OPENAI_API_KEY","CUSTOM_KEY"])).toEqual(["CUSTOM_KEY","OPENAI_API_KEY"]);
  expect(()=>normalizeExcludedGlobalEnvVarKeys(env,["UNKNOWN_KEY"])).toThrow(/Unknown account environment variable key/);
});

test("group inheritance applies exclusions, nearest overrides, and ignores stale worker exclusions",()=>{
  const effective=mergeGroupEnvLevels([
    {entries:[{key:"SHARED",value:"root"},{key:"ROOT_ONLY",value:"one"}]},
    {excludedInheritedKeys:["ROOT_ONLY"],entries:[{key:"SHARED",value:"child"},{key:"CHILD_ONLY",value:"two"}]},
  ],["CHILD_ONLY","STALE_REMOVED_KEY"]);
  expect(effective).toEqual([{key:"SHARED",value:"child"}]);
});

test("group values are encrypted, names-only reads do not leak, and concurrent owner writes settle",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"agentor-group-env-"));const store=new WorkerGroupEnvStore({dataDir:dir} as any);
  try{await Promise.all([store.set("owner","root",[{key:"ROOT_KEY",value:"root-secret"}]),store.set("owner","child",[{key:"CHILD_KEY",value:"child-secret"}])]);expect(await store.publicList("owner","root")).toEqual([{key:"ROOT_KEY",configured:true}]);expect(await store.resolve("owner","child")).toEqual([{key:"CHILD_KEY",value:"child-secret"}]);const disk=await readFile(join(dir,"users","owner","worker-group-env.json"),"utf8");expect(disk).not.toContain("root-secret");expect(disk).not.toContain("child-secret");}finally{await rm(dir,{recursive:true,force:true});}
});

test("group environment rebuild marking queued behind deletion cannot resurrect the worker",async()=>{
  (globalThis as any).useLogger=()=>({error(){},warn(){},info(){},debug(){}});
  const dir=await mkdtemp(join(tmpdir(),"agentor-worker-env-race-"));
  const store=new GatedWorkerStore(dir);
  const live={userId:"owner",pendingRebuild:false,updatedAt:"before"};
  try{
    await store.upsert({id:"worker-1",userId:"owner",displayName:"worker",status:"active",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"});
    const gate=store.gateNextPersist();
    const deletion=store.delete("owner","worker-1");
    await gate.entered;
    const marking=markWorkerEnvPending("owner","worker-1",store,{get:()=>live});
    gate.release();
    await deletion;
    await expect(marking).resolves.toBe(false);
    expect(store.get("owner","worker-1")).toBeUndefined();
    expect(live).toMatchObject({pendingRebuild:false,updatedAt:"before"});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("MCP publishes names-only worker exclusions and write-only group values",()=>{
  const tools=new ManagementWorkerDomain().tools();
  const create=tools.find(tool=>tool.name==="workers.create")!;
  const update=tools.find(tool=>tool.name==="workers.update")!;
  const groupUpdate=tools.find(tool=>tool.name==="groups.env.update")!;
  expect((create.inputSchema as any).properties.excludedGlobalEnvVarKeys.description).toContain("Names");
  expect((update.inputSchema as any).properties.excludedGroupEnvVarKeys.description).toContain("Values are never accepted");
  expect((groupUpdate.inputSchema as any).properties.entries.items.properties.value.writeOnly).toBe(true);
  expect(JSON.stringify(tools)).not.toContain("never-serialize-this");
});

test("names-only key discovery permits global admin but denies another owner",async({request})=>{
  const first=await createTestUser("env owner"),second=await createTestUser("env outsider");
  const opts={baseURL:process.env.BASE_URL||"http://localhost:3000",extraHTTPHeaders:{Origin:process.env.BASE_URL||"http://localhost:3000"},storageState:{cookies:[],origins:[]}};
  const owner=await playwrightRequest.newContext(opts),outsider=await playwrightRequest.newContext(opts);
  try{await new ApiClient(owner).signInEmail(first.email,first.password);await new ApiClient(outsider).signInEmail(second.email,second.password);const created=await owner.post("/api/worker-groups",{data:{name:"env-scope"}});expect(created.status()).toBe(201);const group=await created.json();const adminRead=await request.get(`/api/account/env-var-keys?groupId=${group.id}`);expect(adminRead.status()).toBe(200);expect(await adminRead.json()).not.toHaveProperty("values");expect((await outsider.get(`/api/account/env-var-keys?groupId=${group.id}`)).status()).toBe(403);await owner.delete(`/api/worker-groups/${group.id}`);}finally{await owner.dispose();await outsider.dispose();await deleteTestUser(first.id);await deleteTestUser(second.id);}
});

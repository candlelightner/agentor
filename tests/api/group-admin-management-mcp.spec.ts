import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ApiClient } from "../helpers/api-client";
import { cleanupWorker, createWorker, waitForWorkerRunning } from "../helpers/worker-lifecycle";
import { createTestUser, deleteTestUser, type CreatedUser } from "../helpers/test-users";
import { captureCommandOutput, TerminalWsClient } from "../helpers/terminal-ws";

/**
 * These tests intentionally use the administrator-only diagnostic transport to
 * exercise the credential that is installed in a group-admin workspace.  The
 * transport is not an authorization bypass: the issued identity remains bound
 * to the workspace's group on every management-domain invocation.
 */
async function invoke(
  request: APIRequestContext,
  credential: string,
  tool: string,
  args: Record<string, unknown> = {},
) {
  return request.post("/api/admin/management-mcp/diagnostics/invoke", {
    data: { credential, tool, arguments: args },
  });
}

test.describe.serial("Group-admin workspace and scoped management MCP", () => {
  let owner: CreatedUser;
  let ownerRequest: APIRequestContext;
  let groupId = "";
  let memberId = "";
  let addedMemberId = "";
  let outsiderId = "";
  let createdByGroupId = "";
  let workspaceId = "";
  let credential = "";
  const previousDelegatedPolicy: Record<string, boolean> = {};

  async function issueCredential(request: APIRequestContext) {
    const identity = await request.post("/api/admin/management-mcp/diagnostics/issue-identity", { data: { workspaceId, ttlSeconds: 60 } });
    expect(identity.status()).toBe(201);
    credential = (await identity.json()).credential;
  }

  test.beforeAll(async ({ request }) => {
    owner = await createTestUser(`Group admin MCP ${Date.now()}`);
    ownerRequest = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || "http://localhost:3000" });
    expect((await new ApiClient(ownerRequest).signInEmail(owner.email, owner.password)).status).toBe(200);

    memberId = (await createWorker(ownerRequest, { displayName: `group-admin-member-${Date.now()}` })).id;
    addedMemberId = (await createWorker(ownerRequest, { displayName: `group-admin-added-${Date.now()}` })).id;
    outsiderId = (await createWorker(ownerRequest, { displayName: `group-admin-outsider-${Date.now()}` })).id;
    const created = await ownerRequest.post("/api/worker-groups", { data: { name: `admin-scope-${Date.now()}` } });
    expect(created.status()).toBe(201);
    groupId = (await created.json()).id;
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [memberId] } })).status()).toBe(200);

    const policy = await (await request.get("/api/admin/management-mcp/policy")).json();
    const delegatedGroups = [
      "worker-lifecycle", "configuration", "console", "exports", "backups",
      "locks", "apps", "running-files", "networking", "storage",
    ];
    const enabled: Record<string, boolean> = {};
    for (const name of delegatedGroups) {
      previousDelegatedPolicy[name] = policy.groups[name].enabled;
      enabled[name] = true;
    }
    expect((await request.put("/api/admin/management-mcp/policy", { data: { groups: enabled } })).status()).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    if (Object.keys(previousDelegatedPolicy).length)
      await request.put("/api/admin/management-mcp/policy", { data: { groups: previousDelegatedPolicy } }).catch(() => {});
    if (groupId) await ownerRequest.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    for (const workerId of [memberId, addedMemberId, outsiderId, createdByGroupId]) {
      if (workerId) await cleanupWorker(ownerRequest, workerId).catch(() => {});
    }
    await ownerRequest?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("provisions one persistent group-admin workspace and keeps its lifecycle group-bound", { timeout: 180_000 }, async ({ request }) => {
    const first = await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace`, { data: {} });
    expect([200, 201]).toContain(first.status());
    const workspace = await first.json();
    workspaceId = workspace.id;
    expect(workspace).toMatchObject({ id: expect.any(String), groupId, userId: owner.id });

    const again = await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace`, { data: {} });
    expect(again.status()).toBe(200);
    expect((await again.json()).id).toBe(workspaceId);
    const fetched = await ownerRequest.get(`/api/worker-groups/${groupId}/admin-workspace`);
    expect(fetched.status()).toBe(200);
    expect(await fetched.json()).toMatchObject({ id: workspaceId, groupId });

    // These routes exercise the real runtime rather than only its persisted
    // record.  A rebuild must retain the immutable workspace/group binding.
    expect((await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace/stop`)).status()).toBe(200);
    expect((await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace/start`)).status()).toBe(200);
    expect((await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace/rebuild`)).status()).toBe(200);
    await expect.poll(async () => (await ownerRequest.get(`/api/worker-groups/${groupId}/admin-workspace`)).status()).toBe(200);
    expect(await (await ownerRequest.get(`/api/worker-groups/${groupId}/admin-workspace`)).json()).toMatchObject({ id: workspaceId, groupId });

    await issueCredential(request);
  });

  test("the real group workspace receives a credential and reaches MCP only on its private network", async ({ request }) => {
    const security = await (await request.get(`/api/admin/workspace/diagnostics/container-security?workerId=${workspaceId}`)).json();
    expect(security).toMatchObject({ administrative: true, managementNetworkAttached: true, rawDockerSocket: false, publishedPorts: [] });
    expect(security.networks).toContain(`agentor-management-group-${groupId}`);
    expect(security.networks).toContain(`agentor-admin-egress-group-${groupId}`);
    expect(security.networks).not.toContain("agentor-management");
    expect(security.networks).not.toContain("agentor-admin-egress-v1");
    expect(security.networks).not.toContain("agentor-net");
    const terminal = new TerminalWsClient(workspaceId);
    await terminal.connect(15_000);
    await terminal.waitForOutput(/agent@.+:\/workspace\$/, 15_000);
    terminal.sendLine(`C=$(cat /run/agentor-management/credential); curl -fsS -H "Authorization: Bearer $C" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' http://agentor-orchestrator:3099/mcp`);
    await terminal.waitForOutput(/agentor-management/, 30_000);
    terminal.close();
  });

  test("identity is workspace- and group-bound, and cannot be substituted", async ({ request }) => {
    await issueCredential(request);
    const introspected = await request.post("/api/admin/management-mcp/diagnostics/introspect-identity", { data: { credential } });
    expect(introspected.status()).toBe(200);
    expect(await introspected.json()).toMatchObject({ workspaceId, groupId, scope: "group", audience: "agentor-management-mcp", persistedInWorkspace: false });

    const wrongWorkspace = await request.post("/api/admin/management-mcp/diagnostics/introspect-identity", { data: { credential, workspaceId: outsiderId } });
    expect(wrongWorkspace.status()).toBe(403);
  });

  test("scope filters discovery and denies known out-of-group worker ids", async ({ request }) => {
    await issueCredential(request);
    const discovery=await request.post("/api/admin/management-mcp/diagnostics/list-tools",{data:{credential}});
    expect(discovery.status()).toBe(200);
    const toolNames=(await discovery.json()).map((tool:{name:string})=>tool.name);
    expect(toolNames).toContain("workers.inspect");
    expect(toolNames).not.toContain("groups.update");
    expect(toolNames).toContain("workers.create");
    expect(toolNames).not.toContain("port-mappings.list");
    expect(toolNames).toEqual(expect.arrayContaining(["workspaces.list", "workspaces.files", "workspaces.preview", "workspaces.download"]));
    for (const unavailable of ["workspaces.clone", "imports.prepare", "images.build", "networks.create"])
      expect(toolNames).not.toContain(unavailable);
    const listed = await invoke(request, credential, "workers.list");
    expect(listed.status()).toBe(200);
    const ids = (await listed.json()).workers.map((worker: { id: string }) => worker.id);
    expect(ids).toEqual([memberId]);

    expect((await invoke(request, credential, "workers.inspect", { workerId: memberId })).status()).toBe(200);
    // Direct targeting must enforce the same boundary as discovery; knowing a
    // UUID is not authority to operate on that worker.
    const denied = await invoke(request, credential, "workers.inspect", { workerId: outsiderId });
    const unknown = await invoke(request, credential, "workers.inspect", { workerId: randomUUID() });
    expect(denied.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());

    const outsiderExport = await ownerRequest.post(`/api/containers/${outsiderId}/export-jobs`, {
      data: { includeRootfs: false },
    });
    expect(outsiderExport.status()).toBe(202);
    const outsiderExportId = (await outsiderExport.json()).id;
    const deniedExport = await invoke(request, credential, "exports.status", { jobId: outsiderExportId });
    const unknownExport = await invoke(request, credential, "exports.status", { jobId: randomUUID() });
    expect(deniedExport.status()).toBe(404);
    expect(await deniedExport.json()).toEqual(await unknownExport.json());
    await ownerRequest.delete(`/api/export-jobs/${outsiderExportId}`).catch(() => {});

    const directTargets: Array<[string, Record<string, unknown>]> = [
      ["worker.stop", { workerId: outsiderId }],
      ["worker.start", { workerId: outsiderId }],
      ["workers.update", { workerId: outsiderId }],
      ["workers.restart", { workerId: outsiderId }],
      ["workers.rebuild", { workerId: outsiderId }],
      ["workers.archive", { workerId: outsiderId }],
      ["workers.unarchive", { workerId: outsiderId }],
      ["workers.delete", { workerId: outsiderId }],
      ["configuration.inspect", { workerId: outsiderId }],
      ["configuration.get", { workerId: outsiderId }],
      ["configuration.set", { workerId: outsiderId }],
      ["logs.read", { workerId: outsiderId }],
      ["workers.metrics.get", { workerId: outsiderId }],
      ["console.open", { workerId: outsiderId }],
      ["apps.list", { workerId: outsiderId }],
      ["apps.start", { workerId: outsiderId }],
      ["apps.stop", { workerId: outsiderId }],
      ["files.list", { workerId: outsiderId }],
      ["files.upload", { workerId: outsiderId }],
      ["files.mkdir", { workerId: outsiderId }],
      ["files.rename", { workerId: outsiderId }],
      ["files.move", { workerId: outsiderId }],
      ["files.delete", { workerId: outsiderId }],
      ["locks.get", { workerId: outsiderId }],
      ["locks.set", { workerId: outsiderId }],
      ["locks.remove", { workerId: outsiderId }],
      ["exports.create", { workerId: outsiderId }],
      ["port-mappings.create", { workerId: outsiderId }],
      ["domain-mappings.create", { workerId: outsiderId }],
      ["volumes.list-files", { workspaceId: outsiderId }],
      ["workspaces.files", { workspaceId: outsiderId }],
      ["workspaces.preview", { workspaceId: outsiderId }],
      ["workspaces.download", { workspaceId: outsiderId }],
      ["backups.create", { ownerId: owner.id, workspaceIds: [outsiderId] }],
    ];
    for (const [tool, args] of directTargets) {
      const started = Date.now();
      const response = await invoke(request, credential, tool, args);
      expect(response.status(), tool).toBe(404);
      expect(Date.now() - started, tool).toBeLessThan(2_000);
    }

    // Exercise the installed stdio proxy itself, not only the diagnostic HTTP
    // adapter. A mismatched/null response id was the original hang: spawnSync
    // would hit its 1.9s timeout if the MCP request were left unresolved.
    const bridgeCall = async (workerId: string, id: number) => {
      const input = Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "workers.inspect", arguments: { workerId } },
      })}\n`).toString("base64");
      return captureCommandOutput(
        workspaceId,
        `node -e 'const{spawnSync}=require("node:child_process");const s=Date.now();const r=spawnSync("/usr/local/bin/agentor-management-mcp",[],{input:Buffer.from(process.argv[1],"base64"),encoding:"utf8",timeout:1900});console.log("BRIDGE_MS="+(Date.now()-s));console.log("BRIDGE_STATUS="+r.status);console.log("BRIDGE_OUTPUT="+r.stdout.trim())' '${input}'`,
        10_000,
      );
    };
    const allowedBridge = await bridgeCall(memberId, 41);
    console.log(`MANUAL_GROUP_MCP_IN_GROUP\n${allowedBridge}`);
    expect(allowedBridge).toContain("BRIDGE_STATUS=0");
    expect(allowedBridge).toContain('"id":41');
    expect(allowedBridge).toContain(memberId);
    const deniedBridge = await bridgeCall(outsiderId, 42);
    console.log(`MANUAL_GROUP_MCP_OUT_OF_GROUP\n${deniedBridge}`);
    expect(deniedBridge).toContain("BRIDGE_STATUS=0");
    expect(deniedBridge).toContain('"id":42');
    expect(deniedBridge).toContain('"statusCode":404');
    expect(deniedBridge).not.toContain(outsiderId);
  });

  test("membership changes grant and revoke MCP authority immediately", async ({ request }) => {
    await issueCredential(request);
    const opened = await invoke(request, credential, "console.open", { workerId: memberId });
    expect(opened.status()).toBe(200);
    const sessionId = (await opened.json()).sessionId;
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [memberId, addedMemberId] } })).status()).toBe(200);
    expect((await invoke(request, credential, "workers.inspect", { workerId: addedMemberId })).status()).toBe(200);

    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [addedMemberId] } })).status()).toBe(200);
    expect((await invoke(request, credential, "workers.inspect", { workerId: memberId })).status()).toBe(404);
    expect((await invoke(request, credential, "worker.stop", { workerId: memberId })).status()).toBe(404);
    expect((await invoke(request, credential, "console.read", { sessionId })).status()).toBe(404);
    expect((await invoke(request, credential, "workers.inspect", { workerId: addedMemberId })).status()).toBe(200);
  });

  test("prepared private downloads recheck live group membership", async ({ request }) => {
    await issueCredential(request);
    const listed = await invoke(request, credential, "workspaces.list");
    expect(listed.status()).toBe(200);
    expect((await listed.json()).workspaces.map((item: { id: string }) => item.id)).toEqual([addedMemberId]);
    const prepared = await invoke(request, credential, "workspaces.download", { workspaceId: addedMemberId, paths: [""] });
    expect(prepared.status()).toBe(200);
    const { downloadPath } = await prepared.json();
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [] } })).status()).toBe(200);
    const output = await captureCommandOutput(
      workspaceId,
      `curl -sS -H "Authorization: Bearer $(tr -d '\\n' </run/agentor-management/credential)" --output /dev/null --write-out HTTP_%{http_code} 'http://agentor-orchestrator:3099${downloadPath}'`,
      60_000,
    );
    expect(output).toContain("HTTP_403");
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [addedMemberId] } })).status()).toBe(200);
  });

  test("a permitted lifecycle operation has a real worker side effect", { timeout: 180_000 }, async ({ request }) => {
    await issueCredential(request);
    expect((await invoke(request, credential, "worker.stop", { workerId: addedMemberId })).status()).toBe(200);
    await expect.poll(async () => {
      const workers = await new ApiClient(ownerRequest).listContainers();
      return workers.body.find((worker: { id: string }) => worker.id === addedMemberId)?.status;
    }, { timeout: 60_000 }).toBe("stopped");
    expect((await invoke(request, credential, "worker.start", { workerId: addedMemberId })).status()).toBe(200);
    await waitForWorkerRunning(ownerRequest, addedMemberId, 90_000);
  });

  test("creates evaluation workers directly into the bound group and manages only there", { timeout: 180_000 }, async ({ request }) => {
    await issueCredential(request);
    const displayName = `group-created-evaluation-${Date.now()}`;
    const created = await invoke(request, credential, "workers.create", { displayName });
    expect(created.status()).toBe(200);
    const worker = await created.json();
    createdByGroupId = worker.id;
    expect(worker).toMatchObject({ id: expect.any(String), userId: owner.id });
    const group = await (await ownerRequest.get(`/api/worker-groups/${groupId}`)).json();
    expect(group.workerIds).toContain(createdByGroupId);
    expect((await invoke(request, credential, "workers.inspect", { workerId: createdByGroupId })).status()).toBe(200);
    const renamed = `${displayName}-managed`;
    expect((await invoke(request, credential, "workers.update", { workerId: createdByGroupId, displayName: renamed })).status()).toBe(200);
    const inspected = await invoke(request, credential, "workers.inspect", { workerId: createdByGroupId });
    expect(await inspected.json()).toMatchObject({ id: createdByGroupId, displayName: renamed });
    // Supplying owner/group selectors is rejected even when their values are
    // known: those bindings always come from the workload identity.
    expect((await invoke(request, credential, "workers.create", { displayName: "forbidden", userId: owner.id })).status()).toBe(404);
    expect((await invoke(request, credential, "workers.create", { displayName: "forbidden", groupId })).status()).toBe(404);
  });
});

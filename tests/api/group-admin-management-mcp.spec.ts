import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
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
  let workspaceId = "";
  let credential = "";
  let previousLifecyclePolicy: boolean | undefined;

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
    previousLifecyclePolicy = policy.groups["worker-lifecycle"].enabled;
    expect((await request.put("/api/admin/management-mcp/policy", { data: { groups: { "worker-lifecycle": true } } })).status()).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    if (previousLifecyclePolicy !== undefined) {
      await request.put("/api/admin/management-mcp/policy", { data: { groups: { "worker-lifecycle": previousLifecyclePolicy } } }).catch(() => {});
    }
    if (groupId) await ownerRequest.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    for (const workerId of [memberId, addedMemberId, outsiderId]) {
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
    expect(toolNames).not.toContain("workers.create");
    expect(toolNames).not.toContain("port-mappings.list");
    expect(toolNames).toEqual(expect.arrayContaining(["workspaces.list", "workspaces.files", "workspaces.preview", "workspaces.download"]));
    for (const unavailable of ["workspaces.clone", "imports.prepare", "images.build", "networks.create"])
      expect(toolNames).not.toContain(unavailable);
    const listed = await invoke(request, credential, "workers.list");
    expect(listed.status()).toBe(200);
    const ids = (await listed.json()).workers.map((worker: { id: string }) => worker.id);
    expect(ids).toContain(memberId);
    expect(ids).not.toContain(outsiderId);

    expect((await invoke(request, credential, "workers.inspect", { workerId: memberId })).status()).toBe(200);
    // Direct targeting must enforce the same boundary as discovery; knowing a
    // UUID is not authority to operate on that worker.
    expect((await invoke(request, credential, "workers.inspect", { workerId: outsiderId })).status()).toBe(403);
    expect((await invoke(request, credential, "worker.stop", { workerId: outsiderId })).status()).toBe(403);
  });

  test("membership changes grant and revoke MCP authority immediately", async ({ request }) => {
    await issueCredential(request);
    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [memberId, addedMemberId] } })).status()).toBe(200);
    expect((await invoke(request, credential, "workers.inspect", { workerId: addedMemberId })).status()).toBe(200);

    expect((await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [addedMemberId] } })).status()).toBe(200);
    expect((await invoke(request, credential, "workers.inspect", { workerId: memberId })).status()).toBe(403);
    expect((await invoke(request, credential, "worker.stop", { workerId: memberId })).status()).toBe(403);
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
});

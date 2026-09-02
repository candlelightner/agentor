import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ApiClient } from "../helpers/api-client";
import { cleanupWorker, createWorker, waitForWorkerRunning } from "../helpers/worker-lifecycle";
import { createTestUser, deleteTestUser, type CreatedUser } from "../helpers/test-users";
import { captureCommandOutput, TerminalWsClient } from "../helpers/terminal-ws";
import { buildPng } from "../helpers/clipboard";

const GROUP_ADMIN_ROLE_SKILL_SHA256 = "35c5e2a9a525658160a4f63904b93233f4914e203d4a87e0c86c9b339cc1fe53";

function pluginManifest(suffix: string) {
  return {
    schemaVersion: 1,
    name: `Group plugin ${suffix}`,
    slug: `group-plugin-${suffix.toLowerCase()}`,
    description: "Group-admin plugin scope coverage.",
    version: "1.0.0",
    lifecycle: { start: { argv: ["true"] } },
  };
}

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
  let childGroupId = "";
  let childWorkspaceId = "";
  let siblingGroupId = "";
  let pluginChildGroupId = "";
  let credential = "";
  let groupImageId = "";
  let globalImageId = "";
  let groupImageWorkerId = "";
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
      "locks", "apps", "running-files", "networking", "storage", "images", "image-builds",
      "groups",
    ];
    const enabled: Record<string, boolean> = {};
    for (const name of delegatedGroups) {
      previousDelegatedPolicy[name] = policy.groups[name].enabled;
      enabled[name] = true;
    }
    expect((await request.put("/api/admin/management-mcp/policy", { data: { groups: enabled } })).status()).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    if (groupImageWorkerId) {
      await cleanupWorker(ownerRequest, groupImageWorkerId).catch(() => {});
      groupImageWorkerId = "";
    }
    if (groupImageId && workspaceId) {
      await issueCredential(request).catch(() => {});
      await invoke(request, credential, "images.delete", { definitionId: groupImageId }).catch(() => {});
    }
    if (globalImageId)
      await ownerRequest.delete(`/api/image-catalog/definitions/${globalImageId}`).catch(() => {});
    if (Object.keys(previousDelegatedPolicy).length)
      await request.put("/api/admin/management-mcp/policy", { data: { groups: previousDelegatedPolicy } }).catch(() => {});
    if (groupId)
      await ownerRequest.patch(`/api/worker-groups/${groupId}`, { data: { workerIds: [] } }).catch(() => {});
    for (const workerId of [memberId, addedMemberId, outsiderId, createdByGroupId, groupImageWorkerId]) {
      if (workerId) await cleanupWorker(ownerRequest, workerId).catch(() => {});
    }
    // Group deletion removes its two private administrative networks. It must
    // run after worker cleanup because non-empty groups deliberately reject
    // deletion; doing it first leaked networks across Playwright retries and
    // could exhaust Docker's subnet allocator.
    if (childGroupId) await ownerRequest.delete(`/api/worker-groups/${childGroupId}`).catch(() => {});
    if (pluginChildGroupId) await ownerRequest.delete(`/api/worker-groups/${pluginChildGroupId}`).catch(() => {});
    if (siblingGroupId) await ownerRequest.delete(`/api/worker-groups/${siblingGroupId}`).catch(() => {});
    if (groupId) await ownerRequest.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    await ownerRequest?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("provisions one persistent group-admin workspace and keeps its lifecycle group-bound", { timeout: 180_000 }, async ({ request }) => {
    const first = await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace`, { data: {} });
    expect([200, 201], await first.text()).toContain(first.status());
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
    const initialRole = await captureCommandOutput(workspaceId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-group-administration/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-group-administration/SKILL.md | cut -d' ' -f1)"
      test ! -e ~/.claude/skills/agentor-global-administration && test ! -e ~/.claude/skills/agentor-worker-runtime && printf 'CLAUDE_ISOLATED=1\\n'
      test ! -e ~/.agents/skills/agentor-global-administration && test ! -e ~/.agents/skills/agentor-worker-runtime && printf 'CODEX_ISOLATED=1\\n'
      test ! -e ~/.gemini/commands/agentor-global-administration.toml && test ! -e ~/.gemini/commands/agentor-worker-runtime.toml && printf 'GEMINI_ISOLATED=1\\n'
    `.trim().replace(/\n\s*/g, '; '));
    expect(initialRole).toContain(`CLAUDE_SHA=${GROUP_ADMIN_ROLE_SKILL_SHA256}`);
    expect(initialRole).toContain(`CODEX_SHA=${GROUP_ADMIN_ROLE_SKILL_SHA256}`);
    expect(initialRole).toContain('CLAUDE_ISOLATED=1');
    expect(initialRole).toContain('CODEX_ISOLATED=1');
    expect(initialRole).toContain('GEMINI_ISOLATED=1');
    await captureCommandOutput(workspaceId, `
      mkdir -p ~/.claude/skills/agentor-global-administration ~/.claude/skills/user-kept
      mkdir -p ~/.agents/skills/agentor-worker-runtime ~/.agents/skills/user-kept
      printf stale > ~/.claude/skills/agentor-global-administration/SKILL.md
      printf stale > ~/.agents/skills/agentor-worker-runtime/SKILL.md
      printf keep > ~/.claude/skills/user-kept/SKILL.md
      printf keep > ~/.agents/skills/user-kept/SKILL.md
      printf stale > ~/.gemini/commands/agentor-global-administration.toml
      mkdir -p ~/.hermes-persistent-test
      printf persistent-admin-state > ~/.hermes-persistent-test/state.txt
    `.trim().replace(/\n\s*/g, '; '));
    const persistentSettings = await ownerRequest.put("/api/backup-settings", {
      data: {
        enabled: false,
        selection: "selected",
        workspaceIds: [workspaceId],
        selectedPathsByWorkspace: {
          [workspaceId]: [
            "/workspace",
            "/home/agent/.agent-data",
            "/home/agent/.hermes-persistent-test",
          ],
        },
      },
    });
    expect(persistentSettings.status(), await persistentSettings.text()).toBe(200);
    const rebuildStatuses = await Promise.all([
      ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace/rebuild`).then((response) => response.status()),
      ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace/rebuild`).then((response) => response.status()),
    ]);
    expect(rebuildStatuses.sort((a, b) => a - b)).toEqual([200, 409]);
    await expect.poll(async () => (await ownerRequest.get(`/api/worker-groups/${groupId}/admin-workspace`)).status()).toBe(200);
    expect(await (await ownerRequest.get(`/api/worker-groups/${groupId}/admin-workspace`)).json()).toMatchObject({ id: workspaceId, groupId });
    const rebuiltRole = await captureCommandOutput(workspaceId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-group-administration/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-group-administration/SKILL.md | cut -d' ' -f1)"
      test ! -e ~/.claude/skills/agentor-global-administration && test ! -e ~/.claude/skills/agentor-worker-runtime && printf 'CLAUDE_ISOLATED=1\\n'
      test ! -e ~/.agents/skills/agentor-global-administration && test ! -e ~/.agents/skills/agentor-worker-runtime && printf 'CODEX_ISOLATED=1\\n'
      test ! -e ~/.gemini/commands/agentor-global-administration.toml && test ! -e ~/.gemini/commands/agentor-worker-runtime.toml && printf 'GEMINI_ISOLATED=1\\n'
      printf 'USER_SKILLS=%s\\n' "$(cat ~/.claude/skills/user-kept/SKILL.md ~/.agents/skills/user-kept/SKILL.md)"
      printf 'PERSISTENT_PATH=%s\\n' "$(cat ~/.hermes-persistent-test/state.txt)"
      printf -- '-writable' >> ~/.hermes-persistent-test/state.txt
      printf created > ~/.hermes-persistent-test/after-rebuild.txt
      printf 'PERSISTENT_WRITABLE=%s\\n' "$(cat ~/.hermes-persistent-test/state.txt)"
    `.trim().replace(/\n\s*/g, '; '));
    expect(rebuiltRole).toContain(`CLAUDE_SHA=${GROUP_ADMIN_ROLE_SKILL_SHA256}`);
    expect(rebuiltRole).toContain(`CODEX_SHA=${GROUP_ADMIN_ROLE_SKILL_SHA256}`);
    expect(rebuiltRole).toContain('CLAUDE_ISOLATED=1');
    expect(rebuiltRole).toContain('CODEX_ISOLATED=1');
    expect(rebuiltRole).toContain('GEMINI_ISOLATED=1');
    expect(rebuiltRole).toContain('USER_SKILLS=keepkeep');
    expect(rebuiltRole).toContain('PERSISTENT_PATH=persistent-admin-state');
    expect(rebuiltRole).toContain('PERSISTENT_WRITABLE=persistent-admin-state-writable');

    // A normal inventory refresh must not erase the externally registered
    // administrative runtime. The dashboard polls these endpoints every five
    // seconds and previously fell back to "Desktop is starting..." after any
    // GET /api/containers refresh cleared the registration.
    expect((await ownerRequest.get("/api/containers")).status()).toBe(200);
    const desktopStatus = await ownerRequest.get(`/api/containers/${workspaceId}/desktop/status`);
    expect(desktopStatus.status()).toBe(200);
    expect(await desktopStatus.json()).toMatchObject({ running: true });
    const editorStatus = await ownerRequest.get(`/api/containers/${workspaceId}/editor/status`);
    expect(editorStatus.status()).toBe(200);
    expect(await editorStatus.json()).toMatchObject({ running: true });
    expect((await ownerRequest.get(`/desktop/${workspaceId}/agentor.html`)).status()).toBe(200);
    const clipboard = await ownerRequest.post(`/api/containers/${workspaceId}/clipboard`, {
      headers: { "Content-Type": "image/png" },
      data: buildPng(2, 2),
    });
    expect(clipboard.status()).toBe(200);
    expect(await clipboard.json()).toMatchObject({ ok: true, type: "image/png", width: 2, height: 2 });

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
    const workerMcp = await captureCommandOutput(
      workspaceId,
      `printf '%s\\n' '{"jsonrpc":"2.0","id":72,"method":"initialize","params":{}}' | /usr/local/bin/agentor-worker-mcp`,
    );
    expect(workerMcp).toContain('"name":"agentor-worker"');
    expect(workerMcp).not.toContain('Worker MCP upstream request failed');
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
    const discoveredTools = await discovery.json() as Array<{ name: string; description: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } }>;
    const toolNames=discoveredTools.map((tool)=>tool.name);
    expect(toolNames).toContain("workers.inspect");
    // A group principal cannot restore a multi-worker artifact: new workers
    // would otherwise be created outside its authoritative group assignment.
    expect(toolNames).not.toContain("backups.restore");
    const restoreDeniedAt = Date.now();
    const directRestore = await invoke(request, credential, "backups.restore", {
      artifactId: randomUUID(),
      workspaceIds: [memberId],
    });
    expect(directRestore.status()).toBe(403);
    expect(Date.now() - restoreDeniedAt).toBeLessThan(2_000);
    expect(JSON.stringify(await directRestore.json())).not.toContain(memberId);
    expect(toolNames).toEqual(expect.arrayContaining(["workers.env-keys", "groups.env.list", "groups.env.update"]));
    expect(toolNames).toEqual(expect.arrayContaining([
      "admin-workspace.startup-script.get", "admin-workspace.startup-script.set",
      "groups.admin-workspace.startup-script.get", "groups.admin-workspace.startup-script.set",
    ]));
    expect(toolNames).toEqual(expect.arrayContaining([
      "groups.list", "groups.create", "groups.update", "groups.delete", "groups.assign-worker",
      "groups.workers.stop", "groups.workers.rebuild", "groups.workers.archive",
    ]));
    expect(toolNames).toContain("workers.create");
    expect(toolNames).toEqual(expect.arrayContaining([
      "host-mounts.delegations.list",
      "host-mounts.delegations.create",
      "host-mounts.delegations.delete",
    ]));
    expect(toolNames).not.toContain("host-mounts.catalog.create");
    expect(toolNames).not.toContain("port-mappings.list");
    expect(toolNames).toEqual(expect.arrayContaining(["workspaces.list", "workspaces.files", "workspaces.preview", "workspaces.download"]));
    expect(toolNames).toEqual(expect.arrayContaining([
      "images.list", "images.get", "images.create", "images.update", "images.validate",
      "images.delete", "images.delete-version", "images.build", "images.build-status",
      "images.build-logs", "images.build-cancel", "images.validation-retry",
      "images.test-worker", "images.promote", "images.rollback",
    ]));
    for (const tool of discoveredTools.filter((item) => item.name.startsWith("images."))) {
      expect(tool.description).toContain("authorized image hierarchy");
      expect(tool.inputSchema.required || []).not.toContain("ownerId");
      expect(tool.inputSchema.properties || {}).not.toHaveProperty("ownerId");
      expect(tool.inputSchema.properties || {}).not.toHaveProperty("groupId");
      if (tool.name === "images.create")
        expect(tool.inputSchema.properties || {}).toHaveProperty("targetGroupId");
      else
        expect(tool.inputSchema.properties || {}).not.toHaveProperty("targetGroupId");
    }
    const schemas = new Map(discoveredTools.map((tool) => [tool.name, tool.inputSchema]));
    const delegationCreate = schemas.get("host-mounts.delegations.create");
    expect(delegationCreate).toMatchObject({
      additionalProperties: false,
      required: ["pathId", "targetType", "targetId"],
    });
    expect(delegationCreate?.properties || {}).not.toHaveProperty("sourcePath");
    expect(schemas.get("backups.create")?.required).toEqual(["workspaceIds"]);
    expect(schemas.get("backups.create")?.properties || {}).not.toHaveProperty("ownerId");
    expect(schemas.get("backups.paths.list")?.required).toEqual(["workerId"]);
    expect(schemas.get("backups.paths.list")?.properties || {}).not.toHaveProperty("ownerId");
    expect((schemas.get("workers.create")?.properties as any)?.timeoutSeconds).toMatchObject({
      type: "integer", minimum: 1, maximum: 120,
    });
    expect(discoveredTools.find((tool) => tool.name === "workers.create")?.description).toContain("timeoutSeconds");
    expect(Object.keys(schemas.get("networks.list")?.properties || {})).toEqual([]);
    expect(Object.keys(schemas.get("networks.inspect")?.properties || {})).toEqual(["networkId"]);
    expect(Object.keys(schemas.get("networks.reconcile")?.properties || {}).sort()).toEqual(["lockPasswords", "networkId"]);
    expect(Object.keys(schemas.get("networks.delete")?.properties || {}).sort()).toEqual(["lockPasswords", "networkId"]);
    expect(Object.keys(schemas.get("networks.create")?.properties || {}).sort()).toEqual(["groupId", "lockPasswords", "name", "scope", "workerIds"]);
    for (const name of toolNames.filter((candidate) => candidate.startsWith("networks.")))
      expect(discoveredTools.find((tool) => tool.name === name)?.description).toContain("bound administrative group");
    expect(Object.keys(schemas.get("groups.update")?.properties || {})).not.toContain("workerIds");
    expect(schemas.get("groups.assign-worker")).toMatchObject({ required: ["workerId", "targetGroupId"] });
    expect((schemas.get("groups.env.update")?.properties as any)?.entries?.items?.properties?.value).toMatchObject({ writeOnly: true });
    for (const name of ["groups.workers.stop", "groups.workers.rebuild", "groups.workers.archive"]) {
      expect(schemas.get(name)).toMatchObject({
        additionalProperties: false,
        required: ["groupId"],
        properties: {
          lockPasswords: { additionalProperties: { type: "string", writeOnly: true } },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
        },
      });
      expect(discoveredTools.find(tool => tool.name === name)?.description).toContain("descendant");
      expect(discoveredTools.find(tool => tool.name === name)?.description).toContain("Administrative workspaces are not affected");
    }
    expect(Object.keys(schemas.get("admin-workspace.startup-script.get")?.properties || {})).toEqual(["timeoutSeconds"]);
    expect(Object.keys(schemas.get("admin-workspace.startup-script.set")?.properties || {}).sort()).toEqual(["startupScript", "timeoutSeconds"]);
    expect((schemas.get("admin-workspace.startup-script.set")?.properties as any)?.startupScript).toMatchObject({ type: "string", maxLength: 65_536 });
    for (const name of toolNames.filter((candidate) => candidate.startsWith("groups."))) {
      const description = discoveredTools.find((tool) => tool.name === name)?.description || "";
      expect(description).toContain("bound");
      expect(description).not.toContain("explicit owner");
    }
    for (const unavailable of ["workspaces.clone", "imports.prepare", "images.default", "images.git-sync"])
      expect(toolNames).not.toContain(unavailable);
    const listed = await invoke(request, credential, "workers.list");
    expect(listed.status()).toBe(200);
    const ids = (await listed.json()).workers.map((worker: { id: string }) => worker.id);
    expect(ids).toEqual([memberId]);

    // Backup path selection is available through the group MCP as well as the
    // GUI. The owner is derived from the bound identity, and the group's own
    // administrative workspace is a valid path-browsing target even though it
    // is intentionally omitted from workers.list().
    const ownPaths = await invoke(request, credential, "backups.paths.list", {
      workerId: workspaceId,
      path: "/workspace",
    });
    expect(ownPaths.status(), await ownPaths.text()).toBe(200);
    const selectedBackup = await invoke(request, credential, "backups.create", {
      workspaceIds: [memberId],
      selectedPathsByWorkspace: { [memberId]: ["/workspace"] },
    });
    expect(selectedBackup.status(), await selectedBackup.text()).toBe(200);
    const selectedBackupJob = await selectedBackup.json();
    expect(selectedBackupJob).toMatchObject({ workspaceIds: [memberId] });
    await invoke(request, credential, "backups.cancel", { jobId: selectedBackupJob.id });
    // The calling administrative workspace is also backup-addressable. This
    // must enqueue through the same owner-scoped path as ordinary workers,
    // even when its external ContainerManager registration was refreshed.
    const adminBackup = await invoke(request, credential, "backups.create", {
      workspaceIds: [workspaceId],
      selectedPathsByWorkspace: { [workspaceId]: ["/workspace"] },
    });
    expect(adminBackup.status(), await adminBackup.text()).toBe(200);
    const adminBackupJob = await adminBackup.json();
    expect(adminBackupJob).toMatchObject({ workspaceIds: [workspaceId] });
    await invoke(request, credential, "backups.cancel", { jobId: adminBackupJob.id });
    const deniedSelectedPath = await invoke(request, credential, "backups.create", {
      workspaceIds: [memberId],
      selectedPathsByWorkspace: { [outsiderId]: ["/workspace"] },
    });
    expect(deniedSelectedPath.status()).toBe(404);

    expect((await invoke(request, credential, "workers.inspect", { workerId: memberId })).status()).toBe(200);
    // Direct targeting must enforce the same boundary as discovery; knowing a
    // UUID is not authority to operate on that worker.
    const denied = await invoke(request, credential, "workers.inspect", { workerId: outsiderId });
    const unknown = await invoke(request, credential, "workers.inspect", { workerId: randomUUID() });
    expect(denied.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());
    const names = await invoke(request, credential, "workers.env-keys", { workerId: memberId });
    expect(names.status()).toBe(200);
    const namesBody = await names.json();
    expect(namesBody).toMatchObject({ predefinedKeys: expect.any(Array), customKeys: expect.any(Array), keys: expect.any(Array), groupKeys: expect.any(Array) });
    expect(JSON.stringify(namesBody)).not.toContain('"value"');
    const deniedNames = await invoke(request, credential, "workers.env-keys", { workerId: outsiderId });
    const unknownNames = await invoke(request, credential, "workers.env-keys", { workerId: randomUUID() });
    expect(deniedNames.status()).toBe(404);
    expect(await deniedNames.json()).toEqual(await unknownNames.json());

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

  test("delegates only an explicitly granted host path downward through MCP", async ({ request }) => {
    await issueCredential(request);
    let pathId = "";
    let childGroupId = "";
    try {
      const pathResponse = await request.post("/api/host-mounts", {
        data: {
          name: `group-mcp-path-${Date.now()}`,
          sourcePath: `/tmp/group-mcp-path-${Date.now()}`,
        },
      });
      expect(pathResponse.status(), await pathResponse.text()).toBe(201);
      pathId = (await pathResponse.json()).id;
      expect((await request.put("/api/host-mounts/entitlements", {
        data: { ownerId: owner.id, pathId, enabled: true },
      })).status()).toBe(200);
      expect((await ownerRequest.post("/api/host-mounts/grants", {
        data: { pathId, targetType: "group", targetId: groupId },
      })).status()).toBe(201);

      const child = await invoke(request, credential, "groups.create", {
        name: `mount-delegation-child-${Date.now()}`,
        parentId: groupId,
      });
      expect(child.status(), await child.text()).toBe(200);
      childGroupId = (await child.json()).id;

      const listed = await invoke(request, credential, "host-mounts.delegations.list");
      expect(listed.status(), await listed.text()).toBe(200);
      const listedBody = await listed.json();
      expect(listedBody.availablePaths).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: pathId })]),
      );
      expect(listedBody.delegablePaths).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: pathId })]),
      );
      expect(listedBody.availablePaths.find((path: { id: string }) => path.id === pathId))
        .not.toHaveProperty("sourcePath");
      expect(listedBody.delegablePaths.find((path: { id: string }) => path.id === pathId))
        .not.toHaveProperty("sourcePath");
      const delegated = await invoke(
        request,
        credential,
        "host-mounts.delegations.create",
        { pathId, targetType: "group", targetId: childGroupId },
      );
      expect(delegated.status(), await delegated.text()).toBe(200);
      const grant = await delegated.json();
      expect(grant).toMatchObject({
        pathId,
        targetType: "group",
        targetId: childGroupId,
        grantorType: "group",
        grantorGroupId: groupId,
      });
      expect((await invoke(
        request,
        credential,
        "host-mounts.delegations.delete",
        { grantId: grant.id },
      )).status()).toBe(200);

      // Raw path approval is never available to a group workspace, even when
      // the caller guesses the platform tool name.
      expect((await invoke(
        request,
        credential,
        "host-mounts.catalog.create",
        { name: "forbidden", sourcePath: "/tmp/forbidden-group-admin" },
      )).status()).toBe(403);
    } finally {
      if (pathId) await request.delete(`/api/host-mounts/${pathId}`).catch(() => undefined);
      if (childGroupId)
        await ownerRequest.delete(`/api/worker-groups/${childGroupId}`).catch(() => undefined);
    }
  });

  test("self, parent, and platform identities manage only authorized administrative startup scripts", { timeout: 360_000 }, async ({ request }) => {
    await issueCredential(request);
    const initial = await invoke(request, credential, "admin-workspace.startup-script.get");
    expect(initial.status()).toBe(200);
    const initialSettings = await initial.json();
    const marker = `/workspace/.group-admin-startup-${Date.now()}`;
    const startupScript = `#!/bin/bash\nprintf 'run\\n' >> '${marker}'`;
    const saved = await invoke(request, credential, "admin-workspace.startup-script.set", { startupScript });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toMatchObject({
      script: startupScript,
      configured: true,
      revision: initialSettings.revision + 1,
      pendingRebuild: true,
      runtime: { state: "pending-rebuild" },
    });
    expect((await invoke(request, credential, "groups.admin-workspace.stop", { groupId })).status()).toBe(200);
    expect((await invoke(request, credential, "groups.admin-workspace.start", { groupId })).status()).toBe(200);
    await expect.poll(async () =>
      (await captureCommandOutput(workspaceId, `wc -l < '${marker}'`)).trim(),
      { timeout: 30_000 },
    ).toContain("1");
    await expect.poll(async () =>
      (await (await invoke(request, credential, "admin-workspace.startup-script.get")).json()).runtime,
      { timeout: 10_000 },
    ).toMatchObject({ state: "succeeded", exitCode: 0 });

    const child = await ownerRequest.post("/api/worker-groups", {
      data: { name: `startup-child-${Date.now()}`, parentId: groupId },
    });
    expect(child.status()).toBe(201);
    childGroupId = (await child.json()).id;
    const childWorkspace = await ownerRequest.post(
      `/api/worker-groups/${childGroupId}/admin-workspace`,
      { data: {} },
    );
    expect([200, 201]).toContain(childWorkspace.status());
    childWorkspaceId = (await childWorkspace.json()).id;
    const sibling = await ownerRequest.post("/api/worker-groups", {
      data: { name: `startup-sibling-${Date.now()}` },
    });
    expect(sibling.status()).toBe(201);
    siblingGroupId = (await sibling.json()).id;

    await issueCredential(request);
    const childScript = "#!/bin/bash\necho managed-by-parent";
    const parentSet = await invoke(
      request,
      credential,
      "groups.admin-workspace.startup-script.set",
      { groupId: childGroupId, startupScript: childScript },
    );
    expect(parentSet.status()).toBe(200);
    expect(await parentSet.json()).toMatchObject({ script: childScript, pendingRebuild: true });
    const siblingDenied = await invoke(
      request,
      credential,
      "groups.admin-workspace.startup-script.set",
      { groupId: siblingGroupId, startupScript: "echo forbidden" },
    );
    const unknownDenied = await invoke(
      request,
      credential,
      "groups.admin-workspace.startup-script.set",
      { groupId: randomUUID(), startupScript: "echo forbidden" },
    );
    expect(siblingDenied.status()).toBe(404);
    expect(await siblingDenied.json()).toEqual(await unknownDenied.json());

    const platformWorkspace = await (await request.get("/api/admin/workspace")).json();
    const platformIdentity = await request.post(
      "/api/admin/management-mcp/diagnostics/issue-identity",
      { data: { workspaceId: platformWorkspace.id, ttlSeconds: 60 } },
    );
    expect(platformIdentity.status()).toBe(201);
    const platformCredential = (await platformIdentity.json()).credential;
    const globalScript = "#!/bin/bash\necho managed-by-global";
    const globalSet = await invoke(
      request,
      platformCredential,
      "groups.admin-workspace.startup-script.set",
      { groupId: childGroupId, startupScript: globalScript },
    );
    expect(globalSet.status()).toBe(200);
    expect(await globalSet.json()).toMatchObject({ script: globalScript, pendingRebuild: true });
    expect(childWorkspaceId).toEqual(expect.any(String));

    await issueCredential(request);
    expect((await invoke(request, credential, "admin-workspace.startup-script.set", { startupScript: "" })).status()).toBe(200);
    expect((await invoke(request, credential, "groups.admin-workspace.rebuild", { groupId })).status()).toBe(200);
    expect(await (await invoke(request, credential, "admin-workspace.startup-script.get")).json()).toMatchObject({
      script: "", configured: false, pendingRebuild: false, runtime: { state: "not-configured" },
    });
    expect((await invoke(request, credential, "groups.admin-workspace.startup-script.set", { groupId: childGroupId, startupScript: "" })).status()).toBe(200);
  });

  test("group-admin plugin definitions allow the subtree and hide denied targets as 404", async ({ request }) => {
    const child = await ownerRequest.post("/api/worker-groups", {
      data: { name: `plugin-child-${Date.now()}`, parentId: groupId },
    });
    expect(child.status()).toBe(201);
    pluginChildGroupId = (await child.json()).id;
    expect((await ownerRequest.patch(`/api/worker-groups/${pluginChildGroupId}`, {
      data: { workerIds: [addedMemberId] },
    })).status()).toBe(200);

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let descendantDefinitionId = "";
    let siblingDefinitionId = "";
    try {
      await issueCredential(request);
      const created = await invoke(request, credential, "plugins.definitions.create", {
        workerId: addedMemberId,
        scope: "group",
        groupId: pluginChildGroupId,
        manifest: pluginManifest(suffix),
      });
      expect(created.status(), await created.text()).toBe(200);
      descendantDefinitionId = (await created.json()).id;

      const updated = await invoke(request, credential, "plugins.definitions.update", {
        workerId: addedMemberId,
        definitionId: descendantDefinitionId,
        manifest: { ...pluginManifest(`${suffix}-updated`), name: `Group plugin ${suffix} updated` },
      });
      expect(updated.status()).toBe(200);

      const siblingDefinition = await ownerRequest.post("/api/plugins/definitions", {
        data: { scope: "worker", workerId: outsiderId, manifest: pluginManifest(`${suffix}-sibling`) },
      });
      expect(siblingDefinition.status()).toBe(201);
      siblingDefinitionId = (await siblingDefinition.json()).id;
      const denied = await invoke(request, credential, "plugins.definitions.update", {
        workerId: outsiderId,
        definitionId: siblingDefinitionId,
        manifest: pluginManifest(`${suffix}-denied`),
      });
      const unknown = await invoke(request, credential, "plugins.definitions.update", {
        workerId: randomUUID(),
        definitionId: randomUUID(),
        manifest: pluginManifest(`${suffix}-unknown`),
      });
      expect(denied.status()).toBe(404);
      expect(await denied.json()).toEqual(await unknown.json());
    } finally {
      if (descendantDefinitionId) await ownerRequest.delete(`/api/plugins/definitions/${descendantDefinitionId}`).catch(() => {});
      if (siblingDefinitionId) await ownerRequest.delete(`/api/plugins/definitions/${siblingDefinitionId}`).catch(() => {});
      if (pluginChildGroupId) {
        await ownerRequest.patch(`/api/worker-groups/${pluginChildGroupId}`, { data: { workerIds: [] } }).catch(() => {});
        await ownerRequest.delete(`/api/worker-groups/${pluginChildGroupId}`).catch(() => {});
        pluginChildGroupId = "";
      }
    }
  });

  test("group-admin MCP rejects undeclared plugin environment references", async ({ request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let definitionId = "";
    try {
      await issueCredential(request);
      const created = await invoke(request, credential, "plugins.definitions.create", {
        workerId: memberId,
        scope: "worker",
        manifest: { ...pluginManifest(suffix), environment: { envKeys: ["DECLARED_ENV"], secretKeys: ["DECLARED_SECRET"] } },
      });
      expect(created.status(), await created.text()).toBe(200);
      definitionId = (await created.json()).id;

      for (const args of [{ envKeys: ["UNDECLARED_ENV"] }, { secretKeys: ["UNDECLARED_SECRET"] }]) {
        const rejected = await invoke(request, credential, "plugins.install", { workerId: memberId, definitionId, ...args });
        expect(rejected.status()).toBe(400);
      }
    } finally {
      if (definitionId) await ownerRequest.delete(`/api/plugins/definitions/${definitionId}`).catch(() => {});
    }
  });

  test("group environment values are write-only and audit-safe", async ({ request }) => {
    await issueCredential(request);
    const secret = `must-not-leak-${randomUUID()}`;
    const updated = await invoke(request, credential, "groups.env.update", {
      groupId,
      entries: [{ key: "GROUP_MCP_SECRET", value: secret }],
    });
    expect(updated.status()).toBe(200);
    const body = await updated.json();
    expect(body.ownKeys).toContain("GROUP_MCP_SECRET");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('"value"');
    const listed = await invoke(request, credential, "groups.env.list", { groupId });
    expect(listed.status()).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(secret);
    const audit = await request.get("/api/admin/management-mcp/audit?limit=25");
    expect(audit.status()).toBe(200);
    expect(await audit.text()).not.toContain(secret);
    expect((await invoke(request, credential, "groups.env.update", { groupId, deleteKeys: ["GROUP_MCP_SECRET"] })).status()).toBe(200);
  });

  test("manages a private group image catalog without exposing the owner catalog", async ({ request }) => {
    await issueCredential(request);
    const definition = {
      name: `group-private-${Date.now()}`,
      description: "group private image",
      baseImage: "agentor-worker:approved-test",
      dockerfileFragment: "RUN echo group-private",
      contextFiles: [],
    };
    const created = await invoke(request, credential, "images.create", { definition });
    expect(created.status()).toBe(200);
    const groupImage = await created.json();
    groupImageId = groupImage.id;
    expect(groupImage).toMatchObject({ ownerId: owner.id, groupId });
    expect((await ownerRequest.delete(`/api/worker-groups/${groupId}`)).status()).toBe(409);

    const globalCreated = await ownerRequest.post("/api/image-catalog/definitions", { data: { ...definition, name: `${definition.name}-global` } });
    expect(globalCreated.status()).toBe(201);
    globalImageId = (await globalCreated.json()).id;

    const listed = await invoke(request, credential, "images.list");
    const listedImages = await listed.json();
    expect(listedImages.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([groupImageId, globalImageId]));
    expect(listedImages.find((item: { id: string }) => item.id === groupImageId).access).toMatchObject({ manageable: true, owningGroupId: groupId });
    expect(listedImages.find((item: { id: string }) => item.id === globalImageId).access).toMatchObject({ manageable: false, usable: true });
    expect((await invoke(request, credential, "images.list", { ownerId: owner.id })).status()).toBe(404);
    expect((await invoke(request, credential, "images.list", { groupId })).status()).toBe(404);
    expect((await invoke(request, credential, "images.get", { definitionId: groupImageId })).status()).toBe(200);
    expect((await invoke(request, credential, "images.get", { definitionId: globalImageId })).status()).toBe(200);
    const denied = await invoke(request, credential, "images.update", { definitionId: globalImageId, definition });
    const unknown = await invoke(request, credential, "images.get", { definitionId: randomUUID() });
    expect(denied.status()).toBe(404);
    expect(await denied.json()).toEqual(await unknown.json());

    const updated = await invoke(request, credential, "images.update", {
      definitionId: groupImageId,
      definition: { ...definition, description: "updated in group only" },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).description).toBe("updated in group only");

    const requestId = `group-image-build-${Date.now()}`;
    const build = await invoke(request, credential, "images.build", { definitionId: groupImageId, builder: "fake", requestId });
    expect(build.status()).toBe(200);
    const accepted = await build.json();
    const buildId = accepted.id;
    expect(accepted).toMatchObject({
      accepted: true,
      jobId: buildId,
      requestId,
      nextActions: {
        status: { tool: "images.build-status", arguments: { buildId } },
        logs: { tool: "images.build-logs", arguments: { buildId } },
        cancel: { tool: "images.build-cancel", arguments: { buildId } },
      },
    });
    const duplicate = await invoke(request, credential, "images.build", { definitionId: groupImageId, builder: "fake", requestId });
    expect(duplicate.status()).toBe(200);
    expect((await duplicate.json()).id).toBe(buildId);
    await expect.poll(async () => {
      const response = await invoke(request, credential, "images.build-status", { buildId });
      const status = await response.json();
      expect(status.nextActions).toMatchObject({
        status: { tool: "images.build-status", arguments: { buildId } },
        logs: { tool: "images.build-logs", arguments: { buildId } },
      });
      return status.status;
    }, { timeout: 10_000 }).toBe("succeeded");
    const terminalDuplicate = await invoke(request, credential, "images.build", {
      definitionId: groupImageId,
      builder: "fake",
      requestId,
    });
    expect(terminalDuplicate.status()).toBe(200);
    const terminalAccepted = await terminalDuplicate.json();
    expect(terminalAccepted).toMatchObject({
      id: buildId,
      status: "succeeded",
      nextActions: {
        status: { tool: "images.build-status", arguments: { buildId } },
        logs: { tool: "images.build-logs", arguments: { buildId } },
      },
    });
    expect(terminalAccepted.nextActions.cancel).toBeUndefined();
    const logResponse = await invoke(request, credential, "images.build-logs", { buildId, after: 0, limit: 1 });
    expect(logResponse.status()).toBe(200);
    expect(await logResponse.json()).toMatchObject({ after: 0, nextCursor: expect.any(Number), hasMore: expect.any(Boolean) });
    expect((await invoke(request, credential, "images.promote", { definitionId: groupImageId, version: "v1" })).status()).toBe(200);

    const ownerCatalog = await ownerRequest.get("/api/image-catalog/definitions");
    expect((await ownerCatalog.json()).find((item: { id: string }) => item.id === groupImageId)).toMatchObject({ groupId });
    expect((await invoke(request, credential, "images.build", { definitionId: globalImageId, builder: "fake" })).status()).toBe(404);

    // Catalog builds can refresh Docker inventory. Reconcile the persistent
    // external admin runtime before later tests exercise its terminal.
    const reconciled = await ownerRequest.post(`/api/worker-groups/${groupId}/admin-workspace`, { data: {} });
    expect(reconciled.status()).toBe(200);
    expect((await reconciled.json()).id).toBe(workspaceId);

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

  test("cannot use group replacement to enroll workers outside its subtree", async ({ request }) => {
    await issueCredential(request);
    const beforeResponse = await ownerRequest.get(`/api/worker-groups/${groupId}`);
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json();

    const siblingAttempt = await invoke(request, credential, "groups.update", {
      groupId,
      workerIds: [...before.workerIds, outsiderId],
    });
    const randomAttempt = await invoke(request, credential, "groups.update", {
      groupId,
      workerIds: [...before.workerIds, randomUUID()],
    });
    expect(siblingAttempt.status()).toBe(404);
    expect(randomAttempt.status()).toBe(404);
    expect(await siblingAttempt.json()).toEqual(await randomAttempt.json());

    const after = await (await ownerRequest.get(`/api/worker-groups/${groupId}`)).json();
    expect(after.workerIds).toEqual(before.workerIds);
    expect(after.workerIds).not.toContain(outsiderId);
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

  test("recursively manages ordinary workers in a descendant subtree and denies sibling groups promptly", { timeout: 360_000 }, async ({ request }) => {
    let batchGroupId = "";
    let batchGrandchildId = "";
    const workerIds: string[] = [];
    try {
      await issueCredential(request);
      const child = await invoke(request, credential, "groups.create", {
        name: `batch-child-${Date.now()}`,
        parentId: groupId,
      });
      expect(child.status(), await child.text()).toBe(200);
      batchGroupId = (await child.json()).id;
      const grandchild = await invoke(request, credential, "groups.create", {
        name: `batch-grandchild-${Date.now()}`,
        parentId: batchGroupId,
      });
      expect(grandchild.status(), await grandchild.text()).toBe(200);
      batchGrandchildId = (await grandchild.json()).id;
      for (const targetGroupId of [batchGroupId, batchGrandchildId]) {
        const created = await invoke(request, credential, "workers.create", {
          displayName: `batch-member-${Date.now()}-${workerIds.length}`,
          targetGroupId,
        });
        expect(created.status(), await created.text()).toBe(200);
        workerIds.push((await created.json()).id);
      }

      await issueCredential(request);
      const stopped = await invoke(request, credential, "groups.workers.stop", {
        groupId: batchGroupId,
        timeoutSeconds: 180,
      });
      expect(stopped.status(), await stopped.text()).toBe(200);
      expect(await stopped.json()).toMatchObject({
        action: "stop",
        groupIds: expect.arrayContaining([batchGroupId, batchGrandchildId]),
        succeededWorkerIds: expect.arrayContaining(workerIds),
        failures: [],
      });
      const stoppedWorkers = await new ApiClient(ownerRequest).listContainers();
      for (const workerId of workerIds)
        expect(stoppedWorkers.body.find((worker: { id: string }) => worker.id === workerId)?.status).toBe("stopped");

      await issueCredential(request);
      const rebuilt = await invoke(request, credential, "groups.workers.rebuild", {
        groupId: batchGroupId,
        timeoutSeconds: 300,
      });
      expect(rebuilt.status(), await rebuilt.text()).toBe(200);
      for (const workerId of workerIds) await waitForWorkerRunning(ownerRequest, workerId, 90_000);

      const randomGroupId = randomUUID();
      await issueCredential(request);
      const deniedAt = Date.now();
      const siblingDenied = await invoke(request, credential, "groups.workers.archive", {
        groupId: siblingGroupId,
        timeoutSeconds: 1,
      });
      const randomDenied = await invoke(request, credential, "groups.workers.archive", {
        groupId: randomGroupId,
        timeoutSeconds: 1,
      });
      expect(siblingDenied.status()).toBe(404);
      expect(randomDenied.status()).toBe(404);
      expect(Date.now() - deniedAt).toBeLessThan(2_000);
      expect(await siblingDenied.json()).toEqual(await randomDenied.json());

      await issueCredential(request);
      const archived = await invoke(request, credential, "groups.workers.archive", {
        groupId: batchGroupId,
        timeoutSeconds: 180,
      });
      expect(archived.status(), await archived.text()).toBe(200);
      expect(await archived.json()).toMatchObject({
        action: "archive",
        succeededWorkerIds: expect.arrayContaining(workerIds),
        failures: [],
      });
      const archivedIds = (await (await ownerRequest.get("/api/archived")).json() as Array<{ id: string }>).map(worker => worker.id);
      expect(archivedIds).toEqual(expect.arrayContaining(workerIds));

      await issueCredential(request);
      const listedGroups = await invoke(request, credential, "groups.list", {});
      expect(listedGroups.status(), await listedGroups.text()).toBe(200);
      const visibleGroups = await listedGroups.json() as Array<any>;
      expect(visibleGroups.find(group => group.id === batchGroupId)).toMatchObject({
        memberCounts: { total: 1, active: 0, archived: 1 },
      });
      expect(visibleGroups.find(group => group.id === batchGrandchildId)).toMatchObject({
        memberCounts: { total: 1, active: 0, archived: 1 },
      });

      await issueCredential(request);
      for (const workerId of workerIds)
        expect((await invoke(request, credential, "workers.delete", { workerId })).status()).toBe(200);
      workerIds.length = 0;
      expect((await invoke(request, credential, "groups.delete", { groupId: batchGrandchildId })).status()).toBe(200);
      batchGrandchildId = "";
      expect((await invoke(request, credential, "groups.delete", { groupId: batchGroupId })).status()).toBe(200);
      batchGroupId = "";
    } finally {
      for (const workerId of workerIds) await cleanupWorker(ownerRequest, workerId).catch(() => {});
      if (batchGrandchildId) await ownerRequest.delete(`/api/worker-groups/${batchGrandchildId}`).catch(() => {});
      if (batchGroupId) await ownerRequest.delete(`/api/worker-groups/${batchGroupId}`).catch(() => {});
    }
  });

  test("creates evaluation workers directly into the bound group and manages only there", { timeout: 180_000 }, async ({ request }) => {
    await issueCredential(request);
    const inheritedSecret = `initial-group-secret-${randomUUID()}`;
    expect((await invoke(request, credential, "groups.env.update", {
      groupId,
      entries: [
        { key: "GROUP_INITIAL_VISIBLE", value: inheritedSecret },
        { key: "GROUP_INITIAL_BLOCKED", value: "must-not-be-injected" },
      ],
    })).status()).toBe(200);
    expect((await invoke(request, credential, "workers.create", {
      displayName: "invalid-group-exclusion",
      excludedGroupEnvVarKeys: ["UNKNOWN_GROUP_KEY"],
    })).status()).toBe(400);
    const displayName = `group-created-evaluation-${Date.now()}`;
    const created = await invoke(request, credential, "workers.create", {
      displayName,
      excludedGroupEnvVarKeys: ["GROUP_INITIAL_BLOCKED"],
    });
    expect(created.status()).toBe(200);
    const worker = await created.json();
    createdByGroupId = worker.id;
    expect(worker).toMatchObject({ id: expect.any(String), userId: owner.id });
    const group = await (await ownerRequest.get(`/api/worker-groups/${groupId}`)).json();
    expect(group.workerIds).toContain(createdByGroupId);
    await waitForWorkerRunning(ownerRequest, createdByGroupId, 90_000);
    const inheritedEnvironment = await captureCommandOutput(
      createdByGroupId,
      `printf 'visible=%s\\nblocked=%s' "$GROUP_INITIAL_VISIBLE" "${"${GROUP_INITIAL_BLOCKED+present}"}"`,
      60_000,
    );
    expect(inheritedEnvironment).toBe(`visible=${inheritedSecret}\nblocked=`);
    expect((await invoke(request, credential, "workers.inspect", { workerId: createdByGroupId })).status()).toBe(200);
    const renamed = `${displayName}-managed`;
    expect((await invoke(request, credential, "workers.update", { workerId: createdByGroupId, displayName: renamed })).status()).toBe(200);
    const inspected = await invoke(request, credential, "workers.inspect", { workerId: createdByGroupId });
    expect(await inspected.json()).toMatchObject({ id: createdByGroupId, displayName: renamed });
    // Supplying owner/group selectors is rejected even when their values are
    // known: those bindings always come from the workload identity.
    expect((await invoke(request, credential, "workers.create", { displayName: "forbidden", userId: owner.id })).status()).toBe(404);
    expect((await invoke(request, credential, "workers.create", { displayName: "forbidden", groupId })).status()).toBe(404);

    const workerFromImage = await invoke(request, credential, "workers.create", {
      displayName: `group-image-worker-${Date.now()}`,
      imageDefinitionId: groupImageId,
      imageVersion: "v1",
    });
    expect(workerFromImage.status()).toBe(200);
    groupImageWorkerId = (await workerFromImage.json()).id;
    expect((await (await ownerRequest.get(`/api/worker-groups/${groupId}`)).json()).workerIds).toContain(groupImageWorkerId);
    expect((await invoke(request, credential, "groups.env.update", {
      groupId,
      deleteKeys: ["GROUP_INITIAL_VISIBLE", "GROUP_INITIAL_BLOCKED"],
    })).status()).toBe(200);
  });

  test("deleting a worker clears membership so its group admin can delete the emptied child group", { timeout: 180_000 }, async ({ request }) => {
    await issueCredential(request);
    const child = await invoke(request, credential, "groups.create", {
      name: `delete-after-worker-${Date.now()}`,
      parentId: groupId,
    });
    expect(child.status()).toBe(200);
    const deletionGroupId = (await child.json()).id;
    const created = await invoke(request, credential, "workers.create", {
      displayName: `deleted-child-member-${Date.now()}`,
      targetGroupId: deletionGroupId,
    });
    expect(created.status()).toBe(200);
    const deletionWorkerId = (await created.json()).id;
    expect((await invoke(request, credential, "workers.delete", {
      workerId: deletionWorkerId,
    })).status()).toBe(200);
    const emptied = await ownerRequest.get(`/api/worker-groups/${deletionGroupId}`);
    expect(emptied.status()).toBe(200);
    expect((await emptied.json()).workerIds).toEqual([]);
    expect((await invoke(request, credential, "groups.delete", {
      groupId: deletionGroupId,
    })).status()).toBe(200);
    // Missing owner-scoped resources use the route's normal non-disclosure
    // response (403). Confirm actual deletion through the authoritative list.
    expect((await ownerRequest.get(`/api/worker-groups/${deletionGroupId}`)).status()).toBe(403);
    const remaining = await (await ownerRequest.get("/api/worker-groups")).json();
    expect(remaining.some((candidate: { id: string }) => candidate.id === deletionGroupId)).toBe(false);
  });
});

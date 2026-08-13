import { createHash } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import { cleanupWorker, createWorker } from "../helpers/worker-lifecycle";
import { captureCommandOutput } from "../helpers/terminal-ws";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

test.describe.serial("Private management MCP downloads", () => {
  let owner: CreatedUser;
  let ownerContext: APIRequestContext;
  let adminContext: APIRequestContext;
  let originalPolicy: Record<string, boolean> = {};
  let workerId = "";
  let adminWorkspaceId = "";

  test.beforeAll(async ({ request }) => {
    adminContext = request;
    const policyResponse = await request.get("/api/admin/management-mcp/policy");
    expect(policyResponse.status()).toBe(200);
    const policy = await policyResponse.json();
    originalPolicy = Object.fromEntries(
      Object.entries(policy.groups).map(([name, value]: [string, any]) => [
        name,
        value.enabled,
      ]),
    );
    owner = await createTestUser("MCP Download Owner");
    ownerContext = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await new ApiClient(ownerContext).signInEmail(
          owner.email,
          owner.password,
        )
      ).status,
    ).toBe(200);
    workerId = (
      await createWorker(ownerContext, {
        displayName: `mcp-download-${Date.now()}`,
      })
    ).id;
    adminWorkspaceId = (
      await (
        await request.post("/api/admin/workspace", { data: {} })
      ).json()
    ).id;
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { storage: true, exports: true } },
        })
      ).status(),
    ).toBe(200);
  });

  test.afterAll(async () => {
    if (adminContext && Object.keys(originalPolicy).length)
      await adminContext
        .put("/api/admin/management-mcp/policy", {
          data: { groups: originalPolicy },
        })
        .catch(() => {});
    if (workerId)
      await cleanupWorker(ownerContext, workerId).catch(() => {});
    await ownerContext?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("streams a large offline file and a completed export on the private listener", async ({
    request,
  }) => {
    test.setTimeout(300_000);
    const api = new ApiClient(ownerContext);
    const payload = Buffer.alloc(512 * 1024 + 17, 0x5a);
    const filename = `private-download-${Date.now()}.bin`;
    const directory = `private-directory-${Date.now()}`;
    expect(
      (await api.uploadFiles(workerId, [
        { name: filename, content: payload },
        { name: `${directory}/child.txt`, content: Buffer.from("directory-stream-ok") },
      ]))
        .status,
    ).toBe(200);
    let credential = await issueCredential(
      request,
      adminWorkspaceId,
      300,
    );

    const prepared = await invoke(request, credential, "workspaces.download", {
      workspaceId: workerId,
      paths: [filename],
    });
    expect(prepared.status()).toBe(200);
    const handoff = await prepared.json();
    const invalidCredential = await captureCommandOutput(
      adminWorkspaceId,
      `curl -sS -H 'Authorization: Bearer invalid' --output /dev/null --write-out HTTP_%{http_code} 'http://agentor-orchestrator:3099${handoff.downloadPath}'`,
      60_000,
    );
    expect(invalidCredential).toContain("HTTP_401");
    expect(handoff).toMatchObject({ method: "GET" });
    expect(handoff.downloadPath).toMatch(/^\/downloads\/[0-9a-f-]{36}$/);
    expect(JSON.stringify(handoff)).not.toMatch(/cookie|\/api\/workspaces|base64/i);

    const expectedHash = createHash("sha256").update(payload).digest("hex");
    const actualHash = await privateCurl(
      adminWorkspaceId,
      handoff.downloadPath,
      " --output - | sha256sum | cut -d' ' -f1",
    );
    expect(actualHash).toContain(expectedHash);
    const replay = await privateCurl(
      adminWorkspaceId,
      handoff.downloadPath,
      " --output /dev/null --write-out HTTP_%{http_code}",
      true,
    );
    expect(replay).toContain("HTTP_404");

    const directoryPrepared = await invoke(
      request,
      credential,
      "workspaces.download",
      { workspaceId: workerId, paths: [directory] },
    );
    expect(directoryPrepared.status()).toBe(200);
    const directoryHandoff = await directoryPrepared.json();
    const archivePath = `/tmp/agentor-mcp-download-${Date.now()}.zip`;
    const directoryOutput = await captureCommandOutput(
      adminWorkspaceId,
      `curl -fsS -H "Authorization: Bearer $(tr -d '\\n' </run/agentor-management/credential)" --output '${archivePath}' 'http://agentor-orchestrator:3099${directoryHandoff.downloadPath}' && python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read(sys.argv[2]).decode())' '${archivePath}' '${directory}/child.txt'; rc=$?; rm -f '${archivePath}'; exit $rc`,
      60_000,
    );
    expect(directoryOutput).toContain("directory-stream-ok");

    const exportCreated = await api.createExportJob(workerId, false);
    expect(exportCreated.status).toBe(202);
    const complete = await waitForExport(api, exportCreated.body.id);
    expect(complete.status).toBe("succeeded");
    credential = await issueCredential(request, adminWorkspaceId, 60);
    const exportPrepared = await invoke(
      request,
      credential,
      "exports.download",
      { jobId: complete.id },
    );
    expect(exportPrepared.status()).toBe(200);
    const exportHandoff = await exportPrepared.json();
    expect(exportHandoff).toMatchObject({
      ready: true,
      method: "GET",
      filename: expect.stringMatching(/\.tar$/),
    });
    const listing = await privateCurl(
      adminWorkspaceId,
      exportHandoff.downloadPath,
      " --output - | tar -tf -",
    );
    expect(listing).toContain("manifest.json");
  });

  test("redeeming a prepared handoff rechecks current capability policy", async ({
    request,
  }) => {
    const credential = await issueCredential(
      request,
      adminWorkspaceId,
      120,
    );
    const prepared = await invoke(request, credential, "workspaces.download", {
      workspaceId: workerId,
      paths: [""],
    });
    expect(prepared.status()).toBe(200);
    const handoff = await prepared.json();
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { storage: false } },
        })
      ).status(),
    ).toBe(200);
    // Redemption intentionally reads the current tmpfs credential, which may
    // have rotated since the diagnostic MCP call prepared this handoff.
    const denied = await privateCurl(
      adminWorkspaceId,
      handoff.downloadPath,
      " --output /dev/null --write-out HTTP_%{http_code}",
      true,
    );
    expect(denied).toContain("HTTP_403");
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { storage: true } },
        })
      ).status(),
    ).toBe(200);
    const accepted = await privateCurl(
      adminWorkspaceId,
      handoff.downloadPath,
      " --output /dev/null --write-out HTTP_%{http_code}",
    );
    expect(accepted).toContain("HTTP_200");
  });
});

async function issueCredential(
  request: APIRequestContext,
  workspaceId: string,
  ttlSeconds: number,
) {
  const response = await request.post(
    "/api/admin/management-mcp/diagnostics/issue-identity",
    { data: { workspaceId, ttlSeconds } },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).credential as string;
}

async function invoke(
  request: APIRequestContext,
  credential: string,
  tool: string,
  args: Record<string, unknown>,
) {
  return request.post("/api/admin/management-mcp/diagnostics/invoke", {
    data: { credential, tool, arguments: args },
  });
}

async function privateCurl(
  workspaceId: string,
  path: string,
  suffix: string,
  tolerateHttpError = false,
) {
  const flags = tolerateHttpError ? "-sS" : "-fsS";
  const pipeAt = suffix.indexOf(" | ");
  const curlOptions = pipeAt >= 0 ? suffix.slice(0, pipeAt) : suffix;
  const pipeline = pipeAt >= 0 ? suffix.slice(pipeAt) : "";
  return captureCommandOutput(
    workspaceId,
    `curl ${flags} -H "Authorization: Bearer $(tr -d '\\n' </run/agentor-management/credential)"${curlOptions} 'http://agentor-orchestrator:3099${path}'${pipeline}`,
    60_000,
  );
}

async function waitForExport(api: ApiClient, jobId: string) {
  let current: any;
  await expect
    .poll(
      async () => {
        const response = await api.getExportJob(jobId);
        current = response.body;
        return current.status;
      },
      { timeout: 120_000, intervals: [250, 500, 1_000] },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return current;
}

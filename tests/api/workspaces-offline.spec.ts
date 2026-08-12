import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import { createWorker, cleanupWorker } from "../helpers/worker-lifecycle";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";
import { TerminalWsClient } from "../helpers/terminal-ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

type Workspace = {
  id: string;
  workerId?: string;
  ownerId?: string;
  userId?: string;
  state?: string;
  [key: string]: unknown;
};

async function jsonOrText(res: Awaited<ReturnType<APIRequestContext["get"]>>) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function inventory(
  ctx: APIRequestContext,
): Promise<{ status: number; body: Workspace[] }> {
  const res = await ctx.get("/api/workspaces");
  return { status: res.status(), body: res.ok() ? await res.json() : [] };
}

function workspaceFor(items: Workspace[], workerId: string): Workspace {
  const found = items.find(
    (item) => item.workerId === workerId || item.id === workerId,
  );
  expect(found, `inventory entry for worker ${workerId}`).toBeTruthy();
  return found!;
}

async function exec(workerId: string, command: string): Promise<void> {
  const apiCtx = await playwrightRequest.newContext({
    ...EMPTY_AUTH,
    storageState: ".auth/admin-api.json",
  });
  const api = new ApiClient(apiCtx);
  let pane: number | undefined;
  try {
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await api.createPane(workerId);
      if (result.status === 201 && typeof result.body.index === "number") {
        pane = result.body.index;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (pane === undefined)
      throw new Error("worker terminal did not become ready");
    const ws = new TerminalWsClient(workerId, String(pane));
    try {
      await ws.connect();
      await ws.waitForOutput(/[$#>]\s*$/, 15_000);
      const marker = `OFFLINE_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      ws.sendLine(`${command}; printf '${marker}:%s\\n' "$?"`);
      const output = await ws.waitForOutput(
        new RegExp(`${marker}:\\d+`),
        30_000,
      );
      expect(output).toContain(`${marker}:0`);
    } finally {
      ws.close();
    }
  } finally {
    if (pane !== undefined)
      await api.deletePane(workerId, pane).catch(() => {});
    await apiCtx.dispose();
  }
}

test.describe.serial("Offline workspace inventory and browser security", () => {
  let adminWorker = "";
  let adminWorkspace = "";
  let otherWorker = "";
  let otherWorkspace = "";
  let otherUser: CreatedUser;
  let otherCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  let archived = false;

  test.beforeAll(async ({ request }) => {
    adminWorker = (
      await createWorker(request, {
        displayName: `offline-admin-${Date.now()}`,
      })
    ).id;
    await exec(
      adminWorker,
      "mkdir -p /workspace/docs /workspace/images && printf 'offline sentinel text\\nsecond line\\n' > /workspace/docs/readme.txt && printf '<script>alert(1)</script>' > /workspace/docs/unsafe.html && printf '\\211PNG\\r\\n\\032\\n' > /workspace/images/tiny.png && ln -s /etc/passwd /workspace/escape-link && ln -s /etc /workspace/escape-dir",
    );
    expect(
      (await new ApiClient(request).stopContainer(adminWorker)).status,
    ).toBe(200);

    otherUser = await createTestUser("Offline Workspace Other");
    otherCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await new ApiClient(otherCtx).signInEmail(
          otherUser.email,
          otherUser.password,
        )
      ).status,
    ).toBe(200);
    otherWorker = (
      await createWorker(otherCtx, {
        displayName: `offline-other-${Date.now()}`,
      })
    ).id;
    expect(
      (await new ApiClient(otherCtx).stopContainer(otherWorker)).status,
    ).toBe(200);
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);

    adminWorkspace = workspaceFor(
      (await inventory(request)).body,
      adminWorker,
    ).id;
    otherWorkspace = workspaceFor(
      (await inventory(otherCtx)).body,
      otherWorker,
    ).id;
  });

  test.afterAll(async ({ request }) => {
    if (adminWorker) {
      if (archived)
        await new ApiClient(request)
          .deleteArchivedWorker(adminWorker)
          .catch(() => {});
      else await cleanupWorker(request, adminWorker).catch(() => {});
    }
    if (otherWorker) await cleanupWorker(otherCtx, otherWorker).catch(() => {});
    await otherCtx?.dispose();
    await anonymous?.dispose();
    if (otherUser) await deleteTestUser(otherUser.id).catch(() => {});
  });

  test("all offline workspace endpoints require authentication", async () => {
    const calls = [
      anonymous.get("/api/workspaces"),
      anonymous.get(`/api/workspaces/${adminWorkspace}/files`),
      anonymous.get(
        `/api/workspaces/${adminWorkspace}/metadata?path=docs/readme.txt`,
      ),
      anonymous.get(
        `/api/workspaces/${adminWorkspace}/preview?path=docs/readme.txt`,
      ),
      anonymous.get(`/api/workspaces/${adminWorkspace}/search?q=sentinel`),
      anonymous.post(`/api/workspaces/${adminWorkspace}/download`, {
        data: { paths: ["docs"] },
      }),
      anonymous.get(`/api/workspaces/${adminWorkspace}/download?path=docs`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status()).toBe(401);
  });

  test("inventory is owner-scoped while admin can inventory another user workspace", async ({
    request,
  }) => {
    const own = await inventory(otherCtx);
    expect(own.status).toBe(200);
    expect(own.body.some((item) => item.id === otherWorkspace)).toBe(true);
    expect(own.body.some((item) => item.id === adminWorkspace)).toBe(false);
    const admin = await inventory(request);
    expect(admin.status).toBe(200);
    expect(admin.body.some((item) => item.id === otherWorkspace)).toBe(true);
    expect(JSON.stringify(admin.body)).not.toMatch(
      /\/var\/lib\/docker|\/data\/users|Mountpoint|docker\.sock/,
    );
  });

  test("another user cannot list, inspect, preview, search, or download", async () => {
    const calls = [
      otherCtx.get(`/api/workspaces/${adminWorkspace}/files`),
      otherCtx.get(
        `/api/workspaces/${adminWorkspace}/metadata?path=docs/readme.txt`,
      ),
      otherCtx.get(
        `/api/workspaces/${adminWorkspace}/preview?path=docs/readme.txt`,
      ),
      otherCtx.get(`/api/workspaces/${adminWorkspace}/search?q=sentinel`),
      otherCtx.post(`/api/workspaces/${adminWorkspace}/download`, {
        data: { paths: ["docs"] },
      }),
      otherCtx.get(`/api/workspaces/${adminWorkspace}/download?path=docs`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status()).toBe(403);
  });

  test("stopped workspace supports listing and metadata", async ({
    request,
  }) => {
    const list = await request.get(
      `/api/workspaces/${adminWorkspace}/files?path=docs`,
    );
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(
      body.entries.some(
        (entry: { name: string }) => entry.name === "readme.txt",
      ),
    ).toBe(true);
    const metadata = await request.get(
      `/api/workspaces/${adminWorkspace}/metadata?path=docs/readme.txt`,
    );
    expect(metadata.status()).toBe(200);
    expect(await metadata.json()).toMatchObject({
      type: "file",
      mode: expect.stringMatching(/^[0-7]{4}$/),
      owner: expect.any(String),
      group: expect.any(String),
    });
  });

  test("path traversal, absolute, backslash, NUL, and encoded escapes fail closed", async ({
    request,
  }) => {
    const urls = [
      `?path=${encodeURIComponent("../etc/passwd")}`,
      `?path=${encodeURIComponent("/etc/passwd")}`,
      `?path=${encodeURIComponent("docs\\readme.txt")}`,
      `?path=${encodeURIComponent("docs\0readme.txt")}`,
      "?path=%2e%2e%2fetc%2fpasswd",
    ];
    for (const query of urls) {
      const res = await request.get(
        `/api/workspaces/${adminWorkspace}/metadata${query}`,
      );
      expect(res.status(), query).toBe(400);
    }
  });

  test("escaping symlinks are visible as metadata but never followed", async ({
    request,
  }) => {
    const metadata = await request.get(
      `/api/workspaces/${adminWorkspace}/metadata?path=escape-link`,
    );
    expect(metadata.status()).toBe(200);
    expect(await metadata.json()).toMatchObject({
      type: "symlink",
      linkEscapes: true,
    });
    const preview = await request.get(
      `/api/workspaces/${adminWorkspace}/preview?path=escape-link`,
    );
    expect([400, 409, 415]).toContain(preview.status());
    expect(await preview.text()).not.toContain("root:x:0:0");
  });

  test("an intermediate escaping symlink never permits an offline realpath escape", async ({
    request,
  }) => {
    const metadata = await request.get(
      `/api/workspaces/${adminWorkspace}/metadata?path=escape-dir/passwd`,
    );
    expect(metadata.status()).toBe(400);
    expect(await metadata.text()).not.toContain("root:x:0:0");
    const download = await request.get(
      `/api/workspaces/${adminWorkspace}/download?path=escape-dir/passwd`,
    );
    expect(download.status()).toBe(400);
    expect(await download.text()).not.toContain("root:x:0:0");
  });

  test("text preview is bounded, no-store, and returns safe text", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/workspaces/${adminWorkspace}/preview?path=docs/readme.txt`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await res.text()).toContain("offline sentinel text");
  });

  test("active HTML and malformed image content are not rendered inline", async ({
    request,
  }) => {
    const html = await request.get(
      `/api/workspaces/${adminWorkspace}/preview?path=docs/unsafe.html`,
    );
    expect([200, 400, 415]).toContain(html.status());
    if (html.status() === 200) {
      expect(html.headers()["content-type"]).toContain("text/plain");
      expect(html.headers()["content-security-policy"]).toContain(
        "default-src 'none'",
      );
    }
    const image = await request.get(
      `/api/workspaces/${adminWorkspace}/preview?path=images/tiny.png`,
    );
    expect([400, 415]).toContain(image.status());
    expect(image.headers()["content-type"] || "").not.toContain("text/html");
  });

  test("search is bounded to the workspace and does not follow escaping links", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/workspaces/${adminWorkspace}/search?q=${encodeURIComponent("readme")}&path=docs`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("docs/readme.txt");
    expect(serialized).not.toContain("root:x:0:0");
    expect(body.results.length).toBeLessThanOrEqual(500);
    expect(body).toMatchObject({ query: "readme", path: "docs" });
    expect(body.results[0]).toMatchObject({ name: "readme.txt" });
  });

  test("directory download is a streamed attachment with normalized archive names", async ({
    request,
  }) => {
    const res = await request.post(
      `/api/workspaces/${adminWorkspace}/download`,
      { data: { paths: ["docs"] } },
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("attachment");
    expect(res.headers()["cache-control"]).toContain("no-store");
    const bytes = await res.body();
    expect(bytes.length).toBeGreaterThan(4);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(bytes.toString("binary")).not.toContain("../");

    const native = await request.get(
      `/api/workspaces/${adminWorkspace}/download?path=${encodeURIComponent("docs/readme.txt")}`,
    );
    expect(native.status()).toBe(200);
    expect(native.headers()["content-disposition"]).toContain("readme.txt");
    expect(native.headers()["cache-control"]).toContain("no-store");
    expect(await native.text()).toContain("offline sentinel text");
  });

  test("archived workspace remains browsable without recreating the worker", async ({
    request,
  }) => {
    expect(
      (await new ApiClient(request).archiveContainer(adminWorker)).status,
    ).toBe(200);
    archived = true;
    const entry = workspaceFor((await inventory(request)).body, adminWorker);
    expect(entry.state).toBe("archived");
    const preview = await request.get(
      `/api/workspaces/${entry.id}/preview?path=docs/readme.txt`,
    );
    expect(preview.status()).toBe(200);
    expect(await preview.text()).toContain("offline sentinel text");
  });

  test("an archived workspace clones through the lazy guarded stream without losing content", async ({
    request,
  }) => {
    const clone = await request.post(`/api/containers/${adminWorker}/clone`, {
      data: { displayName: `offline-clone-${Date.now()}` },
    });
    expect(clone.status()).toBe(201);
    const cloned = await clone.json();
    expect(cloned.id).toBeTruthy();
    try {
      await exec(
        cloned.id,
        "grep -F 'offline sentinel text' /workspace/docs/readme.txt",
      );
    } finally {
      await cleanupWorker(request, cloned.id).catch(() => {});
    }
  });

  test("helper implementation details and sensitive mount paths are not exposed", async ({
    request,
  }) => {
    const list = await request.get(`/api/workspaces/${adminWorkspace}/files`);
    expect(list.status()).toBe(200);
    const serialized = JSON.stringify(await jsonOrText(list));
    expect(serialized).not.toMatch(
      /docker\.sock|\/var\/lib\/docker|\/data\/users|agentor-storage-helper|Mountpoint|HostConfig/,
    );
  });

  test("permanent deletion leaves an owner-scoped, non-browsable inventory tombstone", async ({
    request,
  }) => {
    const deletedId = otherWorker;
    await cleanupWorker(otherCtx, deletedId);
    otherWorker = "";
    const ownEntry = workspaceFor((await inventory(otherCtx)).body, deletedId);
    expect(ownEntry).toMatchObject({
      state: "deleted",
      sizeBytes: 0,
      capabilities: { browse: false, backup: false, clone: false },
    });
    expect(workspaceFor((await inventory(request)).body, deletedId).state).toBe(
      "deleted",
    );
    expect(
      (await request.get(`/api/workspaces/${ownEntry.id}/files`)).status(),
    ).toBe(409);
  });
});

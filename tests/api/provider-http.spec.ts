import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GoogleDriveBackupProvider,
  exchangeGoogleAuthorizationCode,
  type BackupHttpTransport,
  type GoogleDriveToken,
} from "../../orchestrator/server/utils/backup-provider";
import {
  GitHubRestProvider,
  type GitHubHttpTransport,
} from "../../orchestrator/server/utils/git-image-provider";
import {
  GIT_IMAGE_CATALOG_PATH,
  parseCatalog,
  serializeCatalog,
} from "../../orchestrator/server/utils/git-image-format";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test.describe.serial("Provider HTTP boundaries", () => {
  const originalClientId = process.env.GOOGLE_BACKUP_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_BACKUP_CLIENT_SECRET;

  test.beforeAll(() => {
    process.env.GOOGLE_BACKUP_CLIENT_ID = "mock-client";
    process.env.GOOGLE_BACKUP_CLIENT_SECRET = "mock-secret";
  });

  test.afterAll(() => {
    if (originalClientId === undefined)
      delete process.env.GOOGLE_BACKUP_CLIENT_ID;
    else process.env.GOOGLE_BACKUP_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined)
      delete process.env.GOOGLE_BACKUP_CLIENT_SECRET;
    else process.env.GOOGLE_BACKUP_CLIENT_SECRET = originalClientSecret;
  });

  test("Google OAuth exchange preserves an existing refresh token when Google omits it", async () => {
    let requestBody = "";
    const token = await exchangeGoogleAuthorizationCode(
      {
        code: "one-time-code",
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://agentor.test/api/callback",
        previousToken: { access_token: "expired", refresh_token: "keep-me" },
      },
      async (_url, init) => {
        requestBody = String(init?.body);
        return json({ access_token: "new-access", expires_in: 1200 });
      },
    );
    expect(token).toMatchObject({
      access_token: "new-access",
      refresh_token: "keep-me",
    });
    expect(requestBody).toContain("grant_type=authorization_code");
    expect(requestBody).toContain("code=one-time-code");
  });

  test("Google refresh, 308 chunking, transient retry, and progress use one resumable session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-provider-"));
    const source = join(dir, "source.backup");
    await writeFile(source, Buffer.alloc(8 * 1024 * 1024 + 7, 0x5a));
    let stored: GoogleDriveToken = {
      access_token: "expired",
      refresh_token: "refresh-stays",
      expires_at: 1,
    };
    const calls: Array<{ url: string; method: string; range?: string }> = [];
    let firstChunkAttempts = 0;
    const transport: BackupHttpTransport = async (input, init = {}) => {
      const url = String(input);
      const method = String(init.method || "GET");
      const headers = new Headers(init.headers);
      calls.push({
        url,
        method,
        range: headers.get("content-range") || undefined,
      });
      if (url.endsWith("oauth2.googleapis.com/token"))
        return json({ access_token: "fresh", expires_in: 3600 });
      if (method === "POST")
        return new Response(null, {
          status: 200,
          headers: {
            location: "https://www.googleapis.com/upload/mock-session",
          },
        });
      if (headers.get("content-range")?.startsWith("bytes 0-")) {
        firstChunkAttempts++;
        if (firstChunkAttempts === 1)
          return new Response("retry", { status: 503 });
        return new Response(null, {
          status: 308,
          headers: { range: "bytes=0-8388607" },
        });
      }
      return json({ id: "drive-object" });
    };
    const progress: number[] = [];
    try {
      const provider = new GoogleDriveBackupProvider(
        async () => stored,
        async (_user, token) => {
          stored = token;
        },
        async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
        transport,
        async () => {},
      );
      const uploaded = await provider.upload(
        "user",
        "artifact",
        source,
        (bytes) => progress.push(bytes),
      );
      expect(uploaded).toMatchObject({
        objectId: "drive-object",
        size: 8 * 1024 * 1024 + 7,
      });
      expect(stored).toMatchObject({
        access_token: "fresh",
        refresh_token: "refresh-stays",
      });
      expect(firstChunkAttempts).toBe(2);
      expect(progress).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024 + 7]);
      expect(
        calls.filter((call) => call.url.includes("mock-session")),
      ).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Google resumes from a probed 308 offset and rejects untrusted session URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-resume-"));
    const source = join(dir, "source.backup");
    await writeFile(source, Buffer.alloc(8 * 1024 * 1024 + 3, 0x41));
    const ranges: string[] = [];
    const transport: BackupHttpTransport = async (_input, init = {}) => {
      const range = new Headers(init.headers).get("content-range") || "";
      ranges.push(range);
      if (range.startsWith("bytes */"))
        return new Response(null, {
          status: 308,
          headers: { range: "bytes=0-8388607" },
        });
      return json({ id: "resumed-object" });
    };
    const provider = new GoogleDriveBackupProvider(
      async () => ({
        access_token: "valid",
        expires_at: Date.now() + 3600_000,
      }),
      async () => {},
      async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
      transport,
      async () => {},
    );
    try {
      await expect(
        provider.upload(
          "user",
          "artifact",
          source,
          () => {},
          undefined,
          "https://evil.example/upload/session",
        ),
      ).rejects.toThrow("Invalid Google Drive resumable upload session");
      const result = await provider.upload(
        "user",
        "artifact",
        source,
        () => {},
        undefined,
        "https://www.googleapis.com/upload/resume-session",
      );
      expect(result).toMatchObject({
        objectId: "resumed-object",
        resumedFromChunk: 1,
      });
      expect(ranges).toEqual([
        "bytes */8388611",
        "bytes 8388608-8388610/8388611",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Google cancellation, download, delete, and upload-session cancellation are bounded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-io-"));
    const source = join(dir, "source.backup");
    const destination = join(dir, "download.backup");
    await writeFile(source, "cancel-me");
    const controller = new AbortController();
    const calls: Array<{ url: string; method: string }> = [];
    const transport: BackupHttpTransport = async (input, init = {}) => {
      const url = String(input),
        method = String(init.method || "GET");
      calls.push({ url, method });
      if (url.includes("uploadType=resumable")) {
        controller.abort();
        return new Response(null, {
          status: 200,
          headers: {
            location: "https://www.googleapis.com/upload/cancel-session",
          },
        });
      }
      if (method === "GET") return new Response(Buffer.from("downloaded"));
      return new Response(null, { status: 204 });
    };
    const provider = new GoogleDriveBackupProvider(
      async () => ({
        access_token: "valid",
        expires_at: Date.now() + 3600_000,
      }),
      async () => {},
      async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
      transport,
      async () => {},
    );
    try {
      await expect(
        provider.upload(
          "user",
          "artifact",
          source,
          () => {},
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await provider.download("user", "object/id", destination);
      expect(await readFile(destination, "utf8")).toBe("downloaded");
      await provider.delete("user", "object/id");
      await provider.abortUpload(
        "user",
        "https://evil.example/upload/nope",
        "artifact",
      );
      await provider.abortUpload(
        "user",
        "https://www.googleapis.com/upload/cancel-session",
        "artifact",
      );
      expect(
        calls.some(
          (call) =>
            call.url.includes("object%2Fid?alt=media") && call.method === "GET",
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.url.includes("object%2Fid") && call.method === "DELETE",
        ),
      ).toBe(true);
      expect(
        calls.filter(
          (call) =>
            call.url.includes("cancel-session") && call.method === "DELETE",
        ),
      ).toHaveLength(1);
      expect(calls.some((call) => call.url.includes("evil.example"))).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GitHub public reads omit Authorization while unauthenticated writes fail before HTTP", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const transport: GitHubHttpTransport = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init.headers) });
      if (url.includes("/git/ref/heads/main"))
        return json({ object: { sha: "commit-sha" } });
      if (url.includes("/git/trees/commit-sha"))
        return json({
          tree: [
            {
              type: "blob",
              path: GIT_IMAGE_CATALOG_PATH,
              sha: "blob-sha",
              size: 12,
            },
          ],
        });
      if (url.includes("/git/blobs/blob-sha"))
        return json({
          content: Buffer.from("catalog-data").toString("base64"),
        });
      throw new Error(`Unexpected mock request: ${url}`);
    };
    const provider = new GitHubRestProvider(async () => undefined, transport);
    expect(await provider.read("owner/public", "main")).toEqual({
      revision: "commit-sha",
      files: { [GIT_IMAGE_CATALOG_PATH]: "catalog-data" },
    });
    expect(calls.every((call) => !call.headers.has("authorization"))).toBe(
      true,
    );
    const beforeWrite = calls.length;
    await expect(
      provider.write("owner/public", {
        branch: "main",
        targetBranch: "main",
        expectedRevision: "commit-sha",
        files: { "images/a/Dockerfile": "FROM base\n" },
        message: "write",
        workflow: "direct",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(beforeWrite);
  });

  test("Git catalog rejects definition and GHCR digest mismatches", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const definition: any = {
      id: "demo",
      ownerId: "owner",
      name: "Demo",
      description: "",
      baseImage: "agentor-worker:latest",
      dockerfileFragment: "RUN true",
      contextFiles: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [
        {
          version: "v1",
          digest,
          baseImage: "agentor-worker:latest",
          createdAt: new Date().toISOString(),
          runtimeImage: `ghcr.io/owner/demo@sha256:${"b".repeat(64)}`,
        },
      ],
    };
    expect(() =>
      serializeCatalog([definition], { buildMode: "local" }),
    ).toThrow("digest must match");
    delete definition.versions[0].runtimeImage;
    const files = serializeCatalog([definition], { buildMode: "local" });
    const manifest = JSON.parse(files[GIT_IMAGE_CATALOG_PATH]!);
    manifest.entries[0].definitionHash = "0".repeat(64);
    files[GIT_IMAGE_CATALOG_PATH] = JSON.stringify(manifest);
    expect(() => parseCatalog(files)).toThrow("failed integrity validation");
  });
});

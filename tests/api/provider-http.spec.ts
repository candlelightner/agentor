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
    const transport: BackupHttpTransport = async (input, init = {}) => {
      if (String(input).includes("probe-failure"))
        throw new Error("probe transport failed");
      if (String(input).includes("completed-missing-id")) return json({});
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
      ).rejects.toMatchObject({
        code: "GOOGLE_DRIVE_INVALID_UPLOAD_SESSION",
        message:
          "The saved Google Drive resumable upload session is invalid. Retry the backup to start a new upload.",
        retryable: true,
      });
      await expect(
        provider.upload(
          "user",
          "artifact",
          source,
          () => {},
          undefined,
          "https://www.googleapis.com/upload/probe-failure",
        ),
      ).rejects.toMatchObject({
        code: "GOOGLE_DRIVE_UPLOAD_CONNECTION_FAILED",
        message:
          "The Google Drive upload connection failed. The resumable upload can be retried.",
        retryable: true,
        uploadId: "https://www.googleapis.com/upload/probe-failure",
      });
      await expect(
        provider.upload(
          "user",
          "artifact",
          source,
          () => {},
          undefined,
          "https://www.googleapis.com/upload/completed-missing-id",
        ),
      ).rejects.toMatchObject({
        code: "GOOGLE_DRIVE_INVALID_RESPONSE",
        message:
          "Google Drive returned an invalid resumable-upload response. Retry the backup.",
        retryable: true,
        uploadId: "https://www.googleapis.com/upload/completed-missing-id",
      });
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

  test("Google preserves resumable sessions on auth, throttle, and server probe failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-probe-status-"));
    const source = join(dir, "source.backup");
    await writeFile(source, "resume-me");
    try {
      for (const [status, code] of [
        [401, "GOOGLE_DRIVE_AUTHORIZATION_EXPIRED"],
        [429, "GOOGLE_DRIVE_RATE_LIMITED"],
        [503, "GOOGLE_DRIVE_TEMPORARILY_UNAVAILABLE"],
      ] as const) {
        const session = `https://www.googleapis.com/upload/probe-${status}`;
        let newSessions = 0;
        const provider = new GoogleDriveBackupProvider(
          async () => ({
            access_token: "valid",
            expires_at: Date.now() + 3600_000,
          }),
          async () => {},
          async () => ({
            clientId: "test-client",
            clientSecret: "test-secret",
          }),
          async (_input, init = {}) => {
            if (init.method === "POST") newSessions += 1;
            return new Response(null, { status });
          },
          async () => {},
        );
        await expect(
          provider.upload(
            "user",
            "artifact",
            source,
            () => {},
            undefined,
            session,
          ),
        ).rejects.toMatchObject({
          code,
          providerStatus: status,
          uploadId: session,
        });
        expect(newSessions).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Google exposes stable failure diagnostics without leaking provider response bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-safe-error-"));
    const source = join(dir, "source.backup");
    await writeFile(source, "safe-error");
    const secretDiagnostic = "provider-secret-diagnostic";
    const provider = new GoogleDriveBackupProvider(
      async () => ({
        access_token: "valid",
        expires_at: Date.now() + 3600_000,
      }),
      async () => {},
      async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
      async () =>
        json(
          {
            error: {
              message: secretDiagnostic,
              errors: [{ reason: "storageQuotaExceeded" }],
            },
          },
          { status: 403 },
        ),
      async () => {},
    );
    try {
      const failure = await provider
        .upload("user", "artifact", source, () => {})
        .catch((error) => error);
      expect(failure).toMatchObject({
        code: "GOOGLE_DRIVE_QUOTA_EXCEEDED",
        providerStatus: 403,
        retryable: false,
      });
      expect(failure.message).not.toContain(secretDiagnostic);
      expect(JSON.stringify(failure)).not.toContain(secretDiagnostic);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Google replaces only terminally missing resumable sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-google-probe-terminal-"));
    const source = join(dir, "source.backup");
    await writeFile(source, "replace-me");
    try {
      for (const terminalStatus of [404, 410]) {
        const oldSession = `https://www.googleapis.com/upload/missing-${terminalStatus}`;
        const newSession = `https://www.googleapis.com/upload/replacement-${terminalStatus}`;
        let newSessions = 0;
        const provider = new GoogleDriveBackupProvider(
          async () => ({
            access_token: "valid",
            expires_at: Date.now() + 3600_000,
          }),
          async () => {},
          async () => ({
            clientId: "test-client",
            clientSecret: "test-secret",
          }),
          async (input, init = {}) => {
            const url = String(input);
            if (url === oldSession)
              return new Response(null, { status: terminalStatus });
            if (init.method === "POST") {
              newSessions += 1;
              return new Response(null, {
                status: 200,
                headers: { location: newSession },
              });
            }
            if (url === newSession)
              return json({ id: `replacement-object-${terminalStatus}` });
            throw new Error(`Unexpected Google request: ${url}`);
          },
          async () => {},
        );
        await expect(
          provider.upload(
            "user",
            "artifact",
            source,
            () => {},
            undefined,
            oldSession,
          ),
        ).resolves.toMatchObject({
          objectId: `replacement-object-${terminalStatus}`,
        });
        expect(newSessions).toBe(1);
      }
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
      ).rejects.toMatchObject({
        name: "AbortError",
        uploadId: "https://www.googleapis.com/upload/cancel-session",
      });
      await provider.download("user", "object/id", destination);
      expect(await readFile(destination, "utf8")).toBe("downloaded");
      await provider.delete("user", "object/id");
      await expect(
        provider.abortUpload(
          "user",
          "https://evil.example/upload/nope",
          "artifact",
        ),
      ).rejects.toThrow("Invalid Google Drive resumable upload session");
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

  test("Google Drive upload cancellation propagates provider failures", async () => {
    const provider = new GoogleDriveBackupProvider(
      async () => ({
        access_token: "valid",
        expires_at: Date.now() + 3600_000,
      }),
      async () => {},
      async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
      async () => new Response(null, { status: 503 }),
      async () => {},
    );
    await expect(
      provider.abortUpload(
        "user",
        "https://www.googleapis.com/upload/cancel-session",
        "artifact",
      ),
    ).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_TEMPORARILY_UNAVAILABLE",
      providerStatus: 503,
      retryable: true,
    });
  });

  test("Google Drive reconciles a crash-window upload by artifact metadata", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = new GoogleDriveBackupProvider(
      async () => ({
        access_token: "valid",
        expires_at: Date.now() + 3600_000,
      }),
      async () => {},
      async () => ({ clientId: "test-client", clientSecret: "test-secret" }),
      async (input, init = {}) => {
        const url = String(input);
        const method = init.method || "GET";
        calls.push({ url, method });
        if (method === "GET")
          return new Response(
            JSON.stringify({ files: [{ id: "opaque-id" }] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        return new Response(null, { status: 204 });
      },
      async () => {},
    );
    await provider.deleteByArtifactId("user", "agentor-artifact-id");
    expect(calls[0]?.url).toContain("appProperties");
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "key='artifactId' and value='agentor-artifact-id'",
    );
    expect(calls).toContainEqual({
      url: "https://www.googleapis.com/drive/v3/files/opaque-id",
      method: "DELETE",
    });
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

  test("GitHub pull-request reconciliation reuses an open head and recovers a lost create response", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let existing = true;
    let losePostResponse = false;
    const transport: GitHubHttpTransport = async (input, init = {}) => {
      const url = String(input),
        method = init.method || "GET";
      calls.push({ url, method });
      if (method === "GET" && url.includes("/pulls?"))
        return json(
          existing
            ? [{ number: 7, html_url: "https://github.test/pull/7" }]
            : [],
        );
      if (method === "POST" && url.endsWith("/pulls")) {
        if (losePostResponse) {
          existing = true;
          throw new Error("injected lost PR response");
        }
        return json({ number: 8, html_url: "https://github.test/pull/8" });
      }
      throw new Error(`Unexpected mock request: ${method} ${url}`);
    };
    const provider = new GitHubRestProvider(async () => "token", transport);
    const input = {
      branch: "agentor/catalog-content",
      targetBranch: "main",
      title: "Sync catalog",
    };

    await expect(
      provider.ensurePullRequest("owner/repo", input),
    ).resolves.toEqual({
      pullRequest: {
        number: 7,
        url: "https://github.test/pull/7",
        state: "open",
      },
      created: false,
    });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "head=owner:agentor/catalog-content",
    );

    existing = false;
    await expect(
      provider.ensurePullRequest("owner/repo", input),
    ).resolves.toEqual({
      pullRequest: {
        number: 8,
        url: "https://github.test/pull/8",
        state: "open",
      },
      created: true,
    });
    expect(calls.slice(1).map((call) => call.method)).toEqual(["GET", "POST"]);

    existing = false;
    losePostResponse = true;
    await expect(
      provider.ensurePullRequest("owner/repo", input),
    ).resolves.toEqual({
      pullRequest: {
        number: 7,
        url: "https://github.test/pull/7",
        state: "open",
      },
      created: false,
    });
    expect(calls.slice(3).map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  test("GitHub requests abort and settle within the configured deadline", async () => {
    const previous = process.env.GIT_IMAGE_HTTP_TIMEOUT_MS;
    process.env.GIT_IMAGE_HTTP_TIMEOUT_MS = "1000";
    let aborted = false;
    const provider = new GitHubRestProvider(
      async () => undefined,
      async (_input, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const started = Date.now();
    try {
      await expect(provider.read("owner/public", "main")).rejects.toMatchObject(
        {
          statusCode: 504,
          message: "GitHub catalog request timed out",
        },
      );
      expect(aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      if (previous === undefined) delete process.env.GIT_IMAGE_HTTP_TIMEOUT_MS;
      else process.env.GIT_IMAGE_HTTP_TIMEOUT_MS = previous;
    }
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

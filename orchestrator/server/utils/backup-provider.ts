import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { assertSafePathId, assertSafeUserId } from "./user-id";

export type BackupHttpTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface UploadResult {
  objectId: string;
  size: number;
  uploadId: string;
  resumedFromChunk: number;
}
export interface BackupProvider {
  kind: string;
  upload(
    userId: string,
    artifactId: string,
    source: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
    resumeUploadId?: string,
  ): Promise<UploadResult>;
  download(
    userId: string,
    objectId: string,
    destination: string,
  ): Promise<void>;
  delete(userId: string, objectId: string): Promise<void>;
  abortUpload?(
    userId: string,
    uploadId: string,
    artifactId: string,
  ): Promise<void>;
}
export interface FakeUploadDiagnostic {
  id: string;
  resumable: true;
  chunks: Array<{ offset: number; size: number; checksum: string }>;
}

export class FakeBackupProvider implements BackupProvider {
  kind = "fake";
  private chunkSizes = new Map<string, number>();
  private faults = new Map<string, { chunk: number; remaining: number }>();
  private uploads = new Map<
    string,
    { ownerId: string; artifactId: string; diagnostic: FakeUploadDiagnostic }
  >();
  constructor(private root: string) {}
  connect(userId: string, chunkSize?: number) {
    const size = Math.max(
      1024,
      Math.min(8 * 1024 * 1024, chunkSize || 64 * 1024),
    );
    this.chunkSizes.set(userId, size);
    return {
      type: "fake",
      id: "fake",
      connected: true,
      testMode: true,
      chunkSize: size,
    };
  }
  setFault(userId: string, chunk: number, count: number) {
    this.faults.set(userId, { chunk, remaining: count });
  }
  diagnostic(userId: string, id: string) {
    const upload = this.uploads.get(id);
    return upload?.ownerId === userId ? upload.diagnostic : undefined;
  }
  private path(userId: string, id: string) {
    assertSafeUserId(userId);
    assertSafePathId(id, "artifactId");
    return join(this.root, userId, `${id}.backup`);
  }
  async upload(
    userId: string,
    artifactId: string,
    source: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
    resumeUploadId?: string,
  ): Promise<UploadResult> {
    assertSafeUserId(userId);
    assertSafePathId(artifactId, "artifactId");
    await mkdir(join(this.root, userId), { recursive: true, mode: 0o700 });
    const prior = resumeUploadId ? this.uploads.get(resumeUploadId) : undefined;
    if (prior && (prior.ownerId !== userId || prior.artifactId !== artifactId))
      throw new Error("Invalid resumable upload session");
    const uploadId = prior ? resumeUploadId! : randomUUID();
    const diagnostic: FakeUploadDiagnostic = prior?.diagnostic ?? {
      id: uploadId,
      resumable: true,
      chunks: [],
    };
    const resumedFromChunk = diagnostic.chunks.length;
    this.uploads.set(uploadId, { ownerId: userId, artifactId, diagnostic });
    const input = await open(source, "r"),
      output = await open(
        this.path(userId, artifactId),
        prior ? "r+" : "w",
        0o600,
      );
    let offset = diagnostic.chunks.reduce(
        (total, chunk) => total + chunk.size,
        0,
      ),
      index = diagnostic.chunks.length + 1;
    try {
      const buffer = Buffer.alloc(this.chunkSizes.get(userId) || 64 * 1024);
      while (true) {
        if (signal?.aborted)
          throw Object.assign(new Error("Backup upload cancelled"), {
            name: "AbortError",
          });
        const { bytesRead } = await input.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        await output.write(chunk, 0, bytesRead, offset);
        diagnostic.chunks.push({
          offset,
          size: bytesRead,
          checksum: createHash("sha256").update(chunk).digest("hex"),
        });
        offset += bytesRead;
        onProgress(offset);
        const fault = this.faults.get(userId);
        if (fault?.chunk === index && fault.remaining > 0) {
          fault.remaining--;
          throw Object.assign(new Error("Fake provider upload failed"), {
            uploadId,
            objectId: artifactId,
            completedChunks: diagnostic.chunks.length,
          });
        }
        index++;
      }
    } finally {
      await input.close();
      await output.close();
    }
    return {
      objectId: artifactId,
      size: offset,
      uploadId,
      resumedFromChunk,
    };
  }
  async download(userId: string, id: string, dest: string) {
    await pipeline(
      createReadStream(this.path(userId, id)),
      createWriteStream(dest, { mode: 0o600 }),
    );
  }
  async delete(userId: string, id: string) {
    await rm(this.path(userId, id), { force: true });
  }
  async abortUpload(userId: string, uploadId: string, artifactId: string) {
    const upload = this.uploads.get(uploadId);
    if (upload?.ownerId === userId) this.uploads.delete(uploadId);
    await rm(this.path(userId, artifactId), { force: true });
  }
}
export class LocalBackupProvider implements BackupProvider {
  kind = "local";
  constructor(private root: string) {}
  private path(u: string, id: string) {
    assertSafeUserId(u);
    assertSafePathId(id, "artifactId");
    return join(this.root, u, `${id}.backup`);
  }
  async upload(
    u: string,
    id: string,
    s: string,
    p: (n: number) => void,
    signal?: AbortSignal,
  ) {
    assertSafeUserId(u);
    assertSafePathId(id, "artifactId");
    await mkdir(join(this.root, u), { recursive: true, mode: 0o700 });
    let n = 0;
    const t = new (await import("node:stream")).Transform({
      transform(c, _e, cb) {
        n += c.length;
        p(n);
        cb(null, c);
      },
    });
    await pipeline(
      createReadStream(s),
      t,
      createWriteStream(this.path(u, id), { mode: 0o600 }),
      { signal },
    );
    return {
      objectId: id,
      size: (await stat(this.path(u, id))).size,
      uploadId: id,
      resumedFromChunk: 0,
    };
  }
  async download(u: string, id: string, d: string) {
    await pipeline(
      createReadStream(this.path(u, id)),
      createWriteStream(d, { mode: 0o600 }),
    );
  }
  async delete(u: string, id: string) {
    await rm(this.path(u, id), { force: true });
  }
}
export class GoogleDriveBackupProvider implements BackupProvider {
  kind = "google-drive";
  constructor(
    private getStoredToken: (userId: string) => Promise<GoogleDriveToken>,
    private saveStoredToken: (
      userId: string,
      token: GoogleDriveToken,
    ) => Promise<void>,
    private getOAuthCredentials: () => Promise<
      { clientId: string; clientSecret: string } | undefined
    > = async () => {
      const clientId = process.env.GOOGLE_BACKUP_CLIENT_ID || "";
      const clientSecret = process.env.GOOGLE_BACKUP_CLIENT_SECRET || "";
      return clientId && clientSecret ? { clientId, clientSecret } : undefined;
    },
    private transport: BackupHttpTransport = fetch,
    private retryDelay: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void> = abortableDelay,
  ) {}
  private async access(userId: string): Promise<string> {
    const token = await this.getStoredToken(userId);
    if (
      token.access_token &&
      (!token.expires_at || token.expires_at > Date.now() + 60_000)
    )
      return token.access_token;
    if (!token.refresh_token)
      throw new Error("Google Drive backup account is not linked");
    const credentials = await this.getOAuthCredentials();
    if (!credentials)
      throw new Error("Google Drive backup OAuth is not configured");
    const response = await this.transport(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: token.refresh_token,
          grant_type: "refresh_token",
        }),
      },
    );
    if (!response.ok) throw new Error("Google Drive token refresh failed");
    const refreshed = (await response.json()) as any;
    if (typeof refreshed.access_token !== "string" || !refreshed.access_token)
      throw new Error("Google Drive token refresh returned an invalid token");
    const next: GoogleDriveToken = {
      ...token,
      access_token: refreshed.access_token,
      expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
    };
    await this.saveStoredToken(userId, next);
    return next.access_token;
  }
  async upload(
    userId: string,
    artifactId: string,
    source: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
    resumeUploadId?: string,
  ): Promise<UploadResult> {
    const access = await this.access(userId);
    const size = (await stat(source)).size;
    let session = resumeUploadId;
    let offset = 0;
    if (session) {
      if (!isGoogleUploadSession(session))
        throw new Error("Invalid Google Drive resumable upload session");
      const probe = await this.transport(session, {
        method: "PUT",
        signal,
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Length": "0",
          "Content-Range": `bytes */${size}`,
        },
      });
      if (probe.status === 308) {
        offset = parseGoogleRange(probe.headers.get("range"));
        if (offset < 0 || offset > size)
          throw new Error("Google Drive returned an invalid resumable offset");
      } else if (!probe.ok) session = undefined;
      else {
        const complete = (await probe.json()) as any;
        return {
          objectId: String(complete.id || ""),
          size,
          uploadId: "completed",
          resumedFromChunk: Math.ceil(size / (8 * 1024 * 1024)),
        };
      }
    }
    if (!session) {
      const metadata: Record<string, unknown> = {
        name: `agentor-${artifactId}.backup`,
        appProperties: { agentorBackup: "v1", artifactId },
      };
      if (process.env.GOOGLE_BACKUP_FOLDER_ID)
        metadata.parents = [process.env.GOOGLE_BACKUP_FOLDER_ID];
      const begin = await this.transport(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size",
        {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "application/octet-stream",
            "X-Upload-Content-Length": String(size),
          },
          body: JSON.stringify(metadata),
        },
      );
      if (!begin.ok)
        throw new Error("Google Drive resumable upload could not start");
      session = begin.headers.get("location") || undefined;
      if (!session)
        throw new Error("Google Drive did not return an upload session");
      if (!isGoogleUploadSession(session))
        throw new Error("Google Drive returned an invalid upload session");
    }
    const resumedFromChunk = Math.floor(offset / (8 * 1024 * 1024));
    const file = await open(source, "r");
    const chunkSize = 8 * 1024 * 1024;
    let objectId = "";
    try {
      while (offset < size) {
        if (signal?.aborted)
          throw Object.assign(new Error("Backup upload cancelled"), {
            name: "AbortError",
          });
        const length = Math.min(chunkSize, size - offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, offset);
        if (bytesRead !== length)
          throw new Error("Backup archive changed during upload");
        const request = () =>
          this.transport(session!, {
            method: "PUT",
            signal,
            headers: {
              Authorization: `Bearer ${access}`,
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
            },
            body: chunk as any,
          });
        let response: Response;
        try {
          response = await this.retryChunk(request, signal);
        } catch (error) {
          throw Object.assign(
            error instanceof Error
              ? error
              : new Error("Google Drive resumable upload failed"),
            { uploadId: session },
          );
        }
        if (response.status !== 308 && !response.ok)
          throw Object.assign(
            new Error("Google Drive resumable upload failed"),
            { uploadId: session },
          );
        offset += length;
        onProgress(offset);
        if (response.ok)
          objectId = String(((await response.json()) as any).id || "");
      }
    } finally {
      await file.close();
    }
    if (!objectId)
      throw new Error("Google Drive upload completed without an object id");
    return { objectId, size, uploadId: objectId, resumedFromChunk };
  }
  async download(
    userId: string,
    objectId: string,
    destination: string,
  ): Promise<void> {
    const response = await this.transport(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(objectId)}?alt=media`,
      { headers: { Authorization: `Bearer ${await this.access(userId)}` } },
    );
    if (!response.ok || !response.body)
      throw new Error("Google Drive backup download failed");
    await pipeline(
      createReadStreamFromWeb(response.body),
      createWriteStream(destination, { mode: 0o600 }),
    );
  }
  async delete(userId: string, objectId: string): Promise<void> {
    const response = await this.transport(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(objectId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await this.access(userId)}` },
      },
    );
    if (!response.ok && response.status !== 404)
      throw new Error("Google Drive backup deletion failed");
  }
  async abortUpload(userId: string, uploadId: string): Promise<void> {
    if (!isGoogleUploadSession(uploadId)) return;
    await this.transport(uploadId, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await this.access(userId)}` },
    }).catch(() => undefined);
  }

  private async retryChunk(
    request: () => Promise<Response>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await request();
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new Error("Google Drive resumable upload failed");
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
      if (attempt < 2) await this.retryDelay(250 * 2 ** attempt, signal);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Google Drive resumable upload failed");
  }
}

export interface GoogleDriveToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}
function createReadStreamFromWeb(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as any);
}
function parseGoogleRange(value: string | null) {
  const match = /bytes=0-(\d+)/.exec(value || "");
  return match ? Number(match[1]) + 1 : 0;
}

function isGoogleUploadSession(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.googleapis.com" &&
      url.pathname.startsWith("/upload/")
    );
  } catch {
    return false;
  }
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ??
          Object.assign(new Error("Aborted"), { name: "AbortError" }),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function exchangeGoogleAuthorizationCode(
  input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    previousToken?: GoogleDriveToken;
  },
  transport: BackupHttpTransport = fetch,
): Promise<GoogleDriveToken> {
  const response = await transport("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok)
    throw new Error("Google Drive authorization code exchange failed");
  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.access_token !== "string" || !payload.access_token)
    throw new Error("Google Drive returned an invalid token");
  return {
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : input.previousToken?.refresh_token,
    token_type:
      typeof payload.token_type === "string" ? payload.token_type : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
}

import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { lstat } from "node:fs/promises";
import { useConfig, useDockerService } from "./services";
import {
  normalizeClientPath,
  normalizeClientPathList,
  toContainerPath,
  parentRelPath,
  baseName,
} from "./workspace-path";
import { probeList, probeLstat } from "./workspace-probe-runner";
import { demuxSingleFileFromTar, buildWorkspaceZip } from "./workspace-zip";
import type { FileEntry, FileListing } from "../../shared/types";
import type { WorkspaceInventoryItem } from "./workspace-inventory";
import {
  operationSettlement,
  type OperationFailureWithSettlement,
  withOperationDeadline,
} from "./operation-deadline";
import { registerOperationHelper } from "./operation-helper-registry";

const HELPER_LIFETIME_MS = 60_000;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_ACTIVE_HELPERS = 8;
const MAX_ACTIVE_HELPERS_PER_USER = 3;
const HELPER_DOCKER_TIMEOUT_MS = 8_000;
let activeHelpers = 0;
const activeHelpersByUser = new Map<string, number>();

/** Remove helper containers left behind by a process crash or hard restart. */
export async function cleanupWorkspaceHelpers(): Promise<number> {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });
  const inventories = await Promise.allSettled(
    ["agentor.workspace-helper=true", "agentor.backup-restore-helper=true"].map(
      (label) =>
        withOperationDeadline(
          (operationSignal) => docker.listContainers({
            all: true,
            filters: { label: [label] },
            abortSignal: operationSignal,
          }),
          HELPER_DOCKER_TIMEOUT_MS,
          "Docker workspace-helper inventory",
        ),
    ),
  );
  const unique = new Map<string, Docker.ContainerInfo>();
  for (const inventory of inventories)
    if (inventory.status === "fulfilled")
      for (const container of inventory.value)
        unique.set(container.Id, container);
  // Startup owns no legitimate transfer from the previous process. Remove
  // every discovered helper, including one Docker still reports as running;
  // per-helper deadlines keep a corrupt object from blocking the rest.
  const containers = [...unique.values()];
  const results = await Promise.allSettled(
    containers.map((container) =>
      withOperationDeadline(
        (operationSignal) => docker.getContainer(container.Id).remove({
          force: true,
          abortSignal: operationSignal,
        } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper cleanup",
      ),
    ),
  );
  return results.filter((result) => result.status === "fulfilled").length;
}

export interface WorkspaceSearchResult {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string;
}
export interface WorkspaceDownload {
  kind: "file" | "zip";
  entry?: FileEntry;
  stream: Readable;
}
export interface WorkspacePreview {
  kind: "text" | "image";
  contentType: string;
  size: number;
  text?: string;
  stream?: Readable;
}

const SEARCH_SCRIPT = String.raw`
import os,sys,json,datetime,time
root='/workspace'; q=sys.argv[1].casefold(); rel=sys.argv[2]; base=os.path.join(root,rel) if rel else root; out=[]; seen=0; deadline=time.monotonic()+5
realbase=os.path.realpath(base)
if not (realbase==root or realbase.startswith(root+'/')) or not os.path.isdir(base) or os.path.islink(base):
  print(json.dumps({'error':'invalid_path'})); sys.exit(0)
for current,dirs,files in os.walk(base,topdown=True,followlinks=False):
  dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(current,d))]
  for name,typ in [(d,'directory') for d in dirs]+[(f,'file') for f in files]:
    if len(out)>=500 or seen>=10000 or time.monotonic()>deadline: break
    seen+=1; p=os.path.join(current,name)
    if os.path.islink(p) or q not in name.casefold(): continue
    try:
      rp=os.path.realpath(p)
      if not (rp==root or rp.startswith(root+'/')): continue
      st=os.lstat(p); rel=os.path.relpath(p,root)
      out.append({'name':name,'path':rel,'type':typ,'size':st.st_size if typ=='file' else 0,'mtime':datetime.datetime.utcfromtimestamp(st.st_mtime).strftime('%Y-%m-%dT%H:%M:%SZ'),'mode':format(st.st_mode & 0o7777,'04o'),'owner':str(st.st_uid),'group':str(st.st_gid)})
    except OSError: pass
  if len(out)>=500 or seen>=10000 or time.monotonic()>deadline: break
print(json.dumps({'results':out,'truncated':seen>=10000 or len(out)>=500 or time.monotonic()>deadline}))
`;

class HelperLease {
  private docker = new Docker({ socketPath: "/var/run/docker.sock" });
  private timer?: NodeJS.Timeout;
  containerId = "";
  private slotHeld = false;
  private readonly operationId = randomUUID();
  private releaseOperation?: () => void;

  constructor(private item: WorkspaceInventoryItem) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const config = useConfig();
    const image = config.workerImagePrefix + config.workerImage;
    await useDockerService().ensureImage(image, signal);
    // Resolve the approved configured image to immutable content before the
    // helper is created. A mutable tag changing between requests cannot select
    // an unreviewed helper implementation mid-operation.
    const imageId = (
      await withOperationDeadline(
        (operationSignal) => this.docker.getImage(image).inspect({
          abortSignal: operationSignal,
        } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper image inspection",
        signal,
      )
    ).Id;
    // Docker creates a missing bind source/volume implicitly. Refuse that side
    // effect: offline browsing must be strictly read-only, including setup.
    if (this.item.backend === "volume") {
      await withOperationDeadline(
        (operationSignal) => this.docker.getVolume(this.item.storageRef).inspect({
          abortSignal: operationSignal,
        }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace volume inspection",
        signal,
      )
        .catch((error) => {
          const status = (error as { statusCode?: number; status?: number })
            ?.statusCode ?? (error as { status?: number })?.status;
          if (status !== 404) throw error;
          throw createError({
            statusCode: 404,
            statusMessage: "Workspace volume not found",
          });
        });
    } else {
      const st = await lstat(this.item.validationRef ?? "").catch(() => null);
      if (!st?.isDirectory() || st.isSymbolicLink())
        throw createError({
          statusCode: 404,
          statusMessage: "Workspace directory not found",
        });
    }
    this.acquireSlot();
    const createOptions: Docker.ContainerCreateOptions = {
      Image: imageId,
      name: `agentor-workspace-reader-${this.operationId}`,
      // Lifetime is controlled explicitly by the lease and startup stale
      // cleanup. A fixed `sleep 60` killed valid throttled download streams.
      Entrypoint: ["tail"],
      Cmd: ["-f", "/dev/null"],
      User: "1000:1000",
      WorkingDir: "/workspace",
      Labels: {
        "agentor.workspace-helper": "true",
        "agentor.workspace-id": this.item.id,
        "agentor.helper.operation-id": this.operationId,
        "agentor.helper.owner-id": this.item.userId ?? "system",
        "agentor.helper.created-at": new Date().toISOString(),
      },
      HostConfig: {
        Mounts: [
          {
            Type: this.item.backend === "volume" ? "volume" : "bind",
            Source: this.item.storageRef,
            Target: "/workspace",
            ReadOnly: true,
            ...(this.item.backend === "volume"
              ? { VolumeOptions: { NoCopy: true } }
              : {}),
          },
        ] as any,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 32,
        Memory: 128 * 1024 * 1024,
        NanoCpus: 500_000_000,
        Init: true,
        AutoRemove: false,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
        LogConfig: { Type: "none", Config: {} },
      },
    };
    let helper: Docker.Container;
    try {
      helper = await withOperationDeadline(
        (operationSignal) => this.docker.createContainer({
          ...createOptions,
          abortSignal: operationSignal,
        }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper creation",
        signal,
      );
    } catch (err) {
      // Docker may accept a create immediately before its HTTP response is
      // aborted. The operation-scoped name remains a safe, deterministic
      // cleanup handle even when dockerode never returned the container id.
      const cleanupAmbiguousCreate = () => withOperationDeadline(
        (operationSignal) => this.docker.getContainer(createOptions.name!).remove({
          force: true,
          abortSignal: operationSignal,
        } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper ambiguous-create cleanup",
      ).catch(() => {});
      await cleanupAmbiguousCreate();
      // If abort won the race before Docker's create response settled, repeat
      // cleanup after settlement so a late-created object cannot escape the
      // immediate name-based attempt. Startup stale cleanup remains the final
      // crash-safe backstop.
      const settlement = (err as OperationFailureWithSettlement)?.[
        operationSettlement
      ];
      if (settlement) void settlement.then(cleanupAmbiguousCreate);
      this.releaseSlot();
      throw err;
    }
    this.containerId = helper.id;
    try {
      await withOperationDeadline(
        (operationSignal) => helper.start({ abortSignal: operationSignal }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper start",
        signal,
      );
    } catch (err) {
      await withOperationDeadline(
        (operationSignal) => helper.remove({ force: true, abortSignal: operationSignal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        HELPER_DOCKER_TIMEOUT_MS,
        "Docker workspace-helper failed-start cleanup",
      ).catch(() => {});
      // Some rootless/nested Docker daemons run their docker cgroup in
      // threaded mode and reject *any* cgroup-v2 controller setting. Keep the
      // isolation controls that do not depend on cgroups (read-only rootfs,
      // no network, dropped capabilities and no-new-privileges), but retry
      // without the optional resource ceilings in that known-hostile runtime.
      // A normal Docker failure must still fail closed.
      if (!isThreadedCgroupLimitError(err)) {
        this.releaseSlot();
        throw err;
      }
      const { PidsLimit, Memory, NanoCpus, ...fallbackHostConfig } =
        createOptions.HostConfig!;
      const fallbackName = `agentor-workspace-reader-${this.operationId}-fallback`;
      try {
        helper = await withOperationDeadline((operationSignal) => this.docker.createContainer({
          ...createOptions,
          name: fallbackName,
          HostConfig: fallbackHostConfig,
          abortSignal: operationSignal,
        }), HELPER_DOCKER_TIMEOUT_MS, "Docker workspace-helper fallback creation", signal);
        this.containerId = helper.id;
        await withOperationDeadline(
          (operationSignal) => helper.start({ abortSignal: operationSignal }),
          HELPER_DOCKER_TIMEOUT_MS,
          "Docker workspace-helper fallback start",
          signal,
        );
      } catch (fallbackError) {
        const cleanupFallback = () => withOperationDeadline(
          (operationSignal) => this.docker.getContainer(fallbackName).remove({
            force: true,
            abortSignal: operationSignal,
          } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
          HELPER_DOCKER_TIMEOUT_MS,
          "Docker workspace-helper fallback cleanup",
        ).catch(() => {});
        await cleanupFallback();
        const settlement = (
          fallbackError as OperationFailureWithSettlement
        )?.[operationSettlement];
        if (settlement) void settlement.then(cleanupFallback);
        this.releaseSlot();
        throw fallbackError;
      }
    }
    this.timer = setTimeout(() => void this.close(), HELPER_LIFETIME_MS);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.containerId) {
      this.releaseSlot();
      return;
    }
    const id = this.containerId;
    this.containerId = "";
    // Capacity belongs to the lease, not Docker's response. Release it before
    // waiting so one broken helper object cannot deny unrelated operations.
    this.releaseSlot();
    await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(id).remove({
        force: true,
        abortSignal: operationSignal,
      } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
      HELPER_DOCKER_TIMEOUT_MS,
      "Docker workspace-helper cleanup",
    ).catch(() => {});
  }

  /** Guard a response/archive stream with an inactivity timeout. The source is
   * connected lazily on the first consumer read so adding the watchdog cannot
   * put it into flowing mode before h3/Docker attaches its consumer. Each chunk
   * that crosses the transform resets the timer; when downstream backpressure
   * stalls the transfer, chunks stop crossing and the helper is reclaimed. */
  holdForStream(source: Readable, signal?: AbortSignal): Readable {
    let guarded!: LazyWatchdogStream;
    const arm = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const err = new Error("Workspace transfer timed out due to inactivity");
        guarded.destroy(err);
        void this.close();
      }, HELPER_LIFETIME_MS);
      this.timer.unref?.();
    };
    guarded = new LazyWatchdogStream(source, arm);
    // Disconnect is a normal ownership release. Avoid emitting an unhandled
    // stream error if it lands in the narrow interval before h3 consumes the
    // returned stream.
    const abort = () => guarded.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    guarded.once("close", () => signal?.removeEventListener("abort", abort));
    arm();
    if (signal?.aborted) abort();
    return guarded;
  }

  private acquireSlot(): void {
    const owner = this.item.userId ?? "system";
    const ownerCount = activeHelpersByUser.get(owner) ?? 0;
    if (
      activeHelpers >= MAX_ACTIVE_HELPERS ||
      ownerCount >= MAX_ACTIVE_HELPERS_PER_USER
    ) {
      throw createError({
        statusCode: 429,
        statusMessage: "Too many concurrent workspace operations",
      });
    }
    activeHelpers++;
    activeHelpersByUser.set(owner, ownerCount + 1);
    this.slotHeld = true;
    this.releaseOperation = registerOperationHelper(this.operationId);
  }

  private releaseSlot(): void {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    const owner = this.item.userId ?? "system";
    activeHelpers = Math.max(0, activeHelpers - 1);
    const remaining = (activeHelpersByUser.get(owner) ?? 1) - 1;
    if (remaining > 0) activeHelpersByUser.set(owner, remaining);
    else activeHelpersByUser.delete(owner);
    this.releaseOperation?.();
    this.releaseOperation = undefined;
  }
}

/** Docker-in-Docker can expose a threaded cgroup subtree where runc cannot
 * apply controller-backed Pids/CPU/memory limits. Match the daemon wording
 * precisely so an unrelated helper startup failure is never weakened. */
function isThreadedCgroupLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cgroup(?:v2)?[^\n]*threaded mode|cannot enter cgroupv2[^\n]*threaded/i.test(
    message,
  );
}

/** A backpressure-preserving pass-through that does not touch its source until
 * a downstream consumer asks for data. This avoids the easy-to-miss data-loss
 * race caused by installing a `data` listener merely to observe activity. */
class LazyWatchdogStream extends Transform {
  private started = false;

  constructor(
    private readonly source: Readable,
    private readonly onActivity: () => void,
  ) {
    super();
    // Error observation does not switch a readable into flowing mode, unlike a
    // `data` listener, and protects the pre-consumer window as well.
    this.source.once("error", (error) => this.destroy(error));
  }

  override _read(size: number): void {
    if (!this.started) {
      this.started = true;
      this.source.pipe(this);
    }
    super._read(size);
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.onActivity();
    callback(null, chunk);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.source.destroy(error ?? undefined);
    callback(error);
  }
}

export class OfflineWorkspaceAccess {
  constructor(private item: WorkspaceInventoryItem) {}

  async list(rawPath: unknown): Promise<FileListing> {
    const rel = normalizeClientPath(rawPath);
    return this.withHelper((lease) =>
      probeList(useDockerService(), lease.containerId, rel),
    );
  }

  async lstat(rawPath: unknown): Promise<FileEntry> {
    const rel = normalizeClientPath(rawPath);
    return this.withHelper(async (lease) => {
      if (rel === "")
        return probeLstat(useDockerService(), lease.containerId, rel);
      // Listing the contained parent exposes symlink metadata (including an
      // escaping target flag) without following the final symlink. The regular
      // probe intentionally rejects such a final symlink, which is correct for
      // reads but too strict for metadata-only inspection.
      const listing = await probeList(
        useDockerService(),
        lease.containerId,
        parentRelPath(rel),
      );
      const entry = listing.entries.find(
        (candidate) => candidate.name === baseName(rel),
      );
      if (!entry)
        throw createError({
          statusCode: 404,
          statusMessage: "Path not found in workspace",
        });
      return entry;
    });
  }

  async search(
    rawQuery: unknown,
    rawPath: unknown = "",
  ): Promise<{
    query: string;
    path: string;
    results: WorkspaceSearchResult[];
    truncated: boolean;
  }> {
    if (
      typeof rawQuery !== "string" ||
      rawQuery.trim().length < 1 ||
      rawQuery.length > 200
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: "q must be between 1 and 200 characters",
      });
    }
    const rel = normalizeClientPath(rawPath);
    return this.withHelper(async (lease) => {
      const res = await useDockerService().execCapture(
        lease.containerId,
        ["python3", "-c", SEARCH_SCRIPT, rawQuery, rel],
        { user: "agent" },
      );
      if (res.exitCode !== 0 || res.stdout.length > 1024 * 1024)
        throw createError({
          statusCode: 500,
          statusMessage: "Workspace search failed",
        });
      const parsed = JSON.parse(res.stdout.toString("utf8")) as {
        error?: string;
        results?: WorkspaceSearchResult[];
        truncated?: boolean;
      };
      if (parsed.error === "invalid_path")
        throw createError({
          statusCode: 404,
          statusMessage: "Search path is not a directory",
        });
      return {
        query: rawQuery,
        path: rel,
        results: (parsed.results ?? []).slice(0, MAX_SEARCH_RESULTS),
        truncated: !!parsed.truncated,
      };
    });
  }

  async preview(rawPath: unknown): Promise<WorkspacePreview> {
    const rel = normalizeClientPath(rawPath, { allowRoot: false });
    const lease = new HelperLease(this.item);
    await lease.start();
    try {
      const entry = await probeLstat(
        useDockerService(),
        lease.containerId,
        rel,
      );
      if (entry.type !== "file")
        throw createError({
          statusCode: 409,
          statusMessage: "Preview requires a regular file",
        });
      if (entry.size > MAX_PREVIEW_BYTES)
        throw createError({
          statusCode: 413,
          statusMessage: "File is too large to preview",
        });
      const tar = await useDockerService().getArchive(
        lease.containerId,
        toContainerPath(rel),
      );
      const stream = demuxSingleFileFromTar(tar, entry.size);
      const head = await readBounded(stream, MAX_PREVIEW_BYTES);
      const imageType = detectImage(head);
      if (imageType)
        return {
          kind: "image",
          contentType: imageType,
          size: entry.size,
          stream: Readable.from(head),
        };
      if (entry.size > MAX_TEXT_PREVIEW_BYTES || hasBinaryControls(head))
        throw createError({
          statusCode: 415,
          statusMessage: "File is not safe text or a supported image",
        });
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(head);
      } catch {
        throw createError({
          statusCode: 415,
          statusMessage: "File is not valid UTF-8 text",
        });
      }
      return {
        kind: "text",
        contentType: "text/plain; charset=utf-8",
        size: entry.size,
        text,
      };
    } finally {
      await lease.close();
    }
  }

  async download(rawPaths: unknown, signal?: AbortSignal): Promise<WorkspaceDownload> {
    signal?.throwIfAborted();
    const rels = normalizeClientPathList(rawPaths);
    if (rels.length > 100)
      throw createError({
        statusCode: 413,
        statusMessage: "Too many download paths",
      });
    const lease = new HelperLease(this.item);
    await lease.start(signal);
    try {
      const entries: FileEntry[] = [];
      for (const rel of rels) {
        signal?.throwIfAborted();
        entries.push(
          await probeLstat(useDockerService(), lease.containerId, rel, signal),
        );
      }
      if (entries.some((entry) => entry.type === "symlink"))
        throw createError({
          statusCode: 400,
          statusMessage: "Symlink downloads are not allowed offline",
        });
      let stream: Readable;
      let result: WorkspaceDownload;
      if (entries.length === 1 && entries[0]!.type === "file") {
        const tar = await useDockerService().getArchive(
          lease.containerId,
          toContainerPath(entries[0]!.path),
          signal,
        );
        stream = demuxSingleFileFromTar(tar, entries[0]!.size, signal);
        result = { kind: "file", entry: entries[0], stream };
      } else {
        stream = buildWorkspaceZip(
          useDockerService(),
          lease.containerId,
          entries,
          signal,
        );
        result = { kind: "zip", stream };
      }
      stream = lease.holdForStream(stream, signal);
      result.stream = stream;
      stream.once("close", () => void lease.close());
      stream.once("end", () => void lease.close());
      stream.once("error", () => void lease.close());
      return result;
    } catch (err) {
      await lease.close();
      throw err;
    }
  }

  /** Copy the complete workspace tar stream into a newly created worker. The
   * source remains read-only and the helper is held until Docker consumes the
   * stream with backpressure. */
  async cloneInto(targetContainerId: string): Promise<void> {
    const lease = new HelperLease(this.item);
    await lease.start();
    try {
      const stream = await useDockerService().getArchive(
        lease.containerId,
        "/workspace",
      );
      await useDockerService().putArchive(
        targetContainerId,
        lease.holdForStream(stream as Readable),
        "/",
      );
    } finally {
      await lease.close();
    }
  }

  private async withHelper<T>(
    fn: (lease: HelperLease) => Promise<T>,
  ): Promise<T> {
    const lease = new HelperLease(this.item);
    await lease.start();
    try {
      return await fn(lease);
    } finally {
      await lease.close();
    }
  }
}

async function readBounded(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > max) {
      stream.destroy();
      throw createError({
        statusCode: 413,
        statusMessage: "Preview exceeds size limit",
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function detectImage(buf: Buffer): string | undefined {
  const sane = (w: number, h: number) =>
    w > 0 && h > 0 && w * h <= MAX_IMAGE_PIXELS;
  if (
    buf.length >= 33 &&
    buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buf.readUInt32BE(8) === 13 &&
    buf.subarray(12, 16).toString() === "IHDR" &&
    sane(buf.readUInt32BE(16), buf.readUInt32BE(20))
  )
    return "image/png";
  if (
    buf.length >= 14 &&
    (buf.subarray(0, 6).toString() === "GIF87a" ||
      buf.subarray(0, 6).toString() === "GIF89a") &&
    sane(buf.readUInt16LE(6), buf.readUInt16LE(8)) &&
    buf[buf.length - 1] === 0x3b
  )
    return "image/gif";
  const jpeg = jpegDimensions(buf);
  if (jpeg && sane(jpeg[0], jpeg[1])) return "image/jpeg";
  const webp = webpDimensions(buf);
  if (webp && sane(webp[0], webp[1])) return "image/webp";
  return undefined;
}

function jpegDimensions(buf: Buffer): [number, number] | undefined {
  if (
    buf.length < 12 ||
    buf[0] !== 0xff ||
    buf[1] !== 0xd8 ||
    buf[buf.length - 2] !== 0xff ||
    buf[buf.length - 1] !== 0xd9
  )
    return;
  for (let i = 2; i + 8 < buf.length;) {
    if (buf[i++] !== 0xff) return;
    while (buf[i] === 0xff) i++;
    const marker = buf[i++]!;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (i + 2 > buf.length) return;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
      return [buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3)];
    i += len;
  }
}

function webpDimensions(buf: Buffer): [number, number] | undefined {
  if (
    buf.length < 30 ||
    buf.subarray(0, 4).toString() !== "RIFF" ||
    buf.subarray(8, 12).toString() !== "WEBP" ||
    buf.readUInt32LE(4) + 8 > buf.length
  )
    return;
  const kind = buf.subarray(12, 16).toString();
  if (kind === "VP8X")
    return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (
    kind === "VP8 " &&
    buf.length >= 30 &&
    buf[23] === 0x9d &&
    buf[24] === 0x01 &&
    buf[25] === 0x2a
  )
    return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === "VP8L" && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
}

function hasBinaryControls(buf: Buffer): boolean {
  for (const byte of buf) {
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
      byte === 0x7f
    )
      return true;
  }
  return false;
}

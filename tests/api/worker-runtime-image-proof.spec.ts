import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { readImageProof } from "../../orchestrator/server/utils/worker-runtime-image-proof";

const requireOrchestrator = createRequire(new URL("../../orchestrator/package.json", import.meta.url));
const tar = requireOrchestrator("tar-stream") as { pack(): any };
const sha = (body: Buffer | string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const os = { os: "linux", architecture: "amd64" };

async function archive(entries: Array<{ name: string; body?: Buffer | string; type?: "file" | "directory" }>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  for (const item of entries) {
    const body = typeof item.body === "string" ? Buffer.from(item.body) : item.body ?? Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => pack.entry({ name: item.name, type: item.type ?? "file", size: body.length }, body,
      (error?: Error | null) => error ? reject(error) : resolve()));
  }
  const ended = new Promise<void>((resolve, reject) => { pack.once("end", resolve); pack.once("error", reject); });
  pack.finalize();
  await ended;
  return Buffer.concat(chunks);
}

async function fixture(kind: "classic" | "oci", overrides: {
  config?: Record<string, unknown>; layer?: string | Buffer; gzip?: boolean; compressedLayer?: Buffer;
  index?: Record<string, unknown> | ((manifestDigest: string, manifestSize: number) => Record<string, unknown>);
  manifest?: Record<string, unknown>;
  extraEntries?: Array<{ name: string; body: Buffer | string }>;
} = {}) {
  const rawLayer = Buffer.isBuffer(overrides.layer) ? overrides.layer : Buffer.from(overrides.layer ?? "layer tar bytes");
  const layer = overrides.compressedLayer ?? (overrides.gzip ? gzipSync(rawLayer) : rawLayer);
  const layerDigest = sha(layer);
  const config = bytes(overrides.config ?? { ...os, rootfs: { type: "layers", diff_ids: [sha(rawLayer)] } });
  const configDigest = sha(config);
  const classicConfigPath = `${configDigest.slice(7)}.json`;
  if (kind === "classic") {
    return { configDigest, data: await archive([
      { name: "layer/layer.tar", body: layer },
      { name: classicConfigPath, body: config },
      { name: "manifest.json", body: bytes([{ Config: classicConfigPath, RepoTags: ["worker:test"], Layers: ["layer/layer.tar"] }]) },
    ]) };
  }
  const manifest = bytes(overrides.manifest ?? { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length },
    layers: [{ mediaType: overrides.gzip ? "application/vnd.oci.image.layer.v1.tar+gzip" : "application/vnd.oci.image.layer.v1.tar",
      digest: layerDigest, size: layer.length }] });
  const manifestDigest = sha(manifest);
  const indexInput = typeof overrides.index === "function" ? overrides.index(manifestDigest, manifest.length) : overrides.index;
  const index = bytes(indexInput ?? { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: manifest.length, platform: os }] });
  return { configDigest, manifestDigest, indexDigest: sha(index), data: await archive([
    { name: "blobs/", type: "directory" },
    { name: "blobs/sha256/", type: "directory" },
    { name: `blobs/sha256/${layerDigest.slice(7)}`, body: layer },
    { name: `blobs/sha256/${configDigest.slice(7)}`, body: config },
    { name: `blobs/sha256/${manifestDigest.slice(7)}`, body: manifest },
    ...(overrides.extraEntries ?? []),
    { name: "index.json", body: index },
    { name: "oci-layout", body: bytes({ imageLayoutVersion: "1.0.0" }) },
    { name: "manifest.json", body: bytes([{ Config: `blobs/sha256/${configDigest.slice(7)}`, RepoTags: null,
      Layers: [`blobs/sha256/${layerDigest.slice(7)}`] }]) },
  ]) };
}

test("proves classic Docker image identity from raw config and streamed layers", async () => {
  const testImage = await fixture("classic");
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os)).resolves.toEqual({
    version: 1, configDigest: testImage.configDigest, platform: os,
  });
});

test("proves OCI image identity through raw config, manifest, and index", async () => {
  const testImage = await fixture("oci");
  for (const id of [testImage.configDigest, testImage.manifestDigest, testImage.indexDigest]) {
    await expect(readImageProof(Readable.from([testImage.data]), id, os)).resolves.toEqual({
      version: 1, configDigest: testImage.configDigest, platform: os,
    });
  }
});

test("rejects mismatched image ID and platform", async () => {
  const testImage = await fixture("oci");
  await expect(readImageProof(Readable.from([testImage.data]), `sha256:${"a".repeat(64)}`, os)).rejects.toThrow(/does not select/);
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest,
    { os: "linux", architecture: "arm64" })).rejects.toThrow(/does not select/);
});

test("verifies gzip layer diff IDs while hashing the compressed OCI descriptor", async () => {
  const testImage = await fixture("oci", { gzip: true, layer: "compressed layer content".repeat(100) });
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os)).resolves.toMatchObject({
    configDigest: testImage.configDigest,
  });
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
    { limits: { maxExpandedBytes: 100 } })).rejects.toThrow(/expanded layer byte limit/);
});

test("rejects truncated gzip member even when its compressed descriptor matches", async () => {
  const raw = Buffer.from("compressed layer content".repeat(100));
  const truncated = gzipSync(raw).subarray(0, -5);
  const testImage = await fixture("oci", { gzip: true, layer: raw.toString(), compressedLayer: truncated });
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os)).rejects.toThrow();
});

test("times out an idle archive stream and destroys it", async () => {
  const stream = new Readable({ read() {} });
  await expect(readImageProof(stream, `sha256:${"a".repeat(64)}`, os,
    { limits: { maxDurationMs: 20 } })).rejects.toThrow(/timed out/);
  expect(stream.destroyed).toBe(true);
});

test("bounds OCI graph traversal and rejects a repeated child", async () => {
  const repeated = await fixture("oci", { index: (manifestDigest, size) => ({
    schemaVersion: 2,
    manifests: [1, 2].map(() => ({ mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: manifestDigest, size, platform: os })),
  }) });
  await expect(readImageProof(Readable.from([repeated.data]), repeated.configDigest, os)).rejects.toThrow(/repeated OCI graph child/);
});

test("requires selected OCI children while allowing authenticated foreign omissions", async () => {
  const foreign = { mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"f".repeat(64)}`, size: 200, platform: { os: "linux", architecture: "arm64" } };
  const native = (manifestDigest: string, size: number) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size, platform: os,
  });
  const allowed = await fixture("oci", { index: (manifestDigest, size) => ({
    schemaVersion: 2, manifests: [native(manifestDigest, size), foreign],
  }) });
  await expect(readImageProof(Readable.from([allowed.data]), allowed.indexDigest, os)).resolves.toMatchObject({
    configDigest: allowed.configDigest,
  });
  const missingSelected = await fixture("oci", { index: () => ({
    schemaVersion: 2, manifests: [{ ...foreign, platform: os }],
  }) });
  await expect(readImageProof(Readable.from([missingSelected.data]), missingSelected.indexDigest, os)).rejects.toThrow(/missing or mis-sized/);
});

test("rejects contradictory platform declarations on nested OCI indexes", async () => {
  const nested = bytes({ schemaVersion: 2, manifests: [{
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"f".repeat(64)}`, size: 200,
    platform: { os: "linux", architecture: "arm64" },
  }] });
  const nestedDigest = sha(nested);
  const testImage = await fixture("oci", {
    extraEntries: [{ name: `blobs/sha256/${nestedDigest.slice(7)}`, body: nested }],
    index: () => ({ schemaVersion: 2, manifests: [{
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: nestedDigest, size: nested.length, platform: os,
    }] }),
  });
  await expect(readImageProof(Readable.from([testImage.data]), testImage.indexDigest, os)).rejects.toThrow(/nested platform descriptors disagree/);
});

test("cancels an active gzip verifier by signal and deadline", async () => {
  const large = Buffer.alloc(64 * 1024 * 1024);
  const testImage = await fixture("oci", { gzip: true, layer: large });
  const controller = new AbortController();
  const signalTimer = setTimeout(() => controller.abort(), 5);
  try {
    await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
      { signal: controller.signal })).rejects.toThrow();
  } finally { clearTimeout(signalTimer); }
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
    { limits: { maxDurationMs: 5 } })).rejects.toThrow(/timed out/);
});

test("rejects config bytes that disagree with config name", async () => {
  const testImage = await fixture("classic");
  const modified = Buffer.from(testImage.data);
  const marker = Buffer.from('"architecture":"amd64"');
  const at = modified.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  modified[at + marker.length - 2] = "5".charCodeAt(0);
  await expect(readImageProof(Readable.from([modified]), testImage.configDigest, os)).rejects.toThrow(/path\/digest mismatch/);
});

test("rejects forged layer bytes even when raw config is unchanged", async () => {
  const testImage = await fixture("classic", { layer: "layer tar bytes" });
  const modified = Buffer.from(testImage.data);
  const at = modified.indexOf(Buffer.from("layer tar bytes"));
  expect(at).toBeGreaterThan(0);
  modified[at] = "L".charCodeAt(0);
  await expect(readImageProof(Readable.from([modified]), testImage.configDigest, os)).rejects.toThrow(/layers disagree/);
});

test("rejects duplicate paths, truncation, and trailing nonzero bytes", async () => {
  const testImage = await fixture("classic");
  const duplicate = await archive([{ name: "same", body: "1" }, { name: "same", body: "2" },
    { name: "manifest.json", body: "[]" }]);
  await expect(readImageProof(Readable.from([duplicate]), testImage.configDigest)).rejects.toThrow(/duplicate/);
  await expect(readImageProof(Readable.from([testImage.data.subarray(0, 1000)]), testImage.configDigest)).rejects.toThrow(/truncated/);
  await expect(readImageProof(Readable.from([Buffer.concat([testImage.data, Buffer.from("evil")])]), testImage.configDigest)).rejects.toThrow(/trailer/);
});

test("enforces archive and metadata limits and cancellation", async () => {
  const testImage = await fixture("classic");
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
    { limits: { maxArchiveBytes: 512 } })).rejects.toThrow(/limit/);
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
    { limits: { maxMetadataBytes: 10 } })).rejects.toThrow(/metadata missing or too large/);
  const controller = new AbortController();
  controller.abort();
  await expect(readImageProof(Readable.from([testImage.data]), testImage.configDigest, os,
    { signal: controller.signal })).rejects.toThrow(/aborted/);
});

test("parses available real Docker save examples without materializing layers", async () => {
  const base = "/workspace/kata-image-proof-live";
  for (const name of ["classic-orchestrator.tar", "containerd-orchestrator.tar", "containerd-ubuntu.tar"]) {
    const path = `${base}/${name}`;
    try { await access(path); } catch { test.skip(); return; }
    const ubuntu = name === "containerd-ubuntu.tar";
    const imageId = ubuntu
      ? "sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3"
      : "sha256:dcc2191f2b072bcb84c71970afe3ed439a65a8cdb2c63a6d698813d9395f60b6";
    const proof = await readImageProof(createReadStream(path), imageId, os);
    expect(proof.configDigest).toBe(ubuntu
      ? "sha256:6232b38791000e3818b58d8847b5a8f5612d606929e01156dd8febc423e0f2ef"
      : imageId);
  }
});

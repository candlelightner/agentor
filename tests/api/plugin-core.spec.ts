import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PluginDefinitionStore } from "../../orchestrator/server/utils/plugin-definition-store";
import { PluginInstallationStore } from "../../orchestrator/server/utils/plugin-installation-store";
import {
  validateDefinitionScope,
  validatePluginManifest,
} from "../../orchestrator/server/utils/plugin-manifest";
import {
  PluginRuntimeManager,
  settleOnceWithDeadline,
  type PluginWorkerExecutor,
} from "../../orchestrator/server/utils/plugin-runtime-manager";
import {
  sanitizePluginSvg,
  sanitizePluginSvgOrDefault,
} from "../../orchestrator/server/utils/plugin-svg";

const manifest = (port = 12000) => ({
  schemaVersion: 1,
  name: "Example",
  slug: "example",
  description: "test",
  version: "1",
  lifecycle: {
    start: { argv: ["true"], mode: "background" },
    readiness: { kind: "tcp", portId: "web" },
  },
  resources: {
    ports: [{ id: "web", protocol: "http", fixedPort: port }],
    display: { mode: "dedicated", rangeStart: 100, rangeEnd: 101 },
  },
  environment: { envKeys: ["SAFE_NAME"], secretKeys: ["SAFE_SECRET"] },
});

test("plugin manifest is strict about scope, lifecycle, and resource references", () => {
  expect(validatePluginManifest(manifest())).toMatchObject({ slug: "example" });
  expect(() =>
    validatePluginManifest({ ...manifest(), ignored: true }),
  ).toThrow(/unsupported fields/);
  expect(() =>
    validatePluginManifest({
      ...manifest(),
      lifecycle: {
        start: { argv: ["true"] },
        readiness: { kind: "tcp", portId: "missing" },
      },
    }),
  ).toThrow(/declared port/);
  expect(() =>
    validatePluginManifest({
      ...manifest(),
      lifecycle: {
        start: { argv: ["true"] },
        stop: { argv: ["true"], mode: "background" },
      },
    }),
  ).toThrow(/oneshot/);
  expect(() =>
    validateDefinitionScope({
      scope: "group",
      ownerId: "owner",
      groupId: "group",
      workerId: "worker",
    }),
  ).toThrow(/worker identity/);
  for (const invalid of [
    { ...manifest(), name: "TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz" },
    { ...manifest(), description: "authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz" },
    { ...manifest(), actions: [{ id: "open", label: "SECRET=github_pat_abcdefghijklmnopqrstuvwxyz", kind: "private-ui", portId: "web", path: "/" }] },
  ]) expect(() => validatePluginManifest(invalid)).toThrow(/secret values/);
});

test("desktop plugin actions use Agentor's authenticated noVNC route", () => {
  const parsed = validatePluginManifest({
    ...manifest(6080),
    actions: [{ id: "desktop", label: "Open desktop", kind: "private-ui", portId: "web", path: "/vnc.html", openMode: "desktop" }],
  });
  expect(parsed.actions?.[0]?.openMode).toBe("desktop");
});

test("plugin SVG sanitizer rejects active content and preserves valid self-closing markup", () => {
  expect(
    sanitizePluginSvg('<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>'),
  ).toContain('<path d="M1 1L2 2"/>');
  for (const unsafe of [
    "<svg><script/></svg>",
    '<svg onload="x"></svg>',
    "<svg><foreignObject/></svg>",
    "<!DOCTYPE svg><svg/>",
  ])
    expect(sanitizePluginSvg(unsafe)).toBeNull();
  expect(sanitizePluginSvgOrDefault("<svg><script/></svg>").fallback).toBe(
    true,
  );
});

test("plugin allocations are durable, worker-local, and serialized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-plugin-core-"));
  try {
    const definitions = new PluginDefinitionStore(dir),
      installations = new PluginInstallationStore(dir);
    await Promise.all([definitions.init(), installations.init()]);
    const definition = await definitions.create({
      scope: "owner",
      ownerId: "owner",
      manifest: manifest(),
    });
    const create = () =>
      installations.create({
        userId: "owner",
        workerId: "worker",
        definitionId: definition.id,
        definitionVersion: "1",
        definitionHash: definition.definitionHash,
      });
    const [first, second] = await Promise.all([create(), create()]);
    const results = await Promise.allSettled([
      installations.reserveResources("owner", first.id, definition.manifest),
      installations.reserveResources("owner", second.id, definition.manifest),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const allocated = results.find(
      (item): item is PromiseFulfilledResult<any> =>
        item.status === "fulfilled",
    )!.value;
    expect(
      (
        await installations.reserveResources(
          "owner",
          allocated.id,
          definition.manifest,
        )
      ).allocations,
    ).toEqual(allocated.allocations);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime reconciliation is generation-idempotent and group scope fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-plugin-runtime-"));
  try {
    const definitions = new PluginDefinitionStore(dir),
      installations = new PluginInstallationStore(dir);
    await Promise.all([definitions.init(), installations.init()]);
    const definition = await definitions.create({
      scope: "owner",
      ownerId: "owner",
      manifest: manifest(12001),
    });
    const installed = await installations.create({
      userId: "owner",
      workerId: "worker",
      definitionId: definition.id,
      definitionVersion: "1",
      definitionHash: definition.definitionHash,
    });
    const calls: string[] = [];
    const executor: PluginWorkerExecutor = {
      execute: async (request) => {
        calls.push(request.phase);
        return { exitCode: 0 };
      },
      probe: async () => {
        calls.push("probe");
        return { exitCode: 0 };
      },
    };
    const runtime = new PluginRuntimeManager(
      definitions,
      installations,
      executor,
    );
    await runtime.reconcileInstallation("owner", installed.id, "generation-1");
    await runtime.reconcileInstallation("owner", installed.id, "generation-1");
    expect(calls).toEqual(["start", "probe"]);
    const group = await definitions.create({
      scope: "group",
      ownerId: "owner",
      groupId: "group",
      manifest: { ...manifest(12002), name: "Group", slug: "group" },
    });
    const groupInstall = await installations.create({
      userId: "owner",
      workerId: "worker",
      definitionId: group.id,
      definitionVersion: "1",
      definitionHash: group.definitionHash,
    });
    await expect(
      runtime.reconcileInstallation("owner", groupInstall.id, "generation-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settle-once deadline rejects promptly and ignores a late resolution", async () => {
  const started = Date.now();
  await expect(
    settleOnceWithDeadline(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 100)),
      20,
      "timed out",
    ),
  ).rejects.toMatchObject({ code: "PLUGIN_RUNTIME_TIMEOUT" });
  expect(Date.now() - started).toBeLessThan(90);
});

import { requireAdmin, requireAuth } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";
import { useContainerManager } from "../../utils/services";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Manage controlled worker-image definitions and builds",
    description:
      "Owner-scoped catalog operations including validation, builds, promotion, rollback, defaults, test workers, rebuilds, and cleanup.",
    responses: {
      200: { description: "Image catalog response" },
      202: { description: "Asynchronous image operation accepted" },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
    },
  },
});

function rethrow(err: unknown): never {
  const e = err as Error & { statusCode?: number };
  throw createError({
    statusCode: e.statusCode || 500,
    statusMessage: e.statusCode ? e.message : "Image catalog operation failed",
  });
}

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const admin = ctx.user.role === "admin";
  const manager = useImageCatalogManager();
  await manager.init();
  const parts = (getRouterParam(event, "path") || "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const method = event.method;
  try {
    if (parts[0] === "definitions") {
      if (parts.length === 1 && method === "GET")
        return manager.list(ctx.user.id, admin);
      if (parts.length === 1 && method === "POST") {
        setResponseStatus(event, 201);
        return manager.create(ctx.user.id, await readBody(event));
      }
      const id = parts[1]!;
      if (parts.length === 2 && method === "GET")
        return manager.definition(id, ctx.user.id, admin);
      if (parts.length === 2 && method === "DELETE") {
        await manager.removeDefinition(id, ctx.user.id, admin);
        setResponseStatus(event, 204);
        return null;
      }
      if (parts[2] === "builds" && method === "POST") {
        setResponseStatus(event, 202);
        return manager.startBuild(
          id,
          ctx.user.id,
          admin,
          await readBody(event),
        );
      }
      if (parts[2] === "rebuild-base" && method === "POST") {
        const body = await readBody<any>(event);
        setResponseStatus(event, 202);
        return manager.startBuild(id, ctx.user.id, admin, body);
      }
      if (parts[2] === "rollback" && method === "POST")
        return manager.rollback(
          id,
          String((await readBody<any>(event))?.version || ""),
          ctx.user.id,
          admin,
        );
      if (parts[2] === "logs" && method === "GET") {
        const logs = manager
          .list(ctx.user.id, admin)
          .filter((d) => d.id === id)
          .flatMap(() => []);
        setResponseHeader(event, "Content-Type", "text/plain; charset=utf-8");
        return logs.join("\n");
      }
      if (parts[2] === "versions") {
        const version = parts[3]!;
        if (parts.length === 4 && method === "DELETE") {
          await manager.deleteVersion(id, version, ctx.user.id, admin);
          setResponseStatus(event, 204);
          return null;
        }
        if (parts[4] === "promote" && method === "POST")
          return manager.promote(id, version, ctx.user.id, admin);
        if (parts[4] === "test-worker" && method === "POST") {
          const definition = manager.definition(id, ctx.user.id, admin),
            v = manager.version(id, version, ctx.user.id, admin);
          if (!v.runtimeImage)
            throw Object.assign(
              new Error(
                "This version has no runnable image artifact; run a controlled build first",
              ),
              { statusCode: 409 },
            );
          const body = await readBody<any>(event);
          const worker = await useContainerManager().create({
            userId: definition.ownerId,
            displayName: String(
              body?.displayName || `${definition.name} smoke test`,
            ).slice(0, 100),
            imageDefinitionId: definition.id,
            imageVersion: v.version,
            imageDigest: v.digest,
            imageRuntimeReference: v.runtimeImage,
          });
          setResponseStatus(event, 201);
          return {
            ...worker,
            workerId: worker.id,
            purpose: "image-test",
            imageDigest: v.digest,
            lifecycle:
              "ordinary-worker; stop/archive/delete through worker controls",
          };
        }
      }
    }
    if (parts[0] === "defaults") {
      if (parts.length === 1 && method === "PUT") {
        const b = await readBody<any>(event);
        return manager.setUserDefault(ctx.user.id, b.definitionId, b.version);
      }
      if (parts[1] === "system" && method === "PUT") {
        requireAdmin(event);
        const b = await readBody<any>(event);
        return manager.setSystemDefault(b.definitionId, b.version, ctx.user.id);
      }
      if (parts[1] === "effective" && method === "GET")
        return manager.effectiveDefault(ctx.user.id);
    }
    if (parts[0] === "usage" && method === "GET")
      return manager.usage(ctx.user.id, admin);
    if (parts[0] === "cleanup" && method === "POST")
      return manager.cleanup(ctx.user.id, admin, await readBody<any>(event));
    throw createError({
      statusCode: 404,
      statusMessage: "Image catalog route not found",
    });
  } catch (err) {
    rethrow(err);
  }
});

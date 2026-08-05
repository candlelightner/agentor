import { requireAuth } from "../../../utils/auth-helpers";
import { useGitImageCatalogManager } from "../../../utils/git-image-manager";
import { useImageCatalogManager } from "../../../utils/image-catalog";
import type { H3Event } from "h3";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Git-backed image catalog and recovery operations",
    description:
      "Optional owner-scoped GitHub source of truth. Credentials are write-only and image-catalog recovery never contains workspace data.",
    responses: {
      200: { description: "Git image catalog response" },
      400: { description: "Invalid request" },
      401: { description: "Unauthorized" },
      409: { description: "Conflict; local changes were preserved" },
    },
  },
});

function routeError(event: H3Event, error: unknown) {
  const value = error as Error & { statusCode?: number };
  // Nitro deliberately replaces dynamic status messages in production.
  // Return the small allowlisted validation error as response data so clients
  // receive actionable, non-secret feedback without reflecting provider
  // errors or credentials.
  if (
    value.statusCode === 400 &&
    (value.message ===
      "GHCR reference digest must match the built image digest" ||
      value.message === "GHCR references must be immutable digest references")
  ) {
    setResponseStatus(event, 400);
    return { error: true, message: value.message };
  }
  throw createError({
    statusCode: value.statusCode || 500,
    statusMessage: value.statusCode
      ? value.message
      : "Git image catalog operation failed",
  });
}
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event),
    manager = useGitImageCatalogManager(),
    catalog = useImageCatalogManager();
  await Promise.all([manager.init(), catalog.init()]);
  const parts = (getRouterParam(event, "path") || "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent),
    method = event.method;
  try {
    if (parts[0] === "format" && method === "GET") return manager.format();
    if (parts[0] === "connection") {
      if (method === "GET") return manager.connection(user.id);
      if (method === "PUT")
        return manager.connect(user.id, await readBody(event));
      if (method === "DELETE") return manager.disconnect(user.id);
    }
    if (parts[0] === "sync" && method === "POST")
      return manager.sync(
        user.id,
        catalog,
        await readBody(event).catch(() => ({})),
      );
    if (parts[0] === "recovery" && method === "GET")
      return manager.recovery(user.id);
    if (parts[0] === "recovery" && method === "POST")
      return manager.sync(user.id, catalog, {
        ...(await readBody(event).catch(() => ({}))),
        direction: "pull",
      });
    if (parts[0] === "fake") {
      if (
        process.env.NODE_ENV === "production" &&
        process.env.ALLOW_FAKE_GIT_PROVIDER !== "true"
      )
        throw Object.assign(new Error("Fake GitHub provider is disabled"), {
          statusCode: 403,
        });
      if (parts[1] === "repository" && method === "PUT")
        return manager.fakeConfigure(user.id, await readBody(event));
      if (parts[1] === "repository" && method === "GET")
        return manager.fakeInspect(user.id);
      if (parts[1] === "remote-files" && method === "PUT") {
        const body = await readBody<any>(event);
        return manager.fakeSetFiles(user.id, body?.files || {}, body?.branch);
      }
    }
    throw Object.assign(new Error("Git image catalog route not found"), {
      statusCode: 404,
    });
  } catch (error) {
    return routeError(event, error);
  }
});

import type { H3Event } from "h3";
import { canAccessResource, requireAuthFromEvent } from "./auth-helpers";
import { requireWorkerInstallation } from "./plugin-api";
import { useContainerManager, usePluginDefinitionStore, usePluginInstallationStore, useWorkerStore } from "./services";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function pluginWebSocketTarget(urlText: string, containerName: string) {
  const url = new URL(urlText, 'http://agentor.invalid');
  const match = /^\/plugin-ui\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return undefined;
  const [, workerId, installationId, actionId, suffix] = match.map((part) => decodeURIComponent(part));
  const installation = usePluginInstallationStore().getById(installationId!);
  if (!installation || installation.workerId !== workerId || !installation.desiredEnabled || !installation.observed.ready) return undefined;
  const definition = usePluginDefinitionStore().getById(installation.definitionId);
  const action = definition?.manifest.actions?.find((item) => item.id === actionId);
  const requirement = action && definition?.manifest.resources?.ports?.find((item) => item.id === action.portId);
  const port = action && installation.allocations?.ports[action.portId];
  if (!definition || definition.definitionHash !== installation.definitionHash || !action || requirement?.protocol !== 'http' || !port) return undefined;
  const base = action.path.endsWith('/') ? action.path : `${action.path}/`;
  const safeSuffix = suffix!.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `ws://${containerName}:${port}${base}${safeSuffix}${url.search}`;
}

export async function proxyPluginUi(event: H3Event, suffix = "") {
  // `/plugin-ui` is outside the `/api` auth middleware. Populate the same
  // context expected by the shared plugin API authorization helpers before
  // checking worker ownership.
  const auth = await requireAuthFromEvent(event);
  (event.context as { auth?: unknown }).auth = auth;
  const worker = useContainerManager().get(getRouterParam(event, "workerId")!) ?? useWorkerStore().findById(getRouterParam(event, "workerId")!);
  if (!worker || !canAccessResource(auth, worker, { allowGlobal: false }))
    throw createError({ statusCode: 404, statusMessage: "Plugin action not found" });
  const installation = requireWorkerInstallation(
    worker.userId,
    worker.id,
    getRouterParam(event, "installationId")!,
  );
  if (!installation.desiredEnabled || !installation.observed.ready)
    throw createError({
      statusCode: 409,
      statusMessage: "Plugin is not ready",
    });
  const runtime = useContainerManager().get(worker.id);
  if (!runtime || runtime.status !== "running")
    throw createError({
      statusCode: 409,
      statusMessage: "Worker is not running",
    });
  const definition = usePluginDefinitionStore().getById(
    installation.definitionId,
  );
  if (!definition || definition.definitionHash !== installation.definitionHash)
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin action not found",
    });
  const action = definition.manifest.actions?.find(
    (item) => item.id === getRouterParam(event, "actionId"),
  );
  const port = action && installation.allocations?.ports[action.portId];
  const requirement =
    action &&
    definition.manifest.resources?.ports?.find(
      (item) => item.id === action.portId,
    );
  if (!action || !port || requirement?.protocol !== "http")
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin action not found",
    });

  // Desktop/noVNC is an Agentor-managed route, not a worker-local HTTP app.
  // Redirect only after the normal authenticated installation/action checks so
  // the desktop proxy retains its owner/admin authorization and clipboard
  // bridge instead of exposing raw port 6080 through the generic gateway.
  // Keep definitions created before desktop mode existed working when they
  // use Agentor's canonical noVNC port/path.
  if (action.openMode === "desktop" || (port === 6080 && action.path === "/vnc.html"))
    return sendRedirect(event, `/desktop/${encodeURIComponent(worker.id)}/agentor.html`, 302);

  const method = event.method.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await readRawBody(event, false);
  if (body && Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw createError({
      statusCode: 413,
      statusMessage: "Plugin request is too large",
    });
  const base = action.path.endsWith("/") ? action.path : `${action.path}/`;
  const relative = suffix
    .split("/")
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join("/");
  const url = new URL(
    `http://${runtime.containerName}:${port}${base}${relative}`,
  );
  url.search = getRequestURL(event).search;
  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: getHeader(event, "accept") || "*/*",
      ...(getHeader(event, "content-type")
        ? { "content-type": getHeader(event, "content-type")! }
        : {}),
    },
    ...(body ? { body: new Uint8Array(body) } : {}),
  }).catch(() => {
    throw createError({
      statusCode: 502,
      statusMessage: "Plugin backend unavailable",
    });
  });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw createError({
      statusCode: 502,
      statusMessage: "Plugin response is too large",
    });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES)
    throw createError({
      statusCode: 502,
      statusMessage: "Plugin response is too large",
    });
  setResponseStatus(event, response.status);
  const contentType = response.headers.get("content-type");
  if (contentType) setHeader(event, "content-type", contentType);
  setHeader(event, "cache-control", "no-store");
  setHeader(
    event,
    "content-security-policy",
    "sandbox allow-forms allow-scripts; default-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'",
  );
  return bytes;
}

import Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import type { H3Event } from "h3";
import type { Peer } from "crossws";
import { authenticateWsPeer, requireAuthFromEvent, type AuthContext } from "./auth-helpers";
import { useContainerManager, usePluginDefinitionStore, usePluginInstallationStore } from "./services";
import { resolvePluginDesktop } from "./plugin-desktop-access";
import { pluginDesktopViewer } from "./plugin-desktop-viewer";
import { toBuffer } from "./ws-utils";
import { withOperationDeadline } from "./operation-deadline";
import { pluginAuthorityForTarget } from "./plugin-api";
import { definitionVisibleToPluginSelf } from "./plugin-scope";
import { useWorkerGroupStore } from "./services";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
type Target = { workerId: string; installationId: string; actionId: string; displayId: string };
function resolve(auth: AuthContext | null, target: Target) {
  const installation = usePluginInstallationStore().getById(target.installationId);
  const worker = useContainerManager().get(target.workerId);
  const definition = installation ? usePluginDefinitionStore().getById(installation.definitionId) : undefined;
  const resolved = resolvePluginDesktop(auth, worker, installation, definition, target);
  const authority = pluginAuthorityForTarget(worker!);
  if (!authority || !definitionVisibleToPluginSelf(definition!, authority, useWorkerGroupStore()))
    throw createError({ statusCode: 404, statusMessage: "Plugin desktop not found" });
  return resolved;
}
function eventTarget(event: H3Event): Target {
  return Object.fromEntries(["workerId", "installationId", "actionId", "displayId"].map(key => [key, getRouterParam(event, key)!])) as Target;
}
export async function proxyPluginDesktop(event: H3Event) {
  const resolved = resolve(await requireAuthFromEvent(event), eventTarget(event));
  if (!["GET", "HEAD"].includes(event.method)) throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
  const path = getRouterParam(event, "path") || "";
  setHeader(event, "cache-control", "private, no-store");
  setHeader(event, "x-content-type-options", "nosniff");
  setHeader(event, "referrer-policy", "no-referrer");
  if (path === "status") return { mode: resolved.mode, display: resolved.display, ready: resolved.ready,
    state: !resolved.installation.desiredEnabled ? "Disabled" : resolved.ready ? "Ready" : resolved.installation.observed.state === "error" ? "Failed" : "Starting",
    ...(resolved.installation.observed.error ? { error: resolved.installation.observed.error.message } : {}) };
  if (!path) {
    if (!getRequestURL(event).pathname.endsWith("/")) return sendRedirect(event, `${getRequestURL(event).pathname}/`, 302);
    if (resolved.mode === "shared" && resolved.ready) {
      const prefix = getRequestURL(event).pathname.split("/plugin-desktop/")[0] ?? "";
      return sendRedirect(event, `${prefix}/desktop/${encodeURIComponent(resolved.worker.id)}/agentor.html?autoconnect=true&resize=scale&reconnect=true&path=${encodeURIComponent(`${prefix.replace(/^\//, "")}${prefix ? "/" : ""}ws/desktop/${resolved.worker.id}`)}`, 302);
    }
    const nonce = randomBytes(18).toString("base64");
    setHeader(event, "content-type", "text/html; charset=utf-8");
    setHeader(event, "content-security-policy", `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`);
    return pluginDesktopViewer(nonce);
  }
  // Only the installed noVNC library modules. Never forward dashboard cookies,
  // authorization, arbitrary paths, redirects, or worker-supplied HTML.
  if (!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(path) || path.split("/").some(p => p === "." || p === ".." || !p))
    throw createError({ statusCode: 404, statusMessage: "Desktop resource not found" });
  if (resolved.worker.status !== "running") throw createError({ statusCode: 409, statusMessage: "Start the worker to load its desktop" });
  const response = await fetch(`http://${resolved.worker.containerName}:6080/${path}`, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!response?.ok || Number(response.headers.get("content-length")) > 2 * 1024 * 1024)
    throw createError({ statusCode: 502, statusMessage: "noVNC assets unavailable. Update the worker image and rebuild the worker." });
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error("limit"); chunks.push(value); } }
  catch { await reader.cancel(); throw createError({ statusCode: 502, statusMessage: "Desktop resource unavailable" }); }
  setHeader(event, "content-type", "text/javascript; charset=utf-8");
  return Buffer.concat(chunks);
}

interface Connection { stream?: Duplex; stdout?: PassThrough; stderr?: PassThrough; closed: boolean; pending: Buffer[]; bytes: number; timer?: NodeJS.Timeout; controller: AbortController }
const connections = new Map<string, Connection>();
function close(peer: Peer, state: Connection) {
  if (state.closed) return;
  state.closed = true; clearInterval(state.timer); state.controller.abort(); state.stream?.destroy(); state.stdout?.destroy(); state.stderr?.destroy(); connections.delete(peer.id);
  try { peer.close(); } catch { /* already disconnected */ }
}
export const pluginDesktopWebSocket = {
  async open(peer: Peer) {
    const state: Connection = { closed: false, pending: [], bytes: 0, controller: new AbortController() }; connections.set(peer.id, state);
    try {
      const url = new URL(peer.request.url, "http://localhost");
      const match = /\/plugin-desktop\/([^/]+)\/([^/]+)\/([^/]+)\/(primary)\/websockify$/.exec(url.pathname);
      if (!match) throw new Error("route");
      // Reject browser requests from opaque plugin frames or other sites.
      const origin = peer.request.headers.get("origin");
      const host = peer.request.headers.get("host");
      if (!origin || new URL(origin).host !== host) throw new Error("origin");
      const target = { workerId: match[1]!, installationId: match[2]!, actionId: match[3]!, displayId: match[4]! };
      const initial = resolve(await authenticateWsPeer(peer), target);
      if (!initial.ready || initial.mode !== "isolated") throw new Error("not ready");
      const container = docker.getContainer(initial.worker.containerId);
      const exec = await withOperationDeadline(signal => container.exec({
        Cmd: ["python3", "/home/agent/apps/plugin-runner/desktop_runtime.py", "connect", initial.installation.id, String(initial.display)],
        User: "agent", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, abortSignal: signal,
      }), 10_000, "Desktop connection", state.controller.signal);
      const stream = await withOperationDeadline(signal => exec.start({ hijack: true, stdin: true, Tty: false, abortSignal: signal }), 10_000, "Desktop stream", state.controller.signal) as Duplex;
      state.stream = stream;
      if (state.closed) { stream.destroy(); return; }
      const stdout = state.stdout = new PassThrough(); const stderr = state.stderr = new PassThrough(); stderr.resume();
      stdout.on("data", (bytes: Buffer) => { try { peer.send(bytes); } catch { close(peer, state); } });
      stream.on("error", () => close(peer, state)); stream.on("end", () => close(peer, state)); stream.on("close", () => close(peer, state));
      container.modem.demuxStream(stream, stdout, stderr);
      for (const bytes of state.pending) stream.write(bytes); state.pending = []; state.bytes = 0;
      let checking = false;
      state.timer = setInterval(async () => {
        if (checking || state.closed) return; checking = true;
        if ((peer.websocket.readyState ?? 1) > 1) { close(peer, state); return; }
        try { const current = resolve(await authenticateWsPeer(peer), target);
          if (!current.ready || current.worker.containerId !== initial.worker.containerId || current.display !== initial.display) close(peer, state);
        } catch { close(peer, state); } finally { checking = false; }
      }, 2000); state.timer.unref();
    } catch { close(peer, state); }
  },
  message(peer: Peer, message: unknown) {
    const state = connections.get(peer.id); if (!state || state.closed) return;
    const bytes = toBuffer(message); if (!bytes) return;
    if (bytes.length + state.bytes + (state.stream?.writableLength ?? 0) > 4 * 1024 * 1024) { close(peer, state); return; }
    if (state.stream) state.stream.write(bytes); else { state.pending.push(bytes); state.bytes += bytes.length; }
  },
  close(peer: Peer) { const state = connections.get(peer.id); if (state) close(peer, state); },
  error(peer: Peer) { const state = connections.get(peer.id); if (state) close(peer, state); },
};

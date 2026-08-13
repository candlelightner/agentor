import { listAppTypes } from "./apps";
import { useConfig, useContainerManager, useDomainMappingStore, usePortMappingStore, useTraefikManager } from "./services";
import { TraefikPortConflictError } from "./traefik-manager";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";

type Group = "networking" | "apps";
type Tool = { name: string; group: Group; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const worker = { type: "object", required: ["workerId"], properties: { workerId: { type: "string" } } };
const lockPassword = { lockPassword: { type: "string", writeOnly: true, description: "Required when the affected worker is protected" } };

/** MCP adapter over the dashboard's existing stores, Traefik reconciler, and
 * ContainerManager. It deliberately exposes no Docker handle or auth secret. */
export class ManagementExposureDomain {
  tools(): Tool[] { return [
    tool("port-mappings.list", "networking", "List controlled TCP port mappings.", { type: "object", properties: { userId: { type: "string" } } }, read),
    tool("port-mappings.create", "networking", "Create a TCP mapping for a running worker; protected workers require lockPassword.", { type: "object", required: ["workerId", "externalPort", "internalPort", "type"], properties: { ...worker.properties, ...lockPassword, externalPort: portSchema(), internalPort: portSchema(), type: { enum: ["localhost", "external"] }, appType: { type: "string" }, instanceId: { type: "string" } } }, mutation),
    tool("port-mappings.delete", "networking", "Remove a TCP mapping by external port; protected workers require lockPassword.", { type: "object", required: ["externalPort"], properties: { externalPort: portSchema(), ...lockPassword } }, { ...mutation, destructiveHint: true }),
    tool("domain-mappings.list", "networking", "List domain mappings without basic-auth passwords.", { type: "object", properties: { userId: { type: "string" } } }, read),
    tool("domain-mappings.create", "networking", "Create a domain mapping for a running worker; protected workers require lockPassword.", { type: "object", required: ["workerId", "baseDomain", "protocol", "internalPort"], properties: { ...worker.properties, ...lockPassword, baseDomain: { type: "string" }, subdomain: { type: "string" }, path: { type: "string" }, protocol: { enum: ["http", "https", "tcp"] }, wildcard: { type: "boolean" }, internalPort: portSchema(), basicAuth: { type: "object", properties: { username: { type: "string" }, password: { type: "string", writeOnly: true } } } } }, mutation),
    tool("domain-mappings.delete", "networking", "Remove a domain mapping by id; protected workers require lockPassword.", { type: "object", required: ["mappingId"], properties: { mappingId: { type: "string" }, ...lockPassword } }, { ...mutation, destructiveHint: true }),
    tool("apps.types", "apps", "List supported worker application types.", { type: "object" }, read),
    tool("apps.list", "apps", "List application instances on a running worker.", worker, read),
    tool("apps.start", "apps", "Start a supported application inside a running worker; protected workers require lockPassword.", { type: "object", required: ["workerId", "appType"], properties: { ...worker.properties, ...lockPassword, appType: { type: "string" } } }, mutation),
    tool("apps.stop", "apps", "Stop an application instance inside a running worker; protected workers require lockPassword.", { type: "object", required: ["workerId", "appType", "instanceId"], properties: { ...worker.properties, ...lockPassword, appType: { type: "string" }, instanceId: { type: "string" } } }, { ...mutation, destructiveHint: true }),
  ]; }

  async execute(name: string, args: Record<string, unknown>) {
    if (!this.tools().some((candidate) => candidate.name === name)) return { handled: false };
    const cm = useContainerManager();
    if (name === "apps.types") return { handled: true, result: listAppTypes() };
    if (name === "apps.list") return { handled: true, result: await this.listApps(req(args.workerId, "workerId")) };
    if (name === "apps.start") { const id = req(args.workerId, "workerId"); this.running(id); await useWorkerProtectionLockStore().verify(id, args.lockPassword); return { handled: true, result: await cm.createAppInstance(id, req(args.appType, "appType")) }; }
    if (name === "apps.stop") { const id = req(args.workerId, "workerId"); this.running(id); await useWorkerProtectionLockStore().verify(id, args.lockPassword); await cm.stopAppInstance(id, req(args.appType, "appType"), req(args.instanceId, "instanceId")); return { handled: true, result: { ok: true } }; }
    if (name === "port-mappings.list") return { handled: true, result: owned(usePortMappingStore().list(), optional(args.userId)).map((item) => ({ ...item })) };
    if (name === "port-mappings.create") return { handled: true, result: await this.createPort(args) };
    if (name === "port-mappings.delete") return { handled: true, result: await this.removePort(port(args.externalPort, "externalPort"), args.lockPassword) };
    if (name === "domain-mappings.list") return { handled: true, result: owned(useDomainMappingStore().list(), optional(args.userId)).map(publicDomain) };
    if (name === "domain-mappings.create") return { handled: true, result: publicDomain(await this.createDomain(args)) };
    if (name === "domain-mappings.delete") return { handled: true, result: await this.removeDomain(req(args.mappingId, "mappingId"), args.lockPassword) };
    return { handled: false };
  }

  private running(id: string) { const item = useContainerManager().get(id); if (!item) throw fail(404, "Worker not found"); if (item.status !== "running") throw fail(409, "Worker is not running"); return item; }
  private async listApps(id: string) { this.running(id); const cm = useContainerManager(); const values = await Promise.allSettled(listAppTypes().map((type) => cm.listAppInstances(id, type.id))); return values.flatMap((value) => value.status === "fulfilled" ? value.value : []); }
  private async createPort(args: Record<string, unknown>) {
    const externalPort = port(args.externalPort, "externalPort"), internalPort = port(args.internalPort, "internalPort"), type = req(args.type, "type");
    if (type !== "localhost" && type !== "external") throw fail(400, 'type must be "localhost" or "external"');
    const target = this.running(req(args.workerId, "workerId"));
    await useWorkerProtectionLockStore().verify(target.id, args.lockPassword);
    try { useTraefikManager().assertPortAcceptable(externalPort); } catch (e) { if (e instanceof TraefikPortConflictError) throw fail(409, e.message); throw e; }
    const store = usePortMappingStore(); let created: any;
    try { created = await store.add({ externalPort, internalPort, type, workerId: target.id, containerName: target.containerName, userId: target.userId, ...(optional(args.appType) ? { appType: optional(args.appType) } : {}), ...(optional(args.instanceId) ? { instanceId: optional(args.instanceId) } : {}) }); await useTraefikManager().reconcileStrict(); return { ...created }; }
    catch (e) { if (created) await store.remove(externalPort).catch(() => {}); throw normalized(e, "Port mapping could not be applied"); }
  }
  private async removePort(externalPort: number, password: unknown) { const store = usePortMappingStore(); const existing = store.findByPort(externalPort); if (!existing) return { ok: true }; await useWorkerProtectionLockStore().verify(existing.item.workerId, password); await store.remove(externalPort); await useTraefikManager().reconcile(); return { ok: true }; }
  private async createDomain(args: Record<string, unknown>) {
    const config = useConfig(), baseDomain = req(args.baseDomain, "baseDomain"), protocol = req(args.protocol, "protocol");
    if (!config.baseDomains.length) throw fail(400, "Domain mapping is not enabled (BASE_DOMAINS not set)");
    if (!config.baseDomains.includes(baseDomain)) throw fail(400, `baseDomain must be one of: ${config.baseDomains.join(", ")}`);
    if (!( ["http", "https", "tcp"] as string[]).includes(protocol)) throw fail(400, 'protocol must be "http", "https", or "tcp"');
    const tls = config.baseDomainConfigs.find((item) => item.domain === baseDomain), wildcard = args.wildcard === true;
    if ((protocol === "https" || protocol === "tcp") && (!tls || tls.challengeType === "none")) throw fail(400, `${protocol.toUpperCase()} requires TLS for this base domain`);
    if (wildcard && (!tls || tls.challengeType === "http")) throw fail(400, "Wildcard routing requires plain, DNS, or self-signed TLS");
    const subdomain = optional(args.subdomain) || ""; if (subdomain && !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(subdomain)) throw fail(400, "subdomain must be a valid DNS label");
    let path = optional(args.path) || ""; if (path === "/") path = ""; if (path) { if (protocol === "tcp") throw fail(400, "path is not supported for TCP protocol"); if (!/^\/[a-zA-Z0-9\/_.-]+$/.test(path)) throw fail(400, "path must be a safe URL prefix"); path = path.replace(/\/+$/, "") || ""; }
    const auth = object(args.basicAuth), username = optional(auth?.username), password = optional(auth?.password); if (Boolean(username) !== Boolean(password)) throw fail(400, "basicAuth requires both username and password");
    const target = this.running(req(args.workerId, "workerId")); const store = useDomainMappingStore(); let created: any;
    await useWorkerProtectionLockStore().verify(target.id, args.lockPassword);
    try { created = await store.add({ subdomain, baseDomain, path, protocol: protocol as any, wildcard, internalPort: port(args.internalPort, "internalPort"), workerId: target.id, containerName: target.containerName, userId: target.userId, ...(username && password ? { basicAuth: { username, password } } : {}) }); await useTraefikManager().reconcileStrict(); return created; }
    catch (e) { if (created) await store.remove(created.id).catch(() => {}); throw normalized(e, "Domain mapping could not be applied"); }
  }
  private async removeDomain(id: string, password: unknown) { const store = useDomainMappingStore(); const existing = store.findById(id); if (!existing) return { ok: true }; await useWorkerProtectionLockStore().verify(existing.item.workerId, password); await store.remove(id); await useTraefikManager().reconcile(); return { ok: true }; }
}
function tool(name: string, group: Group, description: string, inputSchema: Record<string, unknown>, annotations: Record<string, boolean>): Tool { return { name, group, description, inputSchema, annotations }; }
function portSchema() { return { type: "integer", minimum: 1, maximum: 65535 }; }
function req(value: unknown, field: string) { if (typeof value !== "string" || !value.trim()) throw fail(400, `${field} is required`); return value.trim(); }
function optional(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function port(value: unknown, field: string) { const parsed = typeof value === "number" ? value : Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw fail(400, `${field} must be an integer between 1 and 65535`); return parsed; }
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function normalized(cause: unknown, fallback: string) { const e = cause as { statusCode?: unknown; message?: unknown }; return fail(Number.isInteger(e?.statusCode) ? Number(e.statusCode) : 409, typeof e?.message === "string" ? e.message : fallback); }
function owned<T extends { userId: string }>(items: T[], userId?: string) { return userId ? items.filter((item) => item.userId === userId) : items; }
function publicDomain(item: any) { const { basicAuth, ...safe } = item; return { ...safe, ...(basicAuth ? { basicAuthConfigured: true, basicAuthUsername: basicAuth.username } : {}) }; }

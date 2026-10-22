import { useHardwareDeviceStore } from "./services";
import { assertPhysicalGpuPolicyRemovalSafe, enforceHardwareDeviceRevocation } from "./hardware-device-revocation";
import { getUserById } from "./auth";
import { publicHardwareDevice } from "./hardware-device-response";
import { listPhysicalGpuAssignments, setPhysicalGpuAssignment } from "./physical-gpu-management";

type Authority = { scope: "platform" | "group"; ownerId?: string; groupId?: string; reauthorize?: () => Promise<void> };
const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, idempotentHint: false, openWorldHint: false };

export class ManagementHardwareDeviceDomain {
  tools() { return [
    tool("hardware-devices.gpu.list", "List approved GPUs, native vGPU profiles, framebuffer, capacity, active allocations and stopped-VM requirements. Platform administrators only.", {}, read),
    tool("hardware-devices.gpu.assign", "Assign full physical passthrough or a discovered vGPU profile to one explicit stopped ordinary Incus worker. No running VM or host driver is interrupted. Platform administrators only.", { deviceId: stringSchema(), workerId: stringSchema(), profile: stringSchema(), lockPassword: { ...stringSchema(), writeOnly: true } }, mutate, ["deviceId", "workerId"]),
    tool("hardware-devices.gpu.release", "Release a GPU allocation from its stopped ordinary worker VM. Supply workerId when multiple vGPU allocations exist. Platform administrators only.", { deviceId: stringSchema(), workerId: stringSchema(), lockPassword: { ...stringSchema(), writeOnly: true } }, { ...mutate, destructiveHint: true }, ["deviceId"]),
    tool("hardware-devices.discover", "Discover host GPUs and USB devices and show whether each is already approved. Platform administration only.", {}, read),
    tool("hardware-devices.catalog.list", "List globally approved hardware devices and their current availability. Platform administration only.", {}, read),
    tool("hardware-devices.catalog.approve", "Approve one currently discovered hardware device by stable selector.", { selector: stringSchema(), name: stringSchema() }, mutate, ["selector"]),
    tool("hardware-devices.catalog.update", "Rename an approved hardware device. Its stable selector and kind are immutable.", { deviceId: stringSchema(), name: stringSchema() }, mutate, ["deviceId", "name"]),
    tool("hardware-devices.catalog.delete", "Delete an approved device, revoke dependent grants, stop affected workers, and require rebuild.", { deviceId: stringSchema() }, { ...mutate, destructiveHint: true }, ["deviceId"]),
    tool("hardware-devices.entitlements.list", "List approved devices and entitlements for an account.", { ownerId: stringSchema() }, read, ["ownerId"]),
    tool("hardware-devices.entitlements.set", "Grant or revoke an account's ability to assign one approved device.", { ownerId: stringSchema(), deviceId: stringSchema(), enabled: { type: "boolean" } }, mutate, ["ownerId", "deviceId", "enabled"]),
    tool("hardware-devices.grants.list", "List an account's all-worker, group, worker, and delegated device assignments.", { ownerId: stringSchema() }, read, ["ownerId"]),
    tool("hardware-devices.grants.create", "Assign an entitled device to all workers, one direct group, or one worker.", { ownerId: stringSchema(), deviceId: stringSchema(), targetType: { type: "string", enum: ["all", "group", "worker"] }, targetId: stringSchema() }, mutate, ["ownerId", "deviceId", "targetType"]),
    tool("hardware-devices.grants.delete", "Revoke an owner assignment and all derived group delegations.", { ownerId: stringSchema(), grantId: stringSchema() }, { ...mutate, destructiveHint: true }, ["ownerId", "grantId"]),
    tool("hardware-devices.delegations.list", "List devices usable by this administrative group's workers, devices delegable further, and this group's downward delegations.", {}, read),
    tool("hardware-devices.delegations.create", "Delegate a device granted to this administrative group to a descendant group or worker.", { deviceId: stringSchema(), targetType: { type: "string", enum: ["group", "worker"] }, targetId: stringSchema() }, mutate, ["deviceId", "targetType", "targetId"]),
    tool("hardware-devices.delegations.delete", "Revoke a downward device delegation created by this administrative group.", { grantId: stringSchema() }, { ...mutate, destructiveHint: true }, ["grantId"]),
  ]; }

  async execute(name: string, args: Record<string, any>, authority?: Authority): Promise<{ handled: boolean; result?: unknown }> {
    if (!name.startsWith("hardware-devices.")) return { handled: false };
    if (!authority || !["platform", "group"].includes(authority.scope)) throw failure(401, "Administrative identity required");
    if (authority.scope === "group" && (!authority.ownerId || !authority.groupId)) throw failure(403, "Group administrative identity is incomplete");
    const store = useHardwareDeviceStore();
    const groupTool = name.startsWith("hardware-devices.delegations.");
    if (authority.scope === "group" && !groupTool) throw failure(403, "Group administrators cannot approve host devices or create account-wide assignments. Ask the account owner or platform administrator to grant a device to this group first.");
    if (authority.scope === "platform" && groupTool) throw failure(400, "Group delegation tools require a group administrative workspace");
    if (name.startsWith("hardware-devices.gpu.")) {
      const authorize = async () => {
        if (authority.scope !== "platform" || !authority.reauthorize) throw failure(403, "Live platform administrator authority required");
        await authority.reauthorize();
      };
      await authorize();
      if (name === "hardware-devices.gpu.list") return handled(await listPhysicalGpuAssignments());
      if (name === "hardware-devices.gpu.assign") return handled(await setPhysicalGpuAssignment(args.deviceId, args.workerId, authorize, args.lockPassword, { profile: args.profile }));
      if (name === "hardware-devices.gpu.release") return handled(await setPhysicalGpuAssignment(args.deviceId, null, authorize, args.lockPassword, { releaseWorkerId: args.workerId }));
      throw failure(404, "Unknown physical GPU operation");
    }
    if (name === "hardware-devices.discover") {
      const approved = new Set(store.listCatalog().map((item) => item.selector));
      return handled((await store.listDiscoveredDevices()).map(item => ({ ...publicHardwareDevice(item), approved: approved.has(item.selector) })));
    }
    if (name === "hardware-devices.catalog.list") {
      const live = new Set((await store.listDiscoveredDevices()).map((item) => item.selector));
      return handled(store.listCatalog().map(item => ({ ...publicHardwareDevice(item), available: live.has(item.selector) })));
    }
    if (name === "hardware-devices.catalog.approve") {
      return handled(publicHardwareDevice(await store.approveDevice({ selector: args.selector, name: args.name })));
    }
    if (name === "hardware-devices.catalog.update") {
      return handled(publicHardwareDevice(await store.updateDevice(args.deviceId, { name: args.name })));
    }
    if (name === "hardware-devices.catalog.delete") { assertPhysicalGpuPolicyRemovalSafe(args.deviceId); const removed = await store.deleteDevice(args.deviceId); return handled({ deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation() }); }
    if (name === "hardware-devices.entitlements.list") { assertOwner(args.ownerId); const entitled = new Set(store.listEntitledDevices(args.ownerId).map((item) => item.id)); return handled({ ownerId: args.ownerId, catalog: store.listCatalog().map(item => ({ ...publicHardwareDevice(item), entitled: entitled.has(item.id) })) }); }
    if (name === "hardware-devices.entitlements.set") { assertOwner(args.ownerId); if (args.enabled === false) assertPhysicalGpuPolicyRemovalSafe(args.deviceId); const changed = await store.setEntitlement(args.ownerId, args.deviceId, args.enabled); return handled({ ...changed, enforcement: args.enabled ? undefined : await enforceHardwareDeviceRevocation(args.ownerId) }); }
    if (name === "hardware-devices.grants.list") { assertOwner(args.ownerId); return handled({ ownerId: args.ownerId, grants: store.listGrants(args.ownerId) }); }
    if (name === "hardware-devices.grants.create") { assertOwner(args.ownerId); return handled(await store.createOwnerGrant(args.ownerId, args as any)); }
    if (name === "hardware-devices.grants.delete") { assertOwner(args.ownerId); const removed = await store.deleteGrant(args.ownerId, args.grantId); return handled({ deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation(args.ownerId) }); }
    const ownerId = authority.ownerId!; const groupId = authority.groupId!;
    if (name === "hardware-devices.delegations.list") {
      const publicDevice = ({ id, name, kind }: { id: string; name: string; kind: string }) => ({ id, name, kind });
      const available = store.listEntitledDevices(ownerId).filter((item) => store.canWorkerUseDevice(ownerId, "__group_scope__", item.id, groupId)).map(publicDevice);
      const delegable = store.delegableDevicesForGroup(ownerId, groupId).map(publicDevice);
      const grants = store.listGrants(ownerId).filter((grant) => (grant.targetType === "group" && grant.targetId === groupId) || (grant.grantorType === "group" && grant.grantorGroupId === groupId));
      return handled({ ownerId, authorityGroupId: groupId, availableDevices: available, delegableDevices: delegable, grants });
    }
    if (name === "hardware-devices.delegations.create") return handled(await store.createGroupDelegation(ownerId, groupId, args as any));
    if (name === "hardware-devices.delegations.delete") { const removed = await store.deleteGrant(ownerId, args.grantId, groupId); return handled({ deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation(ownerId) }); }
    throw failure(404, "Unknown hardware device management operation");
  }
}
function tool(name: string, description: string, properties: Record<string, unknown>, annotations: Record<string, boolean>, required: string[] = []) { return { name, group: "configuration" as const, description, inputSchema: { type: "object", additionalProperties: false, ...(required.length ? { required } : {}), properties }, annotations }; }
function stringSchema() { return { type: "string", minLength: 1 }; }
function handled(result: unknown) { return { handled: true, result }; }
function failure(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function assertOwner(ownerId: unknown): asserts ownerId is string { if (typeof ownerId !== "string" || !getUserById(ownerId)) throw failure(404, "Account not found"); }

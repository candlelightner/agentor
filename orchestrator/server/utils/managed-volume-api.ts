import type { H3Event } from "h3";
import { requireAuth } from "./auth-helpers";
import { useWorkerStore } from "./services";
import { useManagedVolumeManager, type PersistenceActor } from "./managed-volume-manager";
import { volumeError } from "./managed-volume-store";

export function persistenceActor(event: H3Event, workerId: string): PersistenceActor {
  const { user } = requireAuth(event);
  const worker = useWorkerStore().list().find((w) => w.id === workerId);
  if (!worker || user.role !== "admin" && worker.userId !== user.id) throw volumeError(404, "Worker not found.");
  return { userId: worker.userId, workerId, platformAdmin: user.role === "admin" };
}

export async function volumeActor(event: H3Event, volumeId: string): Promise<PersistenceActor> {
  const { user } = requireAuth(event);
  const manager = useManagedVolumeManager(); await manager.init();
  const volume = manager.store.list().find((v) => v.id === volumeId && (user.role === "admin" || !v.retainedAfterAccountDeletion && v.userId === user.id));
  if (!volume) throw volumeError(404, "Volume not found.");
  return { userId: volume.userId, workerId: volume.workerId, platformAdmin: user.role === "admin" };
}

export function strictVolumeInput(input: unknown, keys: string[]): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !keys.includes(k)))
    throw volumeError(400, "Invalid or unknown storage input fields.");
  return input as Record<string, any>;
}

export async function runVolumeAction(actor: PersistenceActor, input: unknown, fixedVolumeId?: string) {
  const body = strictVolumeInput(input, ["action", "target", "name", "mode", "acknowledgePrivileged", "volumeId", "confirmed", "applyNow", "policy", "lockPassword"]);
  actor = { ...actor, lockPassword: body.lockPassword };
  const manager = useManagedVolumeManager();
  const id = fixedVolumeId ?? body.volumeId;
  switch (body.action) {
    case "add": return manager.add(actor, { target: body.target, name: body.name, mode: body.mode, acknowledgePrivileged: body.acknowledgePrivileged });
    case "policy": return manager.policy(actor, strictVolumeInput(body.policy, ["selfService", "allowSelfRecreate", "allowLiveMount"]));
    case "apply": return manager.apply(actor, id, body.mode, body.acknowledgePrivileged);
    case "detach": return manager.detach(actor, id, body.applyNow === true, body.confirmed === true);
    case "reattach": return manager.reattach(actor, id, body.mode, body.acknowledgePrivileged);
    case "rename": return manager.rename(actor, id, body.name);
    case "delete": return manager.delete(actor, id, body.confirmed === true);
    default: throw volumeError(400, "Unknown storage action.");
  }
}

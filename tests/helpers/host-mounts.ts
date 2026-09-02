import type { APIRequestContext } from "@playwright/test";

export async function approveHostPathForAll(
  request: APIRequestContext,
  sourcePath: string,
  allowWrite = false,
) {
  return approveHostPath(request, sourcePath, {
    allowWrite,
    targetType: "all",
  });
}

export async function approveHostPath(
  request: APIRequestContext,
  sourcePath: string,
  options: {
    allowWrite?: boolean;
    targetType?: "all" | "group" | "worker";
    targetId?: string;
  } = {},
) {
  const {
    allowWrite = false,
    targetType = "all",
    targetId,
  } = options;
  const session = await request.get("/api/auth/get-session");
  const sessionBody = await session.json();
  const ownerId = sessionBody?.user?.id;
  if (!ownerId) throw new Error("Authenticated owner id unavailable");
  const created = await request.post("/api/host-mounts", {
    data: { name: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`, sourcePath, allowWrite },
  });
  if (created.status() !== 201)
    throw new Error(`Host path approval failed (${created.status()}): ${await created.text()}`);
  const path = await created.json();
  const entitled = await request.put("/api/host-mounts/entitlements", {
    data: { ownerId, pathId: path.id, enabled: true },
  });
  if (entitled.status() !== 200)
    throw new Error(`Host path entitlement failed (${entitled.status()}): ${await entitled.text()}`);
  const granted = await request.post("/api/host-mounts/grants", {
    data: { ownerId, pathId: path.id, targetType, ...(targetId ? { targetId } : {}) },
  });
  if (granted.status() !== 201)
    throw new Error(`Host path assignment failed (${granted.status()}): ${await granted.text()}`);
  return path as { id: string; sourcePath: string; allowWrite: boolean };
}

export async function deleteApprovedHostPath(
  request: APIRequestContext,
  pathId: string | undefined,
) {
  if (!pathId) return;
  await request.delete(`/api/host-mounts/${pathId}`).catch(() => undefined);
}

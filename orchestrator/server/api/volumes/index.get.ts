import { requireAuth } from "../../utils/auth-helpers";
import { managedVolumeInventory } from "../../utils/managed-volume-inventory";
defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Inventory Agentor-managed volumes without exposing host paths", operationId: "listManagedVolumes" } });
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  return managedVolumeInventory({ userId: user.id, platform: user.role === "admin" });
});

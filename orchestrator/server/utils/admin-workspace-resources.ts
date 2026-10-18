import type { AdministrativeWorkspaceRecord } from "./admin-workspace-store";

export const MANAGEMENT_NETWORK = "agentor-management";
export const EGRESS_NETWORK = "agentor-admin-egress-v1";
export const ADMIN_CONTAINER = "agentor-admin-workspace";
const ADMIN_WORKSPACE_VOLUME = "agentor-admin-workspace-data";
const ADMIN_AGENTS_VOLUME = "agentor-admin-agent-data";

/** Stable Docker resource identities are also used by instance disaster
 * recovery to inventory the administrative workspace volumes without
 * duplicating their naming contract. */
export function administrativeWorkspaceResourceNames(
  record: Readonly<AdministrativeWorkspaceRecord>,
) {
  const groupId =
    record.kind === "group-administrative"
      ? ((record as any).groupId as string)
      : undefined;
  const suffix = groupId ? `group-${groupId}` : "workspace";
  return {
    groupId,
    container: groupId ? `agentor-admin-${suffix}` : ADMIN_CONTAINER,
    workspaceVolume: groupId
      ? `agentor-admin-${suffix}-data`
      : ADMIN_WORKSPACE_VOLUME,
    agentsVolume: groupId
      ? `agentor-admin-${suffix}-agent-data`
      : ADMIN_AGENTS_VOLUME,
    managementNetwork: groupId
      ? `agentor-management-group-${groupId}`
      : MANAGEMENT_NETWORK,
    egressNetwork: groupId
      ? `agentor-admin-egress-group-${groupId}`
      : EGRESS_NETWORK,
  };
}


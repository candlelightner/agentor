/** One failed runtime must not starve unrelated short-lived admin identities.
 * The dedicated stores still decide whether each individual ensure is safe. */
export async function refreshAdministrativeWorkspaceIdentities(
  ensureGlobal: () => Promise<unknown>,
  listGroups: () => ReadonlyArray<{ id: string; adminWorkspace?: unknown }>,
  ensureGroup: (groupId: string) => Promise<unknown>,
  reportError: (error: unknown) => void,
): Promise<void> {
  try { await ensureGlobal(); } catch (error) { reportError(error); }
  let groups: ReturnType<typeof listGroups>;
  try { groups = listGroups(); } catch (error) { reportError(error); return; }
  for (const group of groups) {
    if (!group.adminWorkspace) continue;
    try { await ensureGroup(group.id); } catch (error) { reportError(error); }
  }
}

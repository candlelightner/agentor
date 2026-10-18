/** Independent short-lived identities must progress even while another
 * admin waits for its lifecycle fence. A held ensure is never queued twice. */
export async function refreshAdministrativeWorkspaceIdentities(
  ensureGlobal: () => Promise<unknown>,
  listGroups: () => ReadonlyArray<{ id: string; adminWorkspace?: unknown }>,
  ensureGroup: (groupId: string) => Promise<unknown>,
  reportError: (error: unknown) => void,
  inFlight = new Map<string, Promise<void>>(),
): Promise<void> {
  const run = (id: string, ensure: () => Promise<unknown>) => {
    let pending = inFlight.get(id);
    if (!pending) {
      pending = Promise.resolve().then(ensure).then(() => {}, reportError).finally(() => { inFlight.delete(id); });
      inFlight.set(id, pending);
    }
    return pending;
  };
  const tasks = [run('global', ensureGlobal)];
  try {
    for (const group of listGroups()) if (group.adminWorkspace) tasks.push(run('group:' + group.id, () => ensureGroup(group.id)));
  } catch (error) { reportError(error); }
  await Promise.all(tasks);
}

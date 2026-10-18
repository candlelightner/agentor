/** Independent short-lived identities must progress even while another
 * admin waits for its lifecycle fence. A held ensure is never queued twice;
 * only successful initialization selects later identity-only refreshes. */
export async function refreshAdministrativeWorkspaceIdentities(
  ensureGlobal: (initialized: boolean) => Promise<unknown>,
  listGroups: () => ReadonlyArray<{ id: string; adminWorkspace?: unknown }>,
  ensureGroup: (groupId: string, initialized: boolean) => Promise<unknown>,
  reportError: (error: unknown) => void,
  inFlight = new Map<string, Promise<void>>(),
  initialized = new Set<string>(),
): Promise<void> {
  const run = (id: string, ensure: (initialized: boolean) => Promise<unknown>) => {
    let pending = inFlight.get(id);
    if (!pending) {
      pending = Promise.resolve().then(() => ensure(initialized.has(id)))
        .then(() => { initialized.add(id); }, reportError).finally(() => { inFlight.delete(id); });
      inFlight.set(id, pending);
    }
    return pending;
  };
  const tasks = [run('global', ensureGlobal)];
  try {
    for (const group of listGroups()) if (group.adminWorkspace) tasks.push(run('group:' + group.id, ready => ensureGroup(group.id, ready)));
  } catch (error) { reportError(error); }
  await Promise.all(tasks);
}

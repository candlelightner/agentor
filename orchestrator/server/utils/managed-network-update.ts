import type { ManagedNetwork } from './managed-network-store';

type Reconciliation = { workerIds: string[]; partialFailures: string[] };

/** Persist and reconcile a managed-network update as one recoverable unit.
 * Docker cannot provide a transaction, so every unsuccessful forward
 * reconciliation restores both desired state and the prior topology before the
 * original error is returned. A failed rollback is surfaced instead of being
 * silently swallowed because desired/actual state may then require repair. */
export async function updateManagedNetworkAtomically(
  current: ManagedNetwork,
  patch: Partial<Pick<ManagedNetwork, 'name' | 'scope' | 'groupId' | 'workerIds'>>,
  dependencies: {
    update: (userId: string, id: string, patch: typeof patch) => Promise<ManagedNetwork>;
    reconcile: (network: ManagedNetwork) => Promise<Reconciliation>;
  },
): Promise<ManagedNetwork & { reconciliation: Reconciliation }> {
  const updated = await dependencies.update(current.userId, current.id, patch);
  try {
    const reconciliation = await dependencies.reconcile(updated);
    if (reconciliation.partialFailures.length) {
      throw Object.assign(new Error(reconciliation.partialFailures.join('; ')), { statusCode: 409 });
    }
    return { ...updated, reconciliation };
  } catch (forwardError: any) {
    let persistenceRollbackError: unknown;
    let topologyRollbackError: unknown;
    try {
      await dependencies.update(current.userId, current.id, {
        name: current.name,
        scope: current.scope,
        groupId: current.groupId ?? '',
        workerIds: current.workerIds,
      });
    } catch (error) {
      persistenceRollbackError = error;
    }
    // Topology rollback is independent of persistence. Always attempt it even
    // when restoring the JSON store failed, matching the group coordinator's
    // fail-recoverable semantics.
    try {
      const rollback = await dependencies.reconcile(current);
      if (rollback.partialFailures.length)
        throw new Error(rollback.partialFailures.join('; '));
    } catch (error) {
      topologyRollbackError = error;
    }
    if (persistenceRollbackError || topologyRollbackError) {
      throw Object.assign(new Error('Managed network update failed and rollback was incomplete'), {
        statusCode: 500,
        cause: { forwardError, persistenceRollbackError, topologyRollbackError },
      });
    }
    throw forwardError;
  }
}

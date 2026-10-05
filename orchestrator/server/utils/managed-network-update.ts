import type { ManagedNetwork } from './managed-network-store';

type Reconciliation = { workerIds: string[]; partialFailures: string[] };
type ManagedNetworkPatch = Partial<
  Pick<ManagedNetwork, 'name' | 'scope' | 'groupId' | 'workerIds'>
>;

/** Reconcile a newly persisted network without losing cleanup authority.
 * The desired record must outlive incomplete runtime cleanup, since its owner
 * and identity are required for later reconciliation/removal. */
export async function reconcileCreatedManagedNetwork(
  network: ManagedNetwork,
  dependencies: {
    reconcile: (network: ManagedNetwork) => Promise<Reconciliation>;
    removeRuntime: (network: ManagedNetwork) => Promise<unknown>;
    removeRecord: (userId: string, id: string) => Promise<unknown>;
  },
): Promise<ManagedNetwork & { reconciliation: Reconciliation }> {
  try {
    const reconciliation = await dependencies.reconcile(network);
    if (reconciliation.partialFailures.length) {
      throw Object.assign(new Error(reconciliation.partialFailures.join('; ')), { statusCode: 409 });
    }
    return { ...network, reconciliation };
  } catch (forwardError) {
    try {
      await dependencies.removeRuntime(network);
    } catch (cleanupError) {
      // Do not delete the record when runtime ownership remains unresolved.
      throw Object.assign(new Error('Managed network creation failed and runtime cleanup was incomplete; network record retained for recovery'), {
        statusCode: 500,
        cause: { forwardError, cleanupError },
      });
    }
    try {
      await dependencies.removeRecord(network.userId, network.id);
    } catch (cleanupError) {
      throw Object.assign(new Error('Managed network creation failed and record cleanup was incomplete'), {
        statusCode: 500,
        cause: { forwardError, cleanupError },
      });
    }
    throw forwardError;
  }
}

/** Persist and reconcile a managed-network update as one recoverable unit.
 * Docker cannot provide a transaction, so every unsuccessful forward
 * reconciliation restores both desired state and the prior topology before the
 * original error is returned. A failed rollback is surfaced instead of being
 * silently swallowed because desired/actual state may then require repair. */
export async function updateManagedNetworkAtomically(
  current: ManagedNetwork,
  patch: ManagedNetworkPatch,
  dependencies: {
    update: (userId: string, id: string, patch: ManagedNetworkPatch) => Promise<ManagedNetwork>;
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

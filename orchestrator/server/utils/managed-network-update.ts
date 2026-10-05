import type { ManagedNetwork } from './managed-network-store';
import { operationSettlement, type OperationFailureWithSettlement } from './operation-deadline';

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
    // A deadline bounds the response, not necessarily the native mutation.
    // Preserve both desired authority and the queue's raw settlement fence.
    if ((forwardError as OperationFailureWithSettlement | null)?.[operationSettlement]) throw forwardError;
    try {
      await dependencies.removeRuntime(network);
    } catch (cleanupError) {
      if ((cleanupError as OperationFailureWithSettlement | null)?.[operationSettlement]) throw cleanupError;
      // Do not delete the record when runtime ownership remains unresolved.
      throw Object.assign(new Error('Managed network creation failed and runtime cleanup was incomplete; network record retained for recovery'), {
        statusCode: 500,
        cause: { forwardError, cleanupError },
      });
    }
    try {
      await dependencies.removeRecord(network.userId, network.id);
    } catch (cleanupError) {
      if ((cleanupError as OperationFailureWithSettlement | null)?.[operationSettlement]) throw cleanupError;
      throw Object.assign(new Error('Managed network creation failed and record cleanup was incomplete'), {
        statusCode: 500,
        cause: { forwardError, cleanupError },
      });
    }
    throw forwardError;
  }
}

/** Persist and reconcile a managed-network update as one recoverable unit.
 * Settled unsuccessful reconciliation restores desired state and prior topology.
 * An unsettled native operation instead retains current desired authority and
 * its raw queue fence: starting rollback while it may still mutate is unsafe.
 * Failed rollback is surfaced because desired/actual state may require repair. */
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
    if (forwardError?.[operationSettlement]) throw forwardError;
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
      if ((error as OperationFailureWithSettlement | null)?.[operationSettlement]) throw error;
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
      if ((error as OperationFailureWithSettlement | null)?.[operationSettlement]) throw error;
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

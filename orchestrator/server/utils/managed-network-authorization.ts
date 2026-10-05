import type { ManagedNetwork } from './managed-network-store';

/** Request-local coverage for every desired or currently attached worker.
 * Actual drift must not bypass a worker's mutation lock during detachment.
 * Only verified IDs escape this call; passwords are never retained in it. */
export async function authorizeManagedNetworkMutation(
  networks: readonly ManagedNetwork[],
  workerIds: Iterable<string>,
  passwords: unknown,
  dependencies?: {
    actualWorkerIds: (network: ManagedNetwork) => Promise<string[]>;
    verify: (ids: Iterable<string>, passwords: unknown) => Promise<void>;
  },
): Promise<ReadonlySet<string>> {
  const guards = dependencies ?? {
    actualWorkerIds: async (network: ManagedNetwork) => {
      const { useManagedNetworkManager } = await import('./managed-network-manager');
      return useManagedNetworkManager().actualWorkerIds(network);
    },
    verify: async (ids: Iterable<string>, supplied: unknown) => {
      const { verifyWorkerMutationUnlocks } = await import('./worker-protection-lock');
      await verifyWorkerMutationUnlocks(ids, supplied);
    },
  };
  const coverage = new Set(workerIds);
  for (const network of networks)
    for (const id of await guards.actualWorkerIds(network)) coverage.add(id);
  await guards.verify(coverage, passwords);
  return coverage;
}

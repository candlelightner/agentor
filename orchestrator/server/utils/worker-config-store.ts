// Preserve the existing application import surface. The controlled standalone
// restore helper imports the same store implementation without app singletons.
export * from './worker-config-store-core';
import { WorkerConfigStore } from './worker-config-store-core';
import { useConfig } from './services';

let singleton: WorkerConfigStore | undefined;
export function useWorkerConfigStore(): WorkerConfigStore {
  return (singleton ??= new WorkerConfigStore(useConfig()));
}

import { defineEventHandler } from 'h3';
import { requireAuth } from '../utils/auth-helpers';
import { useConfig } from '../utils/services';
import { incusDefaultMemoryLimit, type WorkerMemoryPolicy } from '../../shared/worker-memory';

/** Non-secret allocation policy for environment editors, including ordinary
 * users. Running-worker metrics remain the authority for actual guest memory. */
export default defineEventHandler(event => {
  requireAuth(event);
  const config = useConfig();
  return {
    defaultMemoryLimit: config.defaultMemoryLimit || '',
    incusDefaultMemoryLimit: incusDefaultMemoryLimit(config.incusDefaultMemoryLimit),
  } satisfies WorkerMemoryPolicy;
});

import type { H3Event } from 'h3';
import { getRouterParam } from 'h3';
import { useContainerManager } from './services';
import { requireContainerAccess } from './auth-helpers';
import type { ContainerManager } from './container';

/**
 * Shared preamble for every `/api/containers/:id/files/*` route.
 *
 * Order matters and is enforced here: authenticate + ownership-check the worker
 * BEFORE any request body is consumed. `requireContainerAccess` throws 404 for
 * an unknown worker, 401 for an unauthenticated caller (via the global auth
 * middleware + `requireAuth`), and 403 for an owner mismatch — all before the
 * route reads `readBody`/`readMultipartFormData`, so an unauthenticated or
 * non-owning caller can never trigger body parsing or worker-side work.
 *
 * Returns the `ContainerManager` and the validated worker `id` (router param).
 */
export function resolveFilesAccess(event: H3Event): { cm: ContainerManager; id: string } {
  const id = getRouterParam(event, 'id');
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing container id' });
  }
  const cm = useContainerManager();
  // Ownership/404/401/403 checks happen here, before the route touches the body.
  const info = cm.get(id);
  requireContainerAccess(event, info);
  if (!info || info.status !== 'running') {
    throw createError({ statusCode: 409, statusMessage: 'Worker container is not running' });
  }
  return { cm, id };
}

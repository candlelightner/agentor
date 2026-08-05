import type { H3Event } from 'h3';
import { requireAuth } from './auth-helpers';
import { findWorkspaceInventory } from './workspace-inventory';
import { OfflineWorkspaceAccess } from './workspace-access';

/** Authenticate and authorize before routes parse a body or create a helper. */
export async function resolveOfflineWorkspace(event: H3Event): Promise<{ access: OfflineWorkspaceAccess; item: NonNullable<Awaited<ReturnType<typeof findWorkspaceInventory>>> }> {
  const { user } = requireAuth(event);
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing workspace id' });
  const item = await findWorkspaceInventory(id, user.role === 'admin');
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Workspace not found' });
  // Discovery is metadata-only. An orphan has no trustworthy owner binding and
  // must be adopted through a separate audited flow before its contents can be
  // read, even by an administrator.
  if (item.state === 'orphaned') throw createError({ statusCode: 409, statusMessage: 'Orphaned workspace must be adopted before browsing' });
  if (item.state === 'deleted') throw createError({ statusCode: 409, statusMessage: 'Deleted workspace content is no longer available' });
  if (user.role !== 'admin' && item.userId !== user.id) throw createError({ statusCode: 403, statusMessage: 'Forbidden: you do not own this workspace' });
  return { access: new OfflineWorkspaceAccess(item), item };
}

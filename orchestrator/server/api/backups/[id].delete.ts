defineRouteMeta({openAPI:{tags:['Backups'],summary:'Delete backup',operationId:'deleteBackup',responses:{204:{description:'Deleted'},409:{description:'Backup is in use by restore'},401:{description:'Unauthorized'},403:{description:'Forbidden'},404:{description:'Not found'}}}});
import { requireAuth } from '../../utils/auth-helpers';
import { useBackupManager } from '../../utils/backup-manager';
export default defineEventHandler(async event => {
  const user = requireAuth(event).user, manager = useBackupManager(), artifact = await manager.getArtifact(getRouterParam(event, 'id')!);
  if (!artifact) throw createError({statusCode:404,statusMessage:'Backup not found'});
  if (user.role !== 'admin' && artifact.userId !== user.id) throw createError({statusCode:403,statusMessage:'Forbidden'});
  try {
    await manager.deleteArtifact(artifact);
  } catch (error: any) {
    if (error?.statusCode === 404)
      throw createError({statusCode:404,statusMessage:'Backup not found'});
    if (error?.statusCode === 409)
      throw createError({statusCode:409,statusMessage:'Backup artifact is in use by a restore job'});
    throw createError({statusCode:500,statusMessage:'Backup deletion failed'});
  }
  setResponseStatus(event,204); return null;
});

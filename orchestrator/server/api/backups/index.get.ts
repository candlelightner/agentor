defineRouteMeta({openAPI:{tags:['Backups'],summary:'List backups',operationId:'listBackups',responses:{200:{description:'Backups and jobs'},401:{description:'Unauthorized'}}}});
import { requireAuth } from '../../utils/auth-helpers';
import { useBackupManager } from '../../utils/backup-manager';
import { useContainerManager, useWorkerStore } from '../../utils/services';

export default defineEventHandler(async event => {
  const user = requireAuth(event).user;
  const data = await useBackupManager().list(user.id);
  const containers = useContainerManager();
  const workers = useWorkerStore();
  return {
    backups: data.artifacts.map(artifact => {
      const workspaceIds = artifact.workspaceIds ?? [artifact.workspaceId];
      return {
        ...artifact, workspaceIds, sizeBytes: artifact.size, encrypted: true, integrityVerified: true,
        // Names are best-effort current metadata; IDs remain the durable restore authority.
        workspaceMembers: workspaceIds.map(id => {
          const captured = artifact.workspaceMembers?.find(
            (member) => member.id === id,
          );
          const container = containers.get(id);
          const storedWorker = workers.findById(id);
          const displayName =
            captured?.displayName ??
            (container?.userId === artifact.userId
              ? container.displayName
              : storedWorker?.userId === artifact.userId
                ? storedWorker.displayName
                : undefined);
          return displayName ? { id, displayName } : { id };
        }),
      };
    }),
    jobs: data.jobs,
  };
});

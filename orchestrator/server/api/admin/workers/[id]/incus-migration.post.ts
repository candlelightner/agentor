import { requireAdmin } from '../../../../utils/auth-helpers';
import { migrationStartRequest, useWorkerIncusMigrationService } from '../../../../utils/worker-incus-migration-service';

export default defineEventHandler(async event => {
  const admin = requireAdmin(event);
  const request = migrationStartRequest((await readBody<unknown>(event)) ?? {});
  return useWorkerIncusMigrationService().migrate(getRouterParam(event, 'id') ?? '', { kind: 'admin-user', userId: admin.user.id }, request.lockPassword, request.lockPasswords);
});

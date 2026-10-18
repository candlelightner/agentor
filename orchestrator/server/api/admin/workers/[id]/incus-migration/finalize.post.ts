import { requireAdmin } from '../../../../../utils/auth-helpers';
import { migrationLockPassword, useWorkerIncusMigrationService } from '../../../../../utils/worker-incus-migration-service';

export default defineEventHandler(async event => {
  const admin = requireAdmin(event);
  const password = migrationLockPassword((await readBody<unknown>(event)) ?? {});
  return useWorkerIncusMigrationService().finalize(getRouterParam(event, 'id') ?? '', { kind: 'admin-user', userId: admin.user.id }, password);
});

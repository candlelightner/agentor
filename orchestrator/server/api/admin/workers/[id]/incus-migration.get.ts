import { requireAdmin } from '../../../../utils/auth-helpers';
import { useWorkerIncusMigrationService } from '../../../../utils/worker-incus-migration-service';

export default defineEventHandler(async event => {
  const admin = requireAdmin(event);
  return useWorkerIncusMigrationService().status(getRouterParam(event, 'id') ?? '', { kind: 'admin-user', userId: admin.user.id });
});

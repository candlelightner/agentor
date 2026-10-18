import { useInstanceBackupManager } from '../utils/instance-backup-manager';

// Nitro can listen even when an asynchronous startup plugin rejects. Fence
// handlers (including auth and proxy routes) before any DATA access, not just
// plugin initialization. An unsafe startup remains closed until process restart.
export default defineEventHandler(async () => {
  const manager = useInstanceBackupManager();
  await manager.assertStartupSafe();
  await manager.init();
});

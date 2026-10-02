import { installInstanceHttpAdapter } from '../utils/instance-http-adapter';
import { instanceBarrierHttp } from '../utils/instance-barrier-http';
import { instanceControlPlaneCoordinator, instanceSnapshotJobId } from '../utils/instance-snapshot-gate';
import { readInitializedSnapshotAdministrator, isInitializedSnapshotOrigin } from '../utils/auth';
import { initializedInstanceBackupManager } from '../utils/instance-backup-manager';

/** Pinned node-server adapter, installed before service initialization. This
 * covers ordinary HTTP only; WebSocket and detached/background writers must
 * separately enroll. A registered-operation drain is not yet a whole-app cut. */
export default defineNitroPlugin(nitroApp => {
  installInstanceHttpAdapter(nitroApp.h3App, instanceControlPlaneCoordinator, event =>
    instanceBarrierHttp(event, {
      jobId: instanceSnapshotJobId,
      administrator: readInitializedSnapshotAdministrator,
      trustedOrigin: isInitializedSnapshotOrigin,
      job: (id, owner, cancel) => initializedInstanceBackupManager()?.barrierControlJob(id, owner, cancel),
    }));
});

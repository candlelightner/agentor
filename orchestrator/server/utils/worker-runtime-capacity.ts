/** A warning or caller acknowledgement cannot establish free space in the
 * daemon's image, containerd, volume and rollback stores. Keep the public
 * migration path closed until trusted per-destination admission is implemented.
 * Recovery/finalization of existing journals must not call this gate. */
export function assertRuntimeMigrationCapacityAdmission(): void {
  throw Object.assign(new Error('Runtime migration is unavailable until trusted disk-capacity admission is implemented; the worker was not stopped'), {
    statusCode: 503,
    code: 'WORKER_RUNTIME_MIGRATION_CAPACITY_UNVERIFIED',
  });
}

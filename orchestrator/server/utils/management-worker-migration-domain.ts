import { migrationPeerLockPasswords, useWorkerIncusMigrationService, type WorkerMigrationPrincipal, type WorkerIncusMigrationService } from './worker-incus-migration-service';

/** Transport-free adapter. Only a server-issued current platform principal is accepted. */
export class ManagementWorkerMigrationDomain {
  constructor(private readonly service: Pick<WorkerIncusMigrationService, 'status' | 'migrate' | 'finalize'> = useWorkerIncusMigrationService()) {}
  tools() {
    return ['status', 'start', 'finalize'].map(operation => ({
      name: 'migration.' + operation, group: 'worker-lifecycle' as const,
      description: operation === 'status' ? 'Read sanitized explicit Docker-to-Incus migration state.' :
        operation === 'start' ? 'Explicitly migrate one ordinary legacy worker after live validation; retain its source.' :
        'Explicitly finalize a validated migration and remove only its acknowledged retained source.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['workerId'], properties: {
        workerId: { type: 'string', pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' },
        ...(operation === 'status' ? {} : { lockPassword: { type: 'string', maxLength: 1024, writeOnly: true } }),
        ...(operation !== 'start' ? {} : { lockPasswords: { type: 'object', maxProperties: 1000, writeOnly: true,
          propertyNames: { pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' },
          additionalProperties: { type: 'string', maxLength: 1024, writeOnly: true } } }),
      } },
      annotations: { readOnlyHint: operation === 'status', destructiveHint: operation === 'finalize',
        idempotentHint: operation === 'status', openWorldHint: false },
    }));
  }
  async execute(name: string, args: Record<string, unknown>, principal?: WorkerMigrationPrincipal) {
    if (!this.tools().some(tool => tool.name === name)) return { handled: false };
    const keys = name === 'migration.status' ? ['workerId'] : name === 'migration.start' ? ['workerId', 'lockPassword', 'lockPasswords'] : ['workerId', 'lockPassword'];
    if (!args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).some(key => !keys.includes(String(key))) ||
        typeof args.workerId !== 'string' || args.lockPassword !== undefined &&
        (typeof args.lockPassword !== 'string' || args.lockPassword.length > 1024))
      throw Object.assign(new Error('Invalid migration tool arguments'), { statusCode: 400 });
    if (!principal) throw Object.assign(new Error('Platform migration principal is required'), { statusCode: 403 });
    const result = name === 'migration.start'
      ? await this.service.migrate(args.workerId, principal, args.lockPassword as string | undefined, migrationPeerLockPasswords(args.lockPasswords))
      : name === 'migration.finalize' ? await this.service.finalize(args.workerId, principal, args.lockPassword as string | undefined)
      : await this.service.status(args.workerId, principal);
    return { handled: true, result };
  }
}

import { posix } from 'node:path';
import { IncusClient } from './incus-client';
import type { Config } from './config';
import type { MountConfig } from '../../shared/types';
import { readBackupInstallationId } from './backup-installation';

export interface IncusHostExport {
  installation: string;
  project: string;
  pathId: string;
  sourcePath: string;
  allowWrite: boolean;
  /** Immediate host-directory identity, never portable WorkerRecord authority. */
  sourceIdentity: string;
}

/** Only catalog IDs cross to the host. Worker grant/target authorization remains
 * HostMountStore's responsibility; this client cannot accept arbitrary paths. */
export class IncusHostMountClient {
  private readonly client: Pick<IncusClient, 'request'>;

  constructor(private readonly config: Config, client?: Pick<IncusClient, 'request'>) {
    if (!config.incusNetworkHostEndpoint)
      throw new Error('Incus host mounts require the operator-installed Agentor host policy service');
    this.client = client ?? IncusClient.fromConfig({ ...config,
      incusEndpoint: config.incusNetworkHostEndpoint,
      incusServerCertPath: config.incusNetworkHostServerCertPath || config.incusServerCertPath });
  }

  ensure(mount: MountConfig): Promise<IncusHostExport> { return this.resolve('ensure', mount); }
  inspect(mount: MountConfig): Promise<IncusHostExport> { return this.resolve('inspect', mount); }

  /** Normal account onboarding reuses the operator's fixed policy service.
   * Only durable owner/worker IDs cross HTTPS; expected paths are local checks,
   * never a request for caller-selected host filesystem authority. */
  async ensureAccountShares(userId: string, workerId: string, sourcePaths: string[]): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(workerId) ||
        sourcePaths.length !== 3 || new Set(sourcePaths).size !== 3 || sourcePaths.some(path =>
          !posix.isAbsolute(path) || path === '/' || path.startsWith('//') || posix.normalize(path) !== path ||
          /[\u0000-\u001f\u007f\\:,]/.test(path)))
      throw new Error('Account shares require exact worker identity and fixed local sources');
    const installation = await readBackupInstallationId(this.config.dataDir);
    const result = await this.client.request('POST', '/v1/account-shares/ensure', { userId, workerId });
    if (!result || result.installation !== installation || result.project !== this.config.incusProject ||
        result.userId !== userId || result.workerId !== workerId || !Array.isArray(result.sourcePaths) ||
        result.sourcePaths.length !== sourcePaths.length || result.sourcePaths.some((path: unknown, index: number) => path !== sourcePaths[index]))
      throw new Error('Incus host service returned foreign or ambiguous account share authority');
  }

  private async resolve(operation: 'ensure' | 'inspect', mount: MountConfig): Promise<IncusHostExport> {
    if (!mount.pathId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(mount.pathId) ||
        typeof mount.source !== 'string' || !posix.isAbsolute(mount.source) || mount.source === '/' ||
        mount.source.startsWith('//') || posix.normalize(mount.source) !== mount.source ||
        /[\u0000-\u001f\u007f\\:,]/.test(mount.source) ||
        (mount.readOnly !== undefined && typeof mount.readOnly !== 'boolean'))
      throw new Error('Incus host mounts require an exact resolved catalog source and mode');
    const installation = await readBackupInstallationId(this.config.dataDir);
    const result = await this.client.request('POST', `/v1/host-mounts/${operation}`, { pathId: mount.pathId });
    if (!result || result.installation !== installation || result.project !== this.config.incusProject ||
        result.pathId !== mount.pathId || result.sourcePath !== mount.source || typeof result.allowWrite !== 'boolean' ||
        typeof result.sourceIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(result.sourceIdentity))
      throw new Error('Incus host service returned foreign or ambiguous catalog export authority');
    if (mount.readOnly === false && !result.allowWrite)
      throw new Error('Incus catalog export is approved read-only; writable mounts are denied');
    return { installation, project: result.project, pathId: result.pathId,
      sourcePath: result.sourcePath, sourceIdentity: result.sourceIdentity, allowWrite: result.allowWrite };
  }
}

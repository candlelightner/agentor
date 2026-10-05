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

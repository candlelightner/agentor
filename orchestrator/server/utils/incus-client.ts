import https from 'node:https';
import http, { type IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { PassThrough, Writable } from 'node:stream';
import type { Config } from './config';

export class IncusError extends Error {
  statusCode: number;
  errorCode: number;

  constructor(message: string, statusCode = 0, errorCode = 0) {
    super(message);
    this.name = 'IncusError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export interface IncusResponse<T = unknown> {
  type: 'sync' | 'async' | 'error';
  status: string;
  status_code: number;
  operation: string;
  error_code: number;
  error: string;
  metadata: T;
}

export interface IncusOperationMetadata {
  id: string;
  class: 'task' | 'websocket' | 'token';
  description: string;
  created_at: string;
  updated_at: string;
  status: 'Pending' | 'Running' | 'Success' | 'Failure' | 'Cancelling' | 'Cancelled';
  status_code: number;
  resources?: Record<string, string[]>;
  metadata?: Record<string, any> | null;
  may_cancel: boolean;
  err: string;
  location: string;
}

export interface IncusServerInfo {
  api_status: string;
  api_version: string;
  auth: 'trusted' | 'untrusted';
  public: boolean;
  auth_methods: string[];
  auth_user_name: string;
  auth_user_method: string;
  environment: {
    addresses: string[];
    architectures: string[];
    certificate: string;
    certificate_fingerprint: string;
    driver: string;
    driver_version: string;
    kernel_version: string;
    os_name: string;
    os_version: string;
    project: string;
    server: string;
    server_name: string;
    server_version: string;
    storage: string;
    storage_version: string;
    storage_supported_drivers?: Array<{ Name: string; Version: string; Remote: boolean }>;
  };
}

export interface IncusProject {
  name: string;
  description: string;
  config: Record<string, string>;
  used_by: string[];
}

export interface IncusNetwork {
  name: string;
  type: string;
  managed: boolean;
  config: Record<string, string>;
}

export interface IncusNetworkLease {
  address: string;
  hwaddr: string;
  hostname: string;
  type: string;
  location?: string;
}

export interface IncusNetworkAddress {
  family: 'inet' | 'inet6';
  address: string;
  netmask: string;
  scope: 'global' | 'local' | 'link';
}

export interface IncusNetworkInterface {
  addresses: IncusNetworkAddress[];
  counters?: {
    bytes_received: number;
    bytes_sent: number;
    packets_received: number;
    packets_sent: number;
    errors_received: number;
    errors_sent: number;
  };
  hwaddr: string;
  host_name?: string;
  mtu: number;
  state: 'up' | 'down';
  type: string;
}

export interface IncusInstanceState {
  status: 'Running' | 'Stopped' | 'Frozen' | 'Starting' | 'Stopping';
  status_code: number;
  disk?: Record<string, { usage: number }> | null;
  memory?: {
    usage: number;
    usage_peak: number;
    total: number;
    swap_usage: number;
    swap_usage_peak: number;
  };
  network?: Record<string, IncusNetworkInterface> | null;
  pid: number;
  processes: number;
  cpu?: {
    usage: number;
  };
}

export interface IncusDeviceDisk {
  type: 'disk';
  path?: string;
  source?: string;
  pool?: string;
  readonly?: string;
  size?: string;
  [key: string]: any;
}

export interface IncusDeviceNic {
  type: 'nic';
  network?: string;
  name?: string;
  hwaddr?: string;
  'security.mac_filtering'?: string;
  'security.ipv4_filtering'?: string;
  'ipv4.address'?: string;
  [key: string]: any;
}

export type IncusDevice = IncusDeviceDisk | IncusDeviceNic | Record<string, any>;

export interface IncusInstance {
  name: string;
  description: string;
  status: string;
  status_code: number;
  type: 'container' | 'virtual-machine';
  architecture: string;
  ephemeral: boolean;
  profiles: string[];
  config: Record<string, string>;
  devices: Record<string, IncusDevice>;
  expanded_config?: Record<string, string>;
  expanded_devices?: Record<string, IncusDevice>;
  state?: IncusInstanceState;
  created_at?: string;
  last_used_at?: string;
}

export interface IncusInstanceCreateSpec {
  name: string;
  type?: 'container' | 'virtual-machine';
  source: {
    type: 'image' | 'none' | 'copy';
    alias?: string;
    fingerprint?: string;
    source?: string;
  };
  config?: Record<string, string>;
  devices?: Record<string, IncusDevice>;
  profiles?: string[];
  description?: string;
}

export interface IncusInstanceExecOptions {
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  user?: number;
  group?: number;
  interactive?: boolean;
  waitForWebsocket?: boolean;
  recordOutput?: boolean;
  width?: number;
  height?: number;
}

export interface IncusExecResult {
  returnCode: number;
  stdout: string;
  stderr: string;
}

export interface IncusInteractiveExecSession {
  dataWs: WebSocket;
  controlWs: WebSocket;
  operationId: string;
  resize: (cols: number, rows: number) => void;
  sendSignal: (signal: number) => void;
  close: () => void;
}

export interface IncusStreamExecSession {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  operationId: string;
  /** Exit status is authoritative operation metadata, not socket closure. */
  result: Promise<number>;
  sendSignal: (signal: number) => void;
  close: () => void;
}

export interface IncusFilePushOptions {
  mode?: number | string;
  uid?: number;
  gid?: number;
  type?: 'file' | 'directory' | 'symlink';
}

export interface IncusFilePullResult {
  content: Buffer;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  uid: number;
  gid: number;
  modified?: string;
}

export interface IncusCustomVolumeCreateSpec {
  name: string;
  content_type: 'block' | 'filesystem';
  config?: Record<string, string>;
  description?: string;
}

export interface IncusCustomVolume {
  name: string;
  type: 'custom';
  content_type: 'block' | 'filesystem';
  config: Record<string, string>;
  description: string;
  used_by: string[];
  created_at: string;
  project: string;
}

export interface IncusImageAlias {
  name: string;
  target: string;
  description: string;
  type: string;
}

export interface IncusImage {
  fingerprint: string;
  type: 'container' | 'virtual-machine';
  architecture: string;
  size: number;
  aliases: Array<{ name: string; description: string }>;
  properties?: Record<string, string>;
}

export interface IncusClientOptions {
  endpoint: string;
  project?: string;
  clientCert?: string | Buffer;
  clientKey?: string | Buffer;
  serverCert?: string | Buffer;
  clientCertPath?: string;
  clientKeyPath?: string;
  serverCertPath?: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}

export class IncusClient {
  readonly endpoint: string;
  readonly project: string;
  private clientCert?: string | Buffer;
  private clientKey?: string | Buffer;
  private serverCert?: string | Buffer;
  private clientCertPath?: string;
  private clientKeyPath?: string;
  private serverCertPath?: string;
  private rejectUnauthorized: boolean;
  private timeoutMs: number;
  private httpsAgent?: https.Agent;
  private requireVerifiedTransport = false;

  constructor(options: IncusClientOptions) {
    this.endpoint = (options.endpoint || '').replace(/\/+$/, '');
    this.project = options.project || 'agentor';
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
    this.serverCert = options.serverCert;
    this.clientCertPath = options.clientCertPath;
    this.clientKeyPath = options.clientKeyPath;
    this.serverCertPath = options.serverCertPath;
    this.rejectUnauthorized = options.rejectUnauthorized ?? Boolean(options.serverCert || options.serverCertPath);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  static fromConfig(config: Config): IncusClient {
    const client = new IncusClient({
      endpoint: config.incusEndpoint,
      project: config.incusProject || 'agentor',
      clientCertPath: config.incusClientCertPath,
      clientKeyPath: config.incusClientKeyPath,
      serverCertPath: config.incusServerCertPath,
      rejectUnauthorized: true,
    });
    client.requireVerifiedTransport = true;
    return client;
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint);
  }

  /** Session owners close their exec channels separately. Release idle REST
   * connections when an integration fixture/client lifetime ends. */
  dispose(): void {
    this.httpsAgent?.destroy();
    this.httpsAgent = undefined;
  }

  private async getAgent(): Promise<https.Agent> {
    this.validateTransport();
    if (this.httpsAgent) return this.httpsAgent;

    let cert = this.clientCert;
    if (!cert && this.clientCertPath) {
      try {
        cert = await readFile(this.clientCertPath);
      } catch (err: any) {
        throw new IncusError(`Failed to read Incus client cert from ${this.clientCertPath}: ${err.message}`);
      }
    }

    let key = this.clientKey;
    if (!key && this.clientKeyPath) {
      try {
        key = await readFile(this.clientKeyPath);
      } catch (err: any) {
        throw new IncusError(`Failed to read Incus client key from ${this.clientKeyPath}: ${err.message}`);
      }
    }

    let ca = this.serverCert;
    if (!ca && this.serverCertPath) {
      try {
        ca = await readFile(this.serverCertPath);
      } catch (err: any) {
        throw new IncusError(`Failed to read Incus server cert from ${this.serverCertPath}: ${err.message}`);
      }
    }

    this.httpsAgent = new https.Agent({
      cert,
      key,
      ca,
      rejectUnauthorized: this.rejectUnauthorized,
      keepAlive: true,
    });

    return this.httpsAgent;
  }

  private validateTransport(): void {
    if (this.requireVerifiedTransport && (!this.endpoint.startsWith('https://') ||
        !this.clientCertPath || !this.clientKeyPath || !this.serverCertPath))
      throw new IncusError('Production Incus access requires HTTPS, client credentials and verified server TLS');
  }

  private buildUrl(path: string, queryParams?: Record<string, string | number | boolean | undefined>): URL {
    const fullUrl = new URL(path.startsWith('http') ? path : `${this.endpoint}${path.startsWith('/') ? '' : '/'}${path}`);
    if (fullUrl.origin !== new URL(this.endpoint).origin)
      throw new IncusError('Incus response URL must remain on the configured server');
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined) {
          fullUrl.searchParams.set(k, String(v));
        }
      }
    }
    // Automatically apply project scoping if not present and not a root server endpoint
    if (!fullUrl.searchParams.has('project') && !fullUrl.pathname.startsWith('/1.0/projects')) {
      fullUrl.searchParams.set('project', this.project);
    }
    return fullUrl;
  }

  async rawRequest(
    method: string,
    path: string,
    body?: Buffer | string | Record<string, any>,
    headers: Record<string, string> = {},
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
    if (!this.isConfigured()) {
      throw new IncusError('Incus client is not configured (missing endpoint)');
    }

    this.validateTransport();

    const url = this.buildUrl(path, queryParams);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const agent = isHttps ? await this.getAgent() : undefined;

    return new Promise((resolve, reject) => {
      let payloadBuffer: Buffer | undefined;
      const reqHeaders: Record<string, string> = { ...headers };

      if (body !== undefined) {
        if (Buffer.isBuffer(body)) {
          payloadBuffer = body;
          reqHeaders['Content-Length'] = String(payloadBuffer.length);
        } else if (typeof body === 'string') {
          payloadBuffer = Buffer.from(body, 'utf-8');
          reqHeaders['Content-Length'] = String(payloadBuffer.length);
        } else {
          payloadBuffer = Buffer.from(JSON.stringify(body), 'utf-8');
          reqHeaders['Content-Type'] = 'application/json';
          reqHeaders['Content-Length'] = String(payloadBuffer.length);
        }
      }

      const req = transport.request(
        url,
        {
          method: method.toUpperCase(),
          agent,
          headers: reqHeaders,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const resBody = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: resBody,
            });
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => {
        req.destroy(new IncusError(`Incus request timeout after ${this.timeoutMs}ms`, 408));
      });

      req.on('error', reject);

      if (payloadBuffer) {
        req.write(payloadBuffer);
      }
      req.end();
    });
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: Buffer | string | Record<string, any>,
    headers: Record<string, string> = {},
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const res = await this.rawRequest(method, path, body, headers, queryParams);

    let json: IncusResponse<T>;
    try {
      json = JSON.parse(res.body.toString('utf-8')) as IncusResponse<T>;
    } catch {
      if (res.statusCode >= 400) {
        throw new IncusError(
          `Incus HTTP ${res.statusCode}: ${res.body.toString('utf-8').slice(0, 300)}`,
          res.statusCode,
        );
      }
      return res.body as unknown as T;
    }

    if (json.type === 'error' || res.statusCode >= 400) {
      throw new IncusError(json.error || `Incus HTTP ${res.statusCode}`, res.statusCode, json.error_code);
    }

    return json.metadata;
  }

  async waitForOperation(
    operationUrlOrId: string,
    timeoutSeconds = 120,
    signal?: AbortSignal,
  ): Promise<IncusOperationMetadata> {
    const opId = operationUrlOrId.includes('/')
      ? operationUrlOrId.split('/').filter(Boolean).pop()!
      : operationUrlOrId;
    const path = `/1.0/operations/${encodeURIComponent(opId)}`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    // An image-backed VM create can outlive one HTTP request. Poll its state
    // without blocking HTTP on /wait or resending the accepted mutation.
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new IncusError('Incus operation wait cancelled', 499);
      const res = await this.request<IncusOperationMetadata>('GET', path);
      if (res.status === 'Success') return res;
      if (res.status === 'Failure' || res.status_code >= 400) {
        throw new IncusError(res.err || 'Incus operation failed', 500, res.status_code);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new IncusError(`Incus operation ${opId} did not finish within ${timeoutSeconds}s`, 408);
  }

  async getReadiness(): Promise<{
    ready: boolean;
    auth: 'trusted' | 'untrusted';
    project: string;
    serverVersion: string;
    driver: string;
    details?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        ready: false,
        auth: 'untrusted',
        project: this.project,
        serverVersion: '',
        driver: '',
        details: 'Incus endpoint is not configured',
      };
    }

    try {
      const serverInfo = await this.request<IncusServerInfo>('GET', '/1.0');
      if (serverInfo.auth !== 'trusted') {
        return {
          ready: false,
          auth: 'untrusted',
          project: this.project,
          serverVersion: serverInfo.environment?.server_version || '',
          driver: serverInfo.environment?.driver || '',
          details: 'Incus TLS client certificate is untrusted by server',
        };
      }

      // Check project access
      try {
        const project = await this.request<IncusProject>('GET', `/1.0/projects/${encodeURIComponent(this.project)}`);
        return {
          ready: true,
          auth: 'trusted',
          project: project.name,
          serverVersion: serverInfo.environment?.server_version || '',
          driver: serverInfo.environment?.driver || '',
        };
      } catch (err: any) {
        return {
          ready: false,
          auth: 'trusted',
          project: this.project,
          serverVersion: serverInfo.environment?.server_version || '',
          driver: serverInfo.environment?.driver || '',
          details: `Incus project '${this.project}' is inaccessible: ${err.message}`,
        };
      }
    } catch (err: any) {
      return {
        ready: false,
        auth: 'untrusted',
        project: this.project,
        serverVersion: '',
        driver: '',
        details: `Failed to connect to Incus: ${err.message}`,
      };
    }
  }

  // --- Instances ---

  async listInstances(options?: { recursion?: 0 | 1 | 2 }): Promise<IncusInstance[]> {
    const recursion = options?.recursion ?? 1;
    return this.request<IncusInstance[]>('GET', '/1.0/instances', undefined, {}, {
      recursion,
    });
  }

  async getInstance(name: string): Promise<IncusInstance> {
    return this.request<IncusInstance>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  }

  async getInstanceState(name: string): Promise<IncusInstanceState> {
    return this.request<IncusInstanceState>('GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
  }

  async getNetwork(name: string): Promise<IncusNetwork> {
    return this.request<IncusNetwork>('GET', `/1.0/networks/${encodeURIComponent(name)}`);
  }

  async getNetworkLeases(name: string): Promise<IncusNetworkLease[]> {
    return this.request<IncusNetworkLease[]>('GET', `/1.0/networks/${encodeURIComponent(name)}/leases`);
  }

  async updateInstanceDevices(name: string, devices: Record<string, IncusDevice>): Promise<void> {
    const current = await this.getInstance(name);
    const raw = await this.rawRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}`, {
      config: current.config, profiles: current.profiles, description: current.description, devices,
    });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400)
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    if (json.type === 'async' && json.operation) await this.waitForOperation(json.operation);
  }

  /** Guest-agent reports are diagnostic only. Guest root can falsify them;
   * routing and worker-self authority must use host NIC configuration/leases. */
  async getPrimaryIp(name: string, preferredInterface = 'eth0'): Promise<string | undefined> {
    const state = await this.getInstanceState(name);
    if (!state.network) return undefined;

    // First check the preferred interface
    const prefIf = state.network[preferredInterface];
    if (prefIf?.addresses) {
      const ipv4 = prefIf.addresses.find((a) => a.family === 'inet' && a.scope === 'global');
      if (ipv4?.address) return ipv4.address;
    }

    // Fallback: search all interfaces, ignoring lo and docker/bridge/veth devices
    for (const [ifName, ifData] of Object.entries(state.network)) {
      if (ifName === 'lo' || /^(docker|veth|br-)/.test(ifName)) continue;
      if (ifData.addresses) {
        const ipv4 = ifData.addresses.find((a) => a.family === 'inet' && a.scope === 'global');
        if (ipv4?.address) return ipv4.address;
      }
    }

    return undefined;
  }

  async createInstance(spec: IncusInstanceCreateSpec): Promise<IncusInstance> {
    const payload = {
      name: spec.name,
      type: spec.type || 'virtual-machine',
      source: spec.source,
      config: spec.config || {},
      devices: spec.devices || {},
      profiles: spec.profiles || ['default'],
      description: spec.description || '',
    };

    const raw = await this.rawRequest('POST', '/1.0/instances', payload);
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;

    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }

    if (json.type === 'async' && json.operation) {
      // Image unpacking is disk-bound and can exceed a short lifecycle wait
      // on a loaded host. Keep the accepted create, never resend it.
      await this.waitForOperation(json.operation, 300);
    }

    return this.getInstance(spec.name);
  }

  async startInstance(name: string): Promise<void> {
    const raw = await this.rawRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action: 'start',
    });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }
    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  async stopInstance(name: string, options?: { force?: boolean; timeout?: number }): Promise<void> {
    const raw = await this.rawRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action: 'stop',
      force: options?.force ?? false,
      timeout: options?.timeout ?? 30,
    });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }
    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  async restartInstance(name: string, options?: { force?: boolean; timeout?: number }): Promise<void> {
    const raw = await this.rawRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action: 'restart',
      force: options?.force ?? false,
      timeout: options?.timeout ?? 30,
    });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }
    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  async deleteInstance(name: string): Promise<void> {
    const raw = await this.rawRequest('DELETE', `/1.0/instances/${encodeURIComponent(name)}`);
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }
    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  // --- File Operations ---

  async pushFile(
    name: string,
    path: string,
    content: Buffer | string = '',
    options?: IncusFilePushOptions,
  ): Promise<void> {
    let modeStr = '0644';
    if (options?.mode !== undefined) {
      modeStr = typeof options.mode === 'number'
        ? '0' + options.mode.toString(8)
        : options.mode;
    }

    const type = options?.type ?? 'file';
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Incus-uid': String(options?.uid ?? 0),
      'X-Incus-gid': String(options?.gid ?? 0),
      'X-Incus-mode': modeStr,
      'X-Incus-type': type,
    };

    const body = type === 'directory' ? Buffer.alloc(0) : (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
    const res = await this.rawRequest(
      'POST',
      `/1.0/instances/${encodeURIComponent(name)}/files`,
      body,
      headers,
      { path },
    );

    if (res.statusCode >= 400) {
      let errMsg = `HTTP ${res.statusCode}`;
      try {
        const j = JSON.parse(res.body.toString('utf-8'));
        if (j.error) errMsg = j.error;
      } catch {}
      throw new IncusError(`Failed to push file to ${path}: ${errMsg}`, res.statusCode);
    }
  }

  async pullFile(name: string, path: string): Promise<IncusFilePullResult> {
    const res = await this.rawRequest(
      'GET',
      `/1.0/instances/${encodeURIComponent(name)}/files`,
      undefined,
      {},
      { path },
    );

    if (res.statusCode === 404) {
      throw new IncusError(`File not found: ${path}`, 404);
    }
    if (res.statusCode >= 400) {
      let errMsg = `HTTP ${res.statusCode}`;
      try {
        const j = JSON.parse(res.body.toString('utf-8'));
        if (j.error) errMsg = j.error;
      } catch {}
      throw new IncusError(`Failed to pull file from ${path}: ${errMsg}`, res.statusCode);
    }

    const type = (res.headers['x-incus-type'] as 'file' | 'directory' | 'symlink') || 'file';
    const mode = parseInt((res.headers['x-incus-mode'] as string) || '0644', 8);
    const uid = parseInt((res.headers['x-incus-uid'] as string) || '0', 10);
    const gid = parseInt((res.headers['x-incus-gid'] as string) || '0', 10);
    const modified = res.headers['x-incus-modified'] as string | undefined;

    return {
      content: res.body,
      type,
      mode,
      uid,
      gid,
      modified,
    };
  }

  async deleteFile(name: string, path: string): Promise<void> {
    const res = await this.rawRequest(
      'DELETE',
      `/1.0/instances/${encodeURIComponent(name)}/files`,
      undefined,
      {},
      { path },
    );

    if (res.statusCode >= 400) {
      let errMsg = `HTTP ${res.statusCode}`;
      try {
        const j = JSON.parse(res.body.toString('utf-8'));
        if (j.error) errMsg = j.error;
      } catch {}
      throw new IncusError(`Failed to delete file ${path}: ${errMsg}`, res.statusCode);
    }
  }

  // --- Exec ---

  /** Non-PTY exec preserves binary bytes and separates stdout/stderr. Closing
   * control cancels the direct command; this does not promise tree-wide kill. */
  async execStream(
    name: string,
    command: string[],
    options?: IncusInstanceExecOptions & { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IncusStreamExecSession> {
    const signal = options?.signal;
    if (signal?.aborted) throw new IncusError('Incus exec cancelled', 499);
    const raw = await this.rawRequest('POST', `/1.0/instances/${encodeURIComponent(name)}/exec`, {
      command, 'wait-for-websocket': true, interactive: false,
      environment: options?.environment, cwd: options?.cwd, user: options?.user, group: options?.group,
    });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400)
      throw new IncusError('Incus streaming exec setup failed', raw.statusCode, json.error_code);
    const opId = json.metadata.id;
    const fds = json.metadata.metadata?.fds;
    if (!fds?.['0'] || !fds?.['1'] || !fds?.['2'] || !fds.control)
      throw new IncusError('Incus exec did not return required websocket descriptors');
    // No sockets were opened, so Incus's bounded wait-for-websocket prevents
    // an accepted late setup from launching after caller cancellation.
    if (signal?.aborted) throw new IncusError('Incus exec cancelled', 499);

    const stdout = new PassThrough(), stderr = new PassThrough();
    const ended = new Set<string>();
    const channels: Record<string, WebSocket> = {};
    let closed = false;
    let rejectCompletion!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCompletion = reject; });
    cancelled.catch(() => {});
    const operationController = new AbortController();
    const close = (error: Error = new IncusError('Incus exec cancelled', 499)) => {
      if (closed) return;
      closed = true;
      operationController.abort();
      rejectCompletion(error);
      for (const channel of Object.values(channels)) channel.terminate();
      stdout.destroy(error); stderr.destroy(error); stdin.destroy(error);
    };
    const stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const socket = channels['0'];
        if (closed || socket?.readyState !== WebSocket.OPEN) return callback(new IncusError('Incus exec stdin closed', 502));
        socket.send(Buffer.from(chunk), { binary: true }, callback);
      },
      final: (callback) => {
        const socket = channels['0'];
        if (socket?.readyState !== WebSocket.OPEN) return callback();
        socket.send('', { binary: false }, (error) => { socket.close(); callback(error); });
      },
    });
    // Preserve rejection through result even if a socket fails before the
    // caller receives the session and installs stream error listeners.
    for (const stream of [stdin, stdout, stderr]) stream.on('error', () => {});
    const outputDone = Promise.all(['1', '2'].map((fd) => new Promise<void>((resolve) => {
      const output = fd === '1' ? stdout : stderr;
      output.once('finish', resolve);
    })));
    const abort = () => close();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => close(new IncusError('Incus exec timed out', 408)), options?.timeoutMs ?? 120_000);
    timer.unref?.();
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    try {
      const attach = (fd: string, socket: WebSocket) => {
        channels[fd] = socket;
        if (closed) { socket.terminate(); return; }
        socket.on('error', () => close(new IncusError('Incus exec channel failed', 502)));
        if (fd !== '1' && fd !== '2') return;
        const output = fd === '1' ? stdout : stderr;
        const finish = () => {
          if (ended.has(fd)) return;
          ended.add(fd);
          output.end();
          socket.close();
          if (ended.has('1') && ended.has('2')) {
            ended.add('0');
            channels['0']?.close();
          }
        };
        socket.on('message', (bytes: Buffer, binary) => {
          if (!binary) { finish(); return; }
          if (!ended.has(fd) && !output.write(bytes)) socket.pause();
        });
        output.on('drain', () => socket.resume());
        socket.on('close', () => {
          if (!ended.has(fd)) close(new IncusError('Incus exec output closed before EOF', 502));
        });
      };
      // The daemon may launch a non-PTY command before control attaches for
      // older-client compatibility. Connect control first, so a fast command
      // cannot close it normally during its own handshake.
      await this.openExecWebSockets(opId, { control: fds.control }, attach);
      await this.openExecWebSockets(opId, { '0': fds['0'], '1': fds['1'], '2': fds['2'] }, attach, (fd) => ended.has(fd));
      if (closed) throw new IncusError('Incus exec cancelled during setup', 499);
      const result = Promise.race([cancelled, (async () => {
        await outputDone;
        const operation = await this.waitForOperation(opId, 120, operationController.signal);
        const code = operation.metadata?.return;
        if (!Number.isInteger(code)) throw new IncusError('Incus exec omitted its exit status', 502);
        return code as number;
      })()]).catch((error) => { close(error); throw error; }).finally(() => {
        cleanup();
        for (const channel of Object.values(channels)) channel.close();
      });
      result.catch(() => {});
      return { stdin, stdout, stderr, operationId: opId, result, close,
        sendSignal: (signalNumber) => {
          if (channels.control?.readyState === WebSocket.OPEN)
            channels.control.send(JSON.stringify({ command: 'signal', signal: signalNumber }));
        },
      };
    } catch (error) {
      close(error instanceof Error ? error : new IncusError('Incus exec setup failed', 502));
      cleanup();
      throw error;
    }
  }

  async exec(
    name: string,
    command: string[],
    options?: IncusInstanceExecOptions,
  ): Promise<IncusExecResult> {
    const payload = {
      command,
      'wait-for-websocket': false,
      'record-output': true,
      environment: options?.environment,
      cwd: options?.cwd,
      user: options?.user,
      group: options?.group,
    };

    const raw = await this.rawRequest(
      'POST',
      `/1.0/instances/${encodeURIComponent(name)}/exec`,
      payload,
    );

    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }

    const op = await this.waitForOperation(json.operation);
    const opMeta = op.metadata || {};
    const returnCode = opMeta.return ?? 0;

    let stdout = '';
    let stderr = '';

    if (opMeta.output?.['1']) {
      const stdoutRaw = await this.rawRequest('GET', opMeta.output['1']);
      stdout = stdoutRaw.body.toString('utf-8');
    }

    if (opMeta.output?.['2']) {
      const stderrRaw = await this.rawRequest('GET', opMeta.output['2']);
      stderr = stderrRaw.body.toString('utf-8');
    }

    return { returnCode, stdout, stderr };
  }

  async execInteractive(
    name: string,
    command: string[],
    options?: IncusInstanceExecOptions,
    attachData?: (socket: WebSocket) => void,
  ): Promise<IncusInteractiveExecSession> {
    const payload = {
      command,
      'wait-for-websocket': true,
      interactive: true,
      width: options?.width ?? 80,
      height: options?.height ?? 24,
      environment: options?.environment,
      cwd: options?.cwd,
      user: options?.user,
      group: options?.group,
    };

    const raw = await this.rawRequest(
      'POST',
      `/1.0/instances/${encodeURIComponent(name)}/exec`,
      payload,
    );

    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }

    const opId = json.metadata.id;
    const fds = json.metadata.metadata?.fds;
    if (!fds?.['0'] || !fds?.['control']) {
      throw new IncusError('Incus interactive exec did not return required websocket descriptors');
    }

    const sockets = await this.openExecWebSockets(opId, { '0': fds['0'], control: fds.control },
      (fd, socket) => { if (fd === '0') attachData?.(socket); });
    const dataWs = sockets['0']!;
    const controlWs = sockets.control!;
    // Incus signals output EOF with a TEXT frame, not a WebSocket close.
    // Close the data channel at that barrier so its stdin mirror also ends;
    // otherwise a successfully exited PTY command can leave /operations busy.
    dataWs.on('message', (_bytes, binary) => {
      if (!binary && dataWs.readyState === WebSocket.OPEN) dataWs.close();
    });

    const session: IncusInteractiveExecSession = {
      dataWs,
      controlWs,
      operationId: opId,
      resize: (cols: number, rows: number) => {
        if (controlWs.readyState === WebSocket.OPEN) {
          try {
            controlWs.send(
              JSON.stringify({
                command: 'window-resize',
                args: { width: String(cols), height: String(rows) },
              }),
            );
          } catch {}
        }
      },
      sendSignal: (signal: number) => {
        if (controlWs.readyState === WebSocket.OPEN) {
          try {
            controlWs.send(
              JSON.stringify({
                command: 'signal',
                signal,
              }),
            );
          } catch {}
        }
      },
      close: () => {
        try {
          if (dataWs.readyState === WebSocket.OPEN) dataWs.close();
        } catch {}
        try {
          if (controlWs.readyState === WebSocket.OPEN) controlWs.close();
        } catch {}
      },
    };

    return session;
  }

  /** Project-scoped exec channels use the same pinned mTLS agent as REST.
   * Bound every handshake and tear down all partially connected channels.
   * Keep descriptor secrets out of diagnostics. */
  private async openExecWebSockets(operationId: string, descriptors: Record<string, string>,
    onSocket?: (fd: string, socket: WebSocket) => void,
    finished?: (fd: string) => boolean,
  ): Promise<Record<string, WebSocket>> {
    const agent = this.endpoint.startsWith('https:') ? await this.getAgent() : undefined;
    const sockets: Record<string, WebSocket> = {};
    let disposed = false;
    let ready = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const socket of Object.values(sockets)) socket.terminate();
    };
    const pending: Promise<void>[] = [];
    try {
      for (const [fd, secret] of Object.entries(descriptors)) {
        const url = new URL(`/1.0/operations/${encodeURIComponent(operationId)}/websocket`, this.endpoint);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('project', this.project);
        url.searchParams.set('secret', secret);
        const socket = sockets[fd] = new WebSocket(url, { agent, handshakeTimeout: Math.min(this.timeoutMs, 30_000) });
        onSocket?.(fd, socket);
        // An error after setup must still close the other channel, and must
        // never become an unhandled EventEmitter error during late teardown.
        socket.on('error', dispose);
        pending.push(new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new IncusError('Incus exec websocket handshake timed out', 408)), Math.min(this.timeoutMs, 30_000));
          const finish = (error?: Error) => {
            clearTimeout(timeout);
            error ? reject(error) : resolve();
          };
          socket.once('open', () => finish());
          socket.once('error', () => finish(new IncusError('Incus exec websocket handshake failed', 502)));
          socket.once('close', () => {
            finish(new IncusError('Incus exec websocket closed during setup', 502));
            // An already opened channel can close while a sibling still
            // waits. Its resolved promise alone is not a usable session.
            if (!ready && !finished?.(fd)) dispose();
          });
        }));
      }
      await Promise.all(pending);
      if (Object.entries(sockets).some(([fd, socket]) => socket.readyState !== WebSocket.OPEN && !finished?.(fd)))
        throw new IncusError('Incus exec websocket closed during setup', 502);
      ready = true;
      return sockets;
    } catch (error) {
      dispose();
      // Observe every late handshake rejection, including constructor failure.
      await Promise.allSettled(pending);
      throw error;
    }
  }

  // --- Storage Volumes ---

  async createCustomVolume(
    pool: string,
    spec: IncusCustomVolumeCreateSpec,
  ): Promise<void> {
    const raw = await this.rawRequest(
      'POST',
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`,
      {
        name: spec.name,
        content_type: spec.content_type,
        config: spec.config,
        description: spec.description,
      },
    );

    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }

    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  async getCustomVolume(pool: string, name: string): Promise<IncusCustomVolume> {
    return this.request<IncusCustomVolume>(
      'GET',
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
    );
  }

  async deleteCustomVolume(pool: string, name: string): Promise<void> {
    const raw = await this.rawRequest(
      'DELETE',
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
    );

    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400) {
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    }

    if (json.type === 'async' && json.operation) {
      await this.waitForOperation(json.operation);
    }
  }

  async updateCustomVolume(pool: string, name: string, config: Record<string, string>): Promise<void> {
    const raw = await this.rawRequest('PUT',
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`, { config });
    const json = JSON.parse(raw.body.toString('utf-8')) as IncusResponse<any>;
    if (json.type === 'error' || raw.statusCode >= 400)
      throw new IncusError(json.error || `HTTP ${raw.statusCode}`, raw.statusCode, json.error_code);
    if (json.type === 'async' && json.operation) await this.waitForOperation(json.operation);
  }

  async listCustomVolumes(pool: string): Promise<string[]> {
    const list = await this.request<string[]>(
      'GET',
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`,
    );
    return list.map((item) => {
      const segment = item.includes('/')
        ? (item.split('/').filter(Boolean).pop() ?? item)
        : item;
      return segment.split('?')[0] ?? segment;
    });
  }

  // --- Images ---

  async getImageAlias(alias: string): Promise<IncusImageAlias> {
    return this.request<IncusImageAlias>('GET', `/1.0/images/aliases/${encodeURIComponent(alias)}`);
  }

  async hasImageAlias(alias: string): Promise<boolean> {
    try {
      await this.getImageAlias(alias);
      return true;
    } catch (err: any) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  async getImage(fingerprint: string): Promise<IncusImage> {
    return this.request<IncusImage>('GET', `/1.0/images/${encodeURIComponent(fingerprint)}`);
  }
}

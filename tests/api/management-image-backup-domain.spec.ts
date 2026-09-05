import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ManagementImageBackupDomain, sanitizeManagementBackupPayload } from '../../orchestrator/server/utils/management-image-backup-domain';

test('image and backup MCP domain exposes bounded tool surface and safe hints', () => {
  const tools = new ManagementImageBackupDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['images.list','images.create','images.update','images.build','images.build-status','images.build-logs','images.build-cancel','images.validation-retry','images.promote','images.rollback','images.delete-version','images.usage','images.test-worker','images.git-sync','backups.list','backups.providers','backups.discovery.start','backups.discovery.list','backups.inspect','backups.adopt','backups.image-recovery.start','backups.key-status','backups.recovery-material.import','backups.logs','backups.create','backups.cancel','backups.retry','backups.delete','backups.restore','instance-backups.list','instance-backups.create','instance-backups.discovery.start','instance-backups.discovery.list','instance-backups.inspect','instance-backups.preflight','instance-backups.adopt','instance-backups.restore','instance-backups.status','instance-backups.logs','instance-backups.cancel']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'images.build-logs')?.annotations).toMatchObject({ readOnlyHint:true });
  expect(tools.find(tool => tool.name === 'backups.delete')?.annotations).toMatchObject({ destructiveHint:true });
  const restore = tools.find(tool => tool.name === 'backups.restore');
  expect(restore?.inputSchema).toMatchObject({
    required: ['ownerId', 'artifactId'],
    properties: {
      workspaceIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  });
  expect(restore?.description).toContain('exact non-empty workspaceIds subset');
  for (const name of ['images.create', 'images.update', 'images.validate']) {
    const definition = (tools.find(tool => tool.name === name)?.inputSchema.properties as any)?.definition;
    expect(definition).toMatchObject({ required: ['name', 'baseImage', 'contextFiles'] });
    expect(definition.properties.provisioning.items.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ type: { const: 'packages' } }) }),
      expect.objectContaining({ properties: expect.objectContaining({ type: { const: 'command' } }) }),
      expect.objectContaining({ properties: expect.objectContaining({ type: { const: 'script' } }) }),
    ]));
    expect(definition.properties.contextFiles.items.properties).toMatchObject({
      role: { enum: ['asset', 'script'] },
      destination: { pattern: '^/opt/agentor-context/' },
    });
    const packageItem = definition.properties.provisioning.items.oneOf[0].properties.packages.items;
    expect(packageItem).toMatchObject({ pattern: '^(?!-)' });
    expect(definition.properties.dockerfileFragment.description).toContain('Legacy Safe-mode compatibility');
  }
  const definition = (tools.find(tool => tool.name === 'images.create')?.inputSchema.properties as any)?.definition;
  expect(definition.properties.provisioningMode).toMatchObject({ enum: ['safe', 'advanced'], default: 'safe' });
  expect(definition.properties.pluginComposition).toMatchObject({
    type: 'array', maxItems: 50,
    items: { required: ['definitionId', 'validation'], properties: { validation: { enum: ['required', 'optional'] } } },
  });
  for (const name of ['images.build', 'images.validation-retry', 'images.test-worker']) {
    expect(tools.find(tool => tool.name === name)?.description).toContain('asynchronous');
    expect(tools.find(tool => tool.name === name)?.inputSchema.properties).toMatchObject({
      requestId: { type: 'string', minLength: 1 },
    });
  }
  for (const name of ['images.build-status', 'images.build-logs', 'images.build-cancel']) {
    const schema = tools.find(tool => tool.name === name)?.inputSchema as any;
    expect(schema.required).toEqual(['buildId']);
    expect(schema.properties.buildId).toMatchObject({ type: 'string', minLength: 1 });
  }
  expect(tools.find(tool => tool.name === 'images.validation-retry')?.inputSchema.required).toEqual(['definitionId', 'version']);
  expect(tools.find(tool => tool.name === 'backups.recovery-material.import')?.inputSchema).toMatchObject({ required: ['ownerId','recoveryMaterial'], properties: { recoveryMaterial: { writeOnly: true } } });
  expect(tools.find(tool => tool.name === 'backups.adopt')?.inputSchema.required).toEqual(['ownerId','remoteBackupId']);
  expect(tools.find(tool => tool.name === 'backups.image-recovery.start')?.inputSchema).toMatchObject({
    required: ['ownerId', 'artifactId', 'workspaceId'],
    additionalProperties: false,
    properties: {
      startBuild: { type: 'boolean' },
      requestId: { type: 'string', minLength: 1 },
    },
  });
  expect((tools.find(tool => tool.name === 'backups.image-recovery.start')?.inputSchema.properties as any).builder).toBeUndefined();
  expect(tools.find(tool => tool.name === 'backups.discovery.start')?.inputSchema).toMatchObject({
    required: ['ownerId'],
    properties: { providerId: { enum: ['local', 'fake', 'google-drive'] }, requestId: { minLength: 1 } },
  });
  expect(tools.find(tool => tool.name === 'instance-backups.create')?.inputSchema).toMatchObject({
    required: ['ownerId'],
    additionalProperties: false,
    properties: {
      providerId: { enum: ['local', 'fake', 'google-drive'] },
      requestId: { type: 'string', minLength: 1 },
      options: {
        additionalProperties: false,
        properties: {
          includeWorkers: { type: 'boolean', default: true },
          includeAgentData: { type: 'boolean', default: true },
          includeDockerVolumes: { type: 'boolean', default: true },
          includeLocalBackups: { type: 'boolean', default: false },
          includeLogs: { type: 'boolean', default: false },
        },
      },
    },
  });
  expect(tools.find(tool => tool.name === 'instance-backups.discovery.start')?.inputSchema).toMatchObject({
    required: ['ownerId'],
    properties: {
      providerId: { enum: ['local', 'fake', 'google-drive'] },
      requestId: { type: 'string', minLength: 1 },
    },
  });
  expect(tools.find(tool => tool.name === 'instance-backups.restore')?.inputSchema).toMatchObject({
    required: ['ownerId', 'artifactId'],
    properties: {
      requestId: { type: 'string', minLength: 1 },
      options: {
        required: ['confirmReplaceControlPlane', 'confirmExternalDependencies'],
        properties: {
          restoreDockerVolumes: { type: 'boolean', default: true },
          restoreHostMountPolicies: { type: 'boolean', default: false },
          confirmReplaceControlPlane: { type: 'boolean' },
          confirmExternalDependencies: { type: 'boolean' },
        },
      },
    },
  });
  for (const name of ['instance-backups.list','instance-backups.discovery.list','instance-backups.inspect','instance-backups.preflight','instance-backups.status','instance-backups.logs'])
    expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.find(tool => tool.name === 'instance-backups.restore')?.annotations).toMatchObject({ destructiveHint: true });
  expect(tools.find(tool => tool.name === 'instance-backups.cancel')?.annotations).toMatchObject({ destructiveHint: true });
  expect(tools.find(tool => tool.name === 'backups.restore')?.inputSchema.properties).toMatchObject({
    requestId: { type: 'string', minLength: 1 },
    imageResolutions: {
      type: 'object',
      description: expect.stringContaining('never silently substitutes'),
    },
  });
  expect(tools.find(tool => tool.name === 'images.build-logs')?.inputSchema.properties).toMatchObject({
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  });
  expect(tools.find(tool => tool.name === 'images.git-sync')?.inputSchema).toMatchObject({
    properties: {
      direction: { enum: ['push', 'pull'] },
      resolution: { enum: ['remote-copy'] },
      workflow: { enum: ['direct', 'branch', 'pull-request'] },
      ghcrByDigest: { type: 'object' },
    },
  });
});

test('image MCP follow-up actions use durable build ids without an owner selector', () => {
  // The platform adapter resolves the owner from buildId; group adapters have
  // always derived it from identity. Keep the public async protocol identical.
  const source = readFileSync(new URL('../../orchestrator/server/utils/management-image-backup-domain.ts', import.meta.url), 'utf8');
  expect(source).toContain('const jobArguments = { buildId: jobId };');
  expect(source).toMatch(/const\s+arguments_\s*=\s*\{\s*buildId:\s*jobId\s*\}/);
  expect(source).not.toContain('const jobArguments = { ownerId, buildId: jobId };');
});

test('backup MCP payloads redact internal provider cleanup and upload handles', () => {
  expect(sanitizeManagementBackupPayload({
    providerUploadId: 'session',
    pendingProviderUploadId: 'pending-session',
    pendingProviderObjectId: 'object',
    pendingProviderArtifactId: 'artifact',
    recipe: 'FROM secret-base',
    dockerfileFragment: 'RUN leaked-command',
    status: 'failed',
  })).toEqual({
    providerUploadId: '[REDACTED]',
    pendingProviderUploadId: '[REDACTED]',
    pendingProviderObjectId: '[REDACTED]',
    pendingProviderArtifactId: '[REDACTED]',
    recipe: '[REDACTED]',
    dockerfileFragment: '[REDACTED]',
    status: 'failed',
  });
});

test('backup MCP payloads preserve required secret names without exposing secret values', () => {
  expect(sanitizeManagementBackupPayload({
    requiredSecretNames: ['OPENAI_API_KEY'],
    missingSecrets: ['GITHUB_TOKEN'],
    secretValue: 'raw-secret',
    nested: {
      requiredSecretNames: ['PLUGIN_TOKEN'],
      credential: 'raw-credential',
    },
  })).toEqual({
    requiredSecretNames: ['OPENAI_API_KEY'],
    missingSecrets: ['GITHUB_TOKEN'],
    secretValue: '[REDACTED]',
    nested: {
      requiredSecretNames: ['PLUGIN_TOKEN'],
      credential: '[REDACTED]',
    },
  });
});

test('backup MCP surface keeps recovery material write-only and uses shared async follow-ups', () => {
  const source = readFileSync(new URL('../../orchestrator/server/utils/management-image-backup-domain.ts', import.meta.url), 'utf8');
  const managementStore = readFileSync(new URL('../../orchestrator/server/utils/management-mcp-store.ts', import.meta.url), 'utf8');
  const httpGuard = readFileSync(new URL('../../orchestrator/server/middleware/instance-snapshot-guard.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/tool:\s*["']backups\.status["']/);
  expect(source).toMatch(/tool:\s*["']backups\.logs["']/);
  expect(source).toMatch(/tool:\s*["']backups\.cancel["']/);
  expect(source).toMatch(/tool:\s*["']instance-backups\.status["']/);
  expect(source).toMatch(/tool:\s*["']instance-backups\.logs["']/);
  expect(source).toMatch(/tool:\s*["']instance-backups\.cancel["']/);
  expect(source).toMatch(/createRecoveryRestore\(\s*manager,\s*owner,\s*artifact/);
  // The MCP boundary delegates cursor semantics to the persisted manager: it
  // must not truncate a long-running discovery/adoption log before applying
  // the caller's `after` cursor.
  expect(source).toMatch(/manager\.getJobLogs\(\s*job\.id,\s*number\(a\.after,\s*0\),\s*limit\(a\.limit\)\s*\)/);
  expect(source).not.toContain('function backupLogs(');
  expect(source).not.toContain('backups.recovery-key.reveal');
  expect(source).not.toContain('backups.recovery-key.export');
  expect(source).not.toContain('instance-backups.recovery-key.reveal');
  expect(source).not.toContain('instance-backups.recovery-key.export');
  expect(managementStore).toContain('instanceSnapshotActive()');
  expect(managementStore).toContain('name === "instance-backups.cancel"');
  expect(managementStore).toContain('args.jobId === instanceSnapshotJobId()');
  expect(httpGuard).toContain('statusCode: 423');
  expect(httpGuard).toContain('/api/admin/instance-backups/jobs/');
  expect(httpGuard).toContain('encodeURIComponent(instanceSnapshotJobId()!)');
});

test('recovery MCP schemas make every long-operation follow-up and key boundary explicit', () => {
  const tools = new ManagementImageBackupDomain().tools();
  for (const name of ['backups.discovery.start', 'backups.adopt', 'backups.image-recovery.start', 'backups.restore']) {
    const schema = tools.find((tool) => tool.name === name)?.inputSchema as any;
    expect(schema.properties.requestId).toMatchObject({ type: 'string', minLength: 1 });
  }
  const logs = tools.find((tool) => tool.name === 'backups.logs')?.inputSchema as any;
  expect(logs.required).toEqual(['ownerId', 'jobId']);
  expect(logs.properties).toMatchObject({
    after: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  });
  expect(JSON.stringify(tools)).not.toMatch(/recovery-key\.(?:reveal|export)/);
});

test('image recovery delegates to the final durable manager contract and gives exact image build follow-ups only when a build exists', () => {
  const source = readFileSync(new URL('../../orchestrator/server/utils/management-image-backup-domain.ts', import.meta.url), 'utf8');
  expect(source).toContain('await manager.createImageRecovery(');
  expect(source).toContain('a.startBuild !== false');
  expect(source).toContain('value?.recoveredImageBuildId');
  expect(source).not.toContain('createDependencyResolution');
  expect(source).toContain('"backups.image-recovery.start"');
  expect(source).toContain('imageBuildStatus: { tool: "images.build-status"');
  expect(source).toContain('imageBuildLogs: { tool: "images.build-logs"');
  expect(source).toContain('imageBuildCancel: { tool: "images.build-cancel"');
  expect(source).toContain('if (!artifact || artifact.userId !== owner)');
});

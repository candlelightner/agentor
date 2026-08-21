import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagementMcpStore, normalizeManagementMcpState } from '../../orchestrator/server/utils/management-mcp-store';

const legacy = (enabled: unknown = true) => ({ schemaVersion: 1, policy: { default: 'deny', groups: { 'read-only-status': { enabled } }, revision: 4, updatedAt: '2026-01-01T00:00:00.000Z' }, proposals: [], audit: [] });

function authorize(store: ManagementMcpStore) {
  const raw = 'unit-test-credential';
  const hash = createHash('sha256').update(raw).digest('hex');
  (store as any).identities.set(hash, {
    hash,
    workspaceId: 'unit-admin-workspace',
    expiresAt: Date.now() + 60_000,
  });
  return `mcp1.${raw}`;
}

test('legacy aggregate read-only policy expands only the historic narrow read groups', () => {
  const state = normalizeManagementMcpState(legacy())!.state;
  for (const group of ['read-only-status', 'logs', 'volume-browsing', 'configuration-inspection']) expect(state.policy.groups[group as keyof typeof state.policy.groups].enabled).toBe(true);
  for (const group of ['worker-lifecycle', 'console', 'images', 'image-builds', 'catalogs', 'running-files', 'networking', 'apps', 'storage-maintenance']) expect(state.policy.groups[group as keyof typeof state.policy.groups].enabled).toBe(false);
});

test('new groups and malformed/unknown values fail closed without broadening partial policy', () => {
  const input = legacy(); input.policy.groups = { 'read-only-status': { enabled: true }, logs: { enabled: 'true' }, unknown: { enabled: true } } as any;
  const normalized = normalizeManagementMcpState(input)!;
  expect(normalized.state.policy.groups.logs.enabled).toBe(false);
  expect(normalized.state.policy.groups['volume-browsing'].enabled).toBe(false);
  expect(normalized.state.policy.groups['image-builds'].enabled).toBe(false);
  expect((normalized.state.policy.groups as any).unknown).toBeUndefined();
});

test('legacy disabled and persisted image-build permission retain exact fail-closed meaning', () => {
  expect(normalizeManagementMcpState(legacy(false))!.state.policy.groups.logs.enabled).toBe(false);
  const input = legacy(false); input.policy.groups = { 'image-builds': { enabled: true } } as any;
  const state = normalizeManagementMcpState(input)!.state;
  expect(state.policy.groups['image-builds'].enabled).toBe(true);
  expect(state.policy.groups['read-only-status'].enabled).toBe(false);
  expect(state.policy.groups.catalogs.enabled).toBe(false);
});

test('management policy and audit transactions recover after a rejected write without committing the failed policy', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
  const releaseWrite = new Promise<void>((resolve) => { release = resolve; });
  let attempt = 0;
  const store = new ManagementMcpStore('/unused', async () => {
    if (attempt++ === 0) {
      entered();
      await releaseWrite;
      throw new Error('injected write failure');
    }
  });
  const failed = store.updatePolicy({ 'worker-lifecycle': true }, 'first');
  await enteredWrite;
  const succeeding = store.audit('second.audit', 'success');
  release();
  await expect(failed).rejects.toThrow('injected write failure');
  await expect(succeeding).resolves.toBeUndefined();
  expect((await store.getPolicy()).groups['worker-lifecycle'].enabled).toBe(false);
  expect((await store.listAudit()).map((entry) => entry.action)).toEqual(['second.audit']);
});

test('proposal approval remains pending after persistence rejection and can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-management-proposal-'));
  try {
    const state = normalizeManagementMcpState({
      ...legacy(),
      proposals: [{ id: 'proposal-1', immutable: true, status: 'pending-dashboard-approval', diff: { logLevel: 'warn' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    })!.state;
    const admin = join(directory, 'admin');
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'management-mcp.v1.json'), JSON.stringify(state));
    let fail = true;
    const store = new ManagementMcpStore(directory, async () => {
      if (fail) throw new Error('injected approval failure');
    });
    await expect(store.approve('proposal-1', 'admin')).rejects.toThrow('injected approval failure');
    const pending = (await store.listProposals())[0]!;
    expect(pending.status).toBe('pending-dashboard-approval');
    expect(pending.approvedAt).toBeUndefined();
    fail = false;
    await expect(store.approve('proposal-1', 'admin')).resolves.toMatchObject({ status: 'approved' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a completed MCP tool is not reported as failed when only its success audit write fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-management-audit-'));
  try {
    const state = normalizeManagementMcpState({
      ...legacy(),
      policy: {
        ...legacy().policy,
        groups: { 'configuration-proposals': { enabled: true } },
      },
    })!.state;
    const admin = join(directory, 'admin');
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'management-mcp.v1.json'), JSON.stringify(state));
    let writeAttempt = 0;
    const store = new ManagementMcpStore(directory, async () => {
      writeAttempt += 1;
      if (writeAttempt === 2) throw new Error('injected success-audit failure');
    });
    const credential = authorize(store);
    await expect(store.invoke(credential, 'configuration.propose', {
      patch: { logLevel: 'warn' },
    })).resolves.toMatchObject({
      immutable: true,
      status: 'pending-dashboard-approval',
    });
    expect(await store.listProposals()).toHaveLength(1);
    expect(await store.listAudit()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configuration application persists retry intent before its idempotent cross-store effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-management-apply-'));
  const proposalId = 'proposal-retry-safe';
  try {
    const state = normalizeManagementMcpState({
      ...legacy(),
      policy: {
        ...legacy().policy,
        groups: { 'configuration-application': { enabled: true } },
      },
      proposals: [{
        id: proposalId,
        immutable: true,
        status: 'pending-dashboard-approval',
        diff: { workerId: 'worker-1', variables: [{ key: 'SAFE_VALUE', value: 'desired' }] },
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })!.state;
    const admin = join(directory, 'admin');
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'management-mcp.v1.json'), JSON.stringify(state));

    let writeAttempt = 0;
    let appliedVariables: Array<{ key: string; value: string }> = [];
    let effectCalls = 0;
    const store = new ManagementMcpStore(
      directory,
      async () => {
        writeAttempt += 1;
        if (writeAttempt === 2) throw new Error('injected final commit failure');
      },
      {
        getLogLevel: () => 'info',
        setLogLevel: () => undefined,
        verifyWorkerVariables: async () => undefined,
        applyWorkerVariables: async (workerId, variables) => {
          effectCalls += 1;
          appliedVariables = structuredClone(variables);
          return { workerId };
        },
      },
    );
    const credential = authorize(store);

    await expect(store.invoke(credential, 'configuration.apply', { proposalId }))
      .rejects.toMatchObject({
        statusCode: 503,
        code: 'CONFIGURATION_APPLICATION_RETRY_REQUIRED',
      });
    expect((await store.listProposals())[0]).toMatchObject({
      id: proposalId,
      status: 'approved',
    });
    expect(appliedVariables).toEqual([{ key: 'SAFE_VALUE', value: 'desired' }]);

    await expect(store.invoke(credential, 'configuration.apply', { proposalId }))
      .resolves.toMatchObject({ status: 'applied', applied: true, pendingRebuild: true });
    expect(effectCalls).toBe(2);
    expect((await store.listProposals())[0]).toMatchObject({
      id: proposalId,
      status: 'applied',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

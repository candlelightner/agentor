import { test, expect } from '@playwright/test';
import { normalizeManagementMcpState } from '../../orchestrator/server/utils/management-mcp-store';

const legacy = (enabled: unknown = true) => ({ schemaVersion: 1, policy: { default: 'deny', groups: { 'read-only-status': { enabled } }, revision: 4, updatedAt: '2026-01-01T00:00:00.000Z' }, proposals: [], audit: [] });

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

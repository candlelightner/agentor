import { test, expect } from '@playwright/test';
import { validateVcpuCount } from '../../orchestrator/shared/vcpu-count';

test('vCPU counts are strict positive integers bounded by backend capacity', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined])
    expect(() => validateVcpuCount(value, 8)).toThrow('positive integer');
  expect(() => validateVcpuCount(9, 8)).toThrow('backend maximum of 8');
  expect(validateVcpuCount(1, 8)).toBe(1);
  expect(validateVcpuCount(8, 8)).toBe(8);
  // Reconciliation observes an already accepted mutation, even after capacity shrinks.
  expect(validateVcpuCount(8)).toBe(8);
});

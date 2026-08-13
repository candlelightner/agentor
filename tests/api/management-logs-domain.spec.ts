import { test, expect } from '@playwright/test';
import { ManagementLogsDomain, boundBytes, redactLogs } from '../../orchestrator/server/utils/management-logs-domain';

function domain(overrides: Partial<ConstructorParameters<typeof ManagementLogsDomain>[0]> = {}) {
  return new ManagementLogsDomain({
    findWorker: id => id === 'worker-a' ? { id, userId: 'owner-a' } : undefined,
    readLogs: async (_id, tail) => `tail=${tail} token=super-secret file=also-secret`,
    managedSecretValues: async () => ['super-secret', 'also-secret'],
    ...overrides,
  });
}

test('management logs domain declares a bounded read-only worker log tool', () => {
  const tool = domain().tools()[0];
  expect(tool).toMatchObject({ name: 'logs.read', group: 'logs', annotations: { readOnlyHint: true } });
  expect(tool.inputSchema).toMatchObject({ required: ['workerId', 'ownerId'] });
  expect((tool.inputSchema.properties as any).tail).toMatchObject({ maximum: 1000 });
});

test('management logs domain limits tail and redacts configured secrets without returning them', async () => {
  const result: any = await domain().execute('logs.read', { workerId: 'worker-a', ownerId: 'owner-a', tail: 50_000 });
  expect(result.handled).toBe(true);
  expect(result.result).toMatchObject({ workerId: 'worker-a', ownerId: 'owner-a', tail: 1000, redactedSecrets: 2 });
  expect(result.result.logs).toContain('[REDACTED]');
  expect(result.result.logs).not.toContain('super-secret');
  expect(result.result.logs).not.toContain('also-secret');
});

test('management logs domain rejects cross-owner, missing, malformed, and arbitrary tool requests', async () => {
  await expect(domain().execute('logs.read', { workerId: 'worker-a', ownerId: 'owner-b' })).rejects.toMatchObject({ statusCode: 404 });
  await expect(domain().execute('logs.read', { workerId: 'missing', ownerId: 'owner-a' })).rejects.toMatchObject({ statusCode: 404 });
  await expect(domain().execute('logs.read', { workerId: 'worker-a', ownerId: 'owner-a', tail: 0 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(domain().execute('logs.read', { workerId: 'worker-a', ownerId: 'owner-a', source: '/var/log/auth.log' })).resolves.toMatchObject({ handled: true });
  await expect(domain().execute('logs.delete', {})).resolves.toEqual({ handled: false });
});

test('redaction handles overlapping literals and output is byte bounded', () => {
  expect(redactLogs('abcd123 abcd', ['abcd', 'abcd123'])).toEqual({ logs: '[REDACTED] [REDACTED]', redacted: 2 });
  const bounded = boundBytes('é'.repeat(100), 40);
  expect(bounded.truncated).toBe(true);
  expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(40);
  expect(bounded.text).toContain('[output truncated]');
});

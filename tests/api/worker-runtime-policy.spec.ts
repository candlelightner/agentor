import { test, expect } from '@playwright/test';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { ApiClient } from '../helpers/api-client';
import {
  assertWorkerRuntimeMatches,
  resolveWorkerRuntimePolicy,
  resolveWorkerRuntimeProfile,
  resolveNewWorkerRuntime,
} from '../../orchestrator/server/utils/worker-runtime-policy';

test('new worker policy selects the registered Kata QEMU runtime', () => {
  expect(resolveNewWorkerRuntime()).toEqual({ runtimeProfile: 'kata-qemu' });
  expect(resolveNewWorkerRuntime({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin', authorize: async () => {} }))
    .toEqual({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin' });
  expect(() => resolveNewWorkerRuntime({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'preexisting' } as any))
    .toThrow(/trusted runtime authorization/);
  expect(() => resolveNewWorkerRuntime({ runtimeProfile: 'legacy-runc', legacyPrivilegeGrant: 'admin' } as any))
    .toThrow(/trusted runtime authorization/);
  expect(resolveWorkerRuntimePolicy({ runtimeProfile: 'kata-qemu', dockerEnabled: false }))
    .toEqual({ runtime: 'agentor-kata-qemu', privileged: false });
  expect(() => resolveWorkerRuntimePolicy({ runtimeProfile: 'kata-qemu', dockerEnabled: true }))
    .toThrow(/guest permissions and Docker storage/);
  expect(resolveWorkerRuntimeProfile(undefined)).toBe('legacy-runc');
});

test('operator attestation and alias registration are both necessary', async () => {
  const service = new DockerService({ ...loadConfig(), kataHostValidated: true });
  (service as any).docker = { info: async () => ({ Runtimes: { 'agentor-kata-qemu': {} } }) };
  await expect(service.assertWorkerRuntimeAvailable('kata-qemu')).resolves.toBeUndefined();
});

test('Docker-in-Docker cannot grant host privilege to an unapproved legacy worker', () => {
  expect(() => resolveWorkerRuntimePolicy({ runtimeProfile: 'legacy-runc', dockerEnabled: true }))
    .toThrow(/administrator privilege grant/);
  expect(resolveWorkerRuntimePolicy({ runtimeProfile: 'legacy-runc', dockerEnabled: true, legacyPrivilegeGrant: 'preexisting' }))
    .toEqual({ runtime: 'runc', privileged: true });
  expect(resolveWorkerRuntimePolicy({ runtimeProfile: 'legacy-runc', dockerEnabled: true, legacyPrivilegeGrant: 'admin' }))
    .toEqual({ runtime: 'runc', privileged: true });
  expect(() => resolveWorkerRuntimePolicy({ runtimeProfile: 'kata-qemu', dockerEnabled: true, legacyPrivilegeGrant: 'admin' }))
    .toThrow(/cannot carry/);
});

test('Kata DinD is rejected before any Docker mutation, without privileged fallback', async () => {
  const service = new DockerService(loadConfig());
  let dockerCalls = 0;
  (service as any).docker = {
    info: async () => { dockerCalls++; return { Runtimes: { 'agentor-kata-qemu': {} } }; },
    createContainer: async () => { dockerCalls++; },
  };
  await expect(service.createWorkerContainer({ runtimeProfile: 'kata-qemu', dockerEnabled: true } as any))
    .rejects.toMatchObject({ code: 'KATA_DIND_NOT_VALIDATED' });
  expect(dockerCalls).toBe(0);
  await expect(service.createWorkerContainer({ runtimeProfile: 'kata-qemu', dockerEnabled: false,
    hardwareDevices: [{ deviceNodes: ['/dev/dri/renderD128'] }] } as any))
    .rejects.toMatchObject({ code: 'KATA_DEVICE_PASSTHROUGH_NOT_VALIDATED' });
  expect(dockerCalls).toBe(0);
});

test('registered runtime is required and Docker inspection must match durable profile', async () => {
  const service = new DockerService({ ...loadConfig(), kataHostValidated: true });
  (service as any).docker = { info: async () => ({ Runtimes: { runc: {} } }) };
  await expect(service.assertWorkerRuntimeAvailable('kata-qemu'))
    .rejects.toMatchObject({ code: 'KATA_RUNTIME_UNAVAILABLE' });
  await expect(service.assertWorkerRuntimeAvailable('legacy-runc')).resolves.toBeUndefined();
  expect(() => assertWorkerRuntimeMatches('kata-qemu', 'runc', false)).toThrow(/does not match/);
  expect(() => assertWorkerRuntimeMatches('kata-qemu', 'agentor-kata-qemu', true)).toThrow(/does not match/);
  expect(() => assertWorkerRuntimeMatches('kata-qemu', 'agentor-kata-qemu', false, 'admin')).toThrow(/does not match/);
  expect(() => assertWorkerRuntimeMatches('legacy-runc', 'runc', true)).toThrow(/does not match/);
  expect(() => assertWorkerRuntimeMatches('legacy-runc', 'runc', true, 'preexisting')).not.toThrow();
});

test('Kata requires operator attestation even when its alias is registered', async () => {
  const service = new DockerService({ ...loadConfig(), kataHostValidated: false });
  let inspected = false;
  (service as any).docker = { info: async () => {
    inspected = true;
    return { Runtimes: { 'agentor-kata-qemu': {} } };
  } };
  await expect(service.assertWorkerRuntimeAvailable('kata-qemu'))
    .rejects.toMatchObject({ code: 'KATA_HOST_NOT_VALIDATED' });
  expect(inspected).toBe(false);
  await expect(service.assertWorkerRuntimeAvailable('legacy-runc')).resolves.toBeUndefined();
});

test('CI legacy fixture choice is explicit and restricted to the authenticated administrator', async () => {
  const payloads: unknown[] = [];
  let role = 'admin';
  const client = new ApiClient({
    get: async () => ({ status: () => 200, json: async () => ({ user: { role } }) }),
    post: async (_url: string, options: { data: unknown }) => {
      payloads.push(options.data);
      return { status: () => 201, json: async () => ({ id: 'fixture' }) };
    },
  } as any);
  await client.createContainer({ displayName: 'ordinary-default' });
  expect(payloads[0]).toEqual({ displayName: 'ordinary-default' });
  await client.createLegacyContainer({ displayName: 'explicit-admin-fixture' });
  expect(payloads[1]).toEqual({ displayName: 'explicit-admin-fixture', runtimeProfile: 'legacy-runc', acknowledgeHostPrivilege: true });
  role = 'user';
  await expect(client.createLegacyContainer()).rejects.toThrow(/authenticated platform administrator/);
  expect(payloads).toHaveLength(2);
});

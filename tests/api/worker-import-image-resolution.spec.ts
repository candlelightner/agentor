import { expect, test } from '@playwright/test';
import { parseWorkerImportImageResolution } from '../../orchestrator/server/utils/worker-import-image-resolution';

test('portable import image choices are explicit and contain only catalog identity or workspace-only acknowledgement', () => {
  expect(parseWorkerImportImageResolution(undefined)).toBeUndefined();
  expect(parseWorkerImportImageResolution({ mode: 'workspace-only', acknowledged: true })).toEqual({ mode: 'workspace-only' });
  expect(parseWorkerImportImageResolution({ mode: 'replacement', imageDefinitionId: 'catalog-uuid', imageVersion: 'v1.2' }))
    .toEqual({ mode: 'replacement', imageDefinitionId: 'catalog-uuid', imageVersion: 'v1.2' });
});

test('public import image choices cannot convey raw images, runtime authority or unacknowledged loss of rootfs', () => {
  for (const value of [null, [], false, 'workspace-only', { mode: 'exact' }, { mode: 'workspace-only' },
    { mode: 'workspace-only', acknowledged: false }, { mode: 'workspace-only', acknowledged: 'true' },
    ...['runtimeKind', 'provenance', 'adminLegacyAuthorized', 'runtimePrincipal', 'imageRuntimeReference', 'imageDigest'].map(key =>
      ({ mode: 'workspace-only', acknowledged: true, [key]: 'untrusted' })),
    { mode: 'replacement', imageDefinitionId: '../unsafe', imageVersion: 'v1' },
    { mode: 'replacement', imageDefinitionId: 'catalog', imageVersion: '' },
    { mode: 'replacement', imageDefinitionId: 'catalog', imageVersion: 'v1\n' },
    { mode: 'replacement', imageDefinitionId: 'catalog', imageVersion: 'a'.repeat(101) },
    { mode: 'replacement', imageDefinitionId: 'catalog', imageVersion: 'v1', imageRuntimeReference: 'raw:image' }])
    expect(() => parseWorkerImportImageResolution(value)).toThrow('Invalid import image resolution');
});

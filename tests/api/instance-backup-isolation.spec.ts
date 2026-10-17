import { expect, test } from '@playwright/test';
import { validatePrivateDocker, validatePrivateDockerMarker } from '../helpers/private-test-docker';

test('whole-instance acceptance admits only its exact private daemon, root directory and hostname', () => {
  const marker = { kind: 'agentor-isolated-test-dind', daemonId: 'fixture-daemon', hostname: 'fixture-runner', dockerRootDir: '/var/lib/docker' };
  const info = { ID: marker.daemonId, DockerRootDir: marker.dockerRootDir, Name: marker.hostname };
  expect(() => validatePrivateDocker(marker, info, marker.hostname)).not.toThrow();
  for (const malformed of [null, {}, [], { ...marker, daemonId: 'bad\ninput' }])
    expect(() => validatePrivateDockerMarker(malformed as any)).toThrow('private nested Docker');
  for (const changed of [{ ...marker, kind: 'production' }, { ...marker, daemonId: '' }, { ...marker, daemonId: 'foreign' },
    { ...marker, hostname: 'another-runner' }, { ...marker, dockerRootDir: '/host/docker' }])
    expect(() => validatePrivateDocker(changed, info, marker.hostname)).toThrow('private nested Docker');
  for (const changed of [{ ...info, ID: 'foreign' }, { ...info, DockerRootDir: '/host/docker' }, { ...info, Name: 'foreign' }])
    expect(() => validatePrivateDocker(marker, changed, marker.hostname)).toThrow('private nested Docker');
});

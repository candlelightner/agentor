import { expect, test } from '@playwright/test';
import { validatePrivateDocker, validatePrivateDockerMarker, validatePrivateDockerCgroup } from '../helpers/private-test-docker';

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


test('whole-instance acceptance requires the exact post-delegation init child and rejects root or foreign cgroups', () => {
  expect(() => validatePrivateDockerCgroup('0::/init\n')).not.toThrow();
  for (const value of ['', '0::/', '0::/initial', '0::/init/child', '0::/system.slice/agentor.service',
    '0::/docker/foreign/init', '1:name=systemd:/init', '0::/init\n1:cpu:/init'])
    expect(() => validatePrivateDockerCgroup(value)).toThrow('delegated private cgroup');
});

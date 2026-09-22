import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000 }).trim();
const image = 'agentor-orchestrator:latest';

test.describe('Trusted live-volume helper (isolated test Docker)', () => {
  test.skip(!existsSync('/src/orchestrator'), 'Runs inside the repository isolated Docker test runner only');

  for (const privileged of [false, true]) test(`live mounts without changing worker privilege (${privileged})`, async () => {
    const worker = `agentor-volume-test-${randomUUID()}`, volume = `${worker}-data`, helper = `${worker}-helper`;
    try {
      docker('volume', 'create', '--label', 'agentor.test=true', volume);
      docker('run', '-d', '--name', worker, ...(privileged ? ['--privileged'] : []), '--label', 'agentor.test=true', '--entrypoint', 'sleep', image, '600');
      docker('exec', worker, 'python3', '-c', 'import pathlib; p=pathlib.Path("/opt/models"); p.mkdir(parents=True); (p/"before").write_text("preserved")');
      docker('pause', worker);
      try {
        const result = docker('run', '--name', helper, '--privileged', '--pid', `container:${worker}`, '--network', 'none', '--read-only', '--mount', `type=volume,src=${volume},dst=/volume,volume-nocopy`, '--entrypoint', 'python3', image, '-I', '/app/.output/server/volume-mount-helper.py', '/opt/models', 'new');
        expect(JSON.parse(result)).toEqual({ ok: true });
      } finally { docker('unpause', worker); }
      expect(docker('inspect', '--format', '{{.HostConfig.Privileged}}', worker)).toBe(String(privileged));
      expect(docker('exec', worker, 'cat', '/opt/models/before')).toBe('preserved');
      docker('exec', worker, 'python3', '-c', 'from pathlib import Path; Path("/opt/models/after").write_text("live")');
      expect(docker('run', '--rm', '--mount', `type=volume,src=${volume},dst=/volume,readonly`, '--entrypoint', 'cat', image, '/volume/after')).toBe('live');
    } finally {
      for (const name of [helper, worker]) { try { docker('rm', '-f', name); } catch {} }
      try { docker('volume', 'rm', volume); } catch {}
    }
  });

  test('busy directory is rejected without replacing its contents', () => {
    const worker = `agentor-volume-test-${randomUUID()}`, volume = `${worker}-data`, helper = `${worker}-helper`;
    try {
      docker('volume', 'create', '--label', 'agentor.test=true', volume);
      docker('run', '-d', '--name', worker, '--label', 'agentor.test=true', '--entrypoint', 'python3', image, '-c', 'import pathlib,time; p=pathlib.Path("/opt/models"); p.mkdir(parents=True); f=open(p/"busy", "w"); f.write("original"); f.flush(); time.sleep(600)');
      // exec completion proves the source process has opened the test file.
      docker('exec', worker, 'python3', '-c', 'import pathlib,time; p=pathlib.Path("/opt/models/busy"); end=time.time()+10\nwhile not p.exists() and time.time()<end: time.sleep(.05)\nassert p.exists()');
      docker('pause', worker);
      try {
        expect(() => docker('run', '--name', helper, '--privileged', '--pid', `container:${worker}`, '--network', 'none', '--mount', `type=volume,src=${volume},dst=/volume,volume-nocopy`, '--entrypoint', 'python3', image, '-I', '/app/.output/server/volume-mount-helper.py', '/opt/models', 'new')).toThrow();
        expect(docker('logs', helper)).toContain('busy');
      } finally { docker('unpause', worker); }
      expect(docker('exec', worker, 'cat', '/opt/models/busy')).toBe('original');
    } finally {
      for (const name of [helper, worker]) { try { docker('rm', '-f', name); } catch {} }
      try { docker('volume', 'rm', volume); } catch {}
    }
  });
});

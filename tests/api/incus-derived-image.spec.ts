import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createHash } from 'node:crypto';
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, symlink, rename, rm, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from "node:child_process";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { IncusWorkerStorage } from "../../orchestrator/server/utils/incus-worker-storage";
import type { Config } from "../../orchestrator/server/utils/config";

function serializeIncusWorkerEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => key + "='" + value.replaceAll("'", "'\\''") + "'").join("\n") + "\n";
}

const config = {
  incusEnabled: true, incusEndpoint: "https://127.0.0.1:18443", incusProject: "agentor",
  incusClientCertPath: "/workspace/agentor-incus-tls/client.crt",
  incusClientKeyPath: "/workspace/agentor-incus-tls/client.key",
  incusServerCertPath: "/workspace/agentor-incus-tls/server.crt",
  incusWorkerImage: process.env.INCUS_TEST_IMAGE || "agentor-worker-takeover",
  incusNetwork: "incusbr0", incusStoragePool: "default",
  incusInternalGatewayUrl: "http://10.159.68.1:3000", containerPrefix: "agentor-worker",
  workerImagePrefix: "", workerImage: "agentor-worker:latest",
} as Config;

function options() {
  return {
    userId: "test-user", id: "test-worker", containerName: "agentor-worker-test-worker", dockerEnabled: false,
    environmentJson: { networkMode: "full", allowedDomains: [], dockerEnabled: false,
      setupScript: "", envVars: "", exposeApis: { portMappings: true, domainMappings: true, usage: true } },
    capabilitiesJson: [], instructionsJson: [],
    workerJson: { id: "test-worker", displayName: "Incus test", repos: [], initScript: "", gitName: "", gitEmail: "" },
  };
}

async function conversionCliFixture(run: (f: { invoke: (args: string[], cached?: boolean) => string;
  log: () => Promise<string>; output: string; source: string; recipe: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-image-cli-')), repo = resolve('..');
  const bin = join(root, 'bin'), output = join(root, 'output'), log = join(root, 'commands');
  await mkdir(bin); await mkdir(join(root, 'locks'));
  const source = 'sha256:' + 'a'.repeat(64);
  const recipe = execFileSync('bash', ['-c',
    `{ printf '%s\\n' '${source}' amd64 3 v0.4.0 8G; sha256sum scripts/build-incus-worker-image.sh worker/entrypoint.sh worker/vm/*; } | sha256sum | cut -d' ' -f1`],
    { cwd: repo, encoding: 'utf8' }).trim();
  const script = join(root, 'convert.sh');
  await writeFile(script, (await readFile(join(repo, 'scripts/build-incus-worker-image.sh'), 'utf8'))
    .replace('REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"', 'REPO_ROOT="$FIXTURE_REPO"')
    .replaceAll('/run/lock/agentor-vm-image-', join(root, 'locks/agentor-vm-image-')));
  const mock = String.raw`#!/bin/bash
set -euo pipefail
tool="${'${'}0##*/}"
printf '%s %s\n' "$tool" "$*" >> "$FIXTURE_LOG"
case "$tool" in
 id) echo 0;;
 docker)
  if [[ "$*" == 'image inspect -f {{.Architecture}} '* ]]; then echo amd64
  elif [[ "$*" == 'image inspect -f '* ]]; then
   if [[ "${'${'}@: -1}" == agentor-worker-vm-stage:* ]]; then printf 'sha256:%064d\n' 0; else echo "$FIXTURE_SOURCE"; fi
  fi;;
 d2vm)
  if [[ "$1" == --version ]]; then echo 'd2vm version v0.4.0'; else
   while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then printf 'raw-fixture\n' > "$2"; break; fi; shift; done
  fi;;
 qemu-img) if [[ "$1" == convert ]]; then printf 'qcow-fixture\n' > "${'${'}@: -1}"; fi;;
 losetup) if [[ "$1" != -d ]]; then echo /dev/fixture-loop; fi;;
 mktemp) /usr/bin/mktemp -d "$FIXTURE_ROOT/mnt.XXXXXX";;
 mount) /bin/mkdir -p "${'${'}@: -1}";;
 umount)
  for target in "$@"; do case "$target" in
   "$FIXTURE_ROOT"/mnt.??????/boot) /bin/rm -f "$target/startup.nsh"; /bin/rmdir "$target";;
   "$FIXTURE_ROOT"/mnt.??????/dev|"$FIXTURE_ROOT"/mnt.??????/proc|"$FIXTURE_ROOT"/mnt.??????/sys) /bin/rmdir "$target";;
   "$FIXTURE_ROOT"/mnt.??????) :;;
   *) exit 99;;
  esac; done;;
 mountpoint) exit 1;;
 incus)
  if [[ "$FIXTURE_CACHED" != true ]]; then echo 'Unexpected Incus access' >&2; exit 98; fi
  if [[ "$*" == 'image alias list '* ]]; then printf 'agentor-worker,%064d\n' 1
  elif [[ "$*" == 'image show '* ]]; then printf 'source_image_id: %s\nrecipe_id: %s\n' "$FIXTURE_SOURCE" "$FIXTURE_RECIPE"
  else exit 97; fi;;
 sgdisk|chroot) :;;
 *) exit 96;;
esac
`;
  try {
    for (const tool of ['docker', 'd2vm', 'qemu-img', 'sgdisk', 'losetup', 'mktemp', 'mount', 'umount', 'mountpoint', 'chroot', 'incus', 'id'])
      await writeFile(join(bin, tool), mock, { mode: 0o755 });
    await run({ source, recipe, output, log: () => readFile(log, 'utf8'), invoke: (args, cached = false) => execFileSync('bash',
      [script, '--output-dir', output, ...args], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, LC_ALL: 'C',
        FIXTURE_ROOT: root, FIXTURE_REPO: repo, FIXTURE_LOG: log, FIXTURE_SOURCE: source, FIXTURE_RECIPE: recipe,
        FIXTURE_CACHED: String(cached) }, encoding: 'utf8', stdio: 'pipe' }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('raw-only CLI keeps finalized raw output and skips qcow metadata/import/cache while identities are pinned', async () => {
  await conversionCliFixture(async f => {
    const output = f.invoke(['--raw-only', '--expected-source-id', f.source, '--expected-recipe-id', f.recipe]);
    expect(output).toContain('Raw conversion complete'); expect(await readFile(join(f.output, 'disk.raw'), 'utf8')).toBe('raw-fixture\n');
    await expect(stat(join(f.output, 'disk.qcow2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(f.output, 'metadata.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
    const log = await f.log(); expect(log).toContain('d2vm convert --raw '); expect(log).toContain('qemu-img resize -f raw ');
    expect(log).toContain('sgdisk -g '); expect(log).toContain('chroot '); expect(log).not.toContain('qemu-img convert '); expect(log).not.toContain('incus ');
  });
});

test('controlled CLI source/recipe mismatch rejects before bootstrap build or raw allocation', async () => {
  for (const field of ['source', 'recipe'] as const) await conversionCliFixture(async f => {
    expect(() => f.invoke(['--raw-only', field === 'source' ? '--expected-source-id' : '--expected-recipe-id',
      field === 'source' ? 'sha256:' + 'c'.repeat(64) : 'd'.repeat(64)])).toThrow(/expected immutable identity/);
    expect(await f.log()).not.toMatch(/docker build|d2vm convert|incus /);
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('legacy no-import output and default matching Incus cache behavior remain compatible', async () => {
  await conversionCliFixture(async f => {
    f.invoke(['--no-import']); expect(await readFile(join(f.output, 'disk.qcow2'), 'utf8')).toBe('qcow-fixture\n');
    expect(await readFile(join(f.output, 'metadata.yaml'), 'utf8')).toContain('source_image_id: "' + f.source + '"');
    await expect(stat(join(f.output, 'disk.raw'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.log()).not.toContain('incus ');
  });
  await conversionCliFixture(async f => {
    expect(f.invoke([], true)).toContain('already up to date'); expect(await f.log()).not.toContain('docker build');
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const canonicalBootstrap = ['scripts/build-incus-worker-image.sh', 'worker/entrypoint.sh',
  ...['99-incus-agent.rules', 'Dockerfile.vm', 'agentor-dnsmasq.service', 'agentor-docker-storage.service',
    'agentor-docker-storage.sh', 'agentor-network.sh', 'agentor-private-storage.sh', 'agentor-worker.service',
    'incus-agent-setup', 'incus-agent.service'].sort().map(name => 'worker/vm/' + name)];

async function assetFixture(run: (f: { root: string; output: string; invoke: () => string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'incus-canonical-assets-')), repo = resolve('..'), output = join(root, 'packaged');
  const module = join(root, 'orchestrator/build-incus-worker-assets.mjs');
  try {
    await mkdir(dirname(module)); await copyFile(join(repo, 'orchestrator/build-incus-worker-assets.mjs'), module);
    for (const name of canonicalBootstrap) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await copyFile(join(repo, name), join(root, name));
    }
    await run({ root, output, invoke: () => execFileSync(process.execPath, [module, output], { encoding: 'utf8', stdio: 'pipe' }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('canonical asset generator packages exactly twelve source files with verified hashes and modes', async () => {
  await assetFixture(async f => {
    await chmod(join(f.root, 'scripts/build-incus-worker-image.sh'), 0o751);
    expect(f.invoke()).toContain('12 hashed source assets');
    const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8')) as {
      version: number; files: Array<{ name: string; size: number; mode: number; sha256: string }>;
    };
    expect(manifest.version).toBe(1); expect(manifest.files.map(file => file.name)).toEqual(canonicalBootstrap);
    expect((await stat(f.output)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.output, 'manifest.json'))).mode & 0o777).toBe(0o600);
    for (const file of manifest.files) {
      const source = await readFile(join(f.root, file.name)), packaged = await readFile(join(f.output, file.name));
      expect(packaged).toEqual(source); expect(file.size).toBe(source.length);
      expect(file.sha256).toBe(createHash('sha256').update(source).digest('hex'));
      expect(file.mode).toBe((await lstat(join(f.root, file.name))).mode & 0o777);
      expect((await stat(join(f.output, file.name))).mode & 0o777).toBe(file.mode);
    }
  });
});

test('canonical asset generator never overwrites an existing destination generation', async () => {
  await assetFixture(async f => {
    await mkdir(f.output, { mode: 0o700 }); await writeFile(join(f.output, 'keep'), 'previous generation');
    expect(f.invoke).toThrow(/EEXIST/); expect(await readFile(join(f.output, 'keep'), 'utf8')).toBe('previous generation');
    await expect(stat(join(f.output, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('canonical asset generator rejects symlink, nonregular and unexpected source assets before creating output', async () => {
  for (const mutation of ['vm-symlink', 'script-symlink', 'directory', 'unexpected', 'vm-parent', 'worker-parent', 'scripts-parent'] as const) await assetFixture(async f => {
    const vm = join(f.root, 'worker/vm/incus-agent.service'), script = join(f.root, 'scripts/build-incus-worker-image.sh');
    if (mutation.endsWith('-parent')) {
      const name = mutation === 'vm-parent' ? 'worker/vm' : mutation === 'worker-parent' ? 'worker' : 'scripts';
      const target = join(f.root, name), outside = join(f.root, 'outside-canonical-' + mutation);
      await rename(target, outside); await symlink(outside, target);
    } else if (mutation === 'unexpected') await writeFile(join(f.root, 'worker/vm/unapproved-os-definition'), 'must not ship');
    else {
      const target = mutation === 'script-symlink' ? script : vm;
      await rm(target);
      if (mutation === 'directory') await mkdir(target);
      else await symlink(join(f.root, 'worker/entrypoint.sh'), target);
    }
    expect(f.invoke).toThrow(/unsupported assets|bounded regular file|real source directories/);
    await expect(stat(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('root image context uses explicit source rules and late known-secret exclusions with the correct CI build root', async () => {
  const rules = (await readFile('../.dockerignore', 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  expect(rules[0]).toBe('**');
  const allowed = rules.filter(line => line.startsWith('!'));
  expect(allowed).toEqual(['!orchestrator/', ...['package.json', 'package-lock.json', 'tsconfig.json', 'nuxt.config.ts',
    'app.config.ts', 'Dockerfile', 'build-instance-restore-native.mjs', 'build-incus-worker-assets.mjs', 'instance-restore-native.ts',
    'instance-restore-helper.mjs', 'volume-mount-helper.py', 'incus-volume-live-helper.py'].map(name => '!orchestrator/' + name),
    '!orchestrator/app/', '!orchestrator/app/**', '!orchestrator/server/', '!orchestrator/server/**',
    '!orchestrator/shared/', '!orchestrator/shared/**', '!worker/', '!worker/vm/', '!worker/vm/**',
    '!worker/entrypoint.sh', '!scripts/', '!scripts/build-incus-worker-image.sh']);
  // Docker ignore has no knowledge of Git tracking. These rules protect the
  // named secret/data categories, not arbitrary untracked source-like files;
  // clean CI/scoped private build context remains a separate requirement.
  const lastAllow = Math.max(...allowed.map(rule => rules.indexOf(rule)));
  for (const rule of ['**/.git', '**/node_modules', '**/.output', '**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/*.crt',
    '**/data', '**/.claude', '**/.codex', '**/.gemini', '**/.agents', '**/.agent-data', '**/.aws', '**/.config', '**/auth.db*',
    '**/auth.secret', '**/secrets.json', '**/backup-objects', '**/backups', '**/instance-backup-staging', '**/instance-restore-staging',
    '**/*.backup']) expect(rules.indexOf(rule)).toBeGreaterThan(lastAllow);
  const dockerfile = await readFile('../orchestrator/Dockerfile', 'utf8');
  expect(dockerfile).not.toMatch(/^COPY\s+\.\s+/m);
  expect(dockerfile).toContain('worker/entrypoint.sh'); expect(dockerfile).toContain('worker/vm/');
  expect(dockerfile).toContain('scripts/build-incus-worker-image.sh'); expect(dockerfile).toContain('RUN npm run build');
  const packageJson = JSON.parse(await readFile('../orchestrator/package.json', 'utf8')) as { scripts: { build: string } };
  expect(packageJson.scripts.build).toContain('build-incus-worker-assets.mjs');
  const ci = await readFile('../.github/workflows/docker-build.yml', 'utf8');
  expect(ci).toMatch(/context: \.\s*\n\s*file: \.\/orchestrator\/Dockerfile/);
});

test('early guest agent retains explicit shutdown ordering for background exec children', () => {
  const unit = readFileSync(new URL('../../worker/vm/incus-agent.service', import.meta.url), 'utf8');
  expect(unit).toMatch(/^DefaultDependencies=no$/m);
  expect(unit).toMatch(/^Conflicts=.*\bshutdown\.target\b/m);
  expect(unit).toMatch(/^Before=.*\bshutdown\.target\b/m);
  expect(unit).toMatch(/^After=.*\blocal-fs\.target\b/m);
  expect(unit).toMatch(/^TimeoutStopSec=10s$/m);
});

test("real derived image boots unattended and waits for runtime provisioning", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(600_000);
  const client = IncusClient.fromConfig(config);
  const id = randomUUID();
  const name = `${config.containerPrefix}-${id}`;
  const image = await client.getImageAlias(config.incusWorkerImage);
  const storage = new IncusWorkerStorage(client, config, name);
  const owner = { id, userId: "image-test", containerName: name };
  const devices = await storage.devices(owner, false);
  let created = false;
  try {
    await client.createInstance({ name, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint: image.target },
      config: { "security.secureboot": "false", "limits.memory": "2GiB", "limits.cpu": "2" },
      devices: {
        ...devices,
        root: { type: "disk", path: "/", pool: config.incusStoragePool },
        eth0: { type: "nic", name: "eth0", network: config.incusNetwork,
          "security.ipv4_filtering": "true", "security.mac_filtering": "true", "security.ipv6_filtering": "true" },
      },
    });
    created = true;
    await client.startInstance(name);
    let agentError = '';
    try {
      await expect.poll(async () => {
        try { return (await client.exec(name, ["true"])).returnCode; }
        catch (error) { agentError = String(error); return -1; }
      }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    } catch (error) {
      console.error('Derived-image guest readiness failure', name, agentError);
      // Capture the exact disposable fixture before teardown removes its
      // console. CLI is diagnostic only; normal runtime stays API-based.
      try {
        console.error(execFileSync('ssh', ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
          '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
          '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1',
          `sudo incus console ${name} --project agentor --show-log`], { encoding: 'utf8', timeout: 30_000 }));
      } catch (diagnosticError) { console.error('Console diagnostic unavailable', String(diagnosticError)); }
      throw error;
    }
    const unconfigured = await client.exec(name, ["bash", "-ec", [
      "test \"$(cat /proc/1/comm)\" = systemd",
      "systemctl is-active --quiet incus-agent",
      "systemctl show incus-agent -p Conflicts --value | grep -qw shutdown.target",
      "systemctl show incus-agent -p Before --value | grep -qw shutdown.target",
      "systemctl show incus-agent -p After --value | grep -qw local-fs.target",
      "test \"$(systemctl show incus-agent -p TimeoutStopUSec --value)\" = 10s",
      "test ! -e /run/agentor/worker.env",
      "! systemctl is-active --quiet agentor-worker docker docker.socket containerd",
      "systemctl start agentor-worker",
      "! systemctl is-active --quiet agentor-worker",
      "id agent; sudo -u agent sudo -n true",
    ].join("; ")]);
    expect(unconfigured.returnCode, unconfigured.stderr).toBe(0);
    const opts = options();
    await client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
    await client.pushFile(name, "/run/agentor/worker.env", serializeIncusWorkerEnv({
      ENVIRONMENT: JSON.stringify(opts.environmentJson), WORKER: JSON.stringify(opts.workerJson),
      CAPABILITIES: "[]", INSTRUCTIONS: "[]", ORCHESTRATOR_URL: config.incusInternalGatewayUrl,
      AGENTOR_RUNTIME_ROLE: "worker", WORKER_CONTAINER_NAME: name,
    }), { mode: 0o640, uid: 0, gid: 1000 });
    expect((await client.exec(name, ["sudo", "-u", "agent", "test", "-r", "/run/agentor/worker.env"])).returnCode).toBe(0);
    await client.pushFile(name, "/run/agentor/provisioned", "image-acceptance\n", { mode: 0o600, uid: 0, gid: 0 });
    expect((await client.exec(name, ["systemctl", "start", "agentor-worker"])).returnCode).toBe(0);
    await expect.poll(async () => (await client.exec(name, ["grep", "-q", "^READY|", "/tmp/worker-events"])).returnCode,
      { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    const services = await client.exec(name, ["bash", "-ec", [
      "systemctl is-active --quiet agentor-worker", "! systemctl is-active --quiet docker",
      "sudo -u agent tmux has-session -t main",
      "for process in Xvfb fluxbox x11vnc; do pgrep -x \"$process\"; done",
      "curl -fsS -o /dev/null http://127.0.0.1:6080/",
      "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/)\" = 302",
    ].join("; ")]);
    expect(services.returnCode, services.stderr).toBe(0);
    expect(await client.getPrimaryIp(name)).toBeTruthy();
    const network = await client.exec(name, ["bash", "-ec", [
      "/usr/lib/agentor/agentor-network.sh custom '[\"example.com\"]'",
      "test \"$(readlink /etc/resolv.conf)\" = /run/agentor/filter-resolv.conf",
      "! grep -q 127.0.0.11 /run/agentor/firewall-dns.conf",
      "getent ahostsv4 example.com",
      "curl --ipv4 --noproxy '*' -fsSI --max-time 30 https://example.com",
      "iptables -Z AGENTOR-OUTPUT",
      "! curl --noproxy '*' -fsS --connect-timeout 2 --max-time 3 http://198.51.100.10:81/",
      "iptables -nvxL AGENTOR-OUTPUT | awk '$3 == \"DROP\" { if($1>0) found=1 } END { exit !found }'",
      "/usr/lib/agentor/agentor-network.sh custom '[\"example.org\"]'",
      "! grep -q 'example.com' /run/agentor/firewall-dns.conf",
      "test \"$(iptables -S OUTPUT | grep -c -- '-j AGENTOR-OUTPUT')\" = 1",
      "ip6tables -S AGENTOR-OUTPUT | grep -q -- '-j DROP'",
      "/usr/lib/agentor/agentor-network.sh full",
      "test \"$(readlink /etc/resolv.conf)\" = /run/systemd/resolve/stub-resolv.conf",
      "! systemctl is-active --quiet agentor-dnsmasq.service",
      "getent ahostsv4 example.org",
    ].join("; ")]);
    expect(network.returnCode, `${network.stdout}\n${network.stderr}`).toBe(0);
    // Background exec children used by apps/plugins must stop with the guest
    // agent, before final shutdown/unmount. Keep the production stop bound.
    expect((await client.exec(name, ["bash", "-ec", "cd /workspace; sleep 600 >/dev/null 2>&1 &"])).returnCode).toBe(0);
    await client.stopInstance(name, { timeout: 30 });
    expect((await client.getInstanceState(name)).status).toBe('Stopped');
  } finally {
    // A transport/operation timeout may occur after creation was accepted.
    // Cleanup only this exact generated test name, not an arbitrary inventory.
    const exists = created || await client.getInstance(name).then(() => true, (error) => {
      if (error.statusCode === 404) return false;
      throw error;
    });
    if (exists) {
      if ((await client.getInstanceState(name)).status !== "Stopped")
        await client.stopInstance(name, { force: true });
      await client.deleteInstance(name);
    }
    await storage.remove(owner);
  }
});

import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_CREDENTIAL_MAPPINGS } from "../../orchestrator/server/utils/user-credentials";

test("private ownership repair prunes every account overlay and does not follow symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-private-storage-"));
  try {
    const workspace = join(root, "workspace");
    const agents = join(root, "agents");
    const commands = join(root, "commands");
    const log = join(root, "ownership-log");
    const mountinfo = join(root, 'mountinfo');
    const overlays = [".kilo/config", ".kilo/shared-data",
      ...AGENT_CREDENTIAL_MAPPINGS.filter((entry) => entry.fileBind !== false)
        .map((entry) => entry.containerPath.replace("/home/agent/.agent-data/", ""))];
    await mkdir(workspace);
    await mkdir(agents);
    await mkdir(commands);
    for (const overlay of overlays) {
      await mkdir(join(agents, overlay), { recursive: true });
      await writeFile(join(agents, overlay, "must-not-chown"), "account-fixture");
    }
    await writeFile(join(workspace, "private-file"), "workspace");
    const hostShare = join(workspace, 'host [share]*');
    await mkdir(hostShare);
    await writeFile(join(hostShare, 'must-not-chown'), 'host data');
    await writeFile(join(workspace, 'host s'), 'private near-match');
    await writeFile(mountinfo, `1 0 8:1 / / rw - ext4 /dev/vda1 rw\n2 1 0:99 / ${hostShare.replaceAll(' ', '\\040')} rw - virtiofs host rw\n`);
    await symlink(join(agents, overlays[0]!), join(agents, "private-symlink"));
    await writeFile(join(commands, "mountpoint"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(commands, "chown"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENTOR_OWNERSHIP_LOG"\n', { mode: 0o755 });
    const script = (await readFile("../worker/vm/agentor-private-storage.sh", "utf-8"))
      .replaceAll('/run/agentor/preserve-storage-ownership', join(root, 'ownership-marker'))
      .replaceAll("/home/agent/.agent-data", agents).replaceAll("/workspace", workspace)
      .replaceAll('/proc/self/mountinfo', mountinfo)
      // Select fixture-owned files without changing their real ownership.
      .replaceAll("-uid 1000", `-uid ${(process.getuid?.() ?? 1000) + 1}`);
    execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, AGENTOR_OWNERSHIP_LOG: log } });
    const repaired = (await readFile(log, "utf-8")).trim().split("\n");
    expect(repaired).toContain("-h");
    expect(repaired).toContain(join(workspace, "private-file"));
    expect(repaired).toContain(join(workspace, 'host s'));
    expect(repaired.some(path => path.startsWith(hostShare))).toBe(false);
    expect(repaired).toContain(join(agents, "private-symlink"));
    for (const overlay of overlays) expect(repaired.some((path) => path.startsWith(join(agents, overlay)))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ownership preservation requires exact trusted marker metadata and never falls back to repairing invalid markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-preserve-ownership-'));
  try {
    const workspace = join(root, 'workspace'), agents = join(root, 'agents'), commands = join(root, 'commands');
    const marker = join(root, 'marker'), log = join(root, 'chown-log');
    await mkdir(workspace); await mkdir(agents); await mkdir(commands);
    await writeFile(join(workspace, 'data'), 'private');
    await writeFile(join(commands, 'mountpoint'), '#!/bin/sh\nexit "${MOUNTPOINT_EXIT:-0}"\n', { mode: 0o755 });
    await writeFile(join(commands, 'stat'), '#!/bin/sh\nprintf "%s\\n" "$MARKER_STAT"\n', { mode: 0o755 });
    await writeFile(join(commands, 'chown'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$OWNERSHIP_LOG"\n', { mode: 0o755 });
    const script = (await readFile('../worker/vm/agentor-private-storage.sh', 'utf8'))
      .replaceAll('/home/agent/.agent-data', agents).replaceAll('/workspace', workspace)
      .replaceAll('/run/agentor/preserve-storage-ownership', marker);
    const run = (extra: Record<string, string> = {}) => execFileSync('bash', ['-c', script], {
      env: { ...process.env, PATH: commands + ':' + process.env.PATH, MARKER_STAT: '0:0:600:1:38', OWNERSHIP_LOG: log, ...extra },
      stdio: 'pipe',
    });
    await writeFile(marker, 'agentor-preserve-storage-ownership-v1\n');
    run(); await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => run({ MOUNTPOINT_EXIT: '1' })).toThrow();
    for (const MARKER_STAT of ['1000:0:600:1:38', '0:1000:600:1:38', '0:0:644:1:38', '0:0:600:2:38', '0:0:600:1:37'])
      expect(() => run({ MARKER_STAT })).toThrow();
    await writeFile(marker, 'invalid-preservation-configuration\n'); expect(() => run()).toThrow();
    await rm(marker); await symlink(join(workspace, 'data'), marker); expect(() => run()).toThrow();
    await rm(marker); await mkdir(marker); expect(() => run()).toThrow();
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

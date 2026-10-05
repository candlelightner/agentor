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

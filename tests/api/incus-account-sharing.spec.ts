import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile, unlink, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserCredentialManager } from "../../orchestrator/server/utils/user-credentials";
import { StorageManager } from "../../orchestrator/server/utils/storage";
import type { Config } from "../../orchestrator/server/utils/config";
import { IncusWorkerRuntime } from "../../orchestrator/server/utils/incus-worker-runtime";
import { zeroUserEnvVars } from "../../orchestrator/server/utils/user-env-store";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {} });

for (const name of ["claude.json", "codex.json", "gemini.json", "kilo.json"]) {
  test(`directory-shared ${name} cannot redirect account reads or writes`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentor-account-sharing-"));
    try {
      const storage = new StorageManager({} as any, { dataDir: dir } as Config);
      const manager = new UserCredentialManager(storage);
      await manager.ensureUserDir("test-user");
      const unrelated = join(dir, "unrelated-control-plane.json");
      await writeFile(unrelated, '{"preserve":true}');
      const credential = manager.filePath("test-user", name);
      await unlink(credential);
      await symlink(unrelated, credential);
      expect(await manager.getStatusForUser("test-user", name)).toBe(false);
      await expect(manager.readForUser("test-user", name)).rejects.toMatchObject({ code: "ELOOP" });
      await expect(manager.reset("test-user", name)).rejects.toMatchObject({ code: "ELOOP" });
      await expect(manager.writeForUser("test-user", name, "overwrite")).rejects.toMatchObject({ code: "ELOOP" });
      expect(await readFile(unrelated, "utf-8")).toBe('{"preserve":true}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("normal credential sharing preserves canonical files and in-place account resets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-account-sharing-"));
  try {
    const storage = new StorageManager({} as any, { dataDir: dir } as Config);
    const manager = new UserCredentialManager(storage);
    await manager.ensureUserDir("test-user");
    await manager.writeForUser("test-user", "codex.json", '{"fixture":true}');
    expect(await manager.getStatusForUser("test-user", "codex.json")).toBe(true);
    await manager.reset("test-user", "codex.json");
    expect(await manager.readForUser("test-user", "codex.json")).toBe("{}");
    expect(() => manager.filePath("test-user", "../../other-user")).toThrow("Unknown credential");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a directory-shared hardlink cannot redirect credential resets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-account-hardlinks-"));
  try {
    const manager = new UserCredentialManager(new StorageManager({} as any, { dataDir: dir } as Config));
    await manager.ensureUserDir("test-user");
    const credential = manager.filePath("test-user", "codex.json");
    const unrelated = join(dir, "unrelated");
    await writeFile(unrelated, "preserve");
    await unlink(credential);
    await link(unrelated, credential);
    await expect(manager.reset("test-user", "codex.json")).rejects.toThrow("private regular file");
    expect(await readFile(unrelated, "utf-8")).toBe("preserve");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real same-account workers share regular credentials and atomic Kilo saves without sharing history", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(600_000);
  const ssh = ["-p", "22375", "-i", "/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519",
    "-o", "UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts", "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "kata-test@172.19.0.1"];
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const host = (script: string) => execFileSync("ssh", [...ssh, "bash -ec " + quote(script)], { encoding: "utf-8" }).trim();
  const root = host("sudo -u ubuntu mktemp -d /var/tmp/agentor-account-acceptance.XXXXXXXX");
  if (!/^\/var\/tmp\/agentor-account-acceptance\.[A-Za-z0-9]+$/.test(root)) throw new Error("Invalid test fixture path");
  const dirs = [`${root}/credentials`, `${root}/kilo/config`, `${root}/kilo/data`];
  const previous = JSON.parse(host("sudo incus query /1.0/projects/agentor")).config["restricted.devices.disk.paths"] ?? "";
  const local = await mkdtemp(join(tmpdir(), "agentor-live-accounts-"));
  const config = { dataDir: local, incusEnabled: true, incusEndpoint: "https://127.0.0.1:18443", incusProject: "agentor",
    incusClientCertPath: "/workspace/agentor-incus-tls/client.crt", incusClientKeyPath: "/workspace/agentor-incus-tls/client.key",
    incusServerCertPath: "/workspace/agentor-incus-tls/server.crt", incusWorkerImage: process.env.INCUS_TEST_IMAGE || "agentor-worker-phase5",
    incusNetwork: "incusbr0", incusStoragePool: "default", incusInternalGatewayUrl: "http://10.159.68.1:3000", containerPrefix: "agentor-worker" } as Config;
  const storage = new StorageManager({} as any, config);
  storage.dataHostPath = root;
  storage.getUserHostDir = () => root;
  const runtime = new IncusWorkerRuntime(config);
  const exec = runtime.client.exec.bind(runtime.client);
  runtime.client.exec = async (...args: Parameters<typeof exec>) => {
    const result = await exec(...args);
    if (result.returnCode !== 0 && args[1][0] === "bash" && args[1][3] === "agentor-bind") {
      // Dummy credential fixture only: capture mount/inode errors, never data.
      console.log("Dummy-account bind failure:", args[1].slice(-2), result.stderr);
      const metadata = await exec(args[0], ["bash", "-c",
        'for file in "$@"; do stat -c "%F %u:%g:%a %d:%i %h %n" "$file"; findmnt -rn --mountpoint "$file" -o TARGET,SOURCE,FSTYPE; done',
        "agentor-bind-diagnostic", ...args[1].slice(-2)]);
      console.log("Dummy-account bind metadata:", metadata.stdout, metadata.stderr);
    }
    if (result.returnCode !== 0 && args[1][0] === "systemctl") {
      const logs = await exec(args[0], ["journalctl", "-u", "agentor-worker", "--no-pager", "-n", "30"]);
      console.log("Dummy-account guest service failure:", result.stderr, logs.stdout);
      const ownership = await exec(args[0], ["bash", "-c", 'id agent; stat -c "%u:%g %n" /run/agentor/account-credentials /run/agentor/account-credentials/*.json /home/agent/.agent-data/.kilo/config /home/agent/.agent-data/.kilo/shared-data; findmnt -rn -o TARGET,SOURCE,FSTYPE']);
      console.log("Dummy-account guest ownership:", ownership.stdout);
    }
    return result;
  };
  const create = runtime.client.createInstance.bind(runtime.client);
  runtime.client.createInstance = async (...args: Parameters<typeof create>) => {
    const instance = await create(...args);
    // Narrow diagnostic option: validate source changes in an isolated guest
    // before spending another image conversion. Not production acceptance.
    if (process.env.INCUS_ACCOUNT_BOOTSTRAP_DIAGNOSTIC === "true") {
      await runtime.client.startInstance(instance.name);
      await expect.poll(async () => {
        try { return (await exec(instance.name, ["true"])).returnCode; } catch { return -1; }
      }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
      for (const [source, target, mode] of [
        ["../worker/vm/agentor-private-storage.sh", "/usr/lib/agentor/agentor-private-storage.sh", 0o755],
        ["../worker/vm/agentor-worker.service", "/etc/systemd/system/agentor-worker.service", 0o644],
        ["../worker/entrypoint.sh", "/home/agent/entrypoint.sh", 0o755],
      ] as const) await runtime.client.pushFile(instance.name, target, await readFile(source), { uid: 0, gid: 0, mode });
      expect((await exec(instance.name, ["systemctl", "daemon-reload"])).returnCode).toBe(0);
    }
    return instance;
  };
  const workers = [randomUUID(), randomUUID()].map((id) => ({ id, userId: "account-fixture", containerName: `${config.containerPrefix}-${id}`,
    dockerEnabled: false, memoryLimit: "2GiB", userEnv: zeroUserEnvVars("account-fixture"), storageManager: storage,
    environmentJson: { networkMode: "full", allowedDomains: [], dockerEnabled: false, setupScript: "", envVars: "", exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [], workerJson: { id, displayName: "Account fixture", repos: [], initScript: "", gitName: "", gitEmail: "" } }));
  const checked = async (index: number, script: string) => {
    const result = await runtime.client.exec(workers[index]!.containerName, ["sudo", "-u", "agent", "bash", "-ec", script]);
    expect(result.returnCode, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    host(`sudo -u ubuntu mkdir -p ${dirs.map(quote).join(" ")}; sudo -u ubuntu chmod 700 ${dirs.map(quote).join(" ")}; sudo -u ubuntu bash -ec ${quote(`for file in claude codex gemini; do printf '{}' > ${root}/credentials/$file.json; chmod 600 ${root}/credentials/$file.json; done; printf '{}' > ${root}/kilo/data/auth.json`)}; sudo incus project set agentor restricted.devices.disk.paths ${quote([previous, ...dirs].filter(Boolean).join(","))}`);
    for (const worker of workers) await runtime.create(worker);
    for (let index = 0; index < workers.length; index++) {
      expect(await checked(index, 'stat -c "%u:%g:%a" /run/agentor/account-credentials/codex.json')).toBe("1000:1000:600\n");
      expect((await runtime.client.getInstance(workers[index]!.containerName)).config["raw.idmap"]).toBeUndefined();
    }
    expect(host(`sudo stat -c '%u:%g:%a' ${quote(`${root}/credentials/codex.json`)}`)).toBe("1000:1000:600");
    await checked(0, 'printf "credential-fixture" > /home/agent/.codex/auth.json; echo private-history > /home/agent/.codex/history-fixture');
    expect(await checked(1, 'cat /home/agent/.codex/auth.json; test ! -e /home/agent/.codex/history-fixture')).toBe("credential-fixture");
    expect(host(`sudo -u ubuntu test "$(sudo -u ubuntu head -c 50 ${root}/credentials/codex.json)" = credential-fixture; echo canonical-ok`)).toBe("canonical-ok");
    // Linux file mountpoint rejects atomic replacement, matching old Docker
    // semantics; CLIs fall back to in-place writes. Do not replace with links.
    await checked(0, 'test ! -L /home/agent/.claude/.credentials.json; mountpoint -q /home/agent/.claude/.credentials.json; printf atomic > /home/agent/.claude/credential-temp; ! mv /home/agent/.claude/credential-temp /home/agent/.claude/.credentials.json; printf claude-fixture > /home/agent/.claude/.credentials.json');
    expect(await checked(1, 'cat /home/agent/.claude/.credentials.json')).toBe("claude-fixture");
    await checked(0, 'printf kilo-fixture > /home/agent/.local/share/kilo/auth.tmp; mv /home/agent/.local/share/kilo/auth.tmp /home/agent/.local/share/kilo/auth.json');
    expect(await checked(1, 'cat /home/agent/.local/share/kilo/auth.json')).toBe("kilo-fixture");
    host(`sudo -u ubuntu bash -ec ${quote(`printf '{}' > ${root}/credentials/codex.json`)}`);
    expect(await checked(0, 'cat /home/agent/.codex/auth.json')).toBe("{}");
    expect(await checked(1, 'cat /home/agent/.codex/auth.json')).toBe("{}");
    // A direct canonical-directory replacement is not a normal CLI save, but
    // provisioning must recover its pinned bind inode without merging tokens.
    await checked(0, 'printf replaced-canonical > /run/agentor/account-credentials/new-codex; mv /run/agentor/account-credentials/new-codex /run/agentor/account-credentials/codex.json');
    for (let index = 0; index < workers.length; index++) {
      await runtime.start(workers[index]!);
      expect(await checked(index, 'cat /home/agent/.codex/auth.json')).toBe("replaced-canonical");
    }
  } finally {
    for (const worker of workers) { await runtime.remove(worker.containerName); await runtime.removeStorage(worker); }
    // Keep a nonempty deny-by-default host path policy even if the test started
    // with the old permissive empty policy. Do not widen it on cleanup.
    host(`sudo incus project set agentor restricted.devices.disk.paths ${quote(previous || dirs.join(","))}; sudo rm -r -- ${quote(root)}`);
    await rm(local, { recursive: true, force: true });
  }
});

import { expect, test } from "@playwright/test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackupProvider, LocalBackupProvider } from "../../orchestrator/server/utils/backup-provider";

test("local and fake backup providers reject owner and artifact path escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-provider-path-"));
  const source = join(root, "source");
  await writeFile(source, "backup");

  for (const provider of [new LocalBackupProvider(join(root, "local")), new FakeBackupProvider(join(root, "fake"))]) {
    await expect(provider.upload("../escaped", "safe-id", source, () => {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(provider.upload("safe-owner", "../escaped", source, () => {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(provider.upload("safe-owner", "%2e%2e%2fescaped", source, () => {})).rejects.toMatchObject({ statusCode: 400 });
  }

  for (const escaped of [
    join(root, "escaped", "safe-id.backup"),
    join(root, "local", "escaped.backup"),
    join(root, "fake", "escaped.backup"),
  ]) {
    await expect(access(escaped)).rejects.toMatchObject({ code: "ENOENT" });
  }
  await rm(root, { recursive: true, force: true });
});

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { instanceControlPlaneCoordinator } from "./instance-snapshot-gate";
import { attachSettlement, combineSettlements } from "./operation-deadline";

const filesystem = { chmod, lstat, mkdir, readFile, writeFile };

/** Stable, non-secret source identity included in backup discovery metadata.
 * It identifies an Agentor installation without exposing its hostname, data
 * path, auth secret, or provider account. */
export async function backupInstallationId(dataDir: string, io = filesystem): Promise<string> {
  return instanceControlPlaneCoordinator.run(async () => {
  const path = join(dataDir, "backup-installation-id");
  let value = "";
  try {
    value = (await io.readFile(path, "utf8")).trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      throw attachSettlement(new Error("Backup installation identity is unavailable"), combineSettlements(error));
    await combineSettlements(error);
  }
  if (!value) {
    await io.mkdir(dataDir, { recursive: true, mode: 0o700 });
    value = randomUUID();
    await io.writeFile(path, value, { mode: 0o600, flag: "wx" }).catch(
      async (error) => {
        // A swallowed failure is still live until its exposed write settles.
        await combineSettlements(error);
        value = (await io.readFile(path, "utf8")).trim();
      },
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Backup installation identity is unavailable");
  const info = await io.lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Backup installation identity is unavailable");
  await io.chmod(path, 0o600);
  return value;
  });
}

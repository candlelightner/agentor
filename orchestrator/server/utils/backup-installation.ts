import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Stable, non-secret source identity included in backup discovery metadata.
 * It identifies an Agentor installation without exposing its hostname, data
 * path, auth secret, or provider account. */
export async function backupInstallationId(dataDir: string): Promise<string> {
  const path = join(dataDir, "backup-installation-id");
  let value = "";
  try {
    value = (await readFile(path, "utf8")).trim();
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      throw new Error("Backup installation identity is unavailable");
  }
  if (!value) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    value = randomUUID();
    await writeFile(path, value, { mode: 0o600, flag: "wx" }).catch(
      async () => {
        value = (await readFile(path, "utf8")).trim();
      },
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Backup installation identity is unavailable");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Backup installation identity is unavailable");
  await chmod(path, 0o600);
  return value;
}

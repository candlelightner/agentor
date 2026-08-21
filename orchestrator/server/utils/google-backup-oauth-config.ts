import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { useConfig } from "./services";
import {
  decryptWorkerValue,
  encryptWorkerValue,
  type EncryptedWorkerValue,
} from "./worker-config-crypto";

interface StoredGoogleBackupOAuthConfig {
  schemaVersion: 1;
  clientId: string;
  redirectUri: string;
  clientSecret: EncryptedWorkerValue;
  updatedAt: string;
}

export interface GoogleBackupOAuthStatus {
  configured: boolean;
  source: "installation" | "environment" | "none";
  clientId?: string;
  redirectUri?: string;
  clientSecretConfigured: boolean;
  updatedAt?: string;
}

export interface GoogleBackupOAuthCredentials {
  clientId: string;
  redirectUri: string;
  clientSecret: string;
}

/** Installation-wide Google OAuth client material. The client secret is never
 * serialized to callers; existing environment variables remain a fallback for
 * deployments already configured outside the dashboard. */
export class GoogleBackupOAuthConfigStore {
  private loaded?: Promise<void>;
  private value?: StoredGoogleBackupOAuthConfig;
  private writes = Promise.resolve();

  constructor(
    private readonly dataDir = useConfig().dataDir,
    private readonly stateWriter?: (
      value: StoredGoogleBackupOAuthConfig,
    ) => Promise<void>,
  ) {}

  private get path() {
    return join(this.dataDir, "backup-google-oauth.v1.json");
  }

  private async init() {
    if (!this.loaded)
      this.loaded = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.path, "utf8"));
          if (
            parsed?.schemaVersion === 1 &&
            typeof parsed.clientId === "string" &&
            typeof parsed.redirectUri === "string" &&
            parsed.clientSecret?.version === 1
          )
            this.value = parsed;
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      })();
    await this.loaded;
  }

  async status(): Promise<GoogleBackupOAuthStatus> {
    await this.init();
    if (this.value)
      return {
        configured: true,
        source: "installation",
        clientId: this.value.clientId,
        redirectUri: this.value.redirectUri,
        clientSecretConfigured: true,
        updatedAt: this.value.updatedAt,
      };
    const clientId = process.env.GOOGLE_BACKUP_CLIENT_ID || "";
    const redirectUri = process.env.GOOGLE_BACKUP_REDIRECT_URI || "";
    const clientSecret = process.env.GOOGLE_BACKUP_CLIENT_SECRET || "";
    return {
      configured: Boolean(clientId && redirectUri && clientSecret),
      source: clientId || redirectUri || clientSecret ? "environment" : "none",
      clientId: clientId || undefined,
      redirectUri: redirectUri || undefined,
      clientSecretConfigured: Boolean(clientSecret),
    };
  }

  async credentials(): Promise<GoogleBackupOAuthCredentials | undefined> {
    await this.init();
    if (this.value)
      return {
        clientId: this.value.clientId,
        redirectUri: this.value.redirectUri,
        clientSecret: await decryptWorkerValue(
          useConfig(),
          this.value.clientSecret,
          "backup-google-installation-oauth-v1",
        ),
      };
    const clientId = process.env.GOOGLE_BACKUP_CLIENT_ID || "";
    const redirectUri = process.env.GOOGLE_BACKUP_REDIRECT_URI || "";
    const clientSecret = process.env.GOOGLE_BACKUP_CLIENT_SECRET || "";
    return clientId && redirectUri && clientSecret
      ? { clientId, redirectUri, clientSecret }
      : undefined;
  }

  async configure(input: {
    clientId: string;
    redirectUri: string;
    clientSecret: string;
  }): Promise<GoogleBackupOAuthStatus> {
    const clientId = input.clientId.trim();
    const redirectUri = input.redirectUri.trim();
    if (!clientId || !clientSecretValue(input.clientSecret) || !validRedirectUri(redirectUri))
      throw new Error("A client ID, HTTPS redirect URI, and client secret are required");
    await this.init();
    const nextValue: StoredGoogleBackupOAuthConfig = {
      schemaVersion: 1,
      clientId,
      redirectUri,
      clientSecret: await encryptWorkerValue(
        useConfig(),
        input.clientSecret,
        "backup-google-installation-oauth-v1",
      ),
      updatedAt: new Date().toISOString(),
    };
    await this.persist(nextValue);
    return this.status();
  }

  private async persist(value: StoredGoogleBackupOAuthConfig) {
    const next = this.writes.then(async () => {
      if (this.stateWriter) {
        await this.stateWriter(structuredClone(value));
        this.value = value;
        return;
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
      this.value = value;
    });
    this.writes = next.then(() => undefined, () => undefined);
    await next;
  }
}

function clientSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}
function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

let singleton: GoogleBackupOAuthConfigStore | undefined;
export function useGoogleBackupOAuthConfigStore() {
  return (singleton ??= new GoogleBackupOAuthConfigStore());
}

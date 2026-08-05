import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitImageCiphertext } from "./git-image-crypto";

export type GitAuth =
  | { type: "none" }
  | { type: "pat"; token: GitImageCiphertext }
  | { type: "github-app"; appId: string; installationId: string };
export interface GitImageConnection {
  id: string;
  ownerId: string;
  provider: "fake" | "github";
  repository: string;
  visibility: "public" | "private";
  defaultBranch: string;
  workflow: "direct" | "branch" | "pull-request";
  buildMode: "local" | "github-actions";
  actionsWorkflow?: string;
  publishGhcr: boolean;
  auth: GitAuth;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastRemoteRevision?: string | null;
  lastError?: string;
}
export interface GitImageLink {
  remoteId: string;
  localId: string;
  baseHash: string;
  remoteRevision: string | null;
  recoveredVersions?: Array<{
    version: string;
    digest: string;
    ghcrReference?: string;
  }>;
}
export interface GitImageRecovery {
  state:
    "not-run" | "available" | "recovered" | "partial" | "conflict" | "failed";
  checkedAt?: string;
  catalogEntries: number;
  importedDefinitions: number;
  imageDigests: number;
  pullableImages: number;
  note: string;
}
export interface GitImageState {
  version: 1;
  connections: GitImageConnection[];
  links: Record<string, GitImageLink[]>;
  recovery: Record<string, GitImageRecovery>;
}

export class GitImageStore {
  state: GitImageState = {
    version: 1,
    connections: [],
    links: {},
    recovery: {},
  };
  private initialized?: Promise<void>;
  private saves = Promise.resolve();
  constructor(
    private dataDir = join(
      process.env.DATA_DIR || "/data",
      "git-image-catalog",
    ),
  ) {}
  init() {
    return (this.initialized ??= this.load());
  }
  private path() {
    return join(this.dataDir, "state.json");
  }
  private async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.connections))
        this.state = parsed;
    } catch {}
    await this.persist();
  }
  persist() {
    this.saves = this.saves.then(async () => {
      const temp = `${this.path()}.tmp.${process.pid}`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), {
        mode: 0o600,
      });
      await rename(temp, this.path());
    });
    return this.saves;
  }
}

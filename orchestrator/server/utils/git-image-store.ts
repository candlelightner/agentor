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
    private readonly stateWriter?: (state: GitImageState) => Promise<void>,
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
      if (
        parsed?.version !== 1 ||
        !Array.isArray(parsed.connections) ||
        !parsed.links ||
        typeof parsed.links !== "object" ||
        !parsed.recovery ||
        typeof parsed.recovery !== "object"
      )
        throw new Error("Invalid Git image catalog state");
      this.state = parsed;
    } catch (error: any) {
      // Only first boot may initialize an empty state. Never turn corruption
      // or a transient read failure into a successful empty write.
      if (error?.code !== "ENOENT") throw error;
    }
    await this.persist();
  }
  private async writeState() {
    if (this.stateWriter) {
      await this.stateWriter(structuredClone(this.state));
      return;
    }
    const temp = `${this.path()}.tmp.${process.pid}`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await rename(temp, this.path());
  }
  persist() {
    const next = this.saves.then(() => this.writeState());
    this.saves = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Read a stable snapshot after every previously admitted transaction has
   * settled, without holding the persistence queue across external I/O. */
  read<T>(operation: () => T): Promise<T> {
    return this.saves.then(operation);
  }

  /** Serialize the in-memory mutation together with its durable commit. The
   * snapshot is restored on failure before a later mutation is allowed to run. */
  transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.saves.then(async () => {
      const previous = structuredClone(this.state);
      try {
        const value = await operation();
        await this.writeState();
        return value;
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.saves = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

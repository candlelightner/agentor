import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GitFileMap } from "./git-image-format";

export type GitHubHttpTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_GITHUB_TIMEOUT_MS = 20_000;
const MIN_GITHUB_TIMEOUT_MS = 1_000;
const MAX_GITHUB_TIMEOUT_MS = 120_000;

function githubTimeoutMs() {
  const configured = Number(process.env.GIT_IMAGE_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_GITHUB_TIMEOUT_MS;
  return Math.min(
    MAX_GITHUB_TIMEOUT_MS,
    Math.max(MIN_GITHUB_TIMEOUT_MS, configured),
  );
}

function withGitHubDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(value as T);
    };
    const timeout = setTimeout(() => {
      const error = Object.assign(
        new Error("GitHub catalog request timed out"),
        { statusCode: 504 },
      );
      controller.abort(error);
      finish(error);
    }, githubTimeoutMs());
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}

export interface GitSnapshot {
  revision: string | null;
  files: GitFileMap;
}
export interface GitWrite {
  branch: string;
  expectedRevision: string | null;
  files: GitFileMap;
  message: string;
  workflow: "direct" | "branch" | "pull-request";
  targetBranch: string;
}
export interface GitWriteResult {
  revision: string;
  branch: string;
  pullRequest?: GitPullRequest;
}
export interface GitPullRequest {
  number: number;
  url: string;
  state: "open";
}
export interface GitPullRequestResult {
  pullRequest: GitPullRequest;
  created: boolean;
}
export interface GitImageProvider {
  read(repository: string, branch: string): Promise<GitSnapshot>;
  write(repository: string, input: GitWrite): Promise<GitWriteResult>;
  ensurePullRequest?(
    repository: string,
    input: { branch: string; targetBranch: string; title: string },
  ): Promise<GitPullRequestResult>;
  revoke?(): Promise<void>;
  dispatchWorkflow?(
    repository: string,
    workflow: string,
    ref: string,
  ): Promise<void>;
}

export interface FakeRepository {
  private: boolean;
  branches: Record<string, { revision: string; files: GitFileMap }>;
  pullRequests: Array<{
    number: number;
    url: string;
    state: "open";
    head: string;
    base: string;
  }>;
  workflowDispatches: Array<{ workflow: string; ref: string }>;
}
const fakeRepositories = new Map<string, FakeRepository>();
export function configureFakeGitRepository(
  repository: string,
  input?: Partial<FakeRepository>,
) {
  const value: FakeRepository = {
    private: input?.private ?? true,
    branches: structuredClone(input?.branches || {}),
    pullRequests: structuredClone(input?.pullRequests || []),
    workflowDispatches: structuredClone(input?.workflowDispatches || []),
  };
  fakeRepositories.set(repository, value);
  return value;
}
export function inspectFakeGitRepository(repository: string) {
  return fakeRepositories.get(repository);
}
export class FakeGitHubProvider implements GitImageProvider {
  constructor(private canAccessPrivate: boolean) {}
  private repo(name: string) {
    const repo = fakeRepositories.get(name) ?? configureFakeGitRepository(name);
    if (repo.private && !this.canAccessPrivate)
      throw Object.assign(
        new Error(
          "Repository credential cannot access the selected private repository",
        ),
        { statusCode: 403 },
      );
    return repo;
  }
  async read(repository: string, branch: string) {
    const value = this.repo(repository).branches[branch];
    return value ? structuredClone(value) : { revision: null, files: {} };
  }
  async write(repository: string, input: GitWrite) {
    const repo = this.repo(repository),
      current =
        repo.branches[input.branch] ??
        (input.branch !== input.targetBranch
          ? repo.branches[input.targetBranch]
          : undefined);
    if ((current?.revision ?? null) !== input.expectedRevision)
      throw Object.assign(
        new Error("Remote catalog changed; sync again before writing"),
        { statusCode: 409 },
      );
    const revision = `fake-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    repo.branches[input.branch] = {
      revision,
      files: structuredClone(input.files),
    };
    let pullRequest;
    if (input.workflow === "pull-request") {
      ({ pullRequest } = await this.ensurePullRequest(repository, {
        branch: input.branch,
        targetBranch: input.targetBranch,
        title: input.message,
      }));
    }
    return { revision, branch: input.branch, pullRequest };
  }
  async ensurePullRequest(
    repository: string,
    input: { branch: string; targetBranch: string; title: string },
  ): Promise<GitPullRequestResult> {
    const repo = this.repo(repository),
      existing = repo.pullRequests.find(
        (candidate) =>
          candidate.state === "open" &&
          candidate.head === input.branch &&
          candidate.base === input.targetBranch,
      );
    if (existing)
      return {
        pullRequest: {
          number: existing.number,
          url: existing.url,
          state: "open",
        },
        created: false,
      };
    const number = repo.pullRequests.length + 1,
      pullRequest: GitPullRequest = {
        number,
        url: `https://github.test/${repository}/pull/${number}`,
        state: "open",
      };
    repo.pullRequests.push({
      ...pullRequest,
      head: input.branch,
      base: input.targetBranch,
    });
    return { pullRequest, created: true };
  }
  async revoke() {}
  async dispatchWorkflow(repository: string, workflow: string, ref: string) {
    this.repo(repository).workflowDispatches.push({ workflow, ref });
  }
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}
export async function mintGitHubAppInstallationToken(
  appId: string,
  installationId: string,
  privateKeyPath: string,
  transport: GitHubHttpTransport = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000),
    header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    payload = base64url(
      JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }),
    );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${signer.sign(await readFile(privateKeyPath, "utf8")).toString("base64url")}`;
  return withGitHubDeadline(async (signal) => {
    const response = await transport(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error("GitHub App installation token exchange failed");
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new Error("GitHub App token response was invalid");
    return body.token;
  });
}

export class GitHubRestProvider implements GitImageProvider {
  constructor(
    private token: () => Promise<string | undefined>,
    private transport: GitHubHttpTransport = fetch,
  ) {}
  private async api(path: string, init: RequestInit = {}) {
    const token = await withGitHubDeadline(() => this.token());
    if ((init.method || "GET").toUpperCase() !== "GET" && !token)
      throw Object.assign(
        new Error("This repository operation requires authentication"),
        { statusCode: 401 },
      );
    return withGitHubDeadline(async (signal) => {
      const response = await this.transport(`https://api.github.com${path}`, {
        ...init,
        signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.headers || {}),
        },
      });
      if (!response.ok)
        throw Object.assign(
          new Error(
            response.status === 409
              ? "Remote catalog changed; sync again before writing"
              : "GitHub catalog request failed",
          ),
          {
            statusCode:
              response.status === 404
                ? 404
                : response.status === 409
                  ? 409
                  : 502,
          },
        );
      return response.status === 204 ? null : response.json();
    });
  }
  async read(repository: string, branch: string): Promise<GitSnapshot> {
    let ref: any;
    try {
      ref = await this.api(
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
    } catch (e: any) {
      if (e.statusCode === 404) return { revision: null, files: {} };
      throw e;
    }
    const commitSha = ref.object.sha,
      tree: any = await this.api(
        `/repos/${repository}/git/trees/${commitSha}?recursive=1`,
      ),
      files: GitFileMap = {};
    let total = 0;
    for (const item of tree.tree || []) {
      if (
        item.type !== "blob" ||
        (!item.path.startsWith("images/") &&
          item.path !== ".agentor/image-catalog.v1.json")
      )
        continue;
      if (
        !Number.isSafeInteger(item.size) ||
        item.size > 100 * 1024 * 1024 ||
        (total += item.size) > 250 * 1024 * 1024
      )
        throw new Error("Remote image catalog exceeds import limits");
      const blob: any = await this.api(
        `/repos/${repository}/git/blobs/${item.sha}`,
      );
      files[item.path] = item.path.includes("/context/")
        ? String(blob.content || "").replace(/\n/g, "")
        : Buffer.from(
            String(blob.content || "").replace(/\n/g, ""),
            "base64",
          ).toString("utf8");
    }
    return { revision: commitSha, files };
  }
  async write(repository: string, input: GitWrite): Promise<GitWriteResult> {
    const blobs: Record<string, string> = {};
    for (const [path, content] of Object.entries(input.files)) {
      const body: any = await this.api(`/repos/${repository}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content,
          encoding: path.includes("/context/") ? "base64" : "utf-8",
        }),
      });
      blobs[path] = body.sha;
    }
    const tree: any = await this.api(`/repos/${repository}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: input.expectedRevision || undefined,
        tree: Object.entries(blobs).map(([path, sha]) => ({
          path,
          mode: "100644",
          type: "blob",
          sha,
        })),
      }),
    });
    const commit: any = await this.api(`/repos/${repository}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents: input.expectedRevision ? [input.expectedRevision] : [],
      }),
    });
    if (input.branch === input.targetBranch && input.expectedRevision)
      await this.api(
        `/repos/${repository}/git/refs/heads/${encodeURIComponent(input.branch)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: false }),
        },
      );
    else
      await this.api(`/repos/${repository}/git/refs`, {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${input.branch}`,
          sha: commit.sha,
        }),
      });
    let pullRequest;
    if (input.workflow === "pull-request") {
      ({ pullRequest } = await this.ensurePullRequest(repository, {
        branch: input.branch,
        targetBranch: input.targetBranch,
        title: input.message,
      }));
    }
    return { revision: commit.sha, branch: input.branch, pullRequest };
  }
  async ensurePullRequest(
    repository: string,
    input: { branch: string; targetBranch: string; title: string },
  ): Promise<GitPullRequestResult> {
    const existing = await this.findOpenPullRequest(repository, input);
    if (existing) return { pullRequest: existing, created: false };
    let pr: any;
    try {
      pr = await this.api(`/repos/${repository}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          head: input.branch,
          base: input.targetBranch,
          body: "Agentor image catalog synchronization",
        }),
      });
    } catch (error) {
      // A transport can lose the successful POST response. Re-read the
      // content-addressed head before surfacing the error so a retry never
      // creates a second PR merely because acknowledgement was ambiguous.
      try {
        const reconciled = await this.findOpenPullRequest(repository, input);
        if (reconciled) return { pullRequest: reconciled, created: false };
      } catch {}
      throw error;
    }
    return {
      pullRequest: {
        number: pr.number,
        url: pr.html_url,
        state: "open",
      },
      created: true,
    };
  }
  private async findOpenPullRequest(
    repository: string,
    input: { branch: string; targetBranch: string },
  ): Promise<GitPullRequest | undefined> {
    const owner = repository.split("/", 1)[0]!,
      pulls: any = await this.api(
        `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.targetBranch)}`,
      ),
      existing = Array.isArray(pulls) ? pulls[0] : undefined;
    return existing
      ? {
          number: existing.number,
          url: existing.html_url,
          state: "open",
        }
      : undefined;
  }
  async revoke() {
    await this.api("/installation/token", { method: "DELETE" });
  }
  async dispatchWorkflow(repository: string, workflow: string, ref: string) {
    await this.api(
      `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref }),
      },
    );
  }
}

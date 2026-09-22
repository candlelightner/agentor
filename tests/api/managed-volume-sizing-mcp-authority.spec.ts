import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  managementVolumeSizeAuthorizer,
  type ManagementVolumePrincipal,
} from "../../orchestrator/server/utils/management-volume-domain";
import {
  createLiveManagementVolumeAuthority,
  ManagementMcpStore,
} from "../../orchestrator/server/utils/management-mcp-store";
import type { ManagedVolumeSizingResource } from "../../orchestrator/server/utils/managed-volume-inventory";

const initialPrincipal = {
  scope: "group" as const,
  workspaceId: "group-admin-workspace-1",
  ownerId: "owner-1",
  groupId: "group-1",
};

const resource: ManagedVolumeSizingResource = {
  id: "volume-1",
  dockerName: "server-private-volume-name",
  userId: "owner-1",
  workerId: "worker-1",
  purpose: "persistent-path",
  ownerKey: "owner-1",
  classification: "managed",
  incarnation: "a".repeat(64),
  live: false,
};

function harness() {
  let principal: ManagementVolumePrincipal & { workspaceId: string } = {
    ...initialPrincipal,
  };
  let identityFailure: Error | undefined;
  let policyEnabled = true;
  let workerIds = new Set(["worker-1"]);
  let identityChecks = 0;
  let scopeChecks = 0;
  const authority = createLiveManagementVolumeAuthority(
    initialPrincipal,
    async () => {
      identityChecks += 1;
      if (identityFailure) throw identityFailure;
      return principal;
    },
    () => policyEnabled,
  );
  const authorize = managementVolumeSizeAuthorizer("volume-1", authority, {
    workerIds: () => {
      scopeChecks += 1;
      return new Set(workerIds);
    },
    resolve: async (volumeId, scope) =>
      volumeId === resource.id &&
      scope.userId === resource.userId &&
      scope.workerIds?.has(resource.workerId!)
        ? resource
        : undefined,
  });
  return {
    authorize,
    checks: () => ({ identityChecks, scopeChecks }),
    revokeIdentity(statusCode = 401) {
      identityFailure = Object.assign(new Error("identity no longer authorized"), {
        statusCode,
      });
    },
    replaceWorkspace() {
      principal = { ...initialPrincipal, workspaceId: "replacement-workspace" };
    },
    disablePolicy() {
      policyEnabled = false;
    },
    removeDescendant() {
      workerIds = new Set();
    },
  };
}

async function platformHarness() {
  const store = new ManagementMcpStore("/unused", async () => undefined);
  const raw = randomBytes(32).toString("base64url");
  const credential = `mcp1.${raw}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const identities = (store as any).identities as Map<string, {
    hash: string;
    workspaceId: string;
    expiresAt: number;
  }>;
  identities.set(hash, {
    hash,
    workspaceId: "platform-admin-workspace-1",
    expiresAt: Date.now() + 60_000,
  });
  const expected = await store.introspect(credential);
  let boundWorkspaceId: string | undefined = expected.workspaceId;
  const authority = createLiveManagementVolumeAuthority(
    expected,
    () => store.introspect(credential),
    () => true,
    (current) => current.workspaceId === boundWorkspaceId,
  );
  const authorize = managementVolumeSizeAuthorizer("volume-1", authority, {
    resolve: async (volumeId, scope) =>
      volumeId === resource.id && scope.platform ? resource : undefined,
  });
  return {
    authorize,
    expire() {
      const identity = identities.get(hash);
      if (identity) identity.expiresAt = Date.now() - 1;
    },
    revoke() {
      identities.delete(hash);
    },
    deleteWorkspace() {
      boundWorkspaceId = undefined;
    },
    replaceWorkspace() {
      boundWorkspaceId = "replacement-platform-workspace";
    },
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function raceHarness() {
  let policyEnabled = true;
  let descendants = new Set(["worker-1"]);
  let resolverCalls = 0;
  const started = deferred();
  const released = deferred();
  const authority = createLiveManagementVolumeAuthority(
    initialPrincipal,
    async () => ({ ...initialPrincipal }),
    () => policyEnabled,
  );
  const authorize = managementVolumeSizeAuthorizer("volume-1", authority, {
    workerIds: () => new Set(descendants),
    resolve: async (volumeId, scope) => {
      resolverCalls += 1;
      const captured = {
        volumeId,
        userId: scope.userId,
        workerAllowed: scope.workerIds?.has(resource.workerId!),
      };
      started.release();
      await released.promise;
      return captured.volumeId === resource.id &&
        captured.userId === resource.userId &&
        captured.workerAllowed
        ? resource
        : undefined;
    },
  });
  return {
    authorize,
    started: started.promise,
    release: released.release,
    resolverCalls: () => resolverCalls,
    disablePolicy() {
      policyEnabled = false;
    },
    removeDescendant() {
      descendants = new Set();
    },
  };
}

test("unchanged group authority is rechecked before and after discovery at every sizing stage", async () => {
  const state = harness();
  await expect(state.authorize()).resolves.toMatchObject({ id: "volume-1" });
  await expect(state.authorize()).resolves.toMatchObject({ id: "volume-1" });
  await expect(state.authorize()).resolves.toMatchObject({ id: "volume-1" });
  expect(state.checks()).toEqual({ identityChecks: 6, scopeChecks: 6 });
});

test("real MCP introspection denies expired or revoked credentials after admission", async () => {
  for (const revoke of ["expire", "revoke"] as const) {
    const state = await platformHarness();
    await state.authorize();
    state[revoke]();
    await expect(state.authorize()).rejects.toMatchObject({
      statusCode: 401,
      message: "Invalid or expired workload identity",
    });
  }
});

test("missing or replaced platform workspace binding cannot publish a sizing result", async () => {
  for (const changeBinding of ["deleteWorkspace", "replaceWorkspace"] as const) {
    const state = await platformHarness();
    await state.authorize();
    state[changeBinding]();
    await expect(state.authorize()).rejects.toMatchObject({
      statusCode: 403,
      message: "Administrative workspace is no longer authorized",
    });
  }
});

test("deleted or replaced group workspace binding cannot publish a sizing result", async () => {
  const deleted = harness();
  await deleted.authorize();
  deleted.revokeIdentity(403);
  await expect(deleted.authorize()).rejects.toMatchObject({ statusCode: 403 });

  const replaced = harness();
  await replaced.authorize();
  await replaced.authorize();
  replaced.replaceWorkspace();
  await expect(replaced.authorize()).rejects.toMatchObject({
    statusCode: 403,
    message: "Workload identity binding changed",
  });
});

test("disabled storage policy or removed descendant scope denies later sizing stages", async () => {
  const policy = harness();
  await policy.authorize();
  policy.disablePolicy();
  await expect(policy.authorize()).rejects.toMatchObject({
    statusCode: 403,
    message: "Tool denied by policy",
  });

  const scope = harness();
  await scope.authorize();
  scope.removeDescendant();
  await expect(scope.authorize()).rejects.toMatchObject({
    statusCode: 404,
    message: "Storage resource not found.",
  });
});

test("policy revocation during discovery is denied without resolving the volume twice", async () => {
  const state = raceHarness();
  const result = state.authorize();
  await state.started;
  state.disablePolicy();
  state.release();
  await expect(result).rejects.toMatchObject({
    statusCode: 403,
    message: "Tool denied by policy",
  });
  expect(state.resolverCalls()).toBe(1);
});

test("descendant removal during discovery is denied without resolving the volume twice", async () => {
  const state = raceHarness();
  const result = state.authorize();
  await state.started;
  state.removeDescendant();
  state.release();
  await expect(result).rejects.toMatchObject({
    statusCode: 404,
    message: "Storage resource not found.",
  });
  expect(state.resolverCalls()).toBe(1);
});

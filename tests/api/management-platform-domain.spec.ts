import { expect, test } from "@playwright/test";
import { ManagementPlatformDomain } from "../../orchestrator/server/utils/management-platform-domain";
import { withWorkerNetworkMutation } from "../../orchestrator/server/utils/worker-group-manager";
import { withGroupImageMutationBoundary } from "../../orchestrator/server/utils/management-mcp-store";

test("managed-network tools publish only fields consumed by each operation", () => {
  const tools = new Map(new ManagementPlatformDomain().tools().map((tool) => [tool.name, tool.inputSchema as any]));
  const fields = (name: string) => Object.keys(tools.get(name)?.properties || {}).sort();

  expect(fields("networks.list")).toEqual(["ownerId"]);
  expect(fields("networks.inspect")).toEqual(["networkId"]);
  expect(fields("networks.create")).toEqual(["groupId", "lockPasswords", "name", "ownerId", "scope", "workerIds"]);
  expect(fields("networks.update")).toEqual(["groupId", "lockPasswords", "name", "networkId", "scope", "workerIds"]);
  expect(fields("networks.reconcile")).toEqual(["lockPasswords", "networkId"]);
  expect(fields("networks.delete")).toEqual(["lockPasswords", "networkId"]);
  expect(fields("storage.status")).toEqual([]);
  expect(fields("storage.cleanup")).toEqual(["action"]);
  expect(tools.get("networks.create")).toMatchObject({ required: ["ownerId", "name", "scope"], additionalProperties: false });
  expect(tools.get("networks.update")).toMatchObject({ required: ["networkId"], additionalProperties: false });
});

test("queued group-network creation rechecks live scope before mutation", async () => {
  const ownerId = `network-scope-race-${Date.now()}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const preceding = withWorkerNetworkMutation(ownerId, () => held);
  let authorized = true;
  const mutation = new ManagementPlatformDomain().execute("networks.create", {
    ownerId,
    name: "must-not-be-created",
    scope: "group",
    groupId: "revoked-group",
    __scopeAuthorize: () => {
      if (!authorized)
        throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
    },
  });

  authorized = false;
  release();
  await preceding;
  await expect(mutation).rejects.toMatchObject({ statusCode: 404 });
});

test("group-image mutation boundary observes queued hierarchy revocation", async () => {
  const ownerId = `image-scope-race-${Date.now()}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const preceding = withWorkerNetworkMutation(ownerId, () => held);
  let authorized = true;
  const mutation = withGroupImageMutationBoundary(ownerId, async () => {
    if (!authorized)
      throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
    return "must-not-run";
  });

  authorized = false;
  release();
  await preceding;
  await expect(mutation).rejects.toMatchObject({ statusCode: 404 });
});

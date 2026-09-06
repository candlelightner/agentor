defineRouteMeta({
  openAPI: {
    tags: ["Containers"],
    summary: "Recover an unresponsive worker runtime",
    description:
      "Performs bounded, worker-scoped recovery. Agentor verifies persistent mounts, replaces only the disposable container, re-runs managed secret bootstrap, and reconciles plugins. No workspace or volume is deleted.",
    operationId: "recoverContainer",
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      200: {
        description: "Recovered worker",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ContainerInfo" },
          },
        },
      },
      409: { description: "Persistent mounts could not be verified" },
      503: { description: "Docker daemon state still blocks scoped recovery" },
    },
  },
});

import { useContainerManager } from "../../../utils/services";
import { requireContainerAccess } from "../../../utils/auth-helpers";
import { rethrowAsHttpError } from "../../../utils/http-errors";
import { useWorkerProtectionLockStore } from "../../../utils/worker-protection-lock";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")!;
  try {
    const manager = useContainerManager();
    requireContainerAccess(event, manager.get(id));
    const body: { lockPassword?: unknown } = await readBody(event).catch(
      () => ({}),
    );
    await useWorkerProtectionLockStore().verify(id, body.lockPassword);
    return await manager.recover(id);
  } catch (error) {
    rethrowAsHttpError(error, "Worker recovery failed");
  }
});

defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "List selectable backup paths", description: "Lists a readable directory inside a running worker for the backup selector. Path is absolute, defaults to /workspace, and may navigate upward to /. Metadata only is returned; selecting a sensitive path is explicit and is not blocked.", operationId: "listBackupPaths", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "path", in: "query", schema: { type: "string", default: "/workspace" }, description: "Absolute directory path inside the worker." }], responses: { 200: { description: "Directory entries" }, 400: { description: "Invalid path" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Worker or path not found" }, 409: { description: "Worker not running or path is not a directory" } } } });

import { resolveFilesAccess } from "../../../utils/files-route-helpers";
import { rethrowAsHttpError } from "../../../utils/http-errors";

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const query = getQuery(event);
  const path = typeof query.path === "string" ? query.path : "/workspace";
  try { return await cm.listBackupPaths(id, path); }
  catch (error) { rethrowAsHttpError(error); }
});

import { requireAdmin } from "../../../utils/auth-helpers";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  throw createError({
    statusCode: 400,
    statusMessage:
      "Only a trusted, digest-pinned and explicitly promoted administrative image may be used",
  });
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Configure an explicitly trusted administrative image",
    responses: {
      200: { description: "Administrative image configuration" },
      403: { description: "Administrator required" },
    },
  },
});

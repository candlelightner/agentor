/**
 * User ids are minted by better-auth. Current ids are UUIDs and historical
 * installs may contain better-auth's URL-safe ids, so retain the compatible
 * alphanumeric/underscore/hyphen alphabet while rejecting path separators,
 * dot segments, percent-encoding markers, and absolute path forms.
 */
export const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isSafeUserId(value: unknown): value is string {
  return typeof value === "string" && SAFE_USER_ID_RE.test(value);
}

/** Assert again at every filesystem boundary, even when an upstream caller
 * already validated the id. This keeps user-scoped stores traversal-safe if a
 * future caller bypasses the management MCP dispatcher. */
export function assertSafeUserId(value: unknown, field = "userId"): string {
  if (!isSafeUserId(value)) {
    throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 });
  }
  return value;
}

/** IDs used as a single generated filename/path segment (jobs, artifacts,
 * workers) use the same long-standing URL-safe alphabet as owner ids. */
export function assertSafePathId(value: unknown, field = "id"): string {
  if (!isSafeUserId(value)) {
    throw Object.assign(new Error(`Invalid ${field}`), { statusCode: 400 });
  }
  return value;
}

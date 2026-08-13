import { getUserById } from "./auth";
import { assertSafeUserId } from "./user-id";

type UserExists = (userId: string) => boolean | Promise<boolean>;

/**
 * Validate every explicit management-MCP owner selector at the single
 * dispatcher boundary. Management remains intentionally cross-user, but the
 * target must be a real better-auth user rather than a caller-invented path or
 * an orphan namespace that would create files under DATA_DIR/users.
 *
 * Resource-derived owners do not pass through this function: their ids came
 * from already-persisted records and the user-scoped filesystem stores assert
 * the same safe alphabet again before any path access.
 */
export async function validateManagementOwnerArguments(
  args: Record<string, unknown>,
  userExists: UserExists = (userId) => getUserById(userId) !== null,
): Promise<void> {
  for (const field of ["ownerId", "userId"] as const) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] === undefined)
      continue;
    const userId = assertSafeUserId(args[field], field);
    if (!(await userExists(userId))) {
      throw Object.assign(new Error("Owner not found"), { statusCode: 404 });
    }
  }
}

import type { H3Event } from "h3";
import { createError } from "h3";
import { getAuthDb, getCredentialSummary, useAuth } from "./auth";
import { requireAuth } from "./auth-helpers";

/** Recovery material is equivalent to an offline decryption credential.  A
 * normal seven-day dashboard session is therefore insufficient: password
 * accounts must verify the password again, while passkey-only accounts must
 * present a session minted by a fresh server-verified sign-in ceremony. */
const FRESH_SESSION_WINDOW_MS = 5 * 60_000;

export interface BackupRecoveryReauthInput {
  password?: unknown;
  /** Passkey clients reauthenticate by signing in again, then explicitly ask
   * the server to accept that newly minted session. */
  useFreshSession?: unknown;
}

export async function requireFreshBackupRecoveryAuth(
  event: H3Event,
  input: BackupRecoveryReauthInput,
): Promise<{ userId: string; method: "password" | "fresh-session" }> {
  const { user, session } = requireAuth(event);
  const summary = getCredentialSummary(user.id);

  if (typeof input?.password === "string" && input.password.length > 0) {
    if (!summary.hasPassword) throw reauthFailed();
    try {
      const result = await useAuth().api.verifyPassword({
        body: { password: input.password },
        headers: event.headers,
      });
      if (result?.status !== true) throw reauthFailed();
      return { userId: user.id, method: "password" };
    } catch {
      // Never include Better Auth's response or any submitted material in an
      // error that can be serialized, audited, or logged.
      throw reauthFailed();
    }
  }

  if (input?.useFreshSession === true) {
    // A newly minted ordinary password session is not a second factor and must
    // never bypass explicit password verification. Fresh-session reauth exists
    // only for accounts whose configured authentication method has no password
    // to submit (for example passkey-only accounts).
    if (summary.hasPassword) throw reauthFailed();
    const row = getAuthDb()
      .prepare(
        "SELECT createdAt, updatedAt, userId FROM session WHERE id = ? LIMIT 1",
      )
      .get(session.id) as
      | { createdAt?: string; updatedAt?: string; userId?: string }
      | undefined;
    const mintedAt = Date.parse(row?.createdAt || "");
    if (
      row?.userId === user.id &&
      Number.isFinite(mintedAt) &&
      Date.now() - mintedAt >= 0 &&
      Date.now() - mintedAt <= FRESH_SESSION_WINDOW_MS
    )
      return { userId: user.id, method: "fresh-session" };
    throw createError({
      statusCode: 401,
      statusMessage:
        "Fresh reauthentication required. Sign in with your passkey again, then retry within five minutes.",
    });
  }

  throw createError({
    statusCode: 401,
    statusMessage: summary.hasPassword
      ? "Fresh reauthentication required. Enter your current account password."
      : "Fresh reauthentication required. Sign in with your passkey again, then retry within five minutes.",
  });
}

function reauthFailed() {
  return createError({
    statusCode: 401,
    statusMessage: "Fresh reauthentication failed",
  });
}

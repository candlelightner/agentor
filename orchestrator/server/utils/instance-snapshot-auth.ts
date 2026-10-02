import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface SnapshotAdministrator { userId: string; sessionId: string }

/** Narrow barrier-time authentication, NOT a replacement for normal auth.
 * Uses an already initialized connection and secret; never creates a database,
 * migrates, refreshes/deletes sessions, unbans users or sets cookies. The SQL
 * reads session and current user authority together. Cookie caches, bearer
 * tokens and impersonation are deliberately not accepted on this path.
 *
 * Wire format matches pinned better-call: percent-encoded token + '.' + a
 * padded base64 HMAC-SHA256. The cookie NAME comes from Better Auth's configured
 * getCookies(options), never from request scheme/forwarded headers.
 */
export function createSnapshotAdministratorReader(options: {
  db: Database.Database;
  secret: string;
  cookieName: string;
}): (cookie: string | undefined, now?: number) => SnapshotAdministrator | null {
  const { db, secret, cookieName } = options;
  if (!secret || !/^(?:__Secure-)?agentor\.session_token$/.test(cookieName))
    throw new Error('Unsupported snapshot authentication configuration');
  return (cookie, now = Date.now()) => {
    try {
      if (!cookie || cookie.length > 16_384 || !Number.isSafeInteger(now) || now < 0) return null;
      const matches = cookie.split(';').map(part => part.trim())
        .filter(part => part.slice(0, part.indexOf('=')).trim() === cookieName);
      // Do not guess between path/domain shadow cookies.
      if (matches.length !== 1) return null;
      const encoded = matches[0]!.slice(matches[0]!.indexOf('=') + 1).trim();
      if (encoded.length > 2_048) return null;
      const value = decodeURIComponent(encoded);
      const dot = value.lastIndexOf('.');
      if (dot < 1 || dot > 512) return null;
      const token = value.slice(0, dot), signature = value.slice(dot + 1);
      if (!/^[A-Za-z0-9+/]{43}=$/.test(signature) || /[\x00-\x20\x7f]/.test(token)) return null;
      const expected = createHmac('sha256', secret).update(token).digest();
      const provided = Buffer.from(signature, 'base64');
      if (provided.length !== expected.length || provided.toString('base64') !== signature ||
          !timingSafeEqual(expected, provided)) return null;
      const row = db.prepare(`SELECT s.id AS sessionId, s.userId, s.expiresAt,
          s.impersonatedBy, u.role, u.banned
        FROM session s JOIN user u ON u.id = s.userId WHERE s.token = ?`).get(token) as {
          sessionId: unknown; userId: unknown; expiresAt: unknown;
          impersonatedBy: unknown; role: unknown; banned: unknown;
        } | undefined;
      if (!row || row.role !== 'admin' || (row.banned !== null && row.banned !== 0) ||
          (row.impersonatedBy !== null && row.impersonatedBy !== '') ||
          typeof row.sessionId !== 'string' || !row.sessionId ||
          typeof row.userId !== 'string' || !row.userId) return null;
      // The pinned SQLite adapter stores Date fields as ISO strings. Refuse
      // malformed/unknown encodings rather than guessing units or timezones.
      if (typeof row.expiresAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expiresAt)) return null;
      const expiry = Date.parse(row.expiresAt);
      if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== row.expiresAt || expiry <= now) return null;
      return { userId: row.userId, sessionId: row.sessionId };
    } catch {
      // Missing schema, closed database, malformed cookies and busy failures
      // all deny access; no fallback to lazy/mutating Better Auth is allowed.
      return null;
    }
  };
}

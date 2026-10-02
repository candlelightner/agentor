import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { createSnapshotAdministratorReader } from '../../orchestrator/server/utils/instance-snapshot-auth';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const Database = require('better-sqlite3');
const secret = 'synthetic-snapshot-auth-test-secret-only';
const token = 'synthetic-session-token';
const cookieName = 'agentor.session_token';
const now = Date.parse('2026-09-29T12:00:00.000Z');
const signed = (value = token, key = secret) => encodeURIComponent(value + '.' + createHmac('sha256', key).update(value).digest('base64'));
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, role TEXT, banned INTEGER);
    CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT, token TEXT UNIQUE, expiresAt TEXT, impersonatedBy TEXT);
    INSERT INTO user VALUES ('owner', 'admin', 0);`);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL)').run('session', 'owner', token, new Date(now + 60_000).toISOString());
  return { db, read: createSnapshotAdministratorReader({ db, secret, cookieName }), cookie: cookieName + '=' + signed() };
}
test('signed session requires live authoritative administrator and does not write', () => {
  const { db, read, cookie } = fixture();
  try {
    const before = db.serialize(); db.pragma('query_only = ON');
    expect(read(cookie, now)).toEqual({ userId: 'owner', sessionId: 'session' });
    expect(db.serialize()).toEqual(before);
  } finally { db.close(); }
});
for (const [name, sql] of [
  ['revoked session', 'DELETE FROM session'], ['deleted user', 'DELETE FROM user'],
  ['demoted administrator', "UPDATE user SET role = 'user'"],
  ['banned administrator', 'UPDATE user SET banned = 1'],
  ['unknown ban encoding', 'UPDATE user SET banned = 2'],
  ['impersonated session', "UPDATE session SET impersonatedBy = 'other-admin'"],
  ['expired session', "UPDATE session SET expiresAt = '2026-09-29T12:00:00.000Z'"],
  ['invalid expiry', "UPDATE session SET expiresAt = '2026-02-30T12:00:00.000Z'"],
  ['numeric expiry', "UPDATE session SET expiresAt = '9999999999999'"],
  ['missing schema', 'DROP TABLE session'],
]) test(`${name} is rejected without repairs or deletion`, () => {
  const { db, read, cookie } = fixture();
  try {
    db.exec(sql); const before = db.serialize(); db.pragma('query_only = ON');
    expect(read(cookie, now)).toBeNull(); expect(db.serialize()).toEqual(before);
  } finally { db.close(); }
});
for (const [name, cookie] of [
  ['missing', undefined], ['unsigned', cookieName + '=' + token],
  ['wrong secret', cookieName + '=' + signed(token, 'other-secret')],
  ['wrong cookie', '__Secure-' + cookieName + '=' + signed()],
  ['duplicate', `${cookieName}=${signed()}; ${cookieName}=${signed()}`],
  ['malformed encoding', cookieName + '=%zz'],
  ['cache only', 'agentor.session_data=' + signed()],
  ['oversized', cookieName + '=' + 'a'.repeat(20_000)],
  ['malformed signature', cookieName + '=' + encodeURIComponent(token + '.' + 'a'.repeat(43) + '=')],
]) test(`${name} cookie cannot authenticate`, () => {
  const { db, read } = fixture();
  try { expect(read(cookie, now)).toBeNull(); } finally { db.close(); }
});
test('secure name is exact and session revocation is observed on every lookup', () => {
  const { db, cookie } = fixture();
  try {
    const read = createSnapshotAdministratorReader({ db, secret, cookieName: '__Secure-' + cookieName });
    expect(read(cookie, now)).toBeNull();
    expect(read('__Secure-' + cookie, now)?.userId).toBe('owner');
    db.exec('DELETE FROM session'); expect(read('__Secure-' + cookie, now)).toBeNull();
  } finally { db.close(); }
});
test('closed connection fails without lazy initialization', () => {
  const { db, read, cookie } = fixture(); db.close(); expect(read(cookie, now)).toBeNull();
});
test('real pinned Better Auth cookie and SQLite date format are accepted without refresh', async () => {
  const { betterAuth } = await import(require.resolve('better-auth'));
  const { admin } = await import(require.resolve('better-auth/plugins'));
  const { getMigrations } = await import(require.resolve('better-auth/db/migration'));
  const { getCookies } = await import(require.resolve('better-auth/cookies'));
  const db = new Database(':memory:');
  try {
    const auth = betterAuth({ database: db, secret, baseURL: 'http://localhost:3000',
      emailAndPassword: { enabled: true }, advanced: { cookiePrefix: 'agentor' }, plugins: [admin()] });
    await (await getMigrations(auth.options)).runMigrations();
    const response = await auth.api.signUpEmail({ body: {
      name: 'Synthetic Administrator', email: 'snapshot@example.invalid', password: 'synthetic-test-only-password',
    }, asResponse: true });
    expect(response.status).toBe(200);
    db.exec("UPDATE user SET role = 'admin'");
    const cookies = response.headers.getSetCookie();
    const name = getCookies(auth.options).sessionToken.name;
    const cookie = cookies.find((value: string) => value.startsWith(name + '='))?.split(';')[0];
    expect(cookie).toBeTruthy();
    const read = createSnapshotAdministratorReader({ db, secret, cookieName: name });
    const before = db.serialize(); db.pragma('query_only = ON');
    expect(read(cookie)?.userId).toBeTruthy();
    expect(db.serialize()).toEqual(before);
  } finally { db.close(); }
});

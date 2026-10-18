import { test, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../../orchestrator/server/utils/log-store';
import { readServerLogs, SERVER_LOG_MAX_BYTES } from '../../orchestrator/server/utils/server-log-read';

test('server logs preserve timestamps and multiline text while filtering and redacting credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-server-log-read-'));
  const store = new LogStore({ dataDir: dir, logMaxSize: 1024 * 1024, logMaxFiles: 2, logLevel: 'debug' } as any);
  try {
    await store.init();
    const entries = [
      { timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message: 'backup failed\nBearer token-secret API_KEY=configured-secret' },
      { timestamp: '2026-10-17T10:00:01.000Z', level: 'info', source: 'orchestrator', message: 'backup okay' },
      { timestamp: '2026-10-17T10:00:02.000Z', level: 'error', source: 'worker', message: 'backup worker-private' },
    ];
    for (const entry of entries) store.append(entry as any, entry.source === 'orchestrator' ? 'orchestrator' : 'containers');
    const page = await readServerLogs({ levels: ['error'], search: 'BACKUP', since: entries[0]!.timestamp, until: entries[1]!.timestamp }, { query: options => store.query(options), secretValues: () => ['configured-secret'] });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ timestamp: entries[0]!.timestamp, source: 'orchestrator', level: 'error' });
    expect(page.entries[0]!.message).toContain('failed\nBearer [REDACTED]');
    expect(JSON.stringify(page)).not.toContain('token-secret');
    expect(JSON.stringify(page)).not.toContain('configured-secret');
    expect(page.hasMore).toBe(false);
  } finally { await store.destroy(); await rm(dir, { recursive: true, force: true }); }
});

test('server pagination includes same-time entries and rotated files without leaking cursor message text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-server-log-pages-'));
  const store = new LogStore({ dataDir: dir, logMaxSize: 1, logMaxFiles: 5, logLevel: 'debug' } as any);
  try {
    await store.init();
    for (const message of ['secret-message-a', 'secret-message-b', 'secret-message-c']) store.append({ timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message }, 'orchestrator');
    const seen = new Set();
    let cursor: string | undefined;
    for (let index = 0; index < 3; index++) {
      const page = await readServerLogs({ limit: 1, ...(cursor ? { cursor } : {}) }, { query: options => store.query(options), secretValues: () => [] });
      expect(page.entries).toHaveLength(1);
      expect(seen.has(page.entries[0]!.message)).toBe(false);
      seen.add(page.entries[0]!.message);
      expect(page.hasMore).toBe(index < 2);
      cursor = page.nextCursor;
      if (cursor) expect(cursor).not.toContain('secret-message');
    }
    expect(seen.size).toBe(3);
  } finally { await store.destroy(); await rm(dir, { recursive: true, force: true }); }
});

test('server log projection bounds bytes, makes oversized-entry progress, and rejects malformed filters', async () => {
  const entry = { timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message: 'é\n'.repeat(SERVER_LOG_MAX_BYTES) } as const;
  const deps = { query: async () => ({ entries: [entry], hasMore: false }), secretValues: () => [] };
  const page = await readServerLogs({}, deps);
  expect(Buffer.byteLength(page.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')).toBeLessThanOrEqual(SERVER_LOG_MAX_BYTES);
  expect(page.truncated).toBe(true);
  expect(page.entries[0]!.message).toContain('[entry truncated]');
  for (const args of [{ limit: 1001 }, { limit: 0 }, { limit: '10' }, { levels: ['fatal'] }, { since: 'yesterday' }, { since: '2026-10-18T00:00:00Z', until: '2026-10-17T00:00:00Z' }, { search: 'x'.repeat(501) }, { cursor: 'raw private text' }, { source: 'worker' }, { workerId: 'foreign' }, { constructor: 'bad' }])
    await expect(readServerLogs(args, deps)).rejects.toMatchObject({ statusCode: 400 });
});

test('server log read handles empty pages and propagates storage failure for sanitized transport diagnostics', async () => {
  await expect(readServerLogs({}, { query: async () => ({ entries: [], hasMore: false }), secretValues: () => [] })).resolves.toMatchObject({ entries: [], hasMore: false, truncated: false });
  await expect(readServerLogs({}, { query: async () => { throw new Error('private storage path'); }, secretValues: () => [] })).rejects.toThrow('private storage path');
  const dir = await mkdtemp(join(tmpdir(), 'agentor-server-log-unavailable-'));
  try {
    await mkdir(join(dir, 'logs', 'orchestrator.log'), { recursive: true });
    const store = new LogStore({ dataDir: dir, logMaxSize: 1024, logMaxFiles: 1, logLevel: 'debug' } as any);
    await expect(readServerLogs({}, { query: options => store.query(options), secretValues: () => [] })).rejects.toMatchObject({ code: 'EISDIR' });
  } finally { await rm(dir, { recursive: true, force: true }); }

});


test('new identical entries in the same millisecond retain distinct durable pagination identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-server-log-identities-'));
  const store = new LogStore({ dataDir: dir, logMaxSize: 1024, logMaxFiles: 2, logLevel: 'debug' } as any);
  try {
    await store.init();
    const entry = { timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message: 'identical repeated entry' } as const;
    store.append(entry, 'orchestrator'); store.append(entry, 'orchestrator');
    const deps = { query: (options: any) => store.query(options), secretValues: () => [] };
    const first = await readServerLogs({ limit: 1 }, deps);
    expect(first.hasMore).toBe(true);
    const second = await readServerLogs({ limit: 1, cursor: first.nextCursor }, deps);
    expect(second.entries).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  } finally { await store.destroy(); await rm(dir, { recursive: true, force: true }); }
});


test('very large escaped multibyte entries are truncated within the actual JSONL byte budget', async () => {
  const message = '\u0000"\\漢字😀\n'.repeat(512 * 1024);
  const page = await readServerLogs({}, { query: async () => ({ entries: [{ timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message }], hasMore: false }), secretValues: () => [] });
  const bytes = Buffer.from(JSON.stringify(page.entries[0]) + '\n');
  expect(bytes.length).toBeLessThanOrEqual(SERVER_LOG_MAX_BYTES);
  expect(bytes.length).toBeGreaterThan(SERVER_LOG_MAX_BYTES - 20);
  expect(JSON.parse(bytes.toString('utf8')).message).toContain('[entry truncated]');
  expect(page.entries[0]!.message).not.toContain('\ufffd');
  expect(page.truncated).toBe(true);
});

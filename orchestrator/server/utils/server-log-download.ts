import { defineEventHandler, getQuery, setHeader, createError } from 'h3';
import { requireAdmin } from './auth-helpers';
import { readServerLogs, SERVER_LOG_MAX_ENTRIES } from './server-log-read';

export const serverLogDownload = defineEventHandler(async event => {
  requireAdmin(event);
  const query = getQuery(event);
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') throw createError({ statusCode: 400, statusMessage: 'Invalid log filter' });
    args[key] = key === 'levels' ? value.split(',').filter(Boolean) : key === 'limit' ? Number(value) : value;
  }
  args.limit ??= SERVER_LOG_MAX_ENTRIES;
  let page;
  try { page = await readServerLogs(args); }
  catch (error: any) {
    if (error?.statusCode === 400) throw createError({ statusCode: 400, statusMessage: error.message });
    throw createError({ statusCode: 503, statusMessage: 'Server logs are unavailable. Please retry.' });
  }
  if (!page.entries.length) throw createError({ statusCode: 404, statusMessage: 'No server logs match these filters' });
  const filename = `agentor-server-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  setHeader(event, 'Content-Type', 'application/x-ndjson; charset=utf-8');
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`);
  setHeader(event, 'Cache-Control', 'no-store');
  setHeader(event, 'X-Content-Type-Options', 'nosniff');
  setHeader(event, 'X-Log-Entries', page.entries.length);
  setHeader(event, 'X-Log-Has-More', String(page.hasMore));
  setHeader(event, 'X-Log-Truncated', String(page.truncated));
  if (page.nextCursor) setHeader(event, 'X-Log-Next-Cursor', page.nextCursor);
  // One JSON object per line preserves long and multiline messages losslessly.
  return page.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
});

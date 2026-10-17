import type { LogEntry, LogLevel } from '../../shared/types';
import type { LogQueryOptions } from './log-store';
import { logEntryCursor } from './log-store';
import { useLogStore } from './services';
import { redactManagedOutput, SENSITIVE_CONFIGURATION_NAME } from './worker-output-redaction';

export const SERVER_LOG_MAX_ENTRIES = 1_000;
export const SERVER_LOG_MAX_BYTES = 256 * 1024;
export const serverLogInputSchema = { type: 'object', additionalProperties: false, properties: {
  levels: { type: 'array', items: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } },
  search: { type: 'string', maxLength: 500 },
  since: { type: 'string', description: 'Inclusive ISO timestamp.' },
  until: { type: 'string', description: 'Exclusive ISO timestamp.' },
  limit: { type: 'integer', minimum: 1, maximum: SERVER_LOG_MAX_ENTRIES },
  cursor: { type: 'string', description: 'Opaque nextCursor from a previous page with the same filters.' },
} };

type Dependencies = {
  query: (options: LogQueryOptions) => Promise<{ entries: LogEntry[]; hasMore: boolean }>;
  secretValues: () => string[];
};

/** Server-only projection shared by the authenticated download and management
 * tool. No file path, source ID, worker, or arbitrary container is accepted. */
export async function readServerLogs(args: Record<string, unknown>, deps: Dependencies = {
  query: options => useLogStore().query(options),
  secretValues: () => Object.entries(process.env)
    .filter(([name]) => SENSITIVE_CONFIGURATION_NAME.test(name))
    .map(([, value]) => value || ''),
}) {
  for (const key of Object.keys(args)) if (!Object.hasOwn(serverLogInputSchema.properties, key)) throw failure(400, 'Unknown server log filter');
  const limit = args.limit === undefined ? 200 : args.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > SERVER_LOG_MAX_ENTRIES) throw failure(400, 'Invalid log limit');
  const levels = args.levels;
  if (levels !== undefined && (!Array.isArray(levels) || levels.some(level => !['debug', 'info', 'warn', 'error'].includes(level)))) throw failure(400, 'Invalid log levels');
  if (args.search !== undefined && (typeof args.search !== 'string' || args.search.length > 500)) throw failure(400, 'Invalid log search');
  const since = timestamp(args.since), until = timestamp(args.until);
  if (since && until && since >= until) throw failure(400, 'since must precede until');
  const before = args.cursor;
  if (before !== undefined && (typeof before !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-f0-9]{64}$/.test(before))) throw failure(400, 'Invalid log cursor');
  const page = await deps.query({ sources: ['orchestrator'], levels: levels as LogLevel[] | undefined, search: args.search as string | undefined, since, until, limit: limit as number, before: before as string | undefined });
  const entries: LogEntry[] = [];
  const secrets = deps.secretValues();
  let bytes = 0, redactedSecrets = 0;
  let nextCursor: string | undefined;
  let truncated = false;
  for (const raw of page.entries) {
    const redacted = redactServerMessage(raw.message, secrets);
    const entry: LogEntry = { timestamp: raw.timestamp, level: raw.level, source: 'orchestrator', message: redacted.output };
    const size = Buffer.byteLength(JSON.stringify(entry) + '\n');
    if (bytes + size > SERVER_LOG_MAX_BYTES) {
      if (entries.length) break;
      // A single oversized entry must make progress while keeping valid UTF-8.
      const marker = '\n[entry truncated]';
      let text = entry.message;
      while (Buffer.byteLength(JSON.stringify({ ...entry, message: text + marker }) + '\n') > SERVER_LOG_MAX_BYTES) text = text.slice(0, Math.max(0, text.length - 1024));
      entry.message = text + marker;
      truncated = true;
    }
    entries.push(entry);
    bytes += Buffer.byteLength(JSON.stringify(entry) + '\n');
    redactedSecrets += redacted.redacted;
    nextCursor = logEntryCursor(raw);
  }
  const hasMore = page.hasMore || entries.length < page.entries.length;
  return { entries, hasMore, nextCursor: hasMore ? nextCursor : undefined, truncated: truncated || hasMore, redactedSecrets, limit, maxBytes: SERVER_LOG_MAX_BYTES };
}

export function redactServerMessage(message: string, values: string[]) {
  const managed = redactManagedOutput(message, values);
  // Defense in depth for accidental credential-bearing diagnostics. Raw secrets
  // and headers must never be copied into MCP output or downloadable files.
  const output = managed.output
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [REDACTED]')
    .replace(/((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL)[A-Z_]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return { output, redacted: managed.redacted + (output === managed.output ? 0 : 1) };
}

function timestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw failure(400, 'Invalid log timestamp');
  return new Date(value).toISOString();
}
function failure(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

import { useUserEnvStore } from './services';

const SENSITIVE_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Transport-free adapter for the existing per-user global *plain variable*
 * store. Sensitive-looking names are masked on output as defense in depth, but
 * this adapter deliberately does not call them secrets: true managed secrets
 * use the encrypted worker-configuration store and its separate MCP surface. */
export class ManagementGlobalConfigurationDomain {
  constructor(private readonly userEnv = useUserEnvStore) {}
  tools() { return [
    tool('configuration.global.list', 'List a user global configuration without secret values', read),
    tool('configuration.global.effective-safe', 'Inspect safe global configuration precedence entries', read),
    tool('configuration.global.set', 'Set or replace user-global plain variables', mutate),
    tool('configuration.global.delete', 'Delete user-global plain variables', { ...mutate, destructiveHint: true }),
  ]; }
  async execute(name: string, args: Record<string, unknown>) {
    if (!name.startsWith('configuration.global.')) return { handled: false };
    const action = name.slice('configuration.global.'.length);
    if (!['list', 'effective-safe', 'set', 'delete'].includes(action)) return { handled: false };
    const ownerId = required(args.ownerId, 'ownerId'); const store = this.userEnv(); const current = store.getOrDefault(ownerId).envVars;
    if (action === 'list') return { handled: true, result: publicEntries(current) };
    if (action === 'effective-safe') return { handled: true, result: { precedence: ['orchestrator', 'user'], entries: publicEntries(current).map(entry => ({ ...entry, source: 'user' })) } };
    if (action === 'set') { const updates = inputEntries(args); const merged = new Map(current.map((entry: any) => [entry.key, entry.value])); for (const entry of updates) merged.set(entry.key, entry.value); const saved = await store.upsert(ownerId, { envVars: [...merged].map(([key, value]) => ({ key, value })) }); return { handled: true, result: publicEntries(saved.envVars) }; }
    const keys = requiredKeys(args.keys); const saved = await store.upsert(ownerId, { envVars: current.filter((entry: any) => !keys.includes(entry.key)) }); return { handled: true, result: { deleted: keys, entries: publicEntries(saved.envVars) } };
  }
}
function tool(name: string, description: string, annotations: Record<string, boolean>) { return { name, group: 'configuration', description, inputSchema: { type: 'object', additionalProperties: false, properties: { ownerId: { type: 'string' }, variables: { type: 'array', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } }, keys: { type: 'array', items: { type: 'string' } } }, required: ['ownerId'] }, annotations }; }
function publicEntries(entries: Array<{ key: string; value: string }>) { return entries.map(({ key, value }) => SENSITIVE_NAME_RE.test(key) ? { key, kind: 'secret', configured: true, masked: true } : { key, kind: 'variable', value }); }
function required(value: unknown, name: string): string { if (typeof value !== 'string' || !value) throw fail(400, `${name} is required`); return value; }
function requiredKeys(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.some(key => typeof key !== 'string' || !key)) throw fail(400, 'keys is required'); return [...new Set(value)]; }
function inputEntries(args: Record<string, unknown>) { const value = args.variables; if (!Array.isArray(value) || !value.length) throw fail(400, 'variables is required'); const entries: Array<{ key: string; value: string }> = []; for (const entry of value) { if (!entry || typeof entry !== 'object' || typeof (entry as any).key !== 'string' || typeof (entry as any).value !== 'string') throw fail(400, 'variables entries require key and value'); entries.push({ key: (entry as any).key, value: (entry as any).value }); } if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw fail(400, 'Duplicate configuration key'); return entries; }
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

import { useContainerManager, useWorkerStore } from "./services";
import { useWorkerConfigStore } from "./worker-config-store";

const MAX_TAIL = 1_000;
const MAX_BYTES = 256 * 1024;
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type Worker = { id: string; userId: string };
type Dependencies = {
  findWorker: (id: string) => Worker | undefined;
  readLogs: (id: string, tail: number) => Promise<string>;
  managedSecretValues: (userId: string, workerId: string) => Promise<Array<{ kind: string; value: string }>>;
};

/** A deliberately narrow management-MCP adapter for worker output.  It can
 * only fetch Docker logs for a persisted worker owned by the supplied owner;
 * it never accepts a container id, file path, command, or log source. */
export class ManagementLogsDomain {
  constructor(private readonly deps: Dependencies = defaultDependencies()) {}

  tools() {
    return [{
      name: "logs.read",
      group: "logs",
      description: "Read a bounded, redacted tail of one owned worker's Docker output.",
      inputSchema: { type: "object", required: ["workerId", "ownerId"], properties: {
        workerId: { type: "string", description: "Agentor worker UUID (not a Docker container ID)." },
        ownerId: { type: "string", description: "Owner of the worker; must match the persisted worker record." },
        tail: { type: "integer", minimum: 1, maximum: MAX_TAIL, description: `Maximum lines, capped at ${MAX_TAIL}.` },
      } },
      annotations: readOnly,
    }];
  }

  async execute(name: string, args: Record<string, unknown>) {
    if (name !== "logs.read") return { handled: false };
    const workerId = required(args.workerId, "workerId");
    const ownerId = required(args.ownerId, "ownerId");
    const worker = this.deps.findWorker(workerId);
    if (!worker) throw failure(404, "Worker not found");
    if (worker.userId !== ownerId) throw failure(404, "Worker not found");
    const tail = boundedTail(args.tail);
    const raw = await this.deps.readLogs(worker.id, tail);
    const secretValues = (await this.deps.managedSecretValues(worker.userId, worker.id))
      .filter(entry => entry.kind !== "variable" && entry.value.length > 0)
      .map(entry => entry.value);
    const redaction = redactLogs(raw, secretValues);
    const bounded = boundBytes(redaction.logs, MAX_BYTES);
    return { handled: true, result: {
      workerId: worker.id,
      ownerId: worker.userId,
      tail,
      logs: bounded.text,
      truncated: bounded.truncated,
      redactedSecrets: redaction.redacted,
    } };
  }
}

export function redactLogs(logs: string, values: string[]) {
  let result = logs;
  let redacted = 0;
  // Longer literals first prevents a short secret from partially masking one.
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    if (!value) continue;
    const parts = result.split(value);
    if (parts.length > 1) {
      redacted += parts.length - 1;
      result = parts.join("[REDACTED]");
    }
  }
  return { logs: result, redacted };
}

export function boundBytes(text: string, limit: number) {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  // Do not split a UTF-8 sequence. The marker is included within the cap.
  const marker = "\n[output truncated]";
  let end = Math.max(0, limit - Buffer.byteLength(marker));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > limit - Buffer.byteLength(marker)) end--;
  return { text: text.slice(0, end) + marker, truncated: true };
}

function defaultDependencies(): Dependencies {
  return {
    findWorker: id => useContainerManager().get(id) ?? useWorkerStore().findById(id),
    readLogs: (id, tail) => useContainerManager().logs(id, tail),
    managedSecretValues: (userId, workerId) => useWorkerConfigStore().resolveValues(userId, workerId),
  };
}
function required(value: unknown, name: string) { if (typeof value !== "string" || !value.trim()) throw failure(400, `${name} is required`); return value; }
function boundedTail(value: unknown) { if (value === undefined) return 200; if (!Number.isInteger(value) || (value as number) < 1) throw failure(400, "tail must be a positive integer"); return Math.min(value as number, MAX_TAIL); }
function failure(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }

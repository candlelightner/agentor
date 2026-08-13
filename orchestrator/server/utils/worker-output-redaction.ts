import type { ContainerInfo } from "../../shared/types";
import { DEFAULT_ENVIRONMENT_ID } from "./environments";
import { useEnvironmentStore, useUserEnvStore } from "./services";
import { parseDotEnv, useWorkerConfigStore } from "./worker-config-store";

export const SENSITIVE_CONFIGURATION_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

type WorkerIdentity = Pick<ContainerInfo, "id" | "userId" | "environmentId">;
type Dependencies = {
  localValues: (
    userId: string,
    workerId: string,
  ) => Promise<Array<{ kind: string; key: string; value: string }>>;
  userValues: (userId: string) => Array<{ key: string; value: string }>;
  environmentText: (environmentId: string) => string | undefined;
};

/** Exact managed literals that Agentor can redact. Encoded/transformed values
 * cannot be recognized reliably; very short values are skipped for usability. */
export async function workerOutputRedactionValues(
  worker: WorkerIdentity,
  deps: Dependencies = defaults(),
): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await deps.localValues(worker.userId, worker.id)) {
    if (
      entry.kind !== "variable" ||
      SENSITIVE_CONFIGURATION_NAME.test(entry.key)
    )
      values.push(entry.value);
  }
  for (const entry of deps.userValues(worker.userId)) {
    if (SENSITIVE_CONFIGURATION_NAME.test(entry.key)) values.push(entry.value);
  }
  const text = deps.environmentText(
    worker.environmentId || DEFAULT_ENVIRONMENT_ID,
  );
  if (text) {
    try {
      for (const entry of parseDotEnv(text)) {
        if (SENSITIVE_CONFIGURATION_NAME.test(entry.key))
          values.push(entry.value);
      }
    } catch {
      // Malformed legacy environment data must not break console/log reads.
    }
  }
  return normalizedValues(values);
}

export function redactManagedOutput(text: string, values: string[]) {
  let output = text;
  let redacted = 0;
  for (const value of normalizedValues(values)) {
    const parts = output.split(value);
    if (parts.length > 1) {
      redacted += parts.length - 1;
      output = parts.join("[REDACTED]");
    }
  }
  return { output, redacted };
}

/** Withhold a suffix matching a secret prefix and prevent starting a read
 * inside a complete secret, so incremental console offsets cannot bypass
 * exact-literal redaction. Offsets are byte offsets, matching the buffer. */
export function redactManagedBufferSlice(
  buffer: Buffer,
  requestedIndex: number,
  values: string[],
  bufferMayStartMidValue = false,
) {
  const secrets = normalizedValues(values).map((value) => ({
    value,
    bytes: Buffer.from(value),
  }));
  let safeEnd = buffer.length;
  for (const { bytes } of secrets) {
    const maximum = Math.min(bytes.length - 1, buffer.length);
    for (let length = maximum; length > 0; length--) {
      if (
        buffer
          .subarray(buffer.length - length)
          .equals(bytes.subarray(0, length))
      ) {
        safeEnd = Math.min(safeEnd, buffer.length - length);
        break;
      }
    }
  }
  let start = Math.min(Math.max(0, requestedIndex), safeEnd);
  let leadingSecretSuffix = 0;
  if (bufferMayStartMidValue) {
    for (const { bytes } of secrets) {
      for (let length = Math.min(bytes.length - 1, safeEnd); length >= 4; length--) {
        if (buffer.subarray(0, length).equals(bytes.subarray(bytes.length - length))) {
          leadingSecretSuffix = Math.max(leadingSecretSuffix, length);
          break;
        }
      }
    }
    if (start < leadingSecretSuffix) start = 0;
  }
  for (const { bytes } of secrets) {
    let occurrence = buffer.indexOf(bytes);
    while (occurrence >= 0 && occurrence < safeEnd) {
      if (start > occurrence && start < occurrence + bytes.length)
        start = occurrence;
      occurrence = buffer.indexOf(bytes, occurrence + 1);
    }
  }
  const text = start === 0 && leadingSecretSuffix
    ? `[REDACTED]${buffer.subarray(leadingSecretSuffix, safeEnd).toString("utf8")}`
    : buffer.subarray(start, safeEnd).toString("utf8");
  const result = redactManagedOutput(
    text,
    secrets.map(({ value }) => value),
  );
  return { ...result, start, safeEnd };
}

function normalizedValues(values: string[]) {
  return [...new Set(values.filter((value) => value.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
}

function defaults(): Dependencies {
  return {
    localValues: async (userId, workerId) => {
      const store = useWorkerConfigStore();
      const [desired, applied] = await Promise.all([
        store.resolveValues(userId, workerId),
        store.resolveAppliedValues(userId, workerId),
      ]);
      return [...desired, ...applied];
    },
    userValues: (userId) => useUserEnvStore().getOrDefault(userId).envVars,
    environmentText: (environmentId) =>
      useEnvironmentStore().getById(environmentId)?.envVars,
  };
}

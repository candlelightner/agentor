import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import type { PluginDefinitionRecord } from "./plugin-definition-store";
import { PluginDefinitionStore } from "./plugin-definition-store";
import type {
  PluginInstallationRecord,
  PluginObservedState,
  PluginResourceAllocation,
} from "./plugin-installation-store";
import { PluginInstallationStore } from "./plugin-installation-store";
import type {
  PluginCommand,
  PluginManifest,
  PluginReadiness,
} from "./plugin-manifest";

export interface PluginExecutionRequest {
  workerId: string;
  installationId: string;
  phase: "install" | "start" | "stop" | "cleanup";
  command?: PluginCommand;
  envKeys: string[];
  secretKeys: string[];
  systemEnvironment: Record<string, string>;
  skillMarkdown?: string;
  signal: AbortSignal;
}

export interface PluginProbeRequest {
  workerId: string;
  installationId: string;
  readiness: PluginReadiness;
  allocations: PluginResourceAllocation;
  envKeys: string[];
  secretKeys: string[];
  systemEnvironment: Record<string, string>;
  signal: AbortSignal;
}

export interface PluginExecutionResult {
  exitCode: number;
  output?: string;
  truncated?: boolean;
}

/** Implementations must execute only inside the identified worker. */
export interface PluginWorkerExecutor {
  execute(request: PluginExecutionRequest): Promise<PluginExecutionResult>;
  probe(request: PluginProbeRequest): Promise<PluginExecutionResult>;
}

export type PluginDefinitionRuntimeAuthorizer = (
  definition: PluginDefinitionRecord,
  installation: PluginInstallationRecord,
) => boolean | Promise<boolean>;

export interface PluginRuntimeManagerOptions {
  authorizeDefinition?: PluginDefinitionRuntimeAuthorizer;
  maxRequestTimeoutMs?: number;
}

/**
 * Reconciles persisted installation desire with one concrete worker runtime.
 * `runtimeGeneration` should be the current Docker container id, so a rebuild
 * can never reuse an observed-ready state from a destroyed container.
 */
export class PluginRuntimeManager {
  private workerQueues = new Map<string, Promise<void>>();
  private readonly authorizeDefinition: PluginDefinitionRuntimeAuthorizer;
  private readonly maxRequestTimeoutMs: number;

  constructor(
    private readonly definitions: PluginDefinitionStore,
    private readonly installations: PluginInstallationStore,
    private readonly executor: PluginWorkerExecutor,
    options: PluginRuntimeManagerOptions = {},
  ) {
    this.authorizeDefinition =
      options.authorizeDefinition ?? defaultDefinitionAuthorizer;
    this.maxRequestTimeoutMs = Math.max(
      1_000,
      Math.min(options.maxRequestTimeoutMs ?? 305_000, 310_000),
    );
  }

  reconcileWorker(
    userId: string,
    workerId: string,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord[]> {
    return this.withWorker(workerId, async () => {
      const results: PluginInstallationRecord[] = [];
      for (const installation of this.installations.listForWorker(
        userId,
        workerId,
      )) {
        try {
          results.push(
            await this.reconcileUnlocked(installation, runtimeGeneration),
          );
        } catch {
          const current = this.installations.getById(installation.id);
          if (current) results.push(current);
        }
      }
      return results;
    });
  }

  reconcileInstallation(
    userId: string,
    installationId: string,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord> {
    const installation = this.requiredInstallation(userId, installationId);
    return this.withWorker(installation.workerId, () =>
      this.reconcileUnlocked(
        this.requiredInstallation(userId, installationId),
        runtimeGeneration,
      ),
    );
  }

  async enable(
    userId: string,
    installationId: string,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord> {
    const installation = await this.installations.setDesiredEnabled(
      userId,
      installationId,
      true,
    );
    return this.withWorker(installation.workerId, () =>
      this.reconcileUnlocked(
        this.requiredInstallation(userId, installationId),
        runtimeGeneration,
      ),
    );
  }

  async disable(
    userId: string,
    installationId: string,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord> {
    const installation = await this.installations.setDesiredEnabled(
      userId,
      installationId,
      false,
    );
    return this.withWorker(installation.workerId, () =>
      this.reconcileUnlocked(
        this.requiredInstallation(userId, installationId),
        runtimeGeneration,
      ),
    );
  }

  async uninstall(
    userId: string,
    installationId: string,
    runtimeGeneration: string,
  ): Promise<void> {
    assertRuntimeGeneration(runtimeGeneration);
    const installation = this.requiredInstallation(userId, installationId);
    return this.withWorker(installation.workerId, async () => {
      const current = this.requiredInstallation(userId, installationId);
      const definition = await this.definitionFor(current);
      await this.transition(current, "cleaning", runtimeGeneration);
      try {
        await this.runPhase(current, definition.manifest, "stop");
        await this.runPhase(current, definition.manifest, "cleanup");
        await this.installations.releaseResources(userId, installationId);
        await this.installations.delete(userId, installationId);
      } catch (error) {
        await this.recordError(current, error, runtimeGeneration);
        throw error;
      }
    });
  }

  private async reconcileUnlocked(
    installation: PluginInstallationRecord,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord> {
    assertRuntimeGeneration(runtimeGeneration);
    const definition = await this.definitionFor(installation);
    if (
      installation.desiredEnabled &&
      installation.observed.state === "ready" &&
      installation.observed.ready &&
      installation.observed.runtimeGeneration === runtimeGeneration
    )
      return installation;
    if (
      !installation.desiredEnabled &&
      installation.observed.state === "disabled" &&
      installation.observed.runtimeGeneration === runtimeGeneration
    )
      return installation;
    if (!installation.desiredEnabled) {
      await this.transition(installation, "stopping", runtimeGeneration);
      try {
        await this.runPhase(installation, definition.manifest, "stop");
        return await this.installations.setObserved(
          installation.userId,
          installation.id,
          observed("disabled", false, runtimeGeneration),
        );
      } catch (error) {
        await this.recordError(installation, error, runtimeGeneration);
        throw error;
      }
    }

    try {
      let current = await this.installations.reserveResources(
        installation.userId,
        installation.id,
        definition.manifest,
      );
      await this.transition(current, "installing", runtimeGeneration);
      await this.runPhase(current, definition.manifest, "install");
      current = this.requiredInstallation(current.userId, current.id);
      await this.transition(current, "starting", runtimeGeneration);
      await this.runPhase(current, definition.manifest, "start");
      current = this.requiredInstallation(current.userId, current.id);
      await this.probe(current, definition.manifest);
      return await this.installations.setObserved(
        current.userId,
        current.id,
        observed("ready", true, runtimeGeneration),
      );
    } catch (error) {
      await this.recordError(installation, error, runtimeGeneration);
      throw error;
    }
  }

  private async definitionFor(
    installation: PluginInstallationRecord,
  ): Promise<PluginDefinitionRecord> {
    const definition = this.definitions.getById(installation.definitionId);
    if (
      !definition ||
      definition.definitionHash !== installation.definitionHash ||
      definition.manifest.version !== installation.definitionVersion
    )
      throw runtimeError(
        "PLUGIN_DEFINITION_UNAVAILABLE",
        "Pinned plugin definition is unavailable",
        409,
      );
    if (!(await this.authorizeDefinition(definition, installation)))
      throw runtimeError(
        "PLUGIN_DEFINITION_UNAVAILABLE",
        "Pinned plugin definition is unavailable",
        404,
      );
    const declaredEnv = new Set(definition.manifest.environment?.envKeys ?? []);
    const declaredSecrets = new Set(
      definition.manifest.environment?.secretKeys ?? [],
    );
    if (
      installation.envKeys.some((key) => !declaredEnv.has(key)) ||
      installation.secretKeys.some((key) => !declaredSecrets.has(key))
    )
      throw runtimeError(
        "PLUGIN_KEY_REFERENCE_DENIED",
        "Plugin key references are not declared by the definition",
        400,
      );
    return definition;
  }

  private async runPhase(
    installation: PluginInstallationRecord,
    manifest: PluginManifest,
    phase: "install" | "start" | "stop" | "cleanup",
  ): Promise<void> {
    const command = manifest.lifecycle[phase];
    if (!command && phase !== "stop" && phase !== "cleanup") return;
    const request: PluginExecutionRequest = {
      workerId: installation.workerId,
      installationId: installation.id,
      phase,
      ...(command ? { command } : {}),
      envKeys: [...installation.envKeys],
      secretKeys: [...installation.secretKeys],
      systemEnvironment: runtimeEnvironment(installation),
      ...(manifest.documentation?.skillMarkdown
        ? { skillMarkdown: manifest.documentation.skillMarkdown }
        : {}),
      signal: new AbortController().signal,
    };
    const timeoutMs = Math.min(
      this.maxRequestTimeoutMs,
      (command?.timeoutSeconds ?? 30) * 1_000,
    );
    const result = await settleOnceWithDeadline(
      (signal) => this.executor.execute({ ...request, signal }),
      timeoutMs,
      `${phase} timed out`,
    );
    if (result.exitCode !== 0)
      throw runtimeError(
        "PLUGIN_COMMAND_FAILED",
        `Plugin ${phase} command failed`,
        502,
      );
    if (
      result.truncated ||
      (result.output !== undefined &&
        Buffer.byteLength(result.output, "utf8") >
          (command?.maxOutputBytes ?? 256 * 1024))
    )
      throw runtimeError(
        "PLUGIN_OUTPUT_LIMIT",
        `Plugin ${phase} output exceeded its limit`,
        502,
      );
  }

  private async probe(
    installation: PluginInstallationRecord,
    manifest: PluginManifest,
  ): Promise<void> {
    if (
      !manifest.lifecycle.readiness &&
      manifest.lifecycle.start.mode !== "background"
    )
      return;
    const readiness = manifest.lifecycle.readiness ?? {
      kind: "process" as const,
      timeoutSeconds: 30,
      intervalMs: 250,
    };
    const timeoutMs = Math.min(
      this.maxRequestTimeoutMs,
      (readiness.timeoutSeconds ?? 30) * 1_000,
    );
    const result = await settleOnceWithDeadline(
      (signal) =>
        this.executor.probe({
          workerId: installation.workerId,
          installationId: installation.id,
          readiness,
          allocations: installation.allocations ?? { ports: {} },
          envKeys: [...installation.envKeys],
          secretKeys: [...installation.secretKeys],
          systemEnvironment: runtimeEnvironment(installation),
          signal,
        }),
      timeoutMs,
      "readiness probe timed out",
    );
    if (result.exitCode !== 0 || result.truncated)
      throw runtimeError(
        "PLUGIN_READINESS_FAILED",
        "Plugin readiness check failed",
        502,
      );
  }

  private transition(
    installation: PluginInstallationRecord,
    state: PluginObservedState,
    runtimeGeneration: string,
  ): Promise<PluginInstallationRecord> {
    return this.installations.setObserved(
      installation.userId,
      installation.id,
      observed(state, false, runtimeGeneration),
    );
  }

  private async recordError(
    installation: PluginInstallationRecord,
    error: unknown,
    runtimeGeneration: string,
  ): Promise<void> {
    const current = this.installations.getById(installation.id);
    if (!current || current.userId !== installation.userId) return;
    const normalized = normalizeRuntimeError(error);
    await this.installations
      .setObserved(installation.userId, installation.id, {
        ...observed("error", false, runtimeGeneration),
        error: { code: normalized.code, message: normalized.publicMessage },
      })
      .catch(() => undefined);
  }

  private requiredInstallation(
    userId: string,
    installationId: string,
  ): PluginInstallationRecord {
    const installation = this.installations.getById(installationId);
    if (!installation || installation.userId !== userId)
      throw Object.assign(new Error("Plugin installation not found"), {
        statusCode: 404,
      });
    return installation;
  }

  private withWorker<T>(
    workerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workerQueues.get(workerId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.workerQueues.set(workerId, tail);
    void tail.finally(() => {
      if (this.workerQueues.get(workerId) === tail)
        this.workerQueues.delete(workerId);
    });
    return result;
  }
}

/**
 * Docker executor for the image-baked generic runner. The command and all
 * custom code remain inside the worker; the orchestrator only supplies a
 * validated, values-free control document over stdin.
 */
export class DockerPluginWorkerExecutor implements PluginWorkerExecutor {
  constructor(
    private readonly docker: Docker,
    private readonly resolveContainerId: (
      workerId: string,
    ) => string | undefined,
  ) {}

  execute(request: PluginExecutionRequest): Promise<PluginExecutionResult> {
    return this.invoke(
      request.workerId,
      "execute",
      {
        installationId: request.installationId,
        phase: request.phase,
        command: request.command,
        envKeys: request.envKeys,
        secretKeys: request.secretKeys,
        systemEnvironment: request.systemEnvironment,
        skillMarkdown: request.skillMarkdown,
      },
      request.signal,
    );
  }

  probe(request: PluginProbeRequest): Promise<PluginExecutionResult> {
    return this.invoke(
      request.workerId,
      "probe",
      {
        installationId: request.installationId,
        readiness: request.readiness,
        allocations: request.allocations,
        envKeys: request.envKeys,
        secretKeys: request.secretKeys,
        systemEnvironment: request.systemEnvironment,
      },
      request.signal,
    );
  }

  private async invoke(
    workerId: string,
    operation: "execute" | "probe",
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PluginExecutionResult> {
    const containerId = this.resolveContainerId(workerId);
    if (!containerId)
      throw runtimeError(
        "PLUGIN_WORKER_UNAVAILABLE",
        "Worker is not running",
        409,
      );
    if (signal.aborted)
      throw runtimeError(
        "PLUGIN_RUNTIME_TIMEOUT",
        "Plugin runtime request timed out",
        504,
      );
    let stream: Duplex;
    let container: Docker.Container;
    try {
      container = this.docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: ["/home/agent/apps/plugin-runner/runner.py", operation],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "agent",
      });
      if (signal.aborted)
        throw runtimeError(
          "PLUGIN_RUNTIME_TIMEOUT",
          "Plugin runtime request timed out",
          504,
        );
      stream = (await exec.start({
        hijack: true,
        stdin: true,
        Tty: false,
      })) as Duplex;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "PLUGIN_RUNTIME_TIMEOUT")
        throw error;
      throw runtimeError(
        "PLUGIN_RUNNER_UNAVAILABLE",
        "Plugin runner is unavailable",
        502,
      );
    }
    if (signal.aborted) {
      stream.destroy();
      throw runtimeError(
        "PLUGIN_RUNTIME_TIMEOUT",
        "Plugin runtime request timed out",
        504,
      );
    }
    return new Promise<PluginExecutionResult>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const maxResponseBytes = 9 * 1024 * 1024;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const finish = (error?: unknown, result?: PluginExecutionResult) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        stdout.destroy();
        stderr.destroy();
        error ? reject(error) : resolve(result!);
      };
      const abort = () => {
        stream.destroy();
        finish(
          runtimeError(
            "PLUGIN_RUNTIME_TIMEOUT",
            "Plugin runtime request timed out",
            504,
          ),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          stream.destroy();
          finish(
            runtimeError(
              "PLUGIN_RUNNER_OUTPUT_LIMIT",
              "Plugin runner response exceeded its limit",
              502,
            ),
          );
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      // Runner stderr is intentionally discarded. It may contain details from
      // a failed child process and must never become part of an API response.
      stderr.resume();
      stream.on("error", () =>
        finish(
          runtimeError(
            "PLUGIN_RUNNER_UNAVAILABLE",
            "Plugin runner is unavailable",
            502,
          ),
        ),
      );
      const complete = () => {
        try {
          const output = Buffer.concat(chunks).toString("utf8").trim();
          const line = output
            .split(/\r?\n/)
            .findLast((candidate) => candidate.trim().startsWith("{"));
          if (!line) throw new Error("Plugin runner returned no response");
          const result = JSON.parse(line) as PluginExecutionResult & {
            error?: string;
          };
          if (!Number.isInteger(result.exitCode))
            throw new Error("Plugin runner response is invalid");
          finish(undefined, {
            exitCode: result.exitCode,
            ...(typeof result.output === "string"
              ? { output: result.output }
              : {}),
            ...(result.truncated ? { truncated: true } : {}),
          });
        } catch {
          finish(
            runtimeError(
              "PLUGIN_RUNNER_INVALID_RESPONSE",
              "Plugin runner returned an invalid response",
              502,
            ),
          );
        }
      };
      stream.once("end", complete);
      stream.once("close", complete);
      container.modem.demuxStream(stream, stdout, stderr);
      // The newline is the frame boundary. Docker hijacked sockets do not
      // reliably propagate a write-side EOF, so the runner reads exactly one
      // bounded record rather than waiting for stream.end().
      stream.write(`${JSON.stringify(payload)}\n`);
    });
  }
}

export function settleOnceWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value as T);
    };
    const timer = setTimeout(() => {
      const error = runtimeError("PLUGIN_RUNTIME_TIMEOUT", timeoutMessage, 504);
      controller.abort(error);
      finish(error);
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}

function runtimeEnvironment(
  installation: PluginInstallationRecord,
): Record<string, string> {
  const environment: Record<string, string> = {
    AGENTOR_PLUGIN_ID: installation.id,
    AGENTOR_PLUGIN_INSTANCE_ID: installation.id,
    AGENTOR_PLUGIN_DEFINITION_ID: installation.definitionId,
  };
  for (const [id, port] of Object.entries(
    installation.allocations?.ports ?? {},
  ))
    environment[
      `AGENTOR_PLUGIN_PORT_${id.replaceAll("-", "_").toUpperCase()}`
    ] = String(port);
  if (installation.allocations?.display !== undefined) {
    environment.AGENTOR_PLUGIN_DISPLAY = String(
      installation.allocations.display,
    );
    environment.DISPLAY = `:${installation.allocations.display}`;
  }
  return environment;
}

function assertRuntimeGeneration(runtimeGeneration: string): void {
  if (
    typeof runtimeGeneration !== "string" ||
    !runtimeGeneration ||
    runtimeGeneration.length > 200 ||
    runtimeGeneration.includes("\0")
  )
    throw runtimeError(
      "PLUGIN_WORKER_UNAVAILABLE",
      "Worker runtime generation is unavailable",
      409,
    );
}

function observed(
  state: PluginObservedState,
  ready: boolean,
  runtimeGeneration: string,
) {
  return {
    state,
    ready,
    runtimeGeneration,
    checkedAt: new Date().toISOString(),
  };
}

async function defaultDefinitionAuthorizer(
  definition: PluginDefinitionRecord,
  installation: PluginInstallationRecord,
): Promise<boolean> {
  if (definition.scope === "platform") return true;
  if (definition.userId !== installation.userId) return false;
  if (definition.scope === "worker")
    return definition.workerId === installation.workerId;
  // Group membership is a live relation and must be supplied by the caller.
  // Failing closed here prevents a same-owner sibling installation bypass.
  return definition.scope === "owner";
}

function normalizeRuntimeError(error: unknown): {
  code: string;
  publicMessage: string;
} {
  const candidate = error as {
    code?: unknown;
    publicMessage?: unknown;
  };
  return {
    code:
      typeof candidate?.code === "string"
        ? candidate.code.slice(0, 100)
        : "PLUGIN_RUNTIME_FAILED",
    publicMessage:
      typeof candidate?.publicMessage === "string"
        ? candidate.publicMessage.slice(0, 500)
        : "Plugin runtime operation failed",
  };
}

function runtimeError(code: string, publicMessage: string, statusCode: number) {
  return Object.assign(new Error(publicMessage), {
    code,
    publicMessage,
    statusCode,
  });
}

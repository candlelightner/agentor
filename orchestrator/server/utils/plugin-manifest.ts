import { createHash } from "node:crypto";
import { sanitizePluginSvg } from "./plugin-svg";
import { USER_ENV_KEY_RE } from "./user-env-store";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export type PluginDefinitionScope = "platform" | "owner" | "group" | "worker";
export type PluginProtocol = "tcp" | "http" | "udp";

export interface PluginCommand {
  argv: string[];
  cwd?: string;
  mode?: "oneshot" | "background";
  timeoutSeconds?: number;
  maxOutputBytes?: number;
}

export interface PluginReadiness {
  kind: "process" | "tcp" | "http" | "exec";
  portId?: string;
  path?: string;
  command?: PluginCommand;
  timeoutSeconds?: number;
  intervalMs?: number;
}

export interface PluginPortRequirement {
  id: string;
  protocol: PluginProtocol;
  fixedPort?: number;
  rangeStart?: number;
  rangeEnd?: number;
}

export interface PluginDisplayRequirement {
  mode: "none" | "shared" | "dedicated";
  rangeStart?: number;
  rangeEnd?: number;
}

export interface PluginPrivateAction {
  id: string;
  label: string;
  kind: "private-ui";
  portId: string;
  path: string;
  openMode?: "sandboxed-pane";
}

export interface PluginManifest {
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  name: string;
  slug: string;
  description: string;
  version: string;
  iconSvg?: string;
  lifecycle: {
    install?: PluginCommand;
    start: PluginCommand;
    readiness?: PluginReadiness;
    stop?: PluginCommand;
    cleanup?: PluginCommand;
  };
  resources?: {
    ports?: PluginPortRequirement[];
    display?: PluginDisplayRequirement;
  };
  environment?: {
    envKeys?: string[];
    secretKeys?: string[];
  };
  actions?: PluginPrivateAction[];
  documentation?: {
    markdown?: string;
    skillMarkdown?: string;
  };
}

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const MAX_COMMAND_ARGS = 128;
const MAX_COMMAND_ARG_BYTES = 8 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const SECRET_MATERIAL_RE =
  /(?:\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)\b\s*[=:]\s*["']?[^\s"']{8,}|\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s"']{8,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,})/i;

export function validatePluginManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) fail("Plugin manifest must be an object");
  assertOnlyKeys(
    input,
    [
      "schemaVersion",
      "name",
      "slug",
      "description",
      "version",
      "iconSvg",
      "lifecycle",
      "resources",
      "environment",
      "actions",
      "documentation",
    ],
    "plugin manifest",
  );
  if (input.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION)
    fail("Unsupported plugin manifest schemaVersion");
  const name = requiredText(input.name, "name", 1, 100);
  const slug = requiredText(input.slug, "slug", 1, 64);
  if (!ID_RE.test(slug)) fail("slug must match /^[a-z][a-z0-9-]{0,63}$/");
  const description = requiredText(input.description, "description", 0, 2_000);
  const version = requiredText(input.version, "version", 1, 64);
  if (!VERSION_RE.test(version)) fail("version is invalid");
  if (!isRecord(input.lifecycle)) fail("lifecycle is required");
  assertOnlyKeys(
    input.lifecycle,
    ["install", "start", "readiness", "stop", "cleanup"],
    "lifecycle",
  );

  const lifecycle: PluginManifest["lifecycle"] = {
    start: validateCommand(input.lifecycle.start, "lifecycle.start", true),
  };
  for (const phase of ["install", "stop", "cleanup"] as const) {
    if (input.lifecycle[phase] !== undefined)
      lifecycle[phase] = validateCommand(
        input.lifecycle[phase],
        `lifecycle.${phase}`,
        false,
      );
  }
  if (input.lifecycle.readiness !== undefined)
    lifecycle.readiness = validateReadiness(input.lifecycle.readiness);

  const resources = validateResources(input.resources);
  const portIds = new Set(resources?.ports?.map((port) => port.id) ?? []);
  if (
    (lifecycle.readiness?.kind === "tcp" ||
      lifecycle.readiness?.kind === "http") &&
    !portIds.has(lifecycle.readiness.portId!)
  )
    fail("readiness.portId must reference a declared port");
  const environment = validateEnvironment(input.environment);
  const actions = validateActions(input.actions, portIds);
  const documentation = validateDocumentation(input.documentation);
  // These fields are persisted in definitions and can be carried by export,
  // clone, and Git portability just like lifecycle/docs. Environment entries
  // are intentionally excluded because they are validated key references.
  assertNoSecretMaterial({ name, description, version, actions }, "Plugin metadata");
  assertNoSecretMaterial(lifecycle, "Plugin lifecycle");
  if (documentation)
    assertNoSecretMaterial(documentation, "Plugin documentation");
  let iconSvg: string | undefined;
  if (input.iconSvg !== undefined) {
    iconSvg = sanitizePluginSvg(input.iconSvg) ?? undefined;
    if (!iconSvg) fail("iconSvg is not in the supported safe SVG subset");
  }
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    name,
    slug,
    description,
    version,
    ...(iconSvg ? { iconSvg } : {}),
    lifecycle,
    ...(resources ? { resources } : {}),
    ...(environment ? { environment } : {}),
    ...(actions?.length ? { actions } : {}),
    ...(documentation ? { documentation } : {}),
  };
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  // References are the supported way to pass runtime values. Remove them
  // before scanning so `$TOKEN` remains valid while a literal token does not.
  const text = JSON.stringify(value).replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, "");
  if (SECRET_MATERIAL_RE.test(text))
    fail(`${label} must not contain secret values`);
}

export function pluginDefinitionHash(manifest: PluginManifest): string {
  return createHash("sha256").update(stable(manifest)).digest("hex");
}

export function validateDefinitionScope(input: {
  scope: unknown;
  ownerId?: unknown;
  groupId?: unknown;
  workerId?: unknown;
}): {
  scope: PluginDefinitionScope;
  ownerId: string | null;
  groupId?: string;
  workerId?: string;
} {
  if (!["platform", "owner", "group", "worker"].includes(String(input.scope)))
    fail("Invalid plugin definition scope");
  const scope = input.scope as PluginDefinitionScope;
  if (scope === "platform") {
    if (
      input.ownerId != null ||
      input.groupId != null ||
      input.workerId != null
    )
      fail(
        "Platform plugin definitions cannot carry owner, group, or worker identity",
      );
    return { scope, ownerId: null };
  }
  const ownerId = requiredText(input.ownerId, "ownerId", 1, 200);
  if (scope === "group") {
    if (input.workerId != null)
      fail("Group plugin definitions cannot carry worker identity");
    return {
      scope,
      ownerId,
      groupId: requiredText(input.groupId, "groupId", 1, 200),
    };
  }
  if (scope === "worker") {
    if (input.groupId != null)
      fail("Worker plugin definitions cannot carry group identity");
    return {
      scope,
      ownerId,
      workerId: requiredText(input.workerId, "workerId", 1, 200),
    };
  }
  if (input.groupId != null || input.workerId != null)
    fail("Owner plugin definitions cannot carry group or worker identity");
  return { scope, ownerId };
}

function validateCommand(
  input: unknown,
  label: string,
  allowBackground: boolean,
): PluginCommand {
  if (
    !isRecord(input) ||
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > MAX_COMMAND_ARGS
  )
    fail(`${label}.argv must contain 1-${MAX_COMMAND_ARGS} arguments`);
  assertOnlyKeys(
    input,
    ["argv", "cwd", "mode", "timeoutSeconds", "maxOutputBytes"],
    label,
  );
  const argv = input.argv.map((arg, index) =>
    requiredText(arg, `${label}.argv[${index}]`, 1, MAX_COMMAND_ARG_BYTES),
  );
  if (argv[0]!.includes("\0")) fail(`${label}.argv is invalid`);
  let cwd: string | undefined;
  if (input.cwd !== undefined) {
    cwd = requiredText(input.cwd, `${label}.cwd`, 1, 512);
    if (
      !cwd.startsWith("/") ||
      cwd.includes("\0") ||
      cwd.split("/").includes("..")
    )
      fail(`${label}.cwd must be an absolute normalized worker path`);
  }
  const mode = input.mode === undefined ? "oneshot" : input.mode;
  if (mode !== "oneshot" && mode !== "background")
    fail(`${label}.mode is invalid`);
  if (!allowBackground && mode !== "oneshot")
    fail(`${label}.mode must be oneshot`);
  const timeoutSeconds = boundedInteger(
    input.timeoutSeconds,
    `${label}.timeoutSeconds`,
    1,
    300,
    30,
  );
  const maxOutputBytes = boundedInteger(
    input.maxOutputBytes,
    `${label}.maxOutputBytes`,
    1_024,
    4 * 1024 * 1024,
    256 * 1024,
  );
  return {
    argv,
    ...(cwd ? { cwd } : {}),
    mode,
    timeoutSeconds,
    maxOutputBytes,
  };
}

function validateReadiness(input: unknown): PluginReadiness {
  if (
    !isRecord(input) ||
    !["process", "tcp", "http", "exec"].includes(String(input.kind))
  )
    fail("lifecycle.readiness.kind is invalid");
  assertOnlyKeys(
    input,
    ["kind", "portId", "path", "command", "timeoutSeconds", "intervalMs"],
    "lifecycle.readiness",
  );
  const kind = input.kind as PluginReadiness["kind"];
  const timeoutSeconds = boundedInteger(
    input.timeoutSeconds,
    "readiness.timeoutSeconds",
    1,
    300,
    30,
  );
  const intervalMs = boundedInteger(
    input.intervalMs,
    "readiness.intervalMs",
    50,
    5_000,
    250,
  );
  if ((kind === "tcp" || kind === "http") && typeof input.portId !== "string")
    fail("readiness.portId is required");
  const path =
    kind === "http"
      ? requiredText(input.path ?? "/", "readiness.path", 1, 512)
      : undefined;
  if (
    path &&
    (!path.startsWith("/") || path.includes("\0") || path.includes(".."))
  )
    fail("readiness.path must be a safe absolute URL path");
  const command =
    kind === "exec"
      ? validateCommand(input.command, "readiness.command", false)
      : undefined;
  if (kind !== "exec" && input.command !== undefined)
    fail("readiness.command is only valid for exec readiness");
  if (kind !== "tcp" && kind !== "http" && input.portId !== undefined)
    fail("readiness.portId is only valid for tcp/http readiness");
  if (kind !== "http" && input.path !== undefined)
    fail("readiness.path is only valid for http readiness");
  return {
    kind,
    ...(typeof input.portId === "string" ? { portId: input.portId } : {}),
    ...(path ? { path } : {}),
    ...(command ? { command } : {}),
    timeoutSeconds,
    intervalMs,
  };
}

function validateResources(
  input: unknown,
): PluginManifest["resources"] | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) fail("resources must be an object");
  assertOnlyKeys(input, ["ports", "display"], "resources");
  const ports: PluginPortRequirement[] = [];
  const ids = new Set<string>();
  if (input.ports !== undefined) {
    if (!Array.isArray(input.ports) || input.ports.length > 32)
      fail("resources.ports is invalid");
    for (const raw of input.ports) {
      if (!isRecord(raw)) fail("port requirement must be an object");
      assertOnlyKeys(
        raw,
        ["id", "protocol", "fixedPort", "rangeStart", "rangeEnd"],
        "port requirement",
      );
      const id = requiredText(raw.id, "port.id", 1, 64);
      if (!ID_RE.test(id) || ids.has(id))
        fail("port ids must be unique safe identifiers");
      ids.add(id);
      if (!["tcp", "http", "udp"].includes(String(raw.protocol)))
        fail("port.protocol is invalid");
      const fixedPort =
        raw.fixedPort === undefined
          ? undefined
          : boundedInteger(raw.fixedPort, "port.fixedPort", 1, 65_535);
      const rangeStart =
        raw.rangeStart === undefined
          ? undefined
          : boundedInteger(raw.rangeStart, "port.rangeStart", 1, 65_535);
      const rangeEnd =
        raw.rangeEnd === undefined
          ? undefined
          : boundedInteger(raw.rangeEnd, "port.rangeEnd", 1, 65_535);
      if (
        (fixedPort === undefined) ===
        (rangeStart === undefined || rangeEnd === undefined)
      )
        fail("port requires either fixedPort or a complete range");
      if (
        rangeStart !== undefined &&
        rangeEnd !== undefined &&
        rangeStart > rangeEnd
      )
        fail("port range is invalid");
      ports.push({
        id,
        protocol: raw.protocol as PluginProtocol,
        ...(fixedPort ? { fixedPort } : {}),
        ...(rangeStart ? { rangeStart, rangeEnd } : {}),
      });
    }
  }
  let display: PluginDisplayRequirement | undefined;
  if (input.display !== undefined) {
    if (
      !isRecord(input.display) ||
      !["none", "shared", "dedicated"].includes(String(input.display.mode))
    )
      fail("resources.display.mode is invalid");
    assertOnlyKeys(
      input.display,
      ["mode", "rangeStart", "rangeEnd"],
      "resources.display",
    );
    const mode = input.display.mode as PluginDisplayRequirement["mode"];
    if (mode === "dedicated") {
      const rangeStart = boundedInteger(
        input.display.rangeStart,
        "display.rangeStart",
        100,
        999,
        100,
      );
      const rangeEnd = boundedInteger(
        input.display.rangeEnd,
        "display.rangeEnd",
        rangeStart,
        999,
        199,
      );
      display = { mode, rangeStart, rangeEnd };
    } else {
      if (
        input.display.rangeStart !== undefined ||
        input.display.rangeEnd !== undefined
      )
        fail("display ranges are only valid for dedicated displays");
      display = { mode };
    }
  }
  return ports.length || display
    ? { ...(ports.length ? { ports } : {}), ...(display ? { display } : {}) }
    : undefined;
}

function validateEnvironment(
  input: unknown,
): PluginManifest["environment"] | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) fail("environment must be an object");
  assertOnlyKeys(input, ["envKeys", "secretKeys"], "environment");
  const envKeys = uniqueKeys(input.envKeys, "environment.envKeys");
  const secretKeys = uniqueKeys(input.secretKeys, "environment.secretKeys");
  if (envKeys.some((key) => secretKeys.includes(key)))
    fail("A key cannot be both an env and secret reference");
  return envKeys.length || secretKeys.length
    ? {
        ...(envKeys.length ? { envKeys } : {}),
        ...(secretKeys.length ? { secretKeys } : {}),
      }
    : undefined;
}

function validateActions(
  input: unknown,
  portIds: Set<string>,
): PluginPrivateAction[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 32) fail("actions is invalid");
  const ids = new Set<string>();
  return input.map((raw) => {
    if (!isRecord(raw) || raw.kind !== "private-ui")
      fail("Only private-ui actions are supported");
    assertOnlyKeys(
      raw,
      ["id", "label", "kind", "portId", "path", "openMode"],
      "action",
    );
    const id = requiredText(raw.id, "action.id", 1, 64);
    if (!ID_RE.test(id) || ids.has(id))
      fail("action ids must be unique safe identifiers");
    ids.add(id);
    const portId = requiredText(raw.portId, "action.portId", 1, 64);
    if (!portIds.has(portId))
      fail("action.portId must reference a declared port");
    const path = requiredText(raw.path, "action.path", 1, 512);
    if (
      !path.startsWith("/") ||
      path.includes("\0") ||
      path.includes("..") ||
      path.includes("://")
    )
      fail("action.path must be a safe relative backend path");
    const openMode = raw.openMode ?? "sandboxed-pane";
    // A separate-origin presentation needs an independently authenticated
    // gateway, which is not part of the core runner. Reject it instead of
    // persisting a mode that an API/UI might accidentally serve same-origin.
    if (openMode !== "sandboxed-pane")
      fail("Only sandboxed-pane plugin actions are currently supported");
    return {
      id,
      label: requiredText(raw.label, "action.label", 1, 100),
      kind: "private-ui",
      portId,
      path,
      openMode,
    };
  });
}

function validateDocumentation(
  input: unknown,
): PluginManifest["documentation"] | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) fail("documentation must be an object");
  assertOnlyKeys(input, ["markdown", "skillMarkdown"], "documentation");
  const markdown = optionalDocument(input.markdown, "documentation.markdown");
  const skillMarkdown = optionalDocument(
    input.skillMarkdown,
    "documentation.skillMarkdown",
  );
  return markdown || skillMarkdown
    ? {
        ...(markdown ? { markdown } : {}),
        ...(skillMarkdown ? { skillMarkdown } : {}),
      }
    : undefined;
}

function uniqueKeys(input: unknown, label: string): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some((key) => typeof key !== "string" || !USER_ENV_KEY_RE.test(key))
  )
    fail(`${label} must contain valid environment key names`);
  if (new Set(input).size !== input.length)
    fail(`${label} contains duplicates`);
  return [...input];
}

function optionalDocument(input: unknown, label: string): string | undefined {
  if (input === undefined) return undefined;
  return requiredText(input, label, 1, MAX_DOCUMENT_BYTES);
}

function requiredText(
  input: unknown,
  label: string,
  min: number,
  max: number,
): string {
  if (
    typeof input !== "string" ||
    input.length < min ||
    Buffer.byteLength(input, "utf8") > max ||
    input.includes("\0")
  )
    fail(`${label} is invalid`);
  return input;
}

function boundedInteger(
  input: unknown,
  label: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (input === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(input) || Number(input) < min || Number(input) > max)
    fail(`${label} must be an integer between ${min} and ${max}`);
  return Number(input);
}

function stable(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
  if (isRecord(input))
    return `{${Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${stable(value)}`)
      .join(",")}}`;
  return JSON.stringify(input);
}

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(input).some((key) => !accepted.has(key)))
    fail(`${label} contains unsupported fields`);
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

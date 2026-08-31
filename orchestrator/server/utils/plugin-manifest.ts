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
  openMode?: "sandboxed-pane" | "desktop";
}

/**
 * A credential-free contribution which may be selected while constructing a
 * custom worker image.  It deliberately describes image construction only:
 * lifecycle commands, environment references, ports, displays and instance
 * allocations remain worker-runtime concerns.
 */
export interface PluginImageBuild {
  contextFiles?: PluginImageBuildContextFile[];
  provisioning?: PluginImageBuildProvisioningStep[];
  /** A plugin can make its image check required by default. The image/template
   * selecting it may still decide whether that check is required. */
  validation?: {
    command: PluginCommand;
    defaultRequired?: boolean;
  };
  /** Signals that the contribution intentionally needs unrestricted
   * build-time shell behavior. It never changes an image's mode implicitly. */
  requiresAdvancedProvisioning?: boolean;
}

export interface PluginImageBuildContextFile {
  path: string;
  contentBase64: string;
  role?: "asset" | "script";
  destination?: string;
}

export type PluginImageBuildProvisioningStep =
  | { type: "packages"; manager: "apt" | "npm" | "pip"; packages: string[] }
  | { type: "command"; command: string }
  | { type: "script"; path: string; interpreter: "sh" | "bash" | "python3" | "node" };

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
  imageBuild?: PluginImageBuild;
}

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const MAX_COMMAND_ARGS = 128;
const MAX_COMMAND_ARG_BYTES = 8 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_IMAGE_BUILD_CONTEXT_FILE = 100 * 1024 * 1024;
const MAX_IMAGE_BUILD_CONTEXT_TOTAL = 250 * 1024 * 1024;
const MAX_IMAGE_BUILD_FILES = 100;
const MAX_IMAGE_BUILD_STEPS = 100;
const MAX_IMAGE_BUILD_COMMAND_BYTES = 16 * 1024;
const SAFE_BUILD_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const SAFE_BUILD_DESTINATION_RE = /^\/opt\/agentor-context\/(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const SAFE_BUILD_PACKAGE_RE = /^[a-zA-Z0-9@._+:/=~^-]+$/;
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
      "imageBuild",
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
  const imageBuild = validatePluginImageBuild(input.imageBuild);
  // These fields are persisted in definitions and can be carried by export,
  // clone, and Git portability just like lifecycle/docs. Environment entries
  // are intentionally excluded because they are validated key references.
  assertNoSecretMaterial({ name, description, version, actions }, "Plugin metadata");
  assertNoSecretMaterial(lifecycle, "Plugin lifecycle");
  if (documentation)
    assertNoSecretMaterial(documentation, "Plugin documentation");
  if (imageBuild) assertNoSecretMaterial(imageBuild, "Plugin imageBuild");
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
    ...(imageBuild ? { imageBuild } : {}),
  };
}

/** Validate the serializable, image-only portion of a plugin manifest. */
export function validatePluginImageBuild(input: unknown): PluginImageBuild | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) fail("imageBuild must be an object");
  assertOnlyKeys(
    input,
    ["contextFiles", "provisioning", "validation", "requiresAdvancedProvisioning"],
    "imageBuild",
  );
  const contextFiles = validateImageBuildContextFiles(input.contextFiles);
  const provisioning = validateImageBuildProvisioning(
    input.provisioning,
    contextFiles,
  );
  let validation: PluginImageBuild["validation"];
  if (input.validation !== undefined) {
    if (!isRecord(input.validation)) fail("imageBuild.validation must be an object");
    assertOnlyKeys(input.validation, ["command", "defaultRequired"], "imageBuild.validation");
    if (
      input.validation.defaultRequired !== undefined &&
      typeof input.validation.defaultRequired !== "boolean"
    )
      fail("imageBuild.validation.defaultRequired must be a boolean");
    validation = {
      command: validateCommand(input.validation.command, "imageBuild.validation.command", false),
      ...(input.validation.defaultRequired === undefined
        ? {}
        : { defaultRequired: input.validation.defaultRequired }),
    };
  }
  if (
    input.requiresAdvancedProvisioning !== undefined &&
    typeof input.requiresAdvancedProvisioning !== "boolean"
  )
    fail("imageBuild.requiresAdvancedProvisioning must be a boolean");
  if (!contextFiles?.length && !provisioning?.length && !validation)
    fail("imageBuild must include contextFiles, provisioning, or validation");
  return {
    ...(contextFiles?.length ? { contextFiles } : {}),
    ...(provisioning?.length ? { provisioning } : {}),
    ...(validation ? { validation } : {}),
    ...(input.requiresAdvancedProvisioning ? { requiresAdvancedProvisioning: true } : {}),
  };
}

function validateImageBuildContextFiles(input: unknown): PluginImageBuildContextFile[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_IMAGE_BUILD_FILES)
    fail(`imageBuild.contextFiles must contain at most ${MAX_IMAGE_BUILD_FILES} files`);
  const files: PluginImageBuildContextFile[] = [], seen = new Set<string>();
  let total = 0;
  for (const raw of input) {
    if (!isRecord(raw)) fail("imageBuild context file must be an object");
    assertOnlyKeys(raw, ["path", "contentBase64", "role", "destination"], "imageBuild context file");
    const path = requiredText(raw.path, "imageBuild.contextFiles.path", 1, 512);
    const folded = path.toLowerCase();
    if (!SAFE_BUILD_PATH_RE.test(path) || path.startsWith("./") || path.includes("//") || path.endsWith("/") || folded === "dockerfile" || folded === ".dockerignore" || seen.has(folded))
      fail("imageBuild.contextFiles.path is invalid");
    seen.add(folded);
    const contentBase64 = requiredText(raw.contentBase64, "imageBuild.contextFiles.contentBase64", 0, Math.ceil(MAX_IMAGE_BUILD_CONTEXT_FILE / 3) * 4 + 4);
    if (contentBase64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64))
      fail("imageBuild.contextFiles.contentBase64 must be canonical base64");
    const decoded = Buffer.from(contentBase64, "base64");
    if (decoded.toString("base64") !== contentBase64 || decoded.length > MAX_IMAGE_BUILD_CONTEXT_FILE || (total += decoded.length) > MAX_IMAGE_BUILD_CONTEXT_TOTAL)
      fail("imageBuild context content is invalid or too large");
    assertNoSecretMaterial(decoded.toString("utf8"), "Plugin imageBuild context content");
    const role = raw.role === undefined ? "asset" : raw.role;
    const destination = raw.destination === undefined ? `/opt/agentor-context/${path}` : requiredText(raw.destination, "imageBuild.contextFiles.destination", 1, 1024);
    if ((role !== "asset" && role !== "script") || !SAFE_BUILD_DESTINATION_RE.test(destination) || destination.includes("//") || destination.endsWith("/"))
      fail("imageBuild context role or destination is invalid");
    files.push({ path, contentBase64, role, destination });
  }
  return files;
}

function validateImageBuildProvisioning(input: unknown, files: PluginImageBuildContextFile[] | undefined): PluginImageBuildProvisioningStep[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > MAX_IMAGE_BUILD_STEPS)
    fail(`imageBuild.provisioning must contain at most ${MAX_IMAGE_BUILD_STEPS} steps`);
  return input.map((raw): PluginImageBuildProvisioningStep => {
    if (!isRecord(raw)) fail("imageBuild provisioning step must be an object");
    if (raw.type === "packages") {
      assertOnlyKeys(raw, ["type", "manager", "packages"], "imageBuild package provisioning");
      if (!(["apt", "npm", "pip"] as string[]).includes(String(raw.manager)) || !Array.isArray(raw.packages) || !raw.packages.length || raw.packages.length > 100)
        fail("imageBuild package provisioning is invalid");
      const packages = raw.packages.map((item, index) => {
        const value = requiredText(item, `imageBuild.provisioning.packages[${index}]`, 1, 512);
        if (value.startsWith("-") || !SAFE_BUILD_PACKAGE_RE.test(value)) fail("imageBuild package provisioning is invalid");
        assertNoSecretMaterial(value, "Plugin imageBuild package provisioning");
        return value;
      });
      return { type: "packages", manager: raw.manager as "apt" | "npm" | "pip", packages };
    }
    if (raw.type === "command") {
      assertOnlyKeys(raw, ["type", "command"], "imageBuild command provisioning");
      const command = requiredText(raw.command, "imageBuild.provisioning.command", 1, MAX_IMAGE_BUILD_COMMAND_BYTES).trim();
      if (!command) fail("imageBuild.provisioning.command is invalid");
      assertNoSecretMaterial(command, "Plugin imageBuild command provisioning");
      return { type: "command", command };
    }
    if (raw.type === "script") {
      assertOnlyKeys(raw, ["type", "path", "interpreter"], "imageBuild script provisioning");
      const path = requiredText(raw.path, "imageBuild.provisioning.path", 1, 512);
      const interpreter = raw.interpreter;
      if (!files?.some((file) => file.path === path && file.role === "script") || !(["sh", "bash", "python3", "node"] as string[]).includes(String(interpreter)))
        fail("imageBuild script provisioning must reference a context script with an approved interpreter");
      return { type: "script", path, interpreter: interpreter as "sh" | "bash" | "python3" | "node" };
    }
    fail("Unknown imageBuild provisioning step");
  });
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
    if (openMode !== "sandboxed-pane" && openMode !== "desktop")
      fail("Unsupported plugin action openMode");
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

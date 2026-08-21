import { createHash } from "node:crypto";
import {
  pluginDefinitionHash,
  validateDefinitionScope,
  validatePluginManifest,
  type PluginManifest,
} from "./plugin-manifest";
import type { PluginDefinitionRecord } from "./plugin-definition-store";

/** Git recovery format for reusable definitions only. Installations, assigned
 * ports/displays, observed state, credentials, and worker identities are never
 * represented here. */
export const GIT_PLUGIN_CATALOG_PATH = ".agentor/plugin-catalog.v1.json";
export const GIT_PLUGIN_CATALOG_FORMAT = {
  schema: "https://agentor.dev/schemas/plugin-catalog/v1",
  version: 1,
  layout: {
    manifest: GIT_PLUGIN_CATALOG_PATH,
    definition: "plugins/<id>/manifest.json",
    scripts: "plugins/<id>/scripts/<phase>.json",
    documentation: "plugins/<id>/{README.md,SKILL.md}",
    icon: "plugins/<id>/icon.svg",
  },
  notes: [
    "Plugin recovery contains reusable definitions only, never installations or runtime allocations.",
    "Credentials, secret values, and worker-local runtime state are never part of this format.",
  ],
} as const;
export type GitPluginFileMap = Record<string, string>;
type ScriptPhase = "install" | "start" | "stop" | "cleanup";
interface Entry {
  id: string; scope: string; ownerId: string | null; groupId?: string; workerId?: string;
  name: string; definitionHash: string; manifestPath: string;
  scripts: Partial<Record<ScriptPhase, string>>; documentation?: { markdown?: string; skillMarkdown?: string }; iconPath?: string;
}
interface Manifest { schema: string; version: 1; generatedAt: string; entries: Entry[]; }

const ID = /^[a-zA-Z0-9._-]{1,100}$/;
const SECRET = /(?:github_pat_[A-Za-z0-9_]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:token|secret|password|api[_-]?key)\b\s*[=:]\s*["']?[^\s"']{8,})/i;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeId(value: unknown) { const id = String(value || ""); if (!ID.test(id)) throw new Error("Plugin catalog entry ID is invalid"); return id; }
function noSecrets(value: unknown) {
  const text = stable(value).replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, "");
  if (SECRET.test(text)) throw new Error("Plugin catalog must not contain secret values");
}
function paths(id: string) { const root=`plugins/${id}`; return { root, manifest:`${root}/manifest.json`, icon:`${root}/icon.svg`, readme:`${root}/README.md`, skill:`${root}/SKILL.md`, script:(phase:ScriptPhase)=>`${root}/scripts/${phase}.json` }; }
function publicManifest(manifest: PluginManifest) {
  const copy = structuredClone(manifest);
  delete copy.iconSvg;
  delete copy.documentation;
  return copy;
}

export function serializePluginCatalog(definitions: PluginDefinitionRecord[]): GitPluginFileMap {
  const files: GitPluginFileMap = {};
  const entries: Entry[] = definitions.filter((definition) => !definition.builtIn).map((definition) => {
    safeId(definition.id);
    const normalized = validatePluginManifest(definition.manifest);
    const definitionHash = pluginDefinitionHash(normalized);
    if (definition.definitionHash !== definitionHash)
      throw new Error(`Plugin catalog entry ${definition.id} failed integrity validation`);
    noSecrets(normalized);
    const p = paths(definition.id), manifest = publicManifest(normalized);
    files[p.manifest] = `${JSON.stringify(manifest, null, 2)}\n`;
    const scripts: Entry["scripts"] = {};
    for (const phase of ["install", "start", "stop", "cleanup"] as ScriptPhase[]) {
      const command = normalized.lifecycle[phase];
      if (command) { const path = p.script(phase); files[path] = `${JSON.stringify(command, null, 2)}\n`; scripts[phase] = path; }
    }
    const documentation: Entry["documentation"] = {};
    if (normalized.documentation?.markdown) { files[p.readme] = normalized.documentation.markdown; documentation.markdown = p.readme; }
    if (normalized.documentation?.skillMarkdown) { files[p.skill] = normalized.documentation.skillMarkdown; documentation.skillMarkdown = p.skill; }
    if (normalized.iconSvg) files[p.icon] = normalized.iconSvg;
    return { id: definition.id, scope: definition.scope, ownerId: definition.userId, ...(definition.groupId ? { groupId: definition.groupId } : {}), ...(definition.workerId ? { workerId: definition.workerId } : {}), name: normalized.name, definitionHash, manifestPath: p.manifest, scripts, ...(Object.keys(documentation).length ? { documentation } : {}), ...(normalized.iconSvg ? { iconPath: p.icon } : {}) };
  });
  const manifest: Manifest = { schema: GIT_PLUGIN_CATALOG_FORMAT.schema, version: 1, generatedAt: new Date().toISOString(), entries };
  files[GIT_PLUGIN_CATALOG_PATH] = `${JSON.stringify(manifest, null, 2)}\n`;
  return files;
}

export function parsePluginCatalog(files: GitPluginFileMap): Array<Omit<PluginDefinitionRecord, "createdAt" | "updatedAt" | "builtIn">> {
  const raw = files[GIT_PLUGIN_CATALOG_PATH];
  if (!raw) throw new Error("Repository does not contain an Agentor plugin catalog manifest");
  let catalog: Manifest; try { catalog = JSON.parse(raw); } catch { throw new Error("Plugin catalog manifest is invalid JSON"); }
  if (catalog?.schema !== GIT_PLUGIN_CATALOG_FORMAT.schema || catalog.version !== 1 || !Array.isArray(catalog.entries)) throw new Error("Unsupported plugin catalog format");
  return catalog.entries.map((entry) => {
    const id = safeId(entry.id), p = paths(id), rawManifest = files[entry.manifestPath];
    if (!rawManifest || entry.manifestPath !== p.manifest) throw new Error(`Plugin catalog entry ${id} is incomplete`);
    let manifest: PluginManifest; try { manifest = validatePluginManifest(JSON.parse(rawManifest)); } catch { throw new Error(`Plugin catalog entry ${id} manifest is invalid`); }
    for (const phase of ["install", "start", "stop", "cleanup"] as ScriptPhase[]) {
      const scriptPath = entry.scripts?.[phase], command = manifest.lifecycle[phase];
      if (Boolean(scriptPath) !== Boolean(command) || (scriptPath && (scriptPath !== p.script(phase) || stable(JSON.parse(files[scriptPath] || "null")) !== stable(command)))) throw new Error(`Plugin catalog entry ${id} script integrity failed`);
    }
    if (entry.documentation?.markdown) {
      if (entry.documentation.markdown !== p.readme || files[p.readme] === undefined) throw new Error(`Plugin catalog entry ${id} documentation is incomplete`);
      manifest.documentation = { ...(manifest.documentation || {}), markdown: files[p.readme]! };
    }
    if (entry.documentation?.skillMarkdown) {
      if (entry.documentation.skillMarkdown !== p.skill || files[p.skill] === undefined) throw new Error(`Plugin catalog entry ${id} documentation is incomplete`);
      manifest.documentation = { ...(manifest.documentation || {}), skillMarkdown: files[p.skill]! };
    }
    if (entry.iconPath) {
      if (entry.iconPath !== p.icon || files[p.icon] === undefined) throw new Error(`Plugin catalog entry ${id} icon is incomplete`);
      manifest.iconSvg = files[p.icon];
    }
    manifest = validatePluginManifest(manifest); noSecrets(manifest);
    const identity = validateDefinitionScope({ scope: entry.scope, ownerId: entry.ownerId, groupId: entry.groupId, workerId: entry.workerId });
    const hash = pluginDefinitionHash(manifest);
    if (entry.definitionHash !== hash || entry.name !== manifest.name) throw new Error(`Plugin catalog entry ${id} failed integrity validation`);
    return { schemaVersion: 1, id, userId: identity.ownerId, scope: identity.scope, ...(identity.groupId ? { groupId: identity.groupId } : {}), ...(identity.workerId ? { workerId: identity.workerId } : {}), name: manifest.name, manifest, definitionHash: hash };
  });
}

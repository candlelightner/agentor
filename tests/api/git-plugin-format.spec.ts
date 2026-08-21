import { expect, test } from "@playwright/test";
import { parsePluginCatalog, serializePluginCatalog, GIT_PLUGIN_CATALOG_PATH } from "../../orchestrator/server/utils/git-plugin-format";

const definition: any = { schemaVersion: 1, id: "plugin-1", userId: "owner", scope: "owner", name: "Example", builtIn: false, definitionHash: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", manifest: { schemaVersion: 1, name: "Example", slug: "example", description: "Example", version: "1.0.0", iconSvg: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', lifecycle: { install: { argv: ["echo", "install"] }, start: { argv: ["echo", "start"] } }, documentation: { markdown: "# Example", skillMarkdown: "Use Example." } } };
import { pluginDefinitionHash, validatePluginManifest } from "../../orchestrator/server/utils/plugin-manifest";
definition.manifest = validatePluginManifest(definition.manifest);
definition.definitionHash = pluginDefinitionHash(definition.manifest);

test("plugin Git catalog round-trips definitions, scripts, docs and icon without runtime state", () => {
  const files = serializePluginCatalog([definition]);
  expect(files[GIT_PLUGIN_CATALOG_PATH]).toBeDefined();
  expect(files["plugins/plugin-1/scripts/start.json"]).toBeDefined();
  expect(files["plugins/plugin-1/README.md"]).toBeDefined();
  expect(files["plugins/plugin-1/SKILL.md"]).toBeDefined();
  expect(files["plugins/plugin-1/icon.svg"]).toBeDefined();
  expect(files["plugins/plugin-1/icon.svg"]).toBe(
    definition.manifest.iconSvg,
  );
  expect(JSON.stringify(files)).not.toContain("allocations");
  expect(parsePluginCatalog(files)).toMatchObject([
    {
      id: "plugin-1",
      userId: "owner",
      definitionHash: definition.definitionHash,
      manifest: {
        iconSvg: definition.manifest.iconSvg,
        lifecycle: { start: { argv: ["echo", "start"] } },
        documentation: {
          markdown: "# Example",
          skillMarkdown: "Use Example.",
        },
      },
    },
  ]);
});
test("plugin Git catalog rejects tampered scripts and literal secrets", () => {
  const files = serializePluginCatalog([definition]);
  files["plugins/plugin-1/scripts/start.json"] = JSON.stringify({ argv: ["echo", "changed"] });
  expect(() => parsePluginCatalog(files)).toThrow("script integrity");
  const secret = structuredClone(definition); secret.manifest.lifecycle.start.argv = ["echo", "github_pat_abcdefghijklmnopqrstuvwxyz"];
  expect(() => serializePluginCatalog([secret])).toThrow("secret");
});

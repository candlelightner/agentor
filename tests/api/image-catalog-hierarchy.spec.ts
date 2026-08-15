import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ImageCatalogManager } from "../../orchestrator/server/utils/image-catalog";

const definition = (name: string) => ({
  name,
  description: name,
  baseImage: "agentor-worker:approved-test",
  dockerfileFragment: "RUN true",
  contextFiles: [],
});

test("hierarchical image catalogs expose inherited images read-only and descendant images manageable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentor-image-hierarchy-"));
  try {
    const catalog = new ImageCatalogManager(directory);
    await catalog.init();
    const global = await catalog.create("owner", definition("global"));
    const ancestor = await catalog.createForGroup("owner", "ancestor", definition("ancestor"));
    const own = await catalog.createForGroup("owner", "own", definition("own"));
    const descendant = await catalog.createForGroup("owner", "descendant", definition("descendant"));
    await catalog.createForGroup("owner", "sibling", definition("sibling"));
    await catalog.createForGroup("other-owner", "own", definition("foreign"));

    const visible = catalog.listForGroupHierarchy(
      "owner",
      ["ancestor", "own", "descendant"],
      ["own", "descendant"],
    );
    expect(visible.map((item) => item.id)).toEqual([
      global.id,
      ancestor.id,
      own.id,
      descendant.id,
    ]);
    expect(visible.find((item) => item.id === global.id)?.access.manageable).toBe(false);
    expect(visible.find((item) => item.id === ancestor.id)?.access.manageable).toBe(false);
    expect(visible.find((item) => item.id === own.id)?.access.manageable).toBe(true);
    expect(visible.find((item) => item.id === descendant.id)?.access.manageable).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

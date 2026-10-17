function assertTreeEntry(tree, name, kind) {
  if (tree.has(name)) throw new Error("Instance backup archive has a duplicate entry");
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = tree.get(parts.slice(0, index).join("/"));
    if (ancestor && ancestor !== "directory")
      throw new Error("Instance backup archive traverses a non-directory");
  }
  for (const existing of tree.keys())
    if (existing.startsWith(`${name}/`) && kind !== "directory")
      throw new Error("Instance backup archive replaces an existing parent");
}
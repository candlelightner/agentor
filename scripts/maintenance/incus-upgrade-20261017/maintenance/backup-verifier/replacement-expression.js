(() => {
  const caches = new WeakMap();
  const addParents = (parents, value) => {
    for (let offset = value.indexOf('/'); offset !== -1; offset = value.indexOf('/', offset + 1))
      parents.add(value.slice(0, offset));
  };
  return function assertTreeEntryLinear(tree, name, kind) {
    if (tree.has(name)) throw new Error('Instance backup archive has a duplicate entry');
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = tree.get(parts.slice(0, index).join('/'));
      if (ancestor && ancestor !== 'directory')
        throw new Error('Instance backup archive traverses a non-directory');
    }
    let cache = caches.get(tree);
    if (!cache || cache.expectedSize !== tree.size) {
      cache = { expectedSize: tree.size, parents: new Set() };
      for (const existing of tree.keys()) addParents(cache.parents, existing);
      caches.set(tree, cache);
    }
    if (kind !== 'directory' && cache.parents.has(name))
      throw new Error('Instance backup archive replaces an existing parent');
    addParents(cache.parents, name);
    cache.expectedSize = tree.size + 1;
  };
})()

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const dir = __dirname;
const original = vm.runInNewContext(`(${fs.readFileSync(`${dir}/original-function.js`, 'utf8')})`);
const replacementSource = fs.readFileSync(`${dir}/replacement-expression.js`, 'utf8');
const makeReplacement = () => vm.runInNewContext(replacementSource);
const kinds = ['file', 'directory', 'symlink', 'hardlink'];
let comparisons = 0;
function outcome(fn, tree, name, kind) {
  try { fn(tree, name, kind); return 'accepted'; }
  catch (error) { return error.message; }
}
function compareSequence(entries, seed = []) {
  const a = new Map(seed), b = new Map(seed), fast = makeReplacement();
  for (const [name, kind] of entries) {
    const expected = outcome(original, a, name, kind);
    const actual = outcome(fast, b, name, kind);
    assert.equal(actual, expected, JSON.stringify({ seed, entries, name, kind }));
    comparisons++;
    if (actual === 'accepted') { a.set(name, kind); b.set(name, kind); }
  }
}
// Exhaustively check path relationships against all small accepted trees.
const names = ['a', 'b', 'a/b', 'a/b/c', 'a/bc', 'a.b', 'a.b/c'];
function explore(seed, depth) {
  for (const name of names) for (const kind of kinds) {
    const entries = [[name, kind]];
    compareSequence(entries, seed);
    if (depth && outcome(original, new Map(seed), name, kind) === 'accepted')
      explore([...seed, [name, kind]], depth - 1);
  }
}
explore([], 2);
// Deterministic random sequences check persistent caches after accepted and
// rejected entries, including out-of-order parents and sibling-prefix names.
let randomState = 17719;
function random(n) { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % n; }
for (let trial = 0; trial < 300; trial++) {
  const entries = [];
  for (let i = 0; i < 120; i++) {
    const depth = 1 + random(5);
    const path = Array.from({ length: depth }, () => `part${random(15)}`).join('/');
    entries.push([path, kinds[random(kinds.length)]]);
  }
  compareSequence(entries);
}
// Attaching mid-archive must reconstruct the existing map and retain all checks.
const seed = Array.from({ length: 5000 }, (_, i) => [`root/sub${i}/file`, 'file']);
compareSequence([['root', 'file'], ['root', 'directory'], ['root/sub2', 'symlink'],
  ['root/sub2/file', 'file'], ['root/sub2/extra', 'file'], ['root/sub2', 'directory']], seed);
// The production validator only appends to its map. Unexpected size changes
// rebuild the cache; no parent-conflict protection is skipped.
const fast = makeReplacement(), tree = new Map();
fast(tree, 'a/b', 'file'); tree.set('a/b', 'file');
tree.clear(); fast(tree, 'a', 'file'); tree.set('a', 'file');
assert.throws(() => fast(tree, 'a/b', 'file'), /non-directory/);
// Simulate one million archive entries, beyond the problematic prefix.
const large = new Map(), linear = makeReplacement();
const start = performance.now();
for (let i = 0; i < 1000000; i++) {
  const name = `workspace/project${Math.floor(i / 1000)}/file${i}`;
  linear(large, name, 'file'); large.set(name, 'file');
}
assert.throws(() => linear(large, 'workspace/project0', 'hardlink'), /existing parent/);
console.log(JSON.stringify({ status: 'passed', comparisons, millionEntryMs: Math.round(performance.now() - start) }));

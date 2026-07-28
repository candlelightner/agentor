import { createError } from 'h3';

/**
 * Centralised validation + normalisation for client-supplied workspace paths.
 *
 * The file manager exposes paths as POSIX paths RELATIVE to the worker's
 * `/workspace` root (e.g. `src/index.ts`, `docs/`, or `` for the root). This
 * module is the single chokepoint that turns a client string into a safe,
 * normalised relative path, and rejects anything that could escape `/workspace`
 * lexically (a second, in-container realpath/lstat containment check runs in
 * the worker via Docker exec — see `ContainerManager` — so a symlink can never
 * redirect an operation outside `/workspace`).
 *
 * Host workspace paths are NEVER used: every operation runs through Docker
 * exec/getArchive/putArchive against the running worker container.
 */

/** Absolute in-container path of the worker workspace root. */
export const WORKSPACE_ROOT = '/workspace';

/** Maximum total request body size for multipart uploads (100 MiB). */
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
/** Maximum number of tar entries accepted in a single upload. */
export const MAX_UPLOAD_ENTRIES = 1000;
/** Maximum path depth (number of segments) below the workspace root. */
export const MAX_PATH_DEPTH = 64;
/** Maximum length of a single path component (basename). */
export const MAX_NAME_LENGTH = 255;
/** Maximum length of a normalised relative path. */
export const MAX_REL_PATH_LENGTH = 4096;

/** Rejects NUL and all ASCII control characters (0x00-0x1f and 0x7f). */
const CONTROL_OR_NUL_RE = /[\x00-\x1f\x7f]/;

/**
 * Validate and normalise a client-supplied workspace path.
 *
 * Accepts a POSIX path relative to `/workspace`:
 * - the empty string (or `.`) denotes the workspace root and normalises to ``;
 * - leading/trailing slashes are stripped;
 * - segments `.` are collapsed and empty segments (other than the root) are
 *   rejected;
 * - `..` segments, absolute paths, backslashes, NUL/control characters, and
 *   excessive depth/name length are rejected with a 400.
 *
 * Returns the normalised relative path (no leading/trailing slash; `` for the
 * root). Throws an h3 400 `createError` on any violation.
 */
export function normalizeClientPath(raw: unknown, opts: { allowRoot?: boolean } = {}): string {
  const allowRoot = opts.allowRoot !== false;
  if (typeof raw !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'path must be a string' });
  }
  if (raw === '' || raw === '.' || raw === './') {
    if (!allowRoot) {
      throw createError({ statusCode: 400, statusMessage: 'path must not be the workspace root' });
    }
    return '';
  }
  if (CONTROL_OR_NUL_RE.test(raw)) {
    throw createError({ statusCode: 400, statusMessage: 'path must not contain NUL or control characters' });
  }
  if (raw.includes('\\')) {
    throw createError({ statusCode: 400, statusMessage: 'path must not contain backslashes' });
  }
  // Reject absolute paths (POSIX or Windows drive letters).
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw createError({ statusCode: 400, statusMessage: 'path must be relative to the workspace root' });
  }

  const segments = raw.split('/').flatMap((seg) => (seg === '' ? [] : [seg]));
  const cleaned: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      throw createError({ statusCode: 400, statusMessage: 'path must not contain parent-directory (..) segments' });
    }
    if (seg === '') continue; // already filtered, defensive
    if (seg.length > MAX_NAME_LENGTH) {
      throw createError({ statusCode: 400, statusMessage: `path component exceeds ${MAX_NAME_LENGTH} characters` });
    }
    cleaned.push(seg);
  }
  if (cleaned.length === 0) {
    if (!allowRoot) {
      throw createError({ statusCode: 400, statusMessage: 'path must not be the workspace root' });
    }
    return '';
  }
  if (cleaned.length > MAX_PATH_DEPTH) {
    throw createError({ statusCode: 400, statusMessage: `path exceeds maximum depth of ${MAX_PATH_DEPTH}` });
  }
  const rel = cleaned.join('/');
  if (rel.length > MAX_REL_PATH_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `path exceeds maximum length of ${MAX_REL_PATH_LENGTH}` });
  }
  return rel;
}

/**
 * Validate a single path component (basename) — used by `rename` where only a
 * new name, not a full path, is supplied. Rejects empty, `.`, `..`, slashes,
 * backslashes, NUL/control, and length violations with a 400.
 */
export function validateName(raw: unknown, field = 'newName'): string {
  if (typeof raw !== 'string' || raw === '') {
    throw createError({ statusCode: 400, statusMessage: `${field} must be a non-empty string` });
  }
  if (raw === '.' || raw === '..') {
    throw createError({ statusCode: 400, statusMessage: `${field} must not be '.' or '..'` });
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw createError({ statusCode: 400, statusMessage: `${field} must not contain path separators` });
  }
  if (CONTROL_OR_NUL_RE.test(raw)) {
    throw createError({ statusCode: 400, statusMessage: `${field} must not contain NUL or control characters` });
  }
  if (raw.length > MAX_NAME_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `${field} exceeds ${MAX_NAME_LENGTH} characters` });
  }
  return raw;
}

/**
 * Validate and normalise a list of client paths, deduplicating while preserving
 * order. `allowRoot` is forwarded to `normalizeClientPath` for each entry. The
 * workspace root (``) is always rejected as a deletable/movable target.
 */
export function normalizeClientPathList(raw: unknown, opts: { allowRoot?: boolean } = {}): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'paths must be a non-empty array' });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const rel = normalizeClientPath(item, opts);
    const key = rel; // '' already rejected when allowRoot is false
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  return out;
}

/** Convert a normalised relative workspace path to its in-container absolute
 *  path (`/workspace` for the root, `/workspace/<rel>` otherwise). The input
 *  MUST already be a `normalizeClientPath` result. */
export function toContainerPath(rel: string): string {
  if (rel === '') return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}/${rel}`;
}

/** Derive the parent relative path of a normalised relative path. Returns ``
 *  for a top-level entry; returns `` for the root itself. */
export function parentRelPath(rel: string): string {
  if (rel === '') return '';
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

/** Basename of a normalised relative path (`.` for the root). */
export function baseName(rel: string): string {
  if (rel === '') return '.';
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? rel : rel.slice(idx + 1);
}

/**
 * Filter out selections that are descendants of another selected directory, so
 * a download/move that selects both `dir` and `dir/sub.txt` does not produce
 * duplicate archive entries (the folder's tar already contains the child).
 * Inputs MUST be normalised relative paths. Returns a new, de-duplicated array
 * preserving the original order of the kept (ancestor) entries.
 *
 * Example: `['a', 'a/b', 'c']` -> `['a', 'c']`.
 */
export function filterRedundantDescendants(rels: string[]): string[] {
  const sorted = [...rels].sort();
  const kept: string[] = [];
  // Track kept directory prefixes so a descendant can be dropped in O(n log n).
  // A path `p` is redundant when some kept ancestor `a` satisfies
  // `p === a` or `p.startsWith(a + '/')`.
  for (const p of sorted) {
    if (kept.some((a) => p === a || p.startsWith(`${a}/`))) continue;
    kept.push(p);
  }
  // Restore original order of the survivors.
  return rels.filter((p) => kept.includes(p));
}
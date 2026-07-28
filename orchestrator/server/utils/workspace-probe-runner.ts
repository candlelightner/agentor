import { createError } from 'h3';
import type { DockerService } from './docker';
import { WORKSPACE_PROBE_SCRIPT } from './workspace-probe';
import type { ProbeResult } from './workspace-probe';
import { toContainerPath } from './workspace-path';
import type { FileEntry, FileListing } from '../../shared/types';

/**
 * Run the audited workspace probe inside a worker container and parse its JSON
 * result. The probe runs as uid 1000 (`agent`); the script body is a fixed
 * constant and every path is passed as a separate argv element (or via stdin
 * for `check_many`), so no path is ever interpolated into source.
 *
 * On a probe failure (`ok: false`) this throws an h3 error with a precise
 * status code:
 *   not_found      -> 404
 *   escapes        -> 400 (symlink traversal attempt)
 *   not_directory  -> 409
 *   bad_args       -> 500 (programming error)
 *   other          -> 500
 */
export async function runProbe(
  docker: DockerService,
  containerId: string,
  subcommand: 'lstat' | 'list',
  rel: string,
): Promise<ProbeResult> {
  const full = toContainerPath(rel);
  const res = await docker.execCapture(containerId, ['python3', '-c', WORKSPACE_PROBE_SCRIPT, subcommand, full], {
    user: 'agent',
  });
  return parseProbe(res.stdout, res.stderr, res.exitCode, subcommand);
}

/**
 * Run the `check_many` probe: pass a list of normalised relative paths, get back
 * which already exist and which (symlinks) escape `/workspace`. Paths are sent
 * as JSON on stdin — never interpolated.
 */
export async function runProbeCheckMany(
  docker: DockerService,
  containerId: string,
  rels: string[],
): Promise<{ existing: string[]; escaping: string[] }> {
  const absPaths = rels.map(toContainerPath);
  const stdin = Buffer.from(JSON.stringify(absPaths));
  const res = await docker.execCapture(containerId, ['python3', '-c', WORKSPACE_PROBE_SCRIPT, 'check_many'], {
    user: 'agent',
    stdin,
  });
  const parsed = parseProbe(res.stdout, res.stderr, res.exitCode, 'check_many');
  if (!parsed.ok) throw probeErrorToHttp(parsed);
  return { existing: parsed.existing ?? [], escaping: parsed.escaping ?? [] };
}

function parseProbe(
  stdout: Buffer,
  stderr: Buffer,
  exitCode: number,
  subcommand: string,
): ProbeResult {
  const text = stdout.toString('utf8').trim();
  if (text === '') {
    // No stdout — treat as a hard failure (the probe always emits JSON).
    throw createError({
      statusCode: 500,
      statusMessage: `workspace probe '${subcommand}' produced no output${stderr.length ? `: ${stderr.toString('utf8').trim()}` : ''}`,
    });
  }
  let parsed: ProbeResult;
  try {
    parsed = JSON.parse(text) as ProbeResult;
  } catch {
    throw createError({
      statusCode: 500,
      statusMessage: `workspace probe '${subcommand}' returned non-JSON output`,
    });
  }
  return parsed;
}

/** Convert a failed probe result into a precise h3 error. */
export function probeErrorToHttp(result: Extract<ProbeResult, { ok: false }>): never {
  switch (result.error) {
    case 'not_found':
      throw createError({ statusCode: 404, statusMessage: 'Path not found in workspace' });
    case 'escapes':
      throw createError({ statusCode: 400, statusMessage: 'Path escapes the workspace root' });
    case 'not_directory':
      throw createError({ statusCode: 409, statusMessage: 'Path is not a directory' });
    case 'bad_args':
      throw createError({ statusCode: 500, statusMessage: 'Workspace probe invoked incorrectly' });
    default:
      throw createError({
        statusCode: 500,
        statusMessage: `Workspace probe failed: ${result.message || result.error}`,
      });
  }
}

/** `lstat` a single relative path; throws an h3 error on failure. */
export async function probeLstat(docker: DockerService, containerId: string, rel: string): Promise<FileEntry> {
  const r = await runProbe(docker, containerId, 'lstat', rel);
  if (!r.ok) throw probeErrorToHttp(r);
  if (!r.entry) throw createError({ statusCode: 500, statusMessage: 'Workspace probe returned no entry' });
  return r.entry;
}

/** One-level directory listing; throws an h3 error on failure. */
export async function probeList(docker: DockerService, containerId: string, rel: string): Promise<FileListing> {
  const r = await runProbe(docker, containerId, 'list', rel);
  if (!r.ok) throw probeErrorToHttp(r);
  return { path: rel, entries: r.entries ?? [] };
}
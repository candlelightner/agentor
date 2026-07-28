import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import archiver from 'archiver';
import type { DockerService } from './docker';
import { toContainerPath, filterRedundantDescendants } from './workspace-path';
import type { FileEntry } from '../../shared/types';

/**
 * Streaming workspace archive assembly for the file manager download endpoint.
 *
 * Two helpers live here:
 *
 * 1. `demuxSingleFileFromTar` — for a single regular file, the route streams
 *    raw bytes by demuxing the Docker tar envelope (from `getArchive`) into a
 *    PassThrough carrying just the file's content. No host path is ever
 *    exposed; the Docker tar is consumed and only the file payload is emitted.
 *
 * 2. `buildWorkspaceZip` — for multiple selections and/or folders, a TRUE ZIP
 *    is streamed. It consumes the Docker tar archive (`getArchive`) of each
 *    selected path and re-encodes the entries into a ZIP via `archiver`:
 *    relative names are preserved, hidden files are included (the Docker tar
 *    already contains them), and symlinks are STORED as symlink entries without
 *    following external targets. Nothing is buffered in memory — the Docker
 *    tar is piped through `tar-stream`'s extractor straight into `archiver`
 *    with backpressure, and the resulting ZIP Readable is returned for the
 *    route to stream. Host paths never appear in the archive.
 *
 *    The output PassThrough is returned IMMEDIATELY and the sequential
 *    append/finalize work runs in a detached async task. This is essential:
 *    archiver only emits bytes once a consumer reads the output, so awaiting
 *    all tar->archiver work before returning would deadlock under backpressure
 *    (the route has not started reading yet). Errors and source teardown are
 *    propagated by destroying the output and any in-flight Docker tar.
 */

/**
 * Demux the single file entry out of a Docker `getArchive` tar stream and
 * return a Readable of just that file's bytes. `expectedSize` is the lstat
 * size (used only as a sanity bound; the tar header is authoritative). The
 * returned stream ends when the file entry is fully consumed; a tar error or an
 * unexpected (multi-entry / non-file) envelope destroys it.
 */
export function demuxSingleFileFromTar(tarStream: NodeJS.ReadableStream, expectedSize: number): Readable {
  const out = new PassThrough();
  const extract = tar.extract();
  let handled = false;

  extract.on('entry', (header, stream, next) => {
    if (handled) {
      // Ignore any extra entries (there should be exactly one for a single file).
      stream.on('end', next);
      stream.resume();
      return;
    }
    handled = true;
    if (header.type !== 'file') {
      stream.on('end', next);
      stream.resume();
      out.destroy(new Error(`expected a file entry in the workspace tar, got '${header.type}'`));
      return;
    }
    // Pipe the entry's content into the output. When it ends, advance the
    // extractor so it can drain the trailing tar padding.
    stream.on('end', next);
    stream.pipe(out, { end: false });
  });
  extract.on('finish', () => {
    if (!out.writableEnded) out.end();
  });
  extract.on('error', (err) => out.destroy(err));

  // Drive the tar stream into the extractor; errors tear down the output.
  void pipeline(tarStream, extract).catch((err) => {
    if (!out.destroyed) out.destroy(err instanceof Error ? err : new Error(String(err)));
  });

  // If the consumer aborts early, stop reading the Docker tar.
  out.on('close', () => {
    if (!extract.destroyed) extract.destroy();
    const tar = tarStream as Readable;
    if (!tar.destroyed) tar.destroy();
  });

  // expectedSize is informational only — the tar header governs the bytes.
  void expectedSize;
  return out;
}

/**
 * Build a streaming ZIP from one or more workspace entries (files, folders,
 * symlinks). Redundant descendant selections (e.g. both `dir` and `dir/sub`)
 * are filtered out so the archive never contains duplicate entries. Each
 * kept entry's Docker tar archive is consumed and re-encoded into the ZIP
 * preserving relative names (the Docker tar prefixes entries with the basename
 * of the requested path; we strip that prefix so the archive roots at the
 * selected relative path). Hidden files are included (present in the Docker
 * tar). Symlinks are stored as symlink entries (linkname = raw target) WITHOUT
 * following external targets, so an escaping symlink becomes a dangling
 * in-archive link rather than pulling host data in.
 *
 * Returns a Node Readable of the ZIP bytes IMMEDIATELY; the sequential
 * append/finalize runs in a detached async task so output backpressure cannot
 * deadlock before the route consumes the stream. The route streams it with
 * backpressure and wires client-close cleanup.
 */
export function buildWorkspaceZip(
  docker: DockerService,
  containerId: string,
  entries: FileEntry[],
): Readable {
  const zip = archiver('zip', { zlib: { level: 1 } });
  const out = new PassThrough();
  let activeTar: NodeJS.ReadableStream | null = null;

  // archiver emits its own errors asynchronously (e.g. a bad entry); forward
  // them to the output so the route surfaces a failed stream rather than a
  // truncated one.
  zip.on('error', (err) => {
    if (!out.destroyed) out.destroy(err);
  });
  zip.pipe(out);

  // If the consumer aborts early, tear down archiver and any in-flight source.
  out.on('close', () => {
    zip.abort();
    if (activeTar && !(activeTar as Readable).destroyed) (activeTar as Readable).destroy();
  });

  // Detached driver: sequentially fetch each entry's Docker tar and re-encode it
  // into the ZIP, then finalize. Running this detached (not awaited before
  // returning `out`) is what prevents the backpressure deadlock — archiver
  // only produces bytes once the route reads `out`, so the append/finalize
  // must overlap with the route's consumption.
  void (async () => {
    try {
      const kept = filterRedundantDescendants(entries.map((e) => e.path));
      for (const rel of kept) {
        const abs = toContainerPath(rel);
        activeTar = await docker.getArchive(containerId, abs);
        await appendTarToZip(activeTar, zip, rel);
        activeTar = null;
      }
      activeTar = null;
      await zip.finalize();
    } catch (err) {
      zip.abort();
      if (activeTar && !(activeTar as Readable).destroyed) (activeTar as Readable).destroy();
      if (!out.destroyed) out.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return out;
}

/**
 * Consume a Docker tar stream and append every entry into the ZIP, rewriting
 * the entry name so it is rooted at `rootRel` (the selected relative path
 * inside /workspace). The Docker tar of `getArchive(/workspace/<rootRel>)`
 * prefixes entries with the basename of the requested path (e.g. `dir/...`),
 * so we strip that single leading prefix segment and re-attach `rootRel`.
 *
 * Symlinks (`type: 'symlink'`) are appended via `zip.symlink` with their raw
 * `linkname` — never followed. Directories and files are appended with their
 * content stream piped into `archiver.append` for backpressure. A synchronous
 * `zip.append`/`zip.symlink` throw (queue closed / bad args) REJECTS the
 * promise rather than silently truncating the archive.
 */
function appendTarToZip(tarStream: NodeJS.ReadableStream, zip: archiver.Archiver, rootRel: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let prefix: string | null = null;
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      if (!extract.destroyed) extract.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    extract.on('entry', (header, stream, next) => {
      if (failed) {
        stream.on('end', next);
        stream.resume();
        return;
      }
      // Determine the leading prefix segment shared by every entry (the
      // basename of the requested path). Strip exactly that one segment.
      if (prefix === null) {
        const firstSlash = header.name.indexOf('/');
        prefix = firstSlash < 0 ? header.name : header.name.slice(0, firstSlash);
      }
      let relName = prefix ? header.name.slice(prefix.length + 1) : header.name;
      relName = relName.replace(/^\/+/, '');
      // Final archive name rooted at the selected relative path.
      const archiveName = rootRel === '' ? relName : (relName ? `${rootRel}/${relName}` : rootRel);

      if (header.type === 'symlink') {
        try {
          zip.symlink(archiveName, header.linkname ?? '', header.mode ?? 0o777);
        } catch (e) {
          // A synchronous throw means the entry could not be queued — reject so
          // the archive is aborted rather than silently missing the entry.
          stream.on('end', next);
          stream.resume();
          fail(e);
          return;
        }
        stream.on('end', next);
        stream.resume();
        return;
      }

      if (header.type === 'directory') {
        const name = archiveName.endsWith('/') ? archiveName : `${archiveName}/`;
        try {
          zip.append(stream, { name, type: 'directory', mode: header.mode ?? 0o755 });
        } catch (e) {
          stream.on('end', next);
          stream.resume();
          fail(e);
          return;
        }
        stream.on('end', next);
        return;
      }

      // Regular file (and any other typed entry is treated as a file payload).
      try {
        zip.append(stream, { name: archiveName, type: 'file', mode: header.mode ?? 0o644 });
      } catch (e) {
        stream.on('end', next);
        stream.resume();
        fail(e);
        return;
      }
      stream.on('end', next);
    });

    extract.on('finish', () => {
      if (!failed) resolve();
    });
    extract.on('error', fail);

    void pipeline(tarStream, extract).catch(fail);
  });
}
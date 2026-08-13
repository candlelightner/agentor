import type {
  FileListing,
  MkdirRequest,
  RenameRequest,
  MoveRequest,
  MoveResult,
  MoveConflict,
  DeleteFilesResult,
  UploadFilesResult,
} from '~/types';

/** Outcome of a mutating operation that may surface a conflict list. When the
 *  server returns 409 with a conflict list the caller can retry with
 *  `overwrite: true` after explicit user confirmation. */
export interface WorkspaceFilesConflict {
  conflicts: string[] | MoveConflict[];
}

/** The discriminated result of `upload`/`move` — either a clean success or a
 *  conflict the UI must confirm before retrying with overwrite. */
export type WorkspaceFilesMutationResult =
  | { ok: true; data: UploadFilesResult | MoveResult }
  | { ok: false; conflict: WorkspaceFilesConflict; message: string };

/** A browser-side download triggered from `download`/`downloadWorkspace`. */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a short delay so the click has flushed to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Parse a `Content-Disposition` attachment filename, preferring the quoted
 *  `filename=` form and falling back to the server's default. */
function dispositionFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

/** Workspace file manager client. Wraps the `/api/containers/:id/files` routes
 *  with typed shared models and the app's `fetchErrorMessage`/toast
 *  conventions. All paths are POSIX paths relative to `/workspace` (`` for the
 *  root). The composable is stateless about the current directory — the owning
 *  component tracks the breadcrumb and calls `list` on navigation/refresh. */
export function useWorkspaceFiles(containerId: MaybeRefOrGetter<string>) {
  const toast = useToast();
  const idRef = toRef(containerId);

  function base(): string {
    return `/api/containers/${idRef.value}/files`;
  }

  /** `GET /files?path=` — one-level directory listing (dirs first). */
  async function list(path: string): Promise<FileListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return await $fetch<FileListing>(`${base()}${query}`);
  }

  /** `POST /files/mkdir` — create a directory (and parents). Idempotent. */
  async function mkdir(path: string, lockPassword?: string): Promise<void> {
    const body: MkdirRequest = { path, ...(lockPassword ? { lockPassword } : {}) };
    await $fetch(`${base()}/mkdir`, { method: 'POST', body });
  }

  /** `POST /files/rename` — same-directory rename, no overwrite. */
  async function rename(path: string, newName: string, lockPassword?: string): Promise<void> {
    const body: RenameRequest = { path, newName, ...(lockPassword ? { lockPassword } : {}) };
    await $fetch(`${base()}/rename`, { method: 'POST', body });
  }

  /** `POST /files/move` — move `paths` into the existing `destination`.
   *  Returns a conflict result instead of throwing on 409 so the UI can offer
   *  an explicit overwrite retry. */
  async function move(
    paths: string[],
    destination: string,
    overwrite = false,
    lockPassword?: string,
  ): Promise<WorkspaceFilesMutationResult> {
    const body: MoveRequest = { paths, destination, overwrite, ...(lockPassword ? { lockPassword } : {}) };
    try {
      const data = await $fetch<MoveResult>(`${base()}/move`, { method: 'POST', body });
      return { ok: true, data };
    } catch (err: any) {
      const conflicts = err?.data?.data?.conflicts ?? err?.data?.conflicts;
      const status = err?.statusCode ?? err?.response?.status ?? err?.status;
      if (status === 409 && Array.isArray(conflicts)) {
        return {
          ok: false,
          conflict: { conflicts },
          message: fetchErrorMessage(err, 'Move conflicts with existing paths'),
        };
      }
      throw err;
    }
  }

  /** `DELETE /files` with JSON `{ paths }`. Missing paths are ignored. */
  async function remove(paths: string[], lockPassword?: string): Promise<DeleteFilesResult> {
    return await $fetch<DeleteFilesResult>(`${base()}`, {
      method: 'DELETE',
      body: { paths, ...(lockPassword ? { lockPassword } : {}) },
    });
  }

  /** `POST /files/upload` (multipart). `files` carry their relative path in
   *  `file.name` (preserving dropped/selected directory trees). First attempt
   *  uses `overwrite=false`; on 409 a conflict result is returned so the UI can
   *  confirm and retry with `overwrite=true`. The 100 MiB / entry caps surface
   *  as 413. */
  async function upload(
    path: string,
    files: File[],
    overwrite = false,
    lockPassword?: string,
  ): Promise<WorkspaceFilesMutationResult> {
    const formData = new FormData();
    formData.append('path', path);
    formData.append('overwrite', overwrite ? 'true' : 'false');
    if (lockPassword) formData.append('lockPassword', lockPassword);
    for (const file of files) {
      // `file.name` already carries the relative folder path (FileDropZone /
      // webkitRelativePath preservation), so appending with the name keeps the
      // tree intact on the server.
      formData.append('file', file, file.name);
    }
    try {
      const data = await $fetch<UploadFilesResult>(`${base()}/upload`, {
        method: 'POST',
        body: formData,
      });
      return { ok: true, data };
    } catch (err: any) {
      const conflicts = err?.data?.data?.conflicts ?? err?.data?.conflicts;
      const status = err?.statusCode ?? err?.response?.status ?? err?.status;
      if (status === 409 && Array.isArray(conflicts)) {
        return {
          ok: false,
          conflict: { conflicts: conflicts as string[] },
          message: fetchErrorMessage(err, 'Upload conflicts with existing paths'),
        };
      }
      throw err;
    }
  }

  /** `POST /files/download` (JSON `{ paths }`). Streams a raw single file or a
   *  ZIP. Buffers the response into a Blob (acceptable in the UI) and triggers
   *  a browser download using the server's Content-Disposition filename. Uses
   *  native `fetch` (not `$fetch`) so the response headers — and therefore the
   *  server-chosen filename — are available. */
  async function download(paths: string[]): Promise<void> {
    const res = await fetch(`${base()}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      const message = await res.text().catch(() => '');
      throw new Error(message || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const single = paths.length === 1 ? paths[0] : '';
    const filename = dispositionFilename(
      res.headers.get('Content-Disposition'),
      single && !single.endsWith('/')
        ? single.split('/').pop() || 'download'
        : 'workspace-download.zip',
    );
    triggerDownload(blob, filename);
  }

  /** Standardised success toast. */
  function toastSuccess(title: string, description?: string) {
    toast.add({
      title,
      description,
      color: 'success',
      icon: 'i-lucide-check',
    });
  }

  /** Standardised error toast from a thrown $fetch/h3 error. */
  function toastError(title: string, err: unknown, fallback: string) {
    toast.add({
      title,
      description: fetchErrorMessage(err, fallback),
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
  }

  return {
    list,
    mkdir,
    rename,
    move,
    remove,
    upload,
    download,
    toastSuccess,
    toastError,
    dispositionFilename,
  };
}

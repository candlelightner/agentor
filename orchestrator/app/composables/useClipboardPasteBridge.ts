import { fetchErrorMessage } from '~/utils/fetch-error';

/**
 * Shared clipboard-paste bridge for keyboard-transparent host → worker paste.
 *
 * Used by the xterm terminal integration (and conceptually mirrored by the
 * standalone noVNC bridge module). On a real Ctrl/Cmd+V keydown user gesture it
 * feature-detects the secure `navigator.clipboard.read()` API, reads the
 * ClipboardItems, prefers the first image, normalises non-PNG browser-decodable
 * images to PNG (via `createImageBitmap` + `OffscreenCanvas`, with an
 * `HTMLCanvasElement` fallback for Firefox), caps the payload before POSTing,
 * and POSTs the raw bytes to `POST /api/containers/:id/clipboard`.
 *
 * Concurrency is guarded per target so two rapid Ctrl+V presses cannot race.
 * Success is silent; failure gets a concise toast that NEVER includes clipboard
 * contents. Unsupported/denied are distinguished so the caller can replay the
 * original key and keep existing behaviour.
 *
 * For text, the composable returns the text without hitting the X clipboard in
 * the Agentor Terminal — the xterm caller pastes it through `term.paste()` /
 * the bracketed-paste path, not via Ctrl+V.
 */

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MiB — matches the server cap
const MAX_TEXT_BYTES = 1 * 1024 * 1024;  // 1 MiB — matches the server cap

export type ClipboardTarget = 'terminal' | 'desktop';

export type ClipboardReadResult =
  | { kind: 'image'; bytes: Uint8Array; width: number; height: number }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'error' };

export interface ClipboardPostResult {
  ok: boolean;
  type: 'image/png' | 'text/plain';
  width?: number;
  height?: number;
}

/** True when the async Clipboard API is usable in the current secure context. */
export function clipboardReadAvailable(): boolean {
  return typeof navigator !== 'undefined'
    && window.isSecureContext
    && typeof navigator.clipboard !== 'undefined'
    && typeof navigator.clipboard.read === 'function';
}

/** Encode a Blob to PNG bytes. Prefers OffscreenCanvas; falls back to an
 *  HTMLCanvasElement for browsers (e.g. older Firefox) without OffscreenCanvas
 *  or where `convertToBlob` is unavailable. Returns null when the image cannot
 *  be decoded/encoded in this browser. */
async function blobToPng(blob: Blob): Promise<Uint8Array | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const w = bitmap.width;
  const h = bitmap.height;
  if (w <= 0 || h <= 0) return null;

  // OffscreenCanvas path (Chromium, modern Firefox).
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        if (pngBlob) return new Uint8Array(await pngBlob.arrayBuffer());
      }
    } catch {
      // fall through to HTMLCanvasElement path
    }
  }

  // HTMLCanvasElement fallback (works in Firefox and Safari).
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Read the host clipboard on a real user gesture. Returns a discriminated
 *  result so the caller can act appropriately (paste text, POST image, or
 *  replay the original key on unsupported/denied/error). Never logs contents. */
export async function readClipboardForPaste(): Promise<ClipboardReadResult> {
  if (!clipboardReadAvailable()) return { kind: 'unsupported' };

  let items: ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch (err: any) {
    // NotAllowedError / SecurityError → permission denied; anything else is a
    // generic read failure. Distinguishing denied lets the caller decide
    // whether to replay the original key (preserving existing behaviour).
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      return { kind: 'denied' };
    }
    return { kind: 'error' };
  }
  if (!items || items.length === 0) return { kind: 'error' };

  // Prefer the first image-bearing item; otherwise the first text item.
  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'));
    if (imgType) {
      let blob: Blob;
      try {
        blob = await item.getType(imgType);
      } catch {
        continue;
      }
      if (imgType === 'image/png') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { kind: 'error' };
        const dims = parsePngDims(bytes);
        if (!dims) return { kind: 'error' };
        return { kind: 'image', bytes, width: dims.width, height: dims.height };
      }
      // Non-PNG image: normalise to PNG if the browser can decode it.
      const png = await blobToPng(blob);
      if (!png || png.length === 0 || png.length > MAX_IMAGE_BYTES) return { kind: 'error' };
      const dims = parsePngDims(png);
      if (!dims) return { kind: 'error' };
      return { kind: 'image', bytes: png, width: dims.width, height: dims.height };
    }
  }

  for (const item of items) {
    if (item.types.includes('text/plain')) {
      let blob: Blob;
      try {
        blob = await item.getType('text/plain');
      } catch {
        continue;
      }
      const text = await blob.text();
      if (text.length > MAX_TEXT_BYTES) return { kind: 'error' };
      return { kind: 'text', text };
    }
  }

  return { kind: 'error' };
}

/** Parse PNG width/height from a Uint8Array (signature + IHDR). Returns null
 *  on any malformation. Mirrors the server-side validation. */
function parsePngDims(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) return null;
  return { width, height };
}

/** POST a raw clipboard payload to the worker clipboard route. Uses credentials
 *  (cookies) so the authenticated session is sent. Returns the parsed result,
 *  or throws on non-2xx (caller handles). */
export async function postClipboard(
  containerId: string,
  type: 'image/png' | 'text/plain',
  bytes: Uint8Array,
): Promise<ClipboardPostResult> {
  return await $fetch<ClipboardPostResult>(`/api/containers/${containerId}/clipboard`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: bytes,
    credentials: 'include',
  });
}

/** Per-target concurrency guard: only one paste flow runs at a time per target. */
const inflight = new Map<ClipboardTarget, Promise<unknown>>();

export function useClipboardPaste() {
  const toast = useToast();

  /** Concise error toast — never includes clipboard contents. */
  function toastClipboardError(message: string): void {
    toast.add({
      title: 'Clipboard paste failed',
      description: message,
      color: 'error',
      icon: 'i-lucide-alert-circle',
    });
  }

  /** Bridge a Ctrl/Cmd+V gesture for the terminal target: read the host
   *  clipboard, POST any image to the worker X clipboard, and return a result
   *  the xterm caller acts on (replay raw Ctrl+V for image, paste text for
   *  text, replay original on unsupported/denied/error). Guarded per target. */
  async function bridgeTerminalPaste(
    containerId: string,
  ): Promise<{ replayCtrlV: boolean; text?: string }> {
    const read = await readClipboardForPaste();
    if (read.kind === 'image') {
      try {
        await postClipboard(containerId, 'image/png', read.bytes);
        // API completion means the helper verified ownership; no arbitrary delay.
        return { replayCtrlV: true };
      } catch (err) {
        toastClipboardError(fetchErrorMessage(err, 'Could not paste image'));
        return { replayCtrlV: true }; // replay so existing behaviour is no worse
      }
    }
    if (read.kind === 'text') {
      // Text does NOT hit the X clipboard in the terminal; the caller pastes it
      // through xterm's normal bracketed-paste path.
      return { replayCtrlV: false, text: read.text };
    }
    // unsupported / denied / error: replay the original Ctrl+V so the terminal
    // keeps its existing (xterm-local) paste behaviour.
    if (read.kind === 'error') toastClipboardError('Could not read clipboard');
    return { replayCtrlV: true };
  }

  /** Run a paste flow under the per-target concurrency guard. */
  function runGuarded<T>(target: ClipboardTarget, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(target);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => {
      if (inflight.get(target) === p) inflight.delete(target);
    });
    inflight.set(target, p);
    return p;
  }

  function isPasteInFlight(target: ClipboardTarget): boolean {
    return inflight.has(target);
  }

  return {
    bridgeTerminalPaste,
    runGuarded,
    isPasteInFlight,
    toastClipboardError,
  };
}

// Agentor noVNC clipboard bridge.
//
// Capture-intercepts Ctrl/Cmd+V (and Ctrl+Alt+V) in the noVNC desktop iframe
// BEFORE noVNC sends the key to the remote VNC server. On a real user gesture
// it reads the host clipboard via the secure async Clipboard API, normalises
// non-PNG browser-decodable images to PNG (OffscreenCanvas with an
// HTMLCanvasElement fallback for Firefox), caps the payload, and POSTs the raw
// bytes to `POST /api/containers/<id>/clipboard` (with credentials). On 200 it
// replays Linux Ctrl+V to the VNC session via `UI.rfb.sendKey` using numeric
// X11 keysyms and physical key codes, so host Cmd+V also works and the
// remote GUI app reads the now-synced X11 CLIPBOARD. On denied/error it replays
// the original key once to preserve existing behaviour. Concurrent pastes are
// guarded. No clipboard contents are ever logged.
//
// This is a standalone ES module (no Nuxt/Vue deps) so it can be served from
// the worker's noVNC directory. It imports the existing `UI` default from
// `./ui.js`; because ES modules are cached, importing it here returns the same
// module instance the page's inline bootstrap script used to call `UI.start()`
// — so we never start noVNC a second time. We only read `UI.rfb` (set on
// connect) to replay keys.

import UI from './ui.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MiB — matches the server cap
const MAX_TEXT_BYTES = 1 * 1024 * 1024;  // 1 MiB — matches the server cap

// X11 keysyms (numeric) and physical key codes for replay.
const XK_Control_L = 0xffe3;
const XK_v = 0x0076;
const CODE_V = 'KeyV';
const CODE_CONTROL = 'ControlLeft';

let pasteInFlight = false;

/** True when the async Clipboard API is usable in the current secure context. */
function clipboardReadAvailable() {
  return window.isSecureContext
    && typeof navigator.clipboard !== 'undefined'
    && typeof navigator.clipboard.read === 'function';
}

/** Parse the worker UUID from the current URL: /desktop/<id>/agentor.html.
 *  Returns null when the path does not match. */
function parseWorkerId() {
  const m = location.pathname.match(/^\/desktop\/([^/]+)\/agentor\.html$/i);
  return m ? m[1] : null;
}

/** True when the noVNC canvas/display is focused (so we only intercept paste
 *  when the user is actually interacting with the remote desktop, not the
 *  surrounding noVNC chrome). */
function displayFocused() {
  if (!UI.rfb) return false;
  const container = document.getElementById('noVNC_container');
  if (!container) return false;
  const el = document.activeElement;
  if (!el) return false;
  // The canvas lives inside #noVNC_container; the container itself may also
  // hold focus. Treat focus anywhere inside the container as display focus.
  return container === el || container.contains(el);
}

/** Encode a Blob to PNG bytes. Prefers OffscreenCanvas; falls back to an
 *  HTMLCanvasElement for browsers without OffscreenCanvas/convertToBlob. */
async function blobToPng(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const w = bitmap.width;
  const h = bitmap.height;
  if (w <= 0 || h <= 0) return null;

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

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Parse PNG width/height (signature + IHDR). Returns null on malformation. */
function parsePngDims(buf) {
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

/** Read the host clipboard on a real user gesture. Returns a discriminated
 *  result. Never logs contents. */
async function readClipboard() {
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      return { kind: 'denied' };
    }
    return { kind: 'error' };
  }
  if (!items || items.length === 0) return { kind: 'error' };

  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'));
    if (imgType) {
      let blob;
      try { blob = await item.getType(imgType); } catch { continue; }
      if (imgType === 'image/png') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { kind: 'error' };
        if (!parsePngDims(bytes)) return { kind: 'error' };
        return { kind: 'image', bytes, type: 'image/png' };
      }
      const png = await blobToPng(blob);
      if (!png || png.length === 0 || png.length > MAX_IMAGE_BYTES) return { kind: 'error' };
      if (!parsePngDims(png)) return { kind: 'error' };
      return { kind: 'image', bytes: png, type: 'image/png' };
    }
  }

  for (const item of items) {
    if (item.types.includes('text/plain')) {
      let blob;
      try { blob = await item.getType('text/plain'); } catch { continue; }
      const text = await blob.text();
      if (text.length > MAX_TEXT_BYTES) return { kind: 'error' };
      return { kind: 'text', text };
    }
  }

  return { kind: 'error' };
}

/** POST a raw clipboard payload to the worker clipboard route with credentials.
 *  Resolves on 200, throws on any non-2xx. */
async function postClipboard(workerId, type, bytes) {
  const res = await fetch(`/api/containers/${workerId}/clipboard`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': type },
    body: bytes,
  });
  if (!res.ok) {
    const err = new Error(`clipboard POST failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Wait for UI.rfb to be available (set on connect). Resolves with the rfb
 *  instance or null after a timeout. */
function waitForRfb(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (UI.rfb) return resolve(UI.rfb);
    const start = Date.now();
    const t = setInterval(() => {
      if (UI.rfb) { clearInterval(t); resolve(UI.rfb); }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(null); }
    }, 100);
  });
}

/** Replay the Linux remote-desktop paste chord. Host Cmd+V must become Ctrl+V:
 *  forwarding Meta/Super would not paste in Linux GUI applications. */
function replayPasteKey() {
  const rfb = UI.rfb;
  if (!rfb || typeof rfb.sendKey !== 'function') return;
  rfb.sendKey(XK_Control_L, CODE_CONTROL, true);
  rfb.sendKey(XK_v, CODE_V, true);
  rfb.sendKey(XK_v, CODE_V, false);
  rfb.sendKey(XK_Control_L, CODE_CONTROL, false);
}

/** Handle a paste keydown: read clipboard, POST, replay. Returns true when the
 *  event was fully handled (intercepted), false when the caller should let
 *  noVNC process it (no clipboard API / not focused). */
async function handlePaste(workerId) {
  const read = await readClipboard();

  if (read.kind === 'image') {
    try {
      await postClipboard(workerId, read.type, read.bytes);
      // 200 → X clipboard is synced (helper verified ownership). Replay the
      // Linux Ctrl+V so the remote GUI app pastes from X clipboard.
      replayPasteKey();
      return;
    } catch {
      // POST failed: replay the original key once to preserve behaviour.
      replayPasteKey();
      return;
    }
  }

  if (read.kind === 'text') {
    // For remote GUI apps, syncing text to the X clipboard + replaying the key
    // is correct (the remote app reads the synced X selection).
    try {
      await postClipboard(workerId, 'text/plain', new TextEncoder().encode(read.text));
      replayPasteKey();
      return;
    } catch {
      replayPasteKey();
      return;
    }
  }

  // unsupported / denied / error: replay the original key once so the remote
  // desktop keeps its existing behaviour.
  replayPasteKey();
}

/** Capture-phase keydown interceptor. Runs before noVNC's own key handlers. */
function onKeyDown(e) {
  // Only the paste chords.
  const isV = e.key === 'v' || e.key === 'V';
  if (!isV) return;
  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const meta = e.metaKey;
  // Ctrl+V (non-Mac) or Cmd+V (Mac), optionally with Alt (Ctrl+Alt+V).
  const isPaste = (ctrl || meta) && !e.shiftKey;
  if (!isPaste) return;

  if (!clipboardReadAvailable()) return; // no API → let noVNC handle it
  if (!displayFocused()) return; // only intercept when the display is focused

  // Swallow before noVNC sees it.
  e.preventDefault();
  e.stopPropagation();

  if (pasteInFlight) return; // concurrency guard: drop re-entrant paste
  pasteInFlight = true;

  const workerId = parseWorkerId();
  // If we can't resolve the worker id we can't POST; still swallow? No — let it
  // fall through to noVNC by replaying the key directly so behaviour is no worse.
  if (!workerId) {
    replayPasteKey();
    pasteInFlight = false;
    return;
  }

  handlePaste(workerId).finally(() => {
    pasteInFlight = false;
  });
}

// Attach the interceptor in the capture phase on the document so it runs before
// noVNC's element-level keyboard handlers. Single attach — this module is
// imported once by agentor.html.
document.addEventListener('keydown', onKeyDown, true);

// Ensure the rfb instance is known (best-effort warm-up; replayPasteKey also
// re-checks UI.rfb at call time).
waitForRfb().catch(() => { /* ignore */ });

// Exported only for potential debugging; no clipboard contents are exposed.
export { parseWorkerId as __parseWorkerId };

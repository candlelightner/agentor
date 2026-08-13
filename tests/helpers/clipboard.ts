import { deflateSync, crc32 } from 'node:zlib';
import type { APIRequestContext } from '@playwright/test';
import { runInFreshWindow } from './terminal-ws';
import { ApiClient } from './api-client';

/**
 * Build a minimal, fully-valid PNG (signature + IHDR + IDAT + IEND) of the
 * given dimensions. Used so clipboard tests never depend on an external
 * fixture file and the exact bytes are deterministic. The server's PNG parser
 * validates signature + IHDR + nonzero width/height, so this is sufficient.
 */
export function buildPng(width: number, height: number): Buffer {
  // 8-bit truecolor (color type 2): single filter byte (0) per scanline + RGB.
  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: none
    for (let x = 0; x < rowLen; x++) raw[y * (rowLen + 1) + 1 + x] = (x + y) & 0xff;
  }
  const idatData = deflateSync(raw);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG with a bad signature (first byte flipped). */
export function pngWithBadSignature(): Buffer {
  const png = buildPng(2, 2);
  png[0] = 0x00;
  return png;
}

/** A PNG with a corrupted IHDR chunk tag (bytes 12..15 are not "IHDR"). */
export function pngWithBadIhdr(): Buffer {
  const png = buildPng(2, 2);
  png[12] = 0x00;
  return png;
}

/** A PNG with zero width (IHDR width field overwritten to 0). */
export function pngWithZeroWidth(): Buffer {
  const png = buildPng(2, 2);
  png.writeUInt32BE(0, 16);
  return png;
}

/** A non-empty Buffer of invalid UTF-8 (lone continuation byte 0x80). */
export function invalidUtf8(): Buffer {
  return Buffer.from([0x80, 0x80, 0x80]);
}

/** Wait until the rebuilt worker's X display and xclip helper are ready. Worker
 * creation returns before the desktop stack necessarily accepts selections. */
export async function waitForClipboardReady(
  request: APIRequestContext,
  containerId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const api = new ApiClient(request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = Buffer.from(`clipboard-ready-${Date.now()}`, 'utf8');
    const { status } = await api.setClipboard(containerId, 'text/plain', marker);
    if (status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('worker X clipboard did not become ready');
}

/**
 * Read the worker's X11 CLIPBOARD selection for a given target back as base64
 * via a fresh tmux window. Returns the raw bytes (or null when xclip reports
 * no owner / wrong target). Uses DISPLAY=:99 (the worker's Xvfb display).
 *
 * The clipboard route never returns contents to the caller, so the only way to
 * assert the helper actually served the selection is to read it back from
 * inside the worker. Base64-encoding keeps binary PNG safe across the tmux pty.
 *
 * Split-marker technique (mirrors worker-self.spec.ts): the full marker is
 * assembled at runtime from two shell variables so the concatenated marker
 * never appears as a literal in the echoed command — the pty echoes the typed
 * command back, and a literal marker would match the echo instead of the real
 * output.
 */
export async function readWorkerClipboard(
  request: APIRequestContext,
  containerId: string,
  target: 'image/png' | 'UTF8_STRING',
): Promise<Buffer | null> {
  const tag = Math.random().toString(36).slice(2, 10);
  const ma = `CB${tag.slice(0, 4)}`;
  const mb = `64_${tag.slice(4)}_END`;
  const fullMarker = `${ma}${mb}`;
  const na = `NONE${tag.slice(0, 4)}`;
  const nb = `${tag.slice(4)}_END`;
  const noneMarker = `${na}${nb}`;
  const cmd =
    `MA='${ma}'; MB='${mb}'; NA='${na}'; NB='${nb}'; ` +
    `TMP=$(mktemp); ` +
    `if DISPLAY=:99 timeout 3 xclip -selection clipboard -t '${target}' -o > "$TMP" 2>/dev/null; then ` +
    `printf '%s=%s\\n' "$MA$MB" "$(base64 -w0 < "$TMP")"; ` +
    `else printf '%s\\n' "$NA$NB"; fi; ` +
    `rm -f "$TMP"`;
  const out = await runInFreshWindow(request, containerId, cmd, new RegExp(`${fullMarker}=|${noneMarker}`), 30_000);
  if (new RegExp(noneMarker).test(out)) return null;
  const m = out.match(new RegExp(`${fullMarker}=([A-Za-z0-9+/=]*)`));
  if (!m || !m[1]) return null;
  return Buffer.from(m[1], 'base64');
}

import type { Terminal } from '@xterm/xterm';

export const MAX_TERMINAL_COPY_BYTES = 1024 * 1024;

/** OSC 52 writes are requests, never clipboard reads or automatic writes. The
 * operator confirms each one in the UI, providing the browser's user gesture. */
export function installTerminalClipboard(
  term: Terminal,
  request: (text: string) => void,
  failed: (message: string) => void,
) {
  return term.parser.registerOscHandler(52, data => {
    const separator = data.indexOf(';');
    if (separator < 0) { failed('The terminal sent an invalid copy request.'); return true; }
    const selection = data.slice(0, separator), encoded = data.slice(separator + 1);
    // Queries must never read the browser clipboard or reply to a worker.
    if (encoded === '?' || !['', 'c'].includes(selection)) return true;
    if (!encoded || encoded.length > 4 * Math.ceil(MAX_TERMINAL_COPY_BYTES / 3)) {
      failed(encoded ? 'The terminal copy request exceeds 1 MiB. Export the response to a file instead.' : 'The terminal copy request is empty.');
      return true;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      failed('The terminal sent an invalid copy request.'); return true;
    }
    try {
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      if (bytes.byteLength > MAX_TERMINAL_COPY_BYTES) throw new Error('copy limit');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.length) throw new Error('empty');
      request(text);
    } catch { failed('The terminal sent an invalid or oversized UTF-8 copy request.'); }
    return true;
  });
}

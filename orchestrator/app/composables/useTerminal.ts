import { installTerminalClipboard } from './terminalClipboard';
import type { Terminal, ITheme } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { clipboardReadAvailable, useClipboardPaste } from './useClipboardPasteBridge';

interface TerminalState {
  containerId: string;
  windowIndex: number;
  term: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket;
  containerEl: HTMLElement;
  eventCleanup: () => void;
  writeBatch: (Uint8Array | string)[];
  writeRafId: number | null;
}

export type TerminalToolbarModifier = 'ctrl' | 'shift' | 'alt';
type TerminalToolbarModifiers = Record<TerminalToolbarModifier, boolean>;

function encodeToolbarKey(key: string, modifiers: TerminalToolbarModifiers): string | null {
  if (key.length === 1) {
    let value = key;
    if (modifiers.shift) {
      value = ({ '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~' } as Record<string, string>)[value] ?? value.toUpperCase();
    }
    if (modifiers.ctrl) {
      const upper = value.toUpperCase();
      if (upper >= 'A' && upper <= 'Z') value = String.fromCharCode(upper.charCodeAt(0) - 64);
      else value = ({ ' ': '\0', '@': '\0', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' } as Record<string, string>)[value] ?? '';
      if (!value) return null;
    }
    return (modifiers.alt ? '\x1b' : '') + value;
  }

  if (key === 'Tab') return modifiers.shift ? '\x1b[Z' : modifiers.ctrl ? '\x1b[1;5I' : (modifiers.alt ? '\x1b' : '') + '\t';
  if (key === 'Enter') return modifiers.shift ? '\x1b[13;2u' : modifiers.ctrl ? '\x1b[13;5u' : (modifiers.alt ? '\x1b' : '') + '\r';
  if (key === 'Escape') return '\x1b';
  if (key === 'Backspace') return (modifiers.alt ? '\x1b' : '') + (modifiers.ctrl ? '\x08' : '\x7f');
  const arrows: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };
  if (arrows[key]) {
    const modifier = 1 + Number(modifiers.shift) + 2 * Number(modifiers.alt) + 4 * Number(modifiers.ctrl);
    return modifier === 1 ? `\x1b[${arrows[key]}` : `\x1b[1;${modifier}${arrows[key]}`;
  }
  return null;
}

const DARK_THEME: ITheme = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#0d1117',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39d353',
  white: '#c9d1d9',
};

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  selectionBackground: '#add6ff',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
};

export function useTerminal() {
  const colorMode = useColorMode();
  const activeTerminal = shallowRef<TerminalState | null>(null);
  const copyRequest = ref<{ text: string; error: string } | null>(null);
  const copyMessage = ref('');
  const mobileModifiers = ref<TerminalToolbarModifiers>({ ctrl: false, shift: false, alt: false });

  function clearMobileModifiers() {
    mobileModifiers.value = { ctrl: false, shift: false, alt: false };
  }

  function toggleMobileModifier(modifier: TerminalToolbarModifier) {
    mobileModifiers.value = { ...mobileModifiers.value, [modifier]: !mobileModifiers.value[modifier] };
    activeTerminal.value?.term.focus();
  }

  function sendMobileKey(key: string) {
    const terminal = activeTerminal.value;
    if (!terminal || terminal.ws.readyState !== WebSocket.OPEN) return;
    const data = encodeToolbarKey(key, mobileModifiers.value);
    if (data === null) return;
    terminal.ws.send(data);
    clearMobileModifiers();
    terminal.term.focus();
  }

  async function copyTerminalRequest() {
    const requested = copyRequest.value;
    if (!requested) return;
    try {
      if (!window.isSecureContext || typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(requested.text);
      if (copyRequest.value === requested) { copyRequest.value = null; copyMessage.value = 'Terminal response copied.'; }
    } catch {
      if (copyRequest.value === requested) requested.error = 'Clipboard access is unavailable or blocked. Select and copy the text below.';
    }
  }
  function dismissCopyRequest() { copyRequest.value = null; copyMessage.value = ''; }

  const { bridgeTerminalPaste, bridgeTerminalPasteEvent, runGuarded, isPasteInFlight } = useClipboardPaste();

  function getTheme(): ITheme {
    return colorMode.value === 'dark' ? DARK_THEME : LIGHT_THEME;
  }

  // Update terminal theme when color mode changes
  const stopColorWatch = watch(() => colorMode.value, () => {
    const t = activeTerminal.value;
    if (t) {
      t.term.options.theme = getTheme();
    }
  });
  let fitTimer: ReturnType<typeof setTimeout> | null = null;

  function openTerminal(
    containerId: string,
    windowIndex: number,
    containerEl: HTMLElement,
    TerminalClass: typeof Terminal,
    FitAddonClass: typeof FitAddon,
  ) {
    const current = activeTerminal.value;

    // Already connected to same container+window
    if (current && current.containerId === containerId && current.windowIndex === windowIndex) {
      fitTerminal();
      return;
    }

    closeTerminal();

    const term = new TerminalClass({
      theme: getTheme(),
      fontFamily: 'Menlo, "Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      fastScrollModifier: 'alt',
      macOptionClickForcesSelection: true,
      altClickMovesCursor: false,
    });

    const fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);
    // Hide terminal while the initial tmux screen redraw streams in.
    // Without this, xterm.js progressively renders lines top-to-bottom,
    // causing a visible scroll effect. We reveal after the data settles.
    containerEl.style.visibility = 'hidden';

    term.open(containerEl);
    fitAddon.fit();

    let lastTouchAt = 0;
    let touchGesture: { startX: number; startY: number; startAt: number; lastY: number; axis: 'vertical' | 'horizontal' | null } | null = null;
    const terminalRoot = term.element;
    let touchCleanup = () => {};
    if (terminalRoot) {
      // Keep the browser from scrolling the page; route vertical gestures through
      // xterm so both local scrollback and tmux mouse reporting use their normal paths.
      terminalRoot.style.touchAction = 'pan-x pinch-zoom';
      const onTouchStart = (event: TouchEvent) => {
        lastTouchAt = Date.now();
        if (event.touches.length !== 1 || term.hasSelection()) { touchGesture = null; return; }
        const touch = event.touches[0]!;
        touchGesture = { startX: touch.clientX, startY: touch.clientY, startAt: Date.now(), lastY: touch.clientY, axis: null };
      };
      const onTouchMove = (event: TouchEvent) => {
        if (event.touches.length !== 1 || !touchGesture) {
          touchGesture = null;
          event.stopImmediatePropagation();
          return;
        }
        const touch = event.touches[0]!;
        // A long press belongs to native text selection. Do not turn its drag into scrolling.
        if (!touchGesture.axis && Date.now() - touchGesture.startAt >= 400) {
          touchGesture = null;
          event.stopImmediatePropagation();
          return;
        }
        const deltaX = touch.clientX - touchGesture.startX;
        const deltaY = touch.clientY - touchGesture.startY;
        if (!touchGesture.axis && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 8) {
          touchGesture.axis = Math.abs(deltaY) > Math.abs(deltaX) ? 'vertical' : 'horizontal';
        }
        if (touchGesture.axis !== 'vertical') {
          event.stopImmediatePropagation();
          return;
        }

        const scrollDelta = touchGesture.lastY - touch.clientY;
        touchGesture.lastY = touch.clientY;
        event.stopImmediatePropagation();
        if (scrollDelta !== 0) {
          const wheel = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: scrollDelta,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: touch.clientX,
            clientY: touch.clientY,
          });
          terminalRoot.dispatchEvent(wheel);
        }
      };
      const onTouchEnd = () => { lastTouchAt = Date.now(); touchGesture = null; };
      terminalRoot.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      terminalRoot.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
      terminalRoot.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      terminalRoot.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
      touchCleanup = () => {
        terminalRoot.removeEventListener('touchstart', onTouchStart, true);
        terminalRoot.removeEventListener('touchmove', onTouchMove, true);
        terminalRoot.removeEventListener('touchend', onTouchEnd, true);
        terminalRoot.removeEventListener('touchcancel', onTouchEnd, true);
      };
    }

    // Force xterm.js to use native text selection for click/drag.
    // xterm.js's shouldForceSelection() checks altKey+macOptionClickForcesSelection
    // on Mac, or shiftKey on other platforms. We override the relevant modifier
    // key on pointer/mouse events so xterm.js handles selection locally instead
    // of forwarding to tmux. Wheel events are unaffected.
    const isMac = /mac/i.test(navigator.platform);
    const forceSelectionKey = isMac ? 'altKey' : 'shiftKey';
    const overrideKey = (e: Event) => {
      if ((typeof PointerEvent !== 'undefined' && e instanceof PointerEvent && e.pointerType === 'touch') || Date.now() - lastTouchAt < 400) return;
      Object.defineProperty(e, forceSelectionKey, { value: true });
    };
    const eventTypes = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup'] as const;
    for (const type of eventTypes) {
      containerEl.addEventListener(type, overrideKey, { capture: true });
    }
    const clipboardHandler = installTerminalClipboard(term, text => {
      copyRequest.value = { text, error: '' };
      copyMessage.value = '';
    }, message => {
      copyRequest.value = null;
      copyMessage.value = message;
    });
    let pasteCleanup = () => {};
    const eventCleanup = () => {
      touchCleanup();
      for (const type of eventTypes) {
        containerEl.removeEventListener(type, overrideKey, { capture: true });
      }
      pasteCleanup();
      clipboardHandler.dispose();
      dismissCopyRequest();
    };

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/terminal/${containerId}/${windowIndex}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Send proper dimensions immediately — terminal is already fitted
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
      // Wait for the initial tmux screen redraw to finish, then refit,
      // scroll to bottom, and reveal the terminal in its final state.
      setTimeout(() => {
        fitAddon.fit();
        const dims2 = fitAddon.proposeDimensions();
        if (dims2 && dims2.cols > 0 && dims2.rows > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims2.cols, rows: dims2.rows }));
        }
        term.scrollToBottom();
        containerEl.style.visibility = '';
      }, 200);
    };

    // Batch incoming WebSocket data per animation frame. Claude Code and other
    // TUI agents redraw the full screen on each update (cursor home → rewrite
    // everything). These redraws arrive as multiple WebSocket messages spread
    // across frames. Without batching, xterm.js renders partial states — causing
    // a visible scroll-from-top flicker on each update. By accumulating all
    // data within one frame and writing it in a single term.write() call, the
    // parser processes the complete redraw atomically.
    const writeBatch: (Uint8Array | string)[] = [];
    let writeRafId: number | null = null;

    ws.onmessage = (event) => {
      const data =
        event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      writeBatch.push(data);
      if (writeRafId === null) {
        writeRafId = requestAnimationFrame(() => {
          for (const chunk of writeBatch) {
            term.write(chunk);
          }
          writeBatch.length = 0;
          writeRafId = null;
        });
      }
    };

    ws.onclose = () => {
      dismissCopyRequest();
      term.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n');
    };

    let nativePastePending = false;
    let nativePasteTimer: ReturnType<typeof setTimeout> | null = null;
    const pasteCatcher = document.createElement('textarea');
    pasteCatcher.dataset.agentorPasteCatcher = 'true';
    pasteCatcher.tabIndex = -1;
    pasteCatcher.setAttribute('aria-hidden', 'true');
    pasteCatcher.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    containerEl.appendChild(pasteCatcher);
    const applyPasteResult = (res: { replayCtrlV: boolean; text?: string }) => {
      term.focus();
      if (ws.readyState !== WebSocket.OPEN) return;
      if (res.replayCtrlV) ws.send('\x16');
      else if (res.text !== undefined) term.paste(res.text);
    };
    const onNativePaste = (event: ClipboardEvent) => {
      imeInputPending = false;
      clearMobileModifiers();
      const data = event.clipboardData;
      if (!data) return;
      const hasImage = Array.from(data.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
      // Preserve xterm's native text paste unless this event follows a keydown
      // we deliberately held while waiting for Firefox's paste event.
      if (!hasImage && !nativePastePending) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nativePastePending = false;
      if (nativePasteTimer) clearTimeout(nativePasteTimer);
      nativePasteTimer = null;
      term.focus();
      if (isPasteInFlight('terminal')) return;
      runGuarded('terminal', () => bridgeTerminalPasteEvent(containerId, data)).then(applyPasteResult);
    };
    containerEl.addEventListener('paste', onNativePaste, { capture: true });
    pasteCatcher.addEventListener('paste', onNativePaste);
    pasteCleanup = () => {
      containerEl.removeEventListener('paste', onNativePaste, { capture: true });
      pasteCatcher.removeEventListener('paste', onNativePaste);
      pasteCatcher.remove();
      if (nativePasteTimer) clearTimeout(nativePasteTimer);
    };

    // Shift+Enter → send CSI u encoded Shift+Enter so agents (Claude Code,
    // Codex, etc.) can distinguish it from plain Enter and insert a newline.
    // tmux extended-keys (csi-u format) passes this through to the application.
    //
    // Ctrl/Cmd+V → keyboard-transparent host clipboard paste. On keydown we
    // synchronously swallow the key ONLY when the async Clipboard API is
    // available (so existing xterm-local paste still works where it isn't),
    // then bridge asynchronously: image → POST PNG to the worker X clipboard
    // and replay exactly one raw Ctrl+V (\x16) over the terminal WebSocket so
    // Codex reads the X clipboard; text → paste through xterm's normal
    // bracketed-paste path (term.paste), not Ctrl+V; denied/error → replay the
    // original Ctrl+V so existing behaviour is no worse. Per-target concurrency
    // guard prevents racing rapid presses. Existing Shift+Enter and all other
    // keys are preserved.
    let imeInputPending = false;
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.isComposing) {
        imeInputPending = true;
        return true;
      }
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !mobileModifiers.value.ctrl && !mobileModifiers.value.shift && !mobileModifiers.value.alt) {
        if (event.type === 'keydown' && ws.readyState === WebSocket.OPEN) {
          ws.send('\x1b[13;2u');
        }
        return false;
      }

      // Ctrl+V (non-Mac) or Cmd+V (Mac). Match the keydown only; keyup is
      // swallowed too so xterm never performs its own paste.
      const isPasteKey = event.key === 'v' || event.key === 'V';
      const isCtrlOrCmd = event.ctrlKey || event.metaKey || mobileModifiers.value.ctrl;
      if (isPasteKey && isCtrlOrCmd && !event.altKey && !mobileModifiers.value.alt) {
        const virtualPaste = mobileModifiers.value.ctrl && !event.ctrlKey && !event.metaKey;
        if (event.type === 'keydown' && (mobileModifiers.value.ctrl || mobileModifiers.value.shift || mobileModifiers.value.alt)) clearMobileModifiers();
        imeInputPending = false;
        if (event.type === 'keydown' && !event.ctrlKey && !event.metaKey) event.preventDefault();
        const hasClipboard = clipboardReadAvailable();
        const preferNativePaste = !virtualPaste && (/firefox/i.test(navigator.userAgent) || !hasClipboard);
        if (preferNativePaste) {
          if (event.type === 'keydown') {
            nativePastePending = true;
            if (nativePasteTimer) clearTimeout(nativePasteTimer);
            pasteCatcher.value = '';
            pasteCatcher.focus({ preventScroll: true });
            // If Firefox does not dispatch a paste event, preserve the old raw
            // Ctrl+V behavior rather than swallowing the key indefinitely.
            nativePasteTimer = setTimeout(() => {
              nativePastePending = false;
              term.focus();
              if (ws.readyState === WebSocket.OPEN) ws.send('\x16');
            }, 500);
          }
          return false;
        }
        if (event.type === 'keydown') {
          if (isPasteInFlight('terminal')) return false;
          // Swallow synchronously, then bridge asynchronously. The bridge
          // decides whether to replay \x16 (image/denied/error) or paste text.
          runGuarded('terminal', () => bridgeTerminalPaste(containerId)).then(applyPasteResult);
        }
        return false;
      }

      // Android IMEs may emit both a legacy keypress and a committed input event.
      // Keep xterm's composition helper in control; onData applies the modifier to its committed text.

      if (event.type === 'keydown' && (mobileModifiers.value.ctrl || mobileModifiers.value.shift || mobileModifiers.value.alt)) {
        if (event.key === 'Unidentified' || event.key === 'Process' || event.keyCode === 229) {
          imeInputPending = true;
          return true;
        }
        const modifiers = {
          ctrl: mobileModifiers.value.ctrl || event.ctrlKey,
          shift: mobileModifiers.value.shift || event.shiftKey,
          alt: mobileModifiers.value.alt || event.altKey,
        };
        const data = encodeToolbarKey(event.key, modifiers);
        if (data !== null) {
          event.preventDefault();
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
          clearMobileModifiers();
          return false;
        }
      }
      return true;
    });

    // SGR mouse escape: \x1b[<button;col;row[Mm]
    // Button >= 64 = scroll (wheel up/down) — forward to tmux for scrollback.
    // Button < 64 = click/drag/motion — block so tmux doesn't move cursor.
    const SGR_MOUSE_RE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const m = data.match(SGR_MOUSE_RE);
        if (m && parseInt(m[1]!, 10) < 64) return;
        if (imeInputPending && !m) {
          imeInputPending = false;
          const modifiers = mobileModifiers.value;
          if (data.length === 1 && /[vV]/.test(data) && modifiers.ctrl && !modifiers.alt) {
            clearMobileModifiers();
            if (!isPasteInFlight('terminal')) {
              runGuarded('terminal', () => bridgeTerminalPaste(containerId)).then(applyPasteResult);
            }
            return;
          }
          const input = data.length === 1 && data >= ' ' && data <= '~' ? encodeToolbarKey(data, mobileModifiers.value) : null;
          if (input !== null) {
            ws.send(input);
            clearMobileModifiers();
            return;
          }
          clearMobileModifiers();
        }
        ws.send(data);
      }
    });

    activeTerminal.value = { containerId, windowIndex, term, fitAddon, ws, containerEl, eventCleanup, writeBatch, writeRafId };
  }

  function fitTerminal(immediate = false) {
    if (fitTimer) clearTimeout(fitTimer);
    const doFit = () => {
      const t = activeTerminal.value;
      if (!t) return;
      try {
        t.fitAddon.fit();
        const dims = t.fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0 && t.ws && t.ws.readyState === WebSocket.OPEN) {
          t.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      } catch {
        // Element might not be visible yet
      }
    };
    if (immediate) {
      doFit();
    } else {
      fitTimer = setTimeout(doFit, 30);
    }
  }

  function closeTerminal() {
    const t = activeTerminal.value;
    if (!t) return;
    if (t.writeRafId !== null) cancelAnimationFrame(t.writeRafId);
    t.eventCleanup();
    t.ws?.close();
    t.term?.dispose();
    activeTerminal.value = null;
    clearMobileModifiers();
  }

  function destroy() {
    closeTerminal();
    stopColorWatch();
    if (fitTimer) clearTimeout(fitTimer);
  }

  return {
    activeTerminal,
    copyRequest,
    copyMessage,
    copyTerminalRequest,
    dismissCopyRequest,
    mobileModifiers,
    clearMobileModifiers,
    toggleMobileModifier,
    sendMobileKey,
    openTerminal,
    closeTerminal,
    fitTerminal,
    destroy,
  };
}

<script setup lang="ts">
const props = defineProps<{
  containerId: string;
}>();

const { $Terminal, $FitAddon } = useNuxtApp();

const containerIdRef = toRef(props, 'containerId');
const protection = ref<{ protected: boolean }>({ protected: false });
const lockPassword = ref('');
const paneMutationError = ref('');

const {
  windows,
  activeWindowIndex,
  defaultWindowIndex,
  createWindow,
  renameWindow,
  closeWindow,
  activateWindow,
  destroy: destroyTmuxTabs,
} = useTmuxTabs(containerIdRef);

// Map of window index -> terminal instance + element ref
const terminals = shallowReactive(new Map<
  number,
  { instance: ReturnType<typeof useTerminal>; el: HTMLElement | null }
>());

const activeCopyTerminal = computed(() => activeWindowIndex.value == null ? undefined : terminals.get(activeWindowIndex.value)?.instance);
const copyRequest = computed(() => activeCopyTerminal.value?.copyRequest.value);
const copyMessage = computed(() => activeCopyTerminal.value?.copyMessage.value);
const mobileKeysVisible = ref(false);
const mobileModifiers = computed(() => activeCopyTerminal.value?.mobileModifiers.value ?? { ctrl: false, shift: false, alt: false });

function toggleMobileModifier(modifier: 'ctrl' | 'shift' | 'alt') {
  activeCopyTerminal.value?.toggleMobileModifier(modifier);
}

function sendMobileKey(key: string) {
  activeCopyTerminal.value?.sendMobileKey(key);
}

function toggleMobileKeys() {
  if (mobileKeysVisible.value) {
    for (const { instance } of terminals.values()) instance.clearMobileModifiers();
    mobileKeysVisible.value = false;
  } else {
    mobileKeysVisible.value = true;
  }
}

// Template refs for terminal containers
const terminalRefs = new Map<number, HTMLElement>();
function setTerminalRef(index: number, el: Element | null | ComponentPublicInstance) {
  const htmlEl = (el as ComponentPublicInstance)?.$el ?? el;
  if (htmlEl instanceof HTMLElement) {
    terminalRefs.set(index, htmlEl);
  } else {
    terminalRefs.delete(index);
  }
}

// Container element for ResizeObserver
const terminalsContainer = ref<HTMLElement | null>(null);

function ensureTerminal(windowIndex: number) {
  if (terminals.has(windowIndex)) return;
  const instance = useTerminal();
  terminals.set(windowIndex, { instance, el: null });
}

function connectTerminal(windowIndex: number) {
  const entry = terminals.get(windowIndex);
  const el = terminalRefs.get(windowIndex);
  if (!entry || !el || !$Terminal || !$FitAddon) return;

  entry.el = el;
  el.innerHTML = '';
  entry.instance.openTerminal(props.containerId, windowIndex, el, $Terminal, $FitAddon);
}

function destroyTerminal(windowIndex: number) {
  const entry = terminals.get(windowIndex);
  if (!entry) return;
  entry.instance.destroy();
  terminals.delete(windowIndex);
  terminalRefs.delete(windowIndex);
}

// Reset a terminal's connection without destroying the instance.
// Closes the WebSocket and disposes the xterm terminal so that
// connectTerminal() will create a fresh linked tmux session.
function resetTerminal(windowIndex: number) {
  const entry = terminals.get(windowIndex);
  if (!entry?.el) return;
  entry.instance.closeTerminal();
  entry.el = null;
}

async function onRename(windowIndex: number, newName: string) {
  paneMutationError.value = '';
  if (!await renameWindow(windowIndex, newName, lockPassword.value)) {
    paneMutationError.value = 'Unable to rename terminal. Check the worker lock password.';
  }
}

async function onClose(windowIndex: number) {
  paneMutationError.value = '';
  if (!await closeWindow(windowIndex, lockPassword.value)) {
    paneMutationError.value = 'Unable to close terminal. Check the worker lock password.';
  }
}

// Track known window indices to detect externally-created windows
let knownWindowIndices = new Set<number>();
let skipReconnect = false;

// Wrap createWindow to suppress reconnection for UI-initiated creates
async function handleCreate(name?: string) {
  skipReconnect = true;
  paneMutationError.value = '';
  if (!await createWindow(name, lockPassword.value)) {
    paneMutationError.value = 'Unable to create terminal. Check the worker lock password.';
  }
  await nextTick();
  skipReconnect = false;
}

// Watch windows list — create/destroy terminal instances as needed
watch(
  windows,
  (newWindows) => {
    const currentIndices = new Set(newWindows.map((w) => w.index));

    // Destroy terminals for removed windows
    for (const index of terminals.keys()) {
      if (!currentIndices.has(index)) {
        destroyTerminal(index);
      }
    }

    // Detect externally-created windows (e.g. ctrl+b+c inside a terminal).
    // When tmux creates a window via keyboard shortcut, the linked session
    // switches to the new window, breaking the old tab's window binding.
    // Reset all connected terminals so they reconnect with correct windows.
    if (!skipReconnect && knownWindowIndices.size > 0) {
      const hasNewExternal = [...currentIndices].some((idx) => !knownWindowIndices.has(idx));
      if (hasNewExternal) {
        for (const [index, entry] of terminals.entries()) {
          if (entry.el && currentIndices.has(index)) {
            resetTerminal(index);
          }
        }
      }
    }
    knownWindowIndices = currentIndices;

    // Ensure terminal instances exist for all windows (but don't connect hidden ones yet)
    for (const w of newWindows) {
      ensureTerminal(w.index);
    }

    // Only connect the active window after DOM update
    nextTick(() => {
      const active = activeWindowIndex.value;
      if (active != null) {
        const entry = terminals.get(active);
        if (entry && !entry.el) {
          connectTerminal(active);
        }
      }
    });
  },
  { deep: true },
);

// When active tab changes: connect if needed, then refit
watch(activeWindowIndex, (index) => {
  for (const { instance } of terminals.values()) instance.clearMobileModifiers();
  if (index == null) return;
  nextTick(() => {
    const entry = terminals.get(index);
    if (!entry) return;
    if (!entry.el) {
      // Lazily connect terminal when it first becomes visible
      connectTerminal(index);
    } else {
      // Already connected — just refit for the now-visible element
      entry.instance.fitTerminal();
    }
  });
});

// ResizeObserver for all resize scenarios
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  $fetch<{ protected: boolean }>(`/api/containers/${props.containerId}/protection`)
    .then((value) => { protection.value = value; })
    .catch(() => { /* The server remains authoritative. */ });
  if (!terminalsContainer.value) return;
  resizeObserver = new ResizeObserver(() => {
    if (activeWindowIndex.value == null) return;
    const entry = terminals.get(activeWindowIndex.value);
    entry?.instance.fitTerminal(false);
  });
  resizeObserver.observe(terminalsContainer.value);
});

onUnmounted(() => {
  lockPassword.value = '';
  resizeObserver?.disconnect();
  resizeObserver = null;
  for (const index of [...terminals.keys()]) {
    destroyTerminal(index);
  }
  destroyTmuxTabs();
});
</script>

<template>
  <div class="absolute inset-0 flex flex-col" style="background: var(--terminal-bg);">
    <TmuxTabBar
      :windows="windows"
      :active-window-index="activeWindowIndex"
      :default-window-index="defaultWindowIndex"
      @activate="activateWindow"
      @close="onClose"
      @create="handleCreate"
      @rename="onRename"
    />

    <div v-if="protection.protected" class="flex items-center gap-2 border-b border-amber-700/40 bg-amber-950/30 px-2 py-1">
      <label class="flex min-w-0 flex-1 items-center gap-2 text-xs text-amber-200">
        Worker lock password
        <input
          v-model="lockPassword"
          type="password"
          autocomplete="current-password"
          aria-label="Terminal worker lock password"
          class="min-w-0 flex-1 rounded border border-amber-700/50 bg-black/30 px-2 py-1 text-white"
        >
      </label>
      <span v-if="paneMutationError" role="alert" class="text-xs text-red-300">{{ paneMutationError }}</span>
    </div>

    <div v-if="copyRequest || copyMessage" class="border-b border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
      <div class="flex items-center gap-3" role="status">
        <span class="flex-1">{{ copyRequest ? 'The terminal requested to copy a response.' : copyMessage }}</span>
        <button v-if="copyRequest" class="rounded bg-blue-700 px-3 py-1" @click="activeCopyTerminal?.copyTerminalRequest()">Copy response</button>
        <button class="rounded px-2 py-1" aria-label="Dismiss terminal copy" @click="activeCopyTerminal?.dismissCopyRequest()">Dismiss</button>
      </div>
      <template v-if="copyRequest?.error">
        <p role="alert" class="mt-2 text-amber-200">{{ copyRequest.error }}</p>
        <textarea
          readonly
          aria-label="Terminal response to copy"
          class="mt-2 max-h-48 w-full rounded bg-black p-2 font-mono text-xs"
          :value="copyRequest.text"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
      </template>
    </div>

    <div ref="terminalsContainer" class="relative flex-1 min-h-0">
      <div
        v-for="w in windows"
        :key="w.index"
        v-show="w.index === activeWindowIndex"
        :ref="(el) => setTerminalRef(w.index, el)"
        class="absolute inset-0"
      />
    </div>

    <div class="mobile-terminal-keys shrink-0 sm:hidden" style="padding-bottom: env(safe-area-inset-bottom);">
      <div class="flex justify-end border-t border-slate-700 bg-slate-900 px-2 py-1">
        <button
          type="button"
          class="min-h-9 rounded px-3 text-xs text-slate-200"
          aria-controls="mobile-terminal-key-toolbar"
          :aria-expanded="mobileKeysVisible"
          @pointerdown.prevent
          @click="toggleMobileKeys"
        >{{ mobileKeysVisible ? 'Hide terminal keys' : 'Terminal keys' }}</button>
      </div>
      <div
        v-if="mobileKeysVisible"
        id="mobile-terminal-key-toolbar"
        class="flex min-h-12 items-center gap-1 overflow-x-auto overscroll-x-contain border-t border-slate-700 bg-slate-900 px-2 py-1"
        role="toolbar"
        aria-label="Mobile terminal keys"
      >
        <button
          v-for="modifier in (['ctrl', 'shift', 'alt'] as const)"
          :key="modifier"
          type="button"
          class="min-h-10 min-w-12 rounded border border-slate-600 px-3 text-sm text-slate-100 aria-pressed:bg-blue-800"
          :aria-pressed="mobileModifiers[modifier]"
          :disabled="!activeCopyTerminal"
          @pointerdown.prevent
          @click="toggleMobileModifier(modifier)"
        >{{ modifier === 'ctrl' ? 'Ctrl' : modifier === 'shift' ? 'Shift' : 'Alt' }}</button>
        <button
          v-for="key in [{ label: 'Tab', value: 'Tab' }, { label: 'Esc', value: 'Escape' }, { label: '↑', value: 'ArrowUp' }, { label: '↓', value: 'ArrowDown' }, { label: '←', value: 'ArrowLeft' }, { label: '→', value: 'ArrowRight' }, { label: 'Backspace', value: 'Backspace' }, { label: 'Enter', value: 'Enter' }]"
          :key="key.value"
          type="button"
          class="min-h-10 shrink-0 rounded border border-slate-600 px-3 text-sm text-slate-100"
          :aria-label="key.label === '↑' ? 'Arrow Up' : key.label === '↓' ? 'Arrow Down' : key.label === '←' ? 'Arrow Left' : key.label === '→' ? 'Arrow Right' : key.label"
          :disabled="!activeCopyTerminal"
          @pointerdown.prevent
          @click="sendMobileKey(key.value)"
        >{{ key.label }}</button>
      </div>
    </div>
  </div>
</template>

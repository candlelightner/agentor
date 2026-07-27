import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { TerminalWsClient } from '../helpers/terminal-ws';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_STORAGE = resolve(__dirname, '..', '.auth/admin-api.json');

const UNAUTH_OPTS = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

// Pinned Kilo Code extension installed into the worker image's code-server
// extension directory (see worker/Dockerfile). The exact `publisher.name@x.y.z`
// token is what `code-server --list-extensions --show-versions` emits.
const KILO_EXTENSION_ID = 'kilocode.kilo-code';
const KILO_EXTENSION_VERSION = '7.4.16';

async function createUserAndSignIn(tag: string) {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.example`;
  const password = `${tag}-password-${Date.now()}`;
  let id = '';
  const adminCtx = await playwrightRequest.newContext({ ...UNAUTH_OPTS, storageState: ADMIN_STORAGE });
  try {
    const create = await adminCtx.post('/api/auth/admin/create-user', {
      data: { email, password, name: tag, role: 'user' },
    });
    if (!create.ok()) throw new Error(`Failed to create user: ${create.status()}`);
    const body = await create.json().catch(() => ({}));
    id = body?.user?.id ?? body?.id ?? '';
  } finally {
    await adminCtx.dispose();
  }
  const ctx = await playwrightRequest.newContext(UNAUTH_OPTS);
  const api = new ApiClient(ctx);
  const signIn = await api.signInEmail(email, password);
  if (signIn.status !== 200) {
    await ctx.dispose();
    throw new Error(`Sign-in failed for ${email}: ${signIn.status}`);
  }
  return { ctx, api, email, password, id };
}

async function cleanupUser(u: { ctx: APIRequestContext; id: string }): Promise<void> {
  await u.ctx.dispose().catch(() => {});
  if (!u.id) return;
  const adminCtx = await playwrightRequest.newContext({ ...UNAUTH_OPTS, storageState: ADMIN_STORAGE });
  try {
    await adminCtx.post('/api/auth/admin/remove-user', { data: { userId: u.id } });
  } catch {
    // ignore
  } finally {
    await adminCtx.dispose();
  }
}

/**
 * Connect to a worker's terminal, wait for a shell prompt, run `command`, and
 * return the ANSI-stripped output buffer up to (and including) the trailing
 * sentinel marker.
 *
 * The sentinel is emitted by the command itself (`echo <sentinel>`) and is
 * anchored with newlines on both sides so it only matches the OUTPUT of echo,
 * never the shell's echo-back of the typed command line (which has the
 * sentinel preceded by a space). Without this anchor a `waitForOutput` call
 * would return immediately when the command is typed, before it has run.
 *
 * The admin project's storage state (tests/.auth/admin-api.json) is used for
 * the WebSocket Cookie header so the connection authenticates as admin and
 * passes the `requireContainerAccess` ownership check (admin bypasses the
 * user-ownership gate, so this works for workers owned by either test user).
 */
async function execInWorker(containerId: string, command: string, timeoutMs = 30_000): Promise<string> {
  const ws = new TerminalWsClient(containerId);
  try {
    await ws.connect();
    await ws.waitForOutput(/[\$#>]\s*$/, 30_000);
    ws.clearBuffer();

    const marker = `END_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_MK`;
    ws.sendLine(`${command}; echo ${marker}`);
    await ws.waitForOutput(new RegExp(`\\n${marker}\\n`), timeoutMs);

    return ws.getBuffer();
  } finally {
    ws.close();
  }
}

/**
 * Run `command` and capture only the OUTPUT between two sentinels — excluding
 * the shell's echo-back of the typed command line. This is essential for
 * assertions that would otherwise be satisfied by the echoed command text
 * (e.g. grepping for a literal `kilocode.kilo-code@7.4.16` that appears in the
 * command itself). The command is expected to print its result to stdout; we
 * wrap it so the captured slice is exactly the command's stdout.
 */
async function captureStdout(containerId: string, command: string, timeoutMs = 30_000): Promise<string> {
  const ws = new TerminalWsClient(containerId);
  try {
    await ws.connect();
    await ws.waitForOutput(/[\$#>]\s*$/, 30_000);
    ws.clearBuffer();

    const start = `CAP_START_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const end = `CAP_END_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Quote the command so the start/end sentinels bracket ONLY its stdout.
    ws.sendLine(`echo ${start}; { ${command}; } ; echo ${end}`);
    await ws.waitForOutput(new RegExp(`\\n${end}\\n`), timeoutMs);

    const buf = ws.getBuffer();
    const m = new RegExp(`${start}\\n([\\s\\S]*?)\\n${end}`).exec(buf);
    return m ? m[1]! : '';
  } finally {
    ws.close();
  }
}

// ─── Extension inventory (single worker, serial) ──────────────────────────

test.describe.serial('Kilo Code — extension inventory', () => {
  let containerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `KiloExt-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    if (containerId) await cleanupWorker(request, containerId);
  });

  test('code-server lists the pinned Kilo Code extension at the exact version', async () => {
    // Count matching lines at runtime so the assertion is on the COMPUTED
    // output of `code-server --list-extensions --show-versions`, never on the
    // echoed command line (which contains the literal `kilocode.kilo-code@…`
    // token and would make a substring assertion vacuously pass). The command
    // is wrapped so the captured slice is exactly the extension listing.
    const out = await captureStdout(
      containerId,
      `code-server --list-extensions --show-versions 2>/dev/null | grep -c '^${KILO_EXTENSION_ID}@${KILO_EXTENSION_VERSION}$'`,
      60_000,
    );
    const count = parseInt((out.match(/\b(\d+)\b/)?.[1] ?? '0'), 10);
    expect(count, `extension listing output:\n${out}`).toBe(1);
  });

  test('the Kilo Code extension is installed in the image-level extension dir', async () => {
    // The Dockerfile installs into /home/agent/.local/share/code-server/extensions.
    // code-server suffixes extension directories with their version. Resolve the
    // directory through code-server rather than depending on that disk naming.
    const out = await captureStdout(
      containerId,
      `test -d "$(code-server --locate-extension ${KILO_EXTENSION_ID} 2>/dev/null)" && echo DIR_OK || echo DIR_MISSING`,
      30_000,
    );
    expect(out.trim()).toBe('DIR_OK');
  });
});

// ─── Same-user shared config/auth + per-worker code-server data (serial) ──

test.describe.serial('Kilo Code — same-user sharing & per-worker code-server data', () => {
  let user: { ctx: APIRequestContext; api: ApiClient; email: string; password: string; id: string };
  let w1Id: string | undefined;
  let w2Id: string | undefined;
  const configMarker = `kilo-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const authMarker = `kilo-auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const csMarker1 = `cs-ud-w1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const csMarker2 = `cs-ud-w2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    user = await createUserAndSignIn('kilo-share');
  });

  test.afterAll(async () => {
    if (w1Id) await cleanupWorker(user.ctx, w1Id).catch(() => {});
    if (w2Id) await cleanupWorker(user.ctx, w2Id).catch(() => {});
    if (user) await cleanupUser(user);
  });

  test('two same-user workers share writes under canonical ~/.config/kilo', async () => {
    test.setTimeout(240_000);
    const w1 = await createWorker(user.ctx, { displayName: `kilo-share-w1-${Date.now()}` });
    w1Id = w1.id;
    const w2 = await createWorker(user.ctx, { displayName: `kilo-share-w2-${Date.now()}` });
    w2Id = w2.id;

    // The orchestrator bind-mounts the user's shared global Kilo config dir over
    // /home/agent/.agent-data/.kilo/config, and the entrypoint symlinks
    // ~/.config/kilo → .agent-data/.kilo/config. A write through the canonical
    // path on worker 1 must be visible on worker 2.
    await execInWorker(
      w1Id,
      `mkdir -p ~/.config/kilo && printf '%s\\n' '${configMarker}' > ~/.config/kilo/shared-test.json`,
    );

    const seen = await captureStdout(w2Id, `cat ~/.config/kilo/shared-test.json 2>/dev/null`);
    expect(seen.trim()).toBe(configMarker);
  });

  test('two same-user workers share writes under canonical ~/.local/share/kilo/auth.json', async () => {
    // The per-user Kilo OAuth credential file is bind-mounted at
    // /home/agent/.agent-data/.kilo/data/auth.json, which the entrypoint
    // surfaces at the canonical ~/.local/share/kilo/auth.json via symlink
    // (.local/share/kilo → .agent-data/.kilo/data). A write on worker 1 must
    // be visible on worker 2 — this is the live-credential-sharing guarantee.
    await execInWorker(
      w1Id!,
      `mkdir -p ~/.local/share/kilo && printf '%s\\n' '${authMarker}' > ~/.local/share/kilo/auth.json`,
    );

    const seen = await captureStdout(w2Id!, `cat ~/.local/share/kilo/auth.json 2>/dev/null`);
    expect(seen.trim()).toBe(authMarker);
  });

  test('code-server user-data markers are per-worker, not shared between same-user workers', async () => {
    // code-server runs with --user-data-dir $AGENT_DATA/.code-server, which is
    // the per-worker agent-data volume (NOT a per-user bind). So a marker
    // written under the code-server user-data dir on worker 1 must NOT appear
    // on worker 2.
    await execInWorker(
      w1Id!,
      `mkdir -p ~/.agent-data/.code-server/User && printf '%s\\n' '${csMarker1}' > ~/.agent-data/.code-server/User/w1-marker.txt`,
    );
    await execInWorker(
      w2Id!,
      `mkdir -p ~/.agent-data/.code-server/User && printf '%s\\n' '${csMarker2}' > ~/.agent-data/.code-server/User/w2-marker.txt`,
    );

    const w1Own = await captureStdout(w1Id!, `cat ~/.agent-data/.code-server/User/w1-marker.txt 2>/dev/null`);
    const w2Own = await captureStdout(w2Id!, `cat ~/.agent-data/.code-server/User/w2-marker.txt 2>/dev/null`);
    expect(w1Own.trim()).toBe(csMarker1);
    expect(w2Own.trim()).toBe(csMarker2);

    // Cross-check: worker 1 must NOT see worker 2's marker and vice versa.
    const w1SeesW2 = await captureStdout(
      w1Id!,
      `test -f ~/.agent-data/.code-server/User/w2-marker.txt && echo LEAKED || echo ISOLATED`,
    );
    const w2SeesW1 = await captureStdout(
      w2Id!,
      `test -f ~/.agent-data/.code-server/User/w1-marker.txt && echo LEAKED || echo ISOLATED`,
    );
    expect(w1SeesW2.trim()).toBe('ISOLATED');
    expect(w2SeesW1.trim()).toBe('ISOLATED');
  });
});

// ─── Cross-user isolation (serial) ────────────────────────────────────────

test.describe.serial('Kilo Code — cross-user isolation', () => {
  let alice: { ctx: APIRequestContext; api: ApiClient; email: string; password: string; id: string };
  let bob: { ctx: APIRequestContext; api: ApiClient; email: string; password: string; id: string };
  let aliceWorkerId: string | undefined;
  let bobWorkerId: string | undefined;
  const aliceCfg = `kilo-alice-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const aliceAuth = `kilo-alice-auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const bobCfg = `kilo-bob-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    alice = await createUserAndSignIn('kilo-iso-a');
    bob = await createUserAndSignIn('kilo-iso-b');
  });

  test.afterAll(async () => {
    if (aliceWorkerId) await cleanupWorker(alice.ctx, aliceWorkerId).catch(() => {});
    if (bobWorkerId) await cleanupWorker(bob.ctx, bobWorkerId).catch(() => {});
    if (alice) await cleanupUser(alice);
    if (bob) await cleanupUser(bob);
  });

  test("a second user's worker cannot see the first user's Kilo config/auth and can hold independent values", async () => {
    test.setTimeout(300_000);
    const aliceWorker = await createWorker(alice.ctx, { displayName: `kilo-iso-alice-${Date.now()}` });
    aliceWorkerId = aliceWorker.id;
    const bobWorker = await createWorker(bob.ctx, { displayName: `kilo-iso-bob-${Date.now()}` });
    bobWorkerId = bobWorker.id;

    // Alice writes her markers through the canonical paths.
    await execInWorker(
      aliceWorkerId,
      `mkdir -p ~/.config/kilo ~/.local/share/kilo && printf '%s\\n' '${aliceCfg}' > ~/.config/kilo/alice.json && printf '%s\\n' '${aliceAuth}' > ~/.local/share/kilo/auth.json`,
    );
    // Bob writes his own config marker.
    await execInWorker(
      bobWorkerId,
      `mkdir -p ~/.config/kilo && printf '%s\\n' '${bobCfg}' > ~/.config/kilo/bob.json`,
    );

    // Bob must NOT see Alice's config or auth markers.
    const bobSeesAliceCfg = await captureStdout(
      bobWorkerId,
      `cat ~/.config/kilo/alice.json 2>/dev/null || echo NONE`,
    );
    const bobSeesAliceAuth = await captureStdout(
      bobWorkerId,
      `cat ~/.local/share/kilo/auth.json 2>/dev/null || echo NONE`,
    );
    expect(bobSeesAliceCfg.trim()).toBe('NONE');
    expect(bobSeesAliceAuth.trim()).toBe('NONE');

    // Alice must NOT see Bob's config marker.
    const aliceSeesBobCfg = await captureStdout(
      aliceWorkerId,
      `cat ~/.config/kilo/bob.json 2>/dev/null || echo NONE`,
    );
    expect(aliceSeesBobCfg.trim()).toBe('NONE');

    // Each worker sees only its own owner's values.
    const aliceOwnCfg = await captureStdout(aliceWorkerId, `cat ~/.config/kilo/alice.json 2>/dev/null`);
    const bobOwnCfg = await captureStdout(bobWorkerId, `cat ~/.config/kilo/bob.json 2>/dev/null`);
    expect(aliceOwnCfg.trim()).toBe(aliceCfg);
    expect(bobOwnCfg.trim()).toBe(bobCfg);
  });
});

// ─── Persistence across rebuild (serial, single worker) ──────────────────

test.describe.serial('Kilo Code — persistence across rebuild', () => {
  let user: { ctx: APIRequestContext; api: ApiClient; email: string; password: string; id: string };
  let containerId: string | undefined;
  const sharedCfgMarker = `kilo-rebuild-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const csMarker = `kilo-rebuild-cs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    user = await createUserAndSignIn('kilo-rebuild');
  });

  test.afterAll(async () => {
    if (containerId) await cleanupWorker(user.ctx, containerId).catch(() => {});
    if (user) await cleanupUser(user);
  });

  test('writes shared Kilo config and per-worker code-server marker before rebuild', async () => {
    test.setTimeout(180_000);
    const container = await createWorker(user.ctx, { displayName: `kilo-rebuild-${Date.now()}` });
    containerId = container.id;

    // Shared (per-user) Kilo config write — must survive rebuild (bind mount).
    await execInWorker(
      containerId,
      `mkdir -p ~/.config/kilo && printf '%s\\n' '${sharedCfgMarker}' > ~/.config/kilo/rebuild-test.json`,
    );
    // Per-worker code-server user-data marker — must survive rebuild (volume).
    await execInWorker(
      containerId,
      `mkdir -p ~/.agent-data/.code-server/User && printf '%s\\n' '${csMarker}' > ~/.agent-data/.code-server/User/rebuild-marker.txt`,
    );
  });

  test('shared Kilo config and per-worker code-server marker survive rebuild', async ({ request }) => {
    test.setTimeout(240_000);
    const api = new ApiClient(user.ctx);
    const { status, body } = await api.rebuildContainer(containerId!);
    expect(status).toBe(200);
    const rebuiltId: string = body.id;
    containerId = rebuiltId;
    await waitForWorkerRunning(user.ctx, rebuiltId, 90_000);

    // Shared per-user Kilo config (bind-mounted) survives rebuild.
    const cfg = await captureStdout(rebuiltId, `cat ~/.config/kilo/rebuild-test.json 2>/dev/null`);
    expect(cfg.trim()).toBe(sharedCfgMarker);

    // Per-worker code-server user-data (agent-data volume) survives rebuild.
    const cs = await captureStdout(
      rebuiltId,
      `cat ~/.agent-data/.code-server/User/rebuild-marker.txt 2>/dev/null`,
    );
    expect(cs.trim()).toBe(csMarker);
  });
});

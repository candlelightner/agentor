import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { captureCommandOutput as execInWorker, captureCommandOutput as captureStdout } from '../helpers/terminal-ws';
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
  const authProvider = `kilo-auth-provider-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const authToken = `kilo-auth-token-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dataMarker = `kilo-data-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

  test('the Kilo shared-data directory is symlinked to ~/.local/share/kilo (shared-data, not .kilo/data)', async () => {
    test.setTimeout(240_000);
    const w1 = await createWorker(user.ctx, { displayName: `kilo-share-w1-${Date.now()}` });
    w1Id = w1.id;
    const w2 = await createWorker(user.ctx, { displayName: `kilo-share-w2-${Date.now()}` });
    w2Id = w2.id;

    // The entrypoint symlinks ~/.local/share/kilo → .agent-data/.kilo/shared-data
    // (the per-user shared-data directory bind). The legacy .kilo/data target is
    // gone — it is migrated into shared-data and removed.
    for (const id of [w1Id, w2Id]) {
      const link = await captureStdout(id!, `readlink ~/.local/share/kilo`);
      expect(link.trim()).toBe('/home/agent/.agent-data/.kilo/shared-data');
      // Legacy per-worker .kilo/data must NOT exist after migration.
      const legacy = await captureStdout(id!, `test -e ~/.agent-data/.kilo/data && echo LEGACY_PRESENT || echo LEGACY_GONE`);
      expect(legacy.trim()).toBe('LEGACY_GONE');
    }
  });

  test('two same-user workers share writes under canonical ~/.config/kilo', async () => {
    // The orchestrator bind-mounts the user's shared global Kilo config dir over
    // /home/agent/.agent-data/.kilo/config, and the entrypoint symlinks
    // ~/.config/kilo → .agent-data/.kilo/config. A write through the canonical
    // path on worker 1 must be visible on worker 2.
    await execInWorker(
      w1Id!,
      `mkdir -p ~/.config/kilo && printf '%s\\n' '${configMarker}' > ~/.config/kilo/shared-test.json`,
    );

    const seen = await captureStdout(w2Id!, `cat ~/.config/kilo/shared-test.json 2>/dev/null`);
    expect(seen.trim()).toBe(configMarker);
  });

  test('Kilo atomic (temp+rename) auth writes on worker A are live on worker B via the shared-data directory bind', async () => {
    // Kilo rewrites auth.json atomically via a temp file + rename. The old
    // per-file bind at .kilo/data/auth.json broke this (the rename replaced the
    // inode the bind pointed at, hiding the new content from other workers).
    // The shared-data DIRECTORY bind survives the atomic replace, so a write
    // on worker A is immediately visible on worker B. We reproduce Kilo's real
    // write pattern here: build the new content in a sibling temp file and `mv`
    // it over the canonical auth.json on worker A, then read it on worker B.
    // This test must fail under the old file-bind implementation.
    const payload = JSON.stringify({ provider: authProvider, token: authToken });
    // `printf %s` keeps the JSON on one line and avoids shell quoting issues.
    await execInWorker(
      w1Id!,
      `tmp=$(mktemp ~/.local/share/kilo/auth.json.XXXXXX) && printf '%s' '${payload.replace(/'/g, `'\\''`)}' > "$tmp" && mv -f "$tmp" ~/.local/share/kilo/auth.json`,
    );

    const seen = await captureStdout(w2Id!, `cat ~/.local/share/kilo/auth.json 2>/dev/null`);
    // Worker B sees the provider marker live — proving the directory bind
    // surfaces the renamed file (not a stale inode).
    expect(seen).toContain(authProvider);
    expect(seen).toContain(authToken);
    // The auth file must remain a regular file (not a symlink), inside the
    // shared-data directory.
    const type = await captureStdout(w2Id!, `readlink -f ~/.local/share/kilo/auth.json`);
    expect(type.trim()).toBe('/home/agent/.agent-data/.kilo/shared-data/auth.json');
  });

  test('a non-auth data marker under ~/.local/share/kilo is shared same-user', async () => {
    // The shared-data directory carries auth.json plus Kilo's SQLite
    // session/history DBs — all shared across that user's workers. A marker
    // written next to auth.json on worker A must be visible on worker B.
    await execInWorker(
      w1Id!,
      `printf '%s\\n' '${dataMarker}' > ~/.local/share/kilo/shared-data-marker.txt`,
    );

    const seen = await captureStdout(w2Id!, `cat ~/.local/share/kilo/shared-data-marker.txt 2>/dev/null`);
    expect(seen.trim()).toBe(dataMarker);
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
    // Bob's shared auth.json is seeded as `{}` (his own per-user store), so it
    // is present but must NOT carry Alice's marker — that is the real
    // isolation invariant, not file absence.
    expect(bobSeesAliceAuth).not.toContain(aliceAuth);

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
  const sharedAuthProvider = `kilo-rebuild-auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sharedDataMarker = `kilo-rebuild-data-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const csMarker = `kilo-rebuild-cs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    user = await createUserAndSignIn('kilo-rebuild');
  });

  test.afterAll(async () => {
    if (containerId) await cleanupWorker(user.ctx, containerId).catch(() => {});
    if (user) await cleanupUser(user);
  });

  test('writes shared Kilo config/auth/data and a per-worker code-server marker before rebuild', async () => {
    test.setTimeout(180_000);
    const container = await createWorker(user.ctx, { displayName: `kilo-rebuild-${Date.now()}` });
    containerId = container.id;

    // Shared (per-user) Kilo config write — must survive rebuild (bind mount).
    await execInWorker(
      containerId,
      `mkdir -p ~/.config/kilo && printf '%s\\n' '${sharedCfgMarker}' > ~/.config/kilo/rebuild-test.json`,
    );
    // Shared (per-user) Kilo auth write via the canonical path (directory bind
    // survives rebuild). Use a JSON object so it looks like real Kilo auth.
    await execInWorker(
      containerId,
      `printf '%s' '{"provider":"${sharedAuthProvider}"}' > ~/.local/share/kilo/auth.json`,
    );
    // Shared (per-user) non-auth data marker alongside auth.json in shared-data.
    await execInWorker(
      containerId,
      `printf '%s\\n' '${sharedDataMarker}' > ~/.local/share/kilo/rebuild-data.txt`,
    );
    // Per-worker code-server user-data marker — must survive rebuild (volume).
    await execInWorker(
      containerId,
      `mkdir -p ~/.agent-data/.code-server/User && printf '%s\\n' '${csMarker}' > ~/.agent-data/.code-server/User/rebuild-marker.txt`,
    );
  });

  test('shared Kilo config/auth/data and per-worker code-server marker survive rebuild', async ({ request }) => {
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

    // Shared per-user Kilo auth (directory bind) survives rebuild.
    const auth = await captureStdout(rebuiltId, `cat ~/.local/share/kilo/auth.json 2>/dev/null`);
    expect(auth).toContain(sharedAuthProvider);

    // Shared per-user Kilo data marker (next to auth in shared-data) survives.
    const data = await captureStdout(rebuiltId, `cat ~/.local/share/kilo/rebuild-data.txt 2>/dev/null`);
    expect(data.trim()).toBe(sharedDataMarker);

    // Per-worker code-server user-data (agent-data volume) survives rebuild.
    const cs = await captureStdout(
      rebuiltId,
      `cat ~/.agent-data/.code-server/User/rebuild-marker.txt 2>/dev/null`,
    );
    expect(cs.trim()).toBe(csMarker);
  });
});

// ─── One-time legacy .kilo/data → shared-data migration (serial) ────────

test.describe.serial('Kilo Code — legacy .kilo/data migration', () => {
  let user: { ctx: APIRequestContext; api: ApiClient; email: string; password: string; id: string };
  let containerId: string | undefined;
  // Random marker values (no real keys) — distinguish the legacy-only and
  // shared-pre-existing auth entries so the merge semantics are unambiguous.
  const legacyAuthProvider = `kilo-mig-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sharedAuthProvider = `kilo-mig-shared-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const legacyDataMarker = `kilo-mig-data-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  test.beforeAll(async () => {
    user = await createUserAndSignIn('kilo-migrate');
  });

  test.afterAll(async () => {
    if (containerId) await cleanupWorker(user.ctx, containerId).catch(() => {});
    if (user) await cleanupUser(user);
  });

  test('seed a pre-existing shared provider before forcing legacy migration', async () => {
    test.setTimeout(240_000);
    const container = await createWorker(user.ctx, { displayName: `kilo-migrate-${Date.now()}` });
    containerId = container.id;

    // Pre-populate the shared auth file with an existing provider that must
    // NOT be overwritten by the legacy merge. Writing through the canonical
    // symlink lands in the per-user shared-data bind.
    await execInWorker(
      containerId,
      `printf '%s' '{"existing":"${sharedAuthProvider}"}' > ~/.local/share/kilo/auth.json`,
    );

    // Plant a legacy per-worker .kilo/data dir directly inside the per-worker
    // agent-data volume. This simulates a pre-shared-data worker that still
    // carries its old auth + DB/history. The entrypoint migration block will
    // copy non-auth entries verbatim and merge auth.json (adding missing keys
    // only). auth.json here carries a DIFFERENT provider than the shared one.
    await execInWorker(
      containerId,
      `mkdir -p ~/.agent-data/.kilo/data && printf '%s' '{"legacy":"${legacyAuthProvider}"}' > ~/.agent-data/.kilo/data/auth.json && printf '%s\\n' '${legacyDataMarker}' > ~/.agent-data/.kilo/data/legacy-only.txt`,
    );

    // Remove this worker's shared migration marker so the next boot re-runs
    // the migration. The marker lives in the per-user shared-data dir keyed by
    // the stable worker id (the container's UUID, sourced from $WORKER.id).
    await execInWorker(
      containerId,
      `rm -f ~/.agent-data/.kilo/shared-data/.migrated-worker-${containerId}`,
    );
  });

  test('restart migrates missing legacy auth/data without overwriting the shared provider and removes .kilo/data', async () => {
    test.setTimeout(240_000);
    const api = new ApiClient(user.ctx);
    await api.stopContainer(containerId!);
    await new Promise((r) => setTimeout(r, 2000));
    await api.restartContainer(containerId!);
    await waitForWorkerRunning(user.ctx, containerId!, 90_000);

    // The legacy auth entry was MISSING in shared auth → merged in.
    const auth = await captureStdout(containerId!, `cat ~/.local/share/kilo/auth.json 2>/dev/null`);
    expect(auth).toContain(legacyAuthProvider);
    // The pre-existing shared entry was NOT overwritten.
    expect(auth).toContain(sharedAuthProvider);

    // The legacy-only data file was copied into shared-data.
    const data = await captureStdout(containerId!, `cat ~/.local/share/kilo/legacy-only.txt 2>/dev/null`);
    expect(data.trim()).toBe(legacyDataMarker);

    // The legacy per-worker .kilo/data dir is removed (no stale secret copy).
    const legacy = await captureStdout(
      containerId!,
      `test -e ~/.agent-data/.kilo/data && echo LEGACY_PRESENT || echo LEGACY_GONE`,
    );
    expect(legacy.trim()).toBe('LEGACY_GONE');

    // The migration marker now exists for this worker id.
    const marker = await captureStdout(
      containerId!,
      `test -f ~/.agent-data/.kilo/shared-data/.migrated-worker-${containerId} && echo MARKER_SET || echo MARKER_MISSING`,
    );
    expect(marker.trim()).toBe('MARKER_SET');

    // Cleanup the shared markers we touched so this user's shared-data is left
    // in a clean state for any other test that might reuse the user (best
    // effort — the user is torn down in afterAll anyway).
    await execInWorker(
      containerId!,
      `rm -f ~/.local/share/kilo/legacy-only.txt ~/.agent-data/.kilo/shared-data/.migrated-worker-${containerId}`,
    ).catch(() => {});
  });
});

import { test, expect } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { captureCommandOutput as execInWorker } from '../helpers/terminal-ws';

const WORKER_ROLE_SKILL_SHA256 = '74c26bf91bd0c457c2d403935f0504cefe79c1ed65696bd540f975eb5c8117ad';

// -- Symlink and mount verification (single worker, serial) --

test.describe.serial('Agent data persistence — mount verification', () => {
  let containerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `AgentData-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('agent config dirs are symlinked to .agent-data volume', async () => {
    const output = await execInWorker(containerId, 'readlink ~/.claude && readlink ~/.gemini && readlink ~/.codex && readlink ~/.agents');
    expect(output).toContain('/home/agent/.agent-data/.claude');
    expect(output).toContain('/home/agent/.agent-data/.gemini');
    expect(output).toContain('/home/agent/.agent-data/.codex');
    expect(output).toContain('/home/agent/.agent-data/.agents');
  });

  test('Kilo canonical XDG paths are symlinked to .agent-data/.kilo subdirs', async () => {
    // The entrypoint symlinks each Kilo XDG path at the corresponding per-worker
    // .agent-data/.kilo/<dir>. config and shared-data are overlaid by per-user
    // shared binds (global config + auth/sessions/history shared across this
    // user's workers); state/cache stay per-worker. The symlink target is still
    // the .agent-data path (the binds mount on top of the symlink-resolved dir).
    const output = await execInWorker(
      containerId,
      'readlink ~/.config/kilo && readlink ~/.local/share/kilo && readlink ~/.local/state/kilo && readlink ~/.cache/kilo',
    );
    expect(output).toContain('/home/agent/.agent-data/.kilo/config');
    expect(output).toContain('/home/agent/.agent-data/.kilo/shared-data');
    expect(output).toContain('/home/agent/.agent-data/.kilo/state');
    expect(output).toContain('/home/agent/.agent-data/.kilo/cache');
  });

  test('~/.claude.json is symlinked to .agent-data volume', async () => {
    const output = await execInWorker(containerId, 'readlink ~/.claude.json');
    expect(output).toContain('/home/agent/.agent-data/.claude.json');
  });

  test('credential files are the per-user bind mount (regular files, not symlinks)', async () => {
    // Claude/Codex/Gemini credential files are bind-mounted from
    // <DATA_DIR>/users/<userId>/credentials/<file>.json directly at the CLI's
    // expected path inside the agent-data volume — regular files, not symlinks.
    // Kilo's auth.json is surfaced through the per-user shared-data directory
    // bind (`.agent-data/.kilo/shared-data`, symlinked to ~/.local/share/kilo).
    // It is a regular file whose canonical resolved path lives inside
    // `.kilo/shared-data`, NOT a symlink itself.
    const output = await execInWorker(
      containerId,
      'stat -c "%F" ~/.claude/.credentials.json ~/.codex/auth.json ~/.gemini/oauth_creds.json ~/.local/share/kilo/auth.json 2>/dev/null',
    );
    // Terminal echoes the command line before the output, so line counting is
    // fragile — count occurrences of each file type in the buffer instead.
    const regularCount = (output.match(/regular file/g) ?? []).length;
    expect(regularCount).toBe(4);
    expect(output).not.toContain('symbolic link');

    // Kilo's auth.json resolves inside the shared-data directory (not the
    // legacy .kilo/data).
    const resolved = await execInWorker(containerId, 'readlink -f ~/.local/share/kilo/auth.json');
    expect(resolved.trim()).toBe('/home/agent/.agent-data/.kilo/shared-data/auth.json');
    // The legacy per-worker .kilo/data is gone (migrated + removed on boot).
    const legacy = await execInWorker(
      containerId,
      'test -e ~/.agent-data/.kilo/data && echo LEGACY_PRESENT || echo LEGACY_GONE',
    );
    expect(legacy.trim()).toBe('LEGACY_GONE');
  });

  test('claude settings.json exists with expected keys', async () => {
    const output = await execInWorker(containerId, 'cat ~/.claude/settings.json');
    expect(output).toContain('skipDangerousModePermissionPrompt');
    expect(output).toContain('bypassPermissions');
  });

  test('claude.json contains playwright MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.claude.json');
    expect(output).toContain('"playwright"');
    expect(output).toContain('@playwright/mcp@latest');
  });

  test('claude.json contains chrome-devtools MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.claude.json');
    expect(output).toContain('"chrome-devtools"');
    expect(output).toContain('chrome-devtools-mcp@latest');
  });

  test('claude.json exists with onboarding and trust keys', async () => {
    const output = await execInWorker(containerId, 'cat ~/.claude.json');
    expect(output).toContain('hasCompletedOnboarding');
    expect(output).toContain('/workspace');
  });

  test('codex config.toml exists with workspace trust', async () => {
    const output = await execInWorker(containerId, 'cat ~/.codex/config.toml');
    expect(output).toContain('trust_level');
    expect(output).toContain('/workspace');
  });

  test('codex config.toml contains playwright MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.codex/config.toml');
    expect(output).toContain('[mcp_servers.playwright]');
    expect(output).toContain('@playwright/mcp@latest');
  });

  test('codex config.toml contains chrome-devtools MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.codex/config.toml');
    expect(output).toContain('[mcp_servers.chrome-devtools]');
    expect(output).toContain('chrome-devtools-mcp@latest');
  });

  test('gemini trustedFolders.json exists with workspace trust', async () => {
    const output = await execInWorker(containerId, 'cat ~/.gemini/trustedFolders.json');
    expect(output).toContain('TRUST_FOLDER');
    expect(output).toContain('/workspace');
  });

  test('gemini settings.json contains playwright MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.gemini/settings.json');
    expect(output).toContain('playwright');
    expect(output).toContain('@playwright/mcp@latest');
  });

  test('gemini settings.json contains chrome-devtools MCP server', async () => {
    const output = await execInWorker(containerId, 'cat ~/.gemini/settings.json');
    expect(output).toContain('chrome-devtools');
    expect(output).toContain('chrome-devtools-mcp@latest');
  });

  test('built-in capability SKILL.md is written with real (non-empty) content', async () => {
    // Regression guard for the common.sh capability writer: the streaming jq
    // pass must reproduce the full markdown content (YAML frontmatter + body),
    // not an empty/truncated file. The `tmux` capability is always written by
    // the default environment. Assert the file is non-trivial and carries its
    // frontmatter `name:` line plus multi-word body text.
    const skill = '~/.claude/skills/agentor-tmux/SKILL.md';
    const size = await execInWorker(containerId, `wc -c < ${skill} 2>/dev/null`);
    // A real capability doc is well over a few hundred bytes.
    expect(parseInt(size.match(/\b(\d{3,})\b/)?.[1] ?? '0', 10)).toBeGreaterThan(200);
    const head = await execInWorker(containerId, `head -5 ${skill}`);
    expect(head).toContain('---');
    expect(head.toLowerCase()).toContain('name:');
  });

  test('ordinary workers receive only the authoritative worker-runtime role skill', async () => {
    const output = await execInWorker(containerId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-worker-runtime/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-worker-runtime/SKILL.md | cut -d' ' -f1)"
      printf 'CLAUDE_RESERVED=%s\\n' "$(find ~/.claude/skills -mindepth 1 -maxdepth 1 -printf '%f\\n' | grep -E '^(agentor-(global|group)-administration|agentor-worker-runtime)$' | sort | paste -sd, -)"
      printf 'CODEX_RESERVED=%s\\n' "$(find ~/.agents/skills -mindepth 1 -maxdepth 1 -printf '%f\\n' | grep -E '^(agentor-(global|group)-administration|agentor-worker-runtime)$' | sort | paste -sd, -)"
      printf 'GEMINI_RESERVED=%s\\n' "$(find ~/.gemini/commands -mindepth 1 -maxdepth 1 -printf '%f\\n' | grep -E '^(agentor-(global|group)-administration|agentor-worker-runtime)\\.toml$' | sort | paste -sd, -)"
    `.trim().replace(/\n\s*/g, '; '));
    expect(output).toContain(`CLAUDE_SHA=${WORKER_ROLE_SKILL_SHA256}`);
    expect(output).toContain(`CODEX_SHA=${WORKER_ROLE_SKILL_SHA256}`);
    expect(output).toContain('CLAUDE_RESERVED=agentor-worker-runtime');
    expect(output).toContain('CODEX_RESERVED=agentor-worker-runtime');
    expect(output).toContain('GEMINI_RESERVED=agentor-worker-runtime.toml');
  });
});

// -- Persistence across restart (serial, single worker) --

test.describe.serial('Agent data persistence — restart', () => {
  let containerId: string;
  const MARKER = `restart-persist-${Date.now()}`;
  const CS_MARKER = `restart-cs-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `Restart-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('write marker file to agent config dir', async () => {
    const output = await execInWorker(containerId, `echo "${MARKER}" > ~/.claude/test-marker.txt && cat ~/.claude/test-marker.txt`);
    expect(output).toContain(MARKER);
  });

  test('write code-server user-data marker to per-worker volume', async () => {
    // code-server runs with --user-data-dir $AGENT_DATA/.code-server (the
    // per-worker agent-data volume), so a marker written there must persist
    // across restart like the agent config markers above.
    const output = await execInWorker(
      containerId,
      `mkdir -p ~/.agent-data/.code-server/User && echo "${CS_MARKER}" > ~/.agent-data/.code-server/User/test-marker.txt && cat ~/.agent-data/.code-server/User/test-marker.txt`,
    );
    expect(output).toContain(CS_MARKER);
  });

  test('marker file persists after container restart', async ({ request }) => {
    const api = new ApiClient(request);
    await api.stopContainer(containerId);
    await new Promise(r => setTimeout(r, 2000));
    await api.restartContainer(containerId);
    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(containerId, `cat ~/.claude/test-marker.txt`);
    expect(output).toContain(MARKER);
  });

  test('code-server user-data marker persists after container restart', async ({ request }) => {
    const api = new ApiClient(request);
    await api.stopContainer(containerId);
    await new Promise(r => setTimeout(r, 2000));
    await api.restartContainer(containerId);
    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(
      containerId,
      `cat ~/.agent-data/.code-server/User/test-marker.txt`,
    );
    expect(output).toContain(CS_MARKER);
  });
});

// -- Persistence across rebuild (serial, single worker) --

test.describe.serial('Agent data persistence — rebuild', () => {
  let containerId: string;
  const MARKER = `rebuild-persist-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `Rebuild-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('write marker file to agent config dir', async () => {
    const output = await execInWorker(containerId, `echo "${MARKER}" > ~/.gemini/test-marker.txt && cat ~/.gemini/test-marker.txt`);
    expect(output).toContain(MARKER);
  });

  test('seed stale privileged role files and an unrelated user skill before rebuild', async () => {
    const output = await execInWorker(containerId, `
      mkdir -p ~/.claude/skills/agentor-global-administration ~/.claude/skills/user-kept
      mkdir -p ~/.agents/skills/agentor-group-administration ~/.agents/skills/user-kept
      printf stale > ~/.claude/skills/agentor-global-administration/SKILL.md
      printf stale > ~/.agents/skills/agentor-group-administration/SKILL.md
      printf keep > ~/.claude/skills/user-kept/SKILL.md
      printf keep > ~/.agents/skills/user-kept/SKILL.md
      printf stale > ~/.gemini/commands/agentor-global-administration.toml
      printf 'SEEDED=%s\\n' "$(cat ~/.claude/skills/user-kept/SKILL.md ~/.agents/skills/user-kept/SKILL.md)"
    `.trim().replace(/\n\s*/g, '; '));
    expect(output).toContain('SEEDED=keepkeep');
  });

  test('marker file persists after container rebuild', async ({ request }) => {
    const api = new ApiClient(request);
    const { status, body } = await api.rebuildContainer(containerId);
    expect(status).toBe(200);
    containerId = body.id;

    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(containerId, `cat ~/.gemini/test-marker.txt`);
    expect(output).toContain(MARKER);

    const role = await execInWorker(containerId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-worker-runtime/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-worker-runtime/SKILL.md | cut -d' ' -f1)"
      test ! -e ~/.claude/skills/agentor-global-administration && test ! -e ~/.claude/skills/agentor-group-administration && printf 'CLAUDE_ISOLATED=1\\n'
      test ! -e ~/.agents/skills/agentor-global-administration && test ! -e ~/.agents/skills/agentor-group-administration && printf 'CODEX_ISOLATED=1\\n'
      test ! -e ~/.gemini/commands/agentor-global-administration.toml && test ! -e ~/.gemini/commands/agentor-group-administration.toml && printf 'GEMINI_ISOLATED=1\\n'
      printf 'USER_SKILLS=%s\\n' "$(cat ~/.claude/skills/user-kept/SKILL.md ~/.agents/skills/user-kept/SKILL.md)"
    `.trim().replace(/\n\s*/g, '; '));
    expect(role).toContain(`CLAUDE_SHA=${WORKER_ROLE_SKILL_SHA256}`);
    expect(role).toContain(`CODEX_SHA=${WORKER_ROLE_SKILL_SHA256}`);
    expect(role).toContain('CLAUDE_ISOLATED=1');
    expect(role).toContain('CODEX_ISOLATED=1');
    expect(role).toContain('GEMINI_ISOLATED=1');
    expect(role).toContain('USER_SKILLS=keepkeep');
  });
});

// -- Persistence across archive/unarchive (serial, single worker) --

test.describe.serial('Agent data persistence — archive/unarchive', () => {
  let containerId: string;
  let workerId: string;
  const MARKER = `archive-persist-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `Archive-${Date.now()}` });
    containerId = container.id;
    workerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('write marker file to agent config dir', async () => {
    const output = await execInWorker(containerId, `echo "${MARKER}" > ~/.codex/test-marker.txt && cat ~/.codex/test-marker.txt`);
    expect(output).toContain(MARKER);
  });

  test('marker file persists after archive and unarchive', async ({ request }) => {
    const api = new ApiClient(request);
    await api.archiveContainer(containerId);

    const { status, body } = await api.unarchiveWorker(workerId);
    expect(status).toBe(200);
    containerId = body.id;

    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(containerId, `cat ~/.codex/test-marker.txt`);
    expect(output).toContain(MARKER);
  });
});

// -- Config files are NOT overwritten on restart/rebuild (serial, single worker) --

test.describe.serial('Agent data persistence — no overwrite', () => {
  let containerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request, { displayName: `NoOverwrite-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('user modifications to settings.json are not overwritten on restart', async ({ request }) => {
    // Replace settings.json with custom content
    await execInWorker(containerId, 'echo \'{"custom":"user-owned"}\' > ~/.claude/settings.json');

    const api = new ApiClient(request);
    await api.stopContainer(containerId);
    await new Promise(r => setTimeout(r, 2000));
    await api.restartContainer(containerId);
    await waitForWorkerRunning(request, containerId, 90_000);

    // Setup script must NOT overwrite — file already existed
    const output = await execInWorker(containerId, 'cat ~/.claude/settings.json');
    expect(output).toContain('user-owned');
    expect(output).not.toContain('bypassPermissions');
  });

  test('user modifications to claude.json are not overwritten on restart', async ({ request }) => {
    // Replace claude.json with custom content (use cat > to write through symlink)
    await execInWorker(containerId, 'echo \'{"mcpServers":{"my-server":{"command":"test"}}}\' > ~/.claude.json');

    const api = new ApiClient(request);
    await api.stopContainer(containerId);
    await new Promise(r => setTimeout(r, 2000));
    await api.restartContainer(containerId);
    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(containerId, 'cat ~/.claude.json');
    expect(output).toContain('mcpServers');
    expect(output).not.toContain('hasCompletedOnboarding');
  });

  test('user modifications to settings.json are not overwritten on rebuild', async ({ request }) => {
    // Write custom settings (previous test left custom claude.json)
    await execInWorker(containerId, 'echo \'{"rebuilt":"still-here"}\' > ~/.claude/settings.json');

    const api = new ApiClient(request);
    const { body } = await api.rebuildContainer(containerId);
    containerId = body.id;
    await waitForWorkerRunning(request, containerId, 90_000);

    const output = await execInWorker(containerId, 'cat ~/.claude/settings.json');
    expect(output).toContain('still-here');
    expect(output).not.toContain('bypassPermissions');
  });
});

// -- exposeApis gates which built-in API capability docs are written --

test.describe.serial('Capability exposeApis filtering (worker-level)', () => {
  let containerId: string;
  let envId: string;

  test.beforeAll(async ({ request }) => {
    const api = new ApiClient(request);
    // portMappings disabled, domain/usage enabled. The built-in `port-mapping`
    // capability must be filtered out of the worker; `domain-mapping`, `usage`,
    // and the always-on `tmux` capability must still be written. The filter is
    // keyed by the built-in's slug (its name) — a regression guard for the
    // capability id becoming a derived UUID (a UUID-keyed lookup would never
    // match, wrongly leaving agentor-port-mapping in place).
    const { body: env } = await api.createEnvironment({
      name: `CapFilter-${Date.now()}`,
      networkMode: 'full',
      // Request-controlled environment data must not select either privileged
      // role; entrypoint captures only the server-provisioned worker identity.
      envVars: 'AGENTOR_RUNTIME_ROLE=platform-admin\nAGENTOR_TRUSTED_RUNTIME_ROLE=group-admin',
      exposeApis: { portMappings: false, domainMappings: true, usage: true },
      enabledCapabilityIds: null, // all built-ins
    });
    envId = env.id;
    const container = await createWorker(request, { environmentId: envId, displayName: `CapFilter-${Date.now()}` });
    containerId = container.id;
  });

  test.afterAll(async ({ request }) => {
    if (containerId) await cleanupWorker(request, containerId);
    if (envId) await new ApiClient(request).deleteEnvironment(envId);
  });

  test('built-in capability with exposeApi=false is not written; enabled ones are', async () => {
    // Capabilities are written to ~/.claude/skills/agentor-<safe-name>/ on first startup.
    const out = await execInWorker(containerId, 'ls -1 ~/.claude/skills 2>/dev/null', 60_000);
    expect(out).not.toContain('agentor-port-mapping'); // portMappings:false → filtered out
    expect(out).toContain('agentor-domain-mapping');   // domainMappings:true → present
    expect(out).toContain('agentor-usage');            // usage:true → present
    expect(out).toContain('agentor-tmux');             // never API-filtered
    expect(out).toContain('agentor-worker-runtime');
    expect(out).not.toContain('agentor-global-administration');
    expect(out).not.toContain('agentor-group-administration');
  });
});

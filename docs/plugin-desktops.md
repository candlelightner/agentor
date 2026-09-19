# Managed plugin desktops

Plugins can opt into an independent Agentor-managed X display. Each installation
owns one display, a window-manager session, X authorization file, and native
desktop actions. The existing worker Desktop (`:99`) continues to operate.

## Architecture and authorization

The installation store serializes durable display reservations per owner and
worker, excluding `:99` and all other plugin reservations. `isolated` allocations
use the platform's 100–999 pool. A worker-side collision check skips occupied
displays, including those started outside Agentor; an atomic X server lock is
the final check. No desktop TCP ports are allocated.

The lifecycle reconciler starts an image-baked supervisor before the plugin's
GUI command. It owns Xvfb and fluxbox in an installation-specific process group,
with an independent fluxbox HOME and X authorization cookie. Xvfb disables TCP.
The supervisor tears down its children when either fails; Linux parent-death
signals also terminate them when the supervisor is killed. The 30-second
reconciliation loop probes desired desktops and restarts the desktop/application
when necessary. Startup, worker restart/rebuild, enable, disable, and uninstall
use the same lifecycle. PID records include Linux process start times, preventing
stale records from signaling a reused PID. Disabling retains the allocation for
stable re-enable; uninstall releases it after successful cleanup.
If an X lock survives a container restart and its PID is reused by an unrelated
process, the runner reclaims only its recorded stale lock after checking the old
server identity and confirming there is no listening X socket. Unknown locks or
another X server's state are left alone.

The first-party page is served at
`/plugin-desktop/:workerId/:installationId/:actionId/primary/`. Its relative
`core/` and `vendor/` module requests are proxied from the worker's installed
noVNC library. CSS is part of the page; no generic plugin HTTP server is needed.
Relative module, status, and WebSocket URLs preserve reverse-proxy path prefixes.
The proxy must forward the public Host and Origin and support WebSocket upgrades;
configure Nuxt's app base URL when serving the dashboard under a prefix.

For each viewer, Agentor launches x11vnc in `-inetd` mode. An installation-bound
helper relays RFB over a Unix socket pair and Docker exec to the authenticated
WebSocket. It never listens on VNC, HTTP, or websockify ports. Multiple viewers
can attach to a display, and viewers of different installations coexist.
Disconnecting a viewer ends only its x11vnc process. Each viewer can independently
scale its viewport; the X resolution is selected in the manifest.

Every page, status, module, and WebSocket request checks the browser session,
worker ownership (or existing administrator authority), installation ownership,
pinned definition, current definition visibility, native action, and `primary`
display reference. The server resolves the allocated display and live container;
neither can be overridden by a URL parameter. Connections require desired-enabled,
ready state for the current container and matching display observation. WebSockets
reject foreign and opaque origins, cap pending input, and revalidate session and
installation state every two seconds. Disable/removal revokes connected viewers.
Dashboard cookies and authorization headers never reach the worker asset server.
Failures return bounded platform messages; X cookies, authorization file contents,
process output, and session credentials are not inspection fields.

**Trust boundary:** plugins already execute as the same `agent` user with
passwordless sudo. Separate displays and X cookies provide independent graphical
sessions and protect against accidental cross-display connections; they do not
sandbox mutually hostile code inside one worker. Such code can read another
plugin's files or become root. Different tenants must use different workers.
Process-level isolation against hostile plugins requires a separate execution
sandbox/user/container model. Worker code and the installed noVNC assets remain
trusted under the existing worker desktop security model. This feature does not
claim to change that boundary.

## Plugin manifest

Schema version `1` gains additive fields:

```json
{
  "schemaVersion": 1,
  "name": "Presentation Reviewer",
  "slug": "presentation-reviewer",
  "description": "Slides and speaker notes in a private graphical workspace",
  "version": "1.0.0",
  "resources": {
    "display": { "mode": "isolated", "width": 1920, "height": 1080, "depth": 24 }
  },
  "lifecycle": {
    "start": {
      "argv": ["/workspace/presentation/open-review"],
      "mode": "background",
      "cwd": "/workspace"
    }
  },
  "actions": [
    {
      "id": "open",
      "label": "Open Presentation Review",
      "kind": "desktop",
      "displayId": "primary",
      "openMode": "sandboxed-pane"
    }
  ]
}
```

`width` defaults to 1920 (320–3840), `height` to 1080 (200–2160), and `depth`
to 24 (the supported depth). Dimension fields apply only to `isolated`; display
ranges are platform-owned in this mode. The singular display resource has the
native action ID `primary`; authors may omit `displayId` and `openMode` to use
their defaults. Native actions require `shared` or `isolated` and reject `portId`
and `path`. They support both dashboard panes and standalone tabs.

The runner sets `DISPLAY=:<number>`, `XAUTHORITY` for isolated applications, and
the existing `AGENTOR_PLUGIN_DISPLAY=<number>` numeric metadata. Do not overwrite
DISPLAY/XAUTHORITY, start display servers or window managers, or declare a noVNC
port. A background launcher should keep its GUI applications in its process group
and wait for them, so the existing plugin runner can manage shutdown.

For the reference workflow, the launch script can open
`/workspace/presentation/main.pdf` and the already-rendered speaker-notes PDF in
the PDF viewer installed in the worker image, then wait for both windows. The
Thesis PDF Annotator continues using `{ "mode": "shared" }` and the normal
worker Desktop. Paths and PDF viewer choice belong to those plugins; Agentor
does not render PDFs or install document-specific applications.

## API and UI

Existing install/enable/remove APIs remain unchanged. Installation list responses
add `displayMode`; worker-self list/inspect also include it. `allocations.display`
remains the numeric identifier. Managed desktop observations appear as:

```json
{
  "desktop": {
    "mode": "isolated",
    "display": 100,
    "state": "ready",
    "viewerReady": true
  }
}
```

The example display is illustrative, not a promised allocation. Desktop state
can be `starting`, `ready`, `reconnecting`, `failed`, or `disabled`;
`observed.error` carries bounded failure details. The viewer reports its own
connection/reconnection state. Action buttons appear on the worker card and Apps
pane, with Open in tab and disabled/starting/failed states. The viewer includes
Reconnect, viewport scaling, and an Open in tab link. A failed initial isolated
installation is retained for inspection and retry rather than deleting the record
and potentially orphaning its allocation.

## Upgrade and operation

Update both the orchestrator and worker image, then rebuild affected workers.
Custom image versions must be rebuilt from a current Agentor base. Old images
fail with a managed-desktop diagnostic; they cannot silently fall back to `:99`.
No existing definition needs migration. `none`, `shared`, legacy `dedicated`
(allocation only), `private-ui`, and `private-ui` with `openMode: "desktop"`
retain their existing meanings. Portable exports continue to carry desired
manifest configuration and omit observed state, allocations, and credentials.

If a desktop fails, inspect its plugin state, verify the worker image includes
the desktop runner, xauth, Xvfb, fluxbox, x11vnc, and noVNC, check available memory
and display conflicts, then retry Enable. Each framebuffer consumes memory and
each attached viewer has a separate encoder process; account for this in worker
resource limits. Disable unused plugins. Uninstall stops only that installation's
GUI and desktop and releases its reservation; the normal Desktop and neighboring
installations remain usable.

## Verification

`worker/apps/plugin-runner/test_desktop_runtime.py` exercises real X servers,
cross-cookie denial, collision safety, cleanup, and repeated RFB handshakes.
`tests/api/plugin-desktop-core.spec.ts` covers validation, concurrent durable
reservations, authorization, recovery, and failure cleanup. API acceptance tests
exercise authenticated assets/WebSockets, cross-user denial, worker restart, and
scoped disable/uninstall. Browser tests open a dashboard pane and simultaneous
tabs, verify the actual red/blue application pixels and independent resolutions,
refresh/reconnect, and verify live viewer revocation.

Run the focused acceptance suite in a fresh isolated Docker stack:

```bash
cd tests
npm run test:docker -- api/plugin-desktops.spec.ts ui/plugin-desktops.spec.ts api/plugin-ui-proxy.spec.ts api/plugin-core.spec.ts api/plugin-desktop-core.spec.ts --retries=0
```

For fast real-X11 and module checks:

```bash
cd worker/apps/plugin-runner
python3 -m unittest -v test_desktop_runtime.py test_runner.py
cd ../../../tests
npx playwright test --config=playwright.modules.config.ts api/plugin-core.spec.ts api/plugin-desktop-core.spec.ts
```

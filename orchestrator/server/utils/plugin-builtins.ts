import type { PluginManifest } from "./plugin-manifest";

export const BUILT_IN_PLUGINS: Array<{ id: string; manifest: PluginManifest }> =
  [
    {
      id: "00000000-0000-4000-8000-000000000101",
      manifest: {
        schemaVersion: 1,
        name: "Chromium",
        slug: "chromium",
        description: "Chromium browser with a private DevTools endpoint.",
        version: "1",
        lifecycle: {
          start: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/chromium/manage.sh start "$AGENTOR_PLUGIN_INSTANCE_ID" "$AGENTOR_PLUGIN_PORT_CDP"',
            ],
            mode: "oneshot",
          },
          readiness: { kind: "tcp", portId: "cdp", timeoutSeconds: 30 },
          stop: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/chromium/manage.sh stop "$AGENTOR_PLUGIN_INSTANCE_ID"',
            ],
            mode: "oneshot",
          },
        },
        resources: {
          ports: [
            { id: "cdp", protocol: "http", rangeStart: 9222, rangeEnd: 9322 },
          ],
          display: { mode: "shared" },
        },
        documentation: {
          markdown:
            "Starts an isolated Chromium profile on the worker display and exposes its Chrome DevTools endpoint only through authorized Agentor surfaces.",
          skillMarkdown:
            "Use this installed Chromium capability when visible browser interaction or CDP automation is needed. Discover its allocated port and status through the worker plugin MCP; do not guess ports.",
        },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      manifest: {
        schemaVersion: 1,
        name: "SOCKS5 Proxy",
        slug: "socks5",
        description: "Worker-local SOCKS5 proxy.",
        version: "1",
        lifecycle: {
          start: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/socks5/manage.sh start "$AGENTOR_PLUGIN_INSTANCE_ID" "$AGENTOR_PLUGIN_PORT_SOCKS"',
            ],
            mode: "oneshot",
          },
          readiness: { kind: "tcp", portId: "socks", timeoutSeconds: 15 },
          stop: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/socks5/manage.sh stop "$AGENTOR_PLUGIN_INSTANCE_ID"',
            ],
            mode: "oneshot",
          },
        },
        resources: {
          ports: [
            { id: "socks", protocol: "tcp", rangeStart: 1080, rangeEnd: 1180 },
          ],
        },
        documentation: {
          markdown:
            "A private SOCKS5 listener inside the worker network. It is not publicly exposed unless a separate authorized mapping is created.",
        },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      manifest: {
        schemaVersion: 1,
        name: "VS Code Tunnel",
        slug: "vscode-tunnel",
        description: "Microsoft Remote Tunnels client for native VS Code.",
        version: "1",
        lifecycle: {
          start: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/vscode-tunnel/manage.sh start "$AGENTOR_PLUGIN_INSTANCE_ID" 0 "$AGENTOR_PLUGIN_INSTANCE_ID"',
            ],
            mode: "oneshot",
          },
          readiness: {
            kind: "exec",
            command: {
              argv: [
                "bash",
                "-lc",
                'test -r /home/agent/pids/vscode.pid && kill -0 "$(cat /home/agent/pids/vscode.pid)"',
              ],
              timeoutSeconds: 2,
            },
            timeoutSeconds: 30,
          },
          stop: {
            argv: [
              "bash",
              "-lc",
              '/home/agent/apps/vscode-tunnel/manage.sh stop "$AGENTOR_PLUGIN_INSTANCE_ID"',
            ],
            mode: "oneshot",
          },
        },
        documentation: {
          markdown:
            "Starts the worker's VS Code tunnel client. Microsoft device authorization may be required before it becomes ready.",
        },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000104",
      manifest: {
        schemaVersion: 1,
        name: "Persistent VS Code Desktop",
        slug: "vscode-desktop",
        description:
          "Persistent code-server client shown on the worker noVNC desktop.",
        version: "1",
        lifecycle: {
          start: {
            argv: [
              "bash",
              "-lc",
              "/home/agent/apps/vscode-desktop/manage.sh start vscode-desktop 0",
            ],
            mode: "oneshot",
          },
          readiness: {
            kind: "exec",
            command: {
              argv: [
                "bash",
                "-lc",
                'test -r /home/agent/pids/vscode-desktop.pid && kill -0 "$(cat /home/agent/pids/vscode-desktop.pid)"',
              ],
              timeoutSeconds: 2,
            },
            timeoutSeconds: 30,
          },
          stop: {
            argv: [
              "bash",
              "-lc",
              "/home/agent/apps/vscode-desktop/manage.sh stop vscode-desktop",
            ],
            mode: "oneshot",
          },
        },
        resources: { display: { mode: "shared" } },
        documentation: {
          markdown:
            "Opens code-server in a persistent Chromium profile on DISPLAY=:99. View it through the authenticated Agentor Desktop pane.",
        },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000105",
      manifest: {
        schemaVersion: 1,
        name: "SSH Server",
        slug: "ssh",
        description:
          "OpenSSH server using the account's configured public key.",
        version: "1",
        lifecycle: {
          start: {
            argv: [
              "bash",
              "-lc",
              "/home/agent/apps/ssh/manage.sh start ssh 22",
            ],
            mode: "oneshot",
          },
          readiness: { kind: "tcp", portId: "ssh", timeoutSeconds: 15 },
          stop: {
            argv: ["bash", "-lc", "/home/agent/apps/ssh/manage.sh stop ssh"],
            mode: "oneshot",
          },
        },
        resources: { ports: [{ id: "ssh", protocol: "tcp", fixedPort: 22 }] },
        documentation: {
          markdown:
            "Runs the built-in SSH daemon with public-key authentication. External exposure remains a separate controlled Agentor port mapping.",
        },
      },
    },
  ];

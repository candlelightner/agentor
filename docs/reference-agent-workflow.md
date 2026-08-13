# Reference routed-agent workflow

This is a documented reference workflow for building an experiment around
[Codex-LB](https://github.com/Soju06/codex-lb),
[OmniRoute](https://github.com/diegosouzapw/OmniRoute), and the
[Tavily MCP server](https://github.com/tavily-ai/tavily-mcp). It is not an
Agentor feature dependency and it does not imply that Agentor has authenticated
any external account. The project names are deliberately linked to their exact
upstreams: similarly named routing projects exist.

The administrative workspace uses the internal management MCP to create image
definitions, start test workers, inspect build jobs, configure worker-local
values, and interact with a worker console. It uses no Docker socket in the
workspace and the management MCP has no public route. Use the normal dashboard
or the same MCP operations; they act on the same catalog and worker model.

## Boundaries and prerequisites

The approved Agentor worker image already contains Firefox. It also contains
Node 22, Codex, and the Playwright Firefox bundle. A derived image only needs
the extra programs for the experiment.

Do not put third-party credentials in an image definition, Dockerfile fragment,
build-context file, image metadata, or build log. In particular, do not put
OpenAI/ChatGPT account material, Codex-LB dashboard/API keys, OmniRoute endpoint
keys, or `TAVILY_API_KEY` there. Give a worker the required values through its
worker-local secret configuration. Values are write-only after setting them.

For a service worker and its client workers, use an Agentor managed worker
network. Do not attach ordinary workers to the internal management network.
Choose an ordinary managed network, attach only the intended workers, and use
the service worker's network address or an intentionally exposed service URL.

## 1. Build a reusable image

Create an image definition from the Image Catalog UI or the administrative
MCP's image-definition capability. Use an approved base alias configured by the
installation; `agentor-worker:approved-latest` is the built-in alias. The
following JSON is the actual image-catalog definition shape. It is the combined
Stage A image: Codex-LB `1.23.0`, uv `0.12.3`, and OmniRoute `3.8.49` were the
current upstream releases when reverified on 2026-08-13. Codex-LB now requires
Python 3.13, so uv installs that interpreter into the derived image without
changing Agentor's system Python. Review and intentionally update all three
pins before a later rebuild.

```json
{
  "name": "routed-codex-tools",
  "description": "Codex-LB and OmniRoute combined experiment; credentials are injected per worker at runtime.",
  "baseImage": "agentor-worker:approved-latest",
  "dockerfileFragment": "RUN python3 -m pip install --no-cache-dir --break-system-packages uv==0.12.3 && UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install 3.13 && UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python 3.13 codex-lb==1.23.0 && npm install --global omniroute@3.8.49\n",
  "contextFiles": []
}
```

The controlled catalog supplies `FROM` itself. Its policy rejects a supplied
`FROM`, secret-bearing `ENV` or `ARG`, Docker sockets, bind/secret/SSH mounts,
and unsafe context paths. `contextFiles` is an array of objects with `path` and
canonical base64 `contentBase64` when a harmless config or launcher is genuinely
needed. Keep it empty for this example.

Codex-LB is a Python application. Its upstream supported local command is
`uvx codex-lb`; the combined definition installs the same package as a pinned uv
tool so it can run beside OmniRoute in one test worker as required by Stage A.
Before first launch, create `/workspace/.codex-lb` and symlink
`~/.codex-lb` to it; `/workspace` is Agentor-persistent whereas an arbitrary
home directory is not. Run the installed pinned `codex-lb` command—not an
unpinned `uvx codex-lb` resolution. The upstream also
publishes `ghcr.io/soju06/codex-lb:latest`, but this workflow deliberately does
not pull an unpinned external base or bypass Agentor's approved-base boundary.

Build asynchronously, inspect its job status and sanitized logs, then create a
test worker from the immutable built version. Test it before promoting it as a
user or system default. Promotion and rollback change which already-built
version is preferred; they do not make a mutable tag an image identity.

## 2. Start the routing services and complete the human login

From the test worker's terminal/console, start both services in that combined
worker.
For local development the upstream entry points are:

| Project | Install/run | Dashboard | Client API |
| --- | --- | --- | --- |
| Codex-LB | `mkdir -p /workspace/.codex-lb; ln -sfn /workspace/.codex-lb ~/.codex-lb; codex-lb` | `http://127.0.0.1:2455` | `http://127.0.0.1:2455/backend-api/codex` for Codex; `/v1` for generic OpenAI clients |
| OmniRoute | `omniroute` after `npm install --global omniroute@3.8.49` | `http://127.0.0.1:20128` | `http://127.0.0.1:20128/v1` |

Open Firefox through the worker's Desktop/noVNC view and visit the appropriate
loopback dashboard. In Codex-LB select **Add account**. In OmniRoute use
**Providers** to connect a provider, then use **Endpoints** to create an API
key. Those authentication screens are intentionally a human boundary. The
administrative agent may open the URL and report a device code if the upstream
page explicitly provides one, but must not request, print, export, or retrieve
the resulting tokens.

Codex-LB has a first-remote-access bootstrap flow: its initial token is emitted
by its own service log and is used to set a dashboard password. Local loopback
access bypasses that bootstrap. Treat the token and the resulting dashboard
password as secrets; do not put either in Agentor build logs or worker templates.
Codex-LB's upstream documentation also supports optional dashboard TOTP and
separate dashboard-created API keys for remote clients.

After a human has configured OmniRoute, a non-secret connectivity check can use
the service endpoint and an injected runtime key:

```bash
curl --fail-with-body http://127.0.0.1:20128/v1/models \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY"
```

Run that only inside the intended worker; do not paste its output into a place
that could log headers or secrets. For cross-worker use, replace loopback with
the service worker's managed-network hostname/address and confirm the selected
workers can reach it.

## 3. Configure Codex without persisting a key

Codex-LB's current upstream Codex provider syntax is TOML, not YAML:

```toml
model = "gpt-5.6-sol"
model_provider = "codex-lb"

[model_providers.codex-lb]
name = "openai"
base_url = "http://127.0.0.1:2455/backend-api/codex"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true
env_key = "CODEX_LB_API_KEY"
```

The lowercase `name = "openai"` is material: Codex-LB documents it as required
by current Codex. Set `CODEX_LB_API_KEY` only when the Codex-LB API-key policy
requires it, and set it as a worker-local secret.

For OmniRoute, prefer its current launcher instead of an old
`~/.codex/config.yaml` snippet found in some upstream material:

```bash
omniroute launch-codex --remote http://ROUTER_HOST:20128
```

The launcher reads `OMNIROUTE_API_KEY`, injects an OpenAI-compatible Responses
provider for that invocation, and does not need to write the key to Codex
configuration. The alternate `omniroute setup-codex --remote ... --api-key ...`
generates TOML model profiles from the live catalog; use it only when its
configuration-writing behaviour is desired. Put `OMNIROUTE_API_KEY` in the
worker-local secret scope, not in an image, template, or account-global variable
unless that broader sharing is intentional.

## 4. Add Tavily MCP per worker

The official Tavily local server is `tavily-mcp`; its supported local command is
`npx -y tavily-mcp@latest`. Codex reads MCP configuration from
`~/.codex/config.toml`. Use environment forwarding rather than writing a key:

```toml
[mcp_servers.tavily]
command = "npx"
args = ["-y", "tavily-mcp@latest"]
env_vars = ["TAVILY_API_KEY"]
```

Set `TAVILY_API_KEY` as a worker-local secret. The remote Tavily MCP endpoint
also supports a URL key, Bearer authentication, and OAuth, but a local stdio
server with `env_vars` avoids placing a key in a URL or serialized configuration.
If the worker uses a restricted outbound-network environment, allow the Tavily
API/MCP host through that environment's normal domain policy.

## 5. Promote the routed worker template

After the human login and endpoint checks succeed, create a second reusable
approved-base definition for client workers. Its non-secret launcher should run
`omniroute launch-codex --remote "$OMNIROUTE_URL"`; its Codex configuration may
contain the Tavily stdio block above. The template declares only the names
`OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, and `TAVILY_API_KEY`. Set the URL as a
worker-local variable and both keys as worker-local secrets when each worker is
created. Do not put their values in the definition, context, template metadata,
or launcher arguments.

Build and test this definition through the same catalog job used for Stage A,
then promote the tested immutable digest. Verify from the test worker that
`omniroute` and `npx tavily-mcp` are discoverable, Codex sees the Tavily MCP
entry, and the effective configuration reports the two key names as masked.
The live OmniRoute/Tavily connectivity checks remain blocked until the user
supplies those external credentials; promotion does not weaken that boundary.

An exact Stage D definition can keep the image itself credential-free:

```json
{
  "name": "omniroute-tavily-codex-client",
  "description": "Codex client routed through OmniRoute with Tavily MCP; runtime secrets are worker-local.",
  "baseImage": "agentor-worker:approved-latest",
  "dockerfileFragment": "RUN npm install --global omniroute@3.8.49 tavily-mcp@0.2.22 && mkdir -p /opt/agentor-templates\nCOPY --chown=agent:agent codex-tavily.toml /opt/agentor-templates/codex-tavily.toml\n",
  "contextFiles": [
    {
      "path": "codex-tavily.toml",
      "contentBase64": "W21jcF9zZXJ2ZXJzLnRhdmlseV0KY29tbWFuZCA9ICJ0YXZpbHktbWNwIgplbnZfdmFycyA9IFsiVEFWSUxZX0FQSV9LRVkiXQo="
    }
  ]
}
```

The context file contains only the Tavily command and `env_vars` name. Copy
`/opt/agentor-templates/codex-tavily.toml` from the built image
into the worker's persistent `~/.codex/config.toml` during worker setup, then
launch Codex with `omniroute launch-codex --remote "$OMNIROUTE_URL"`. Verify
the pinned Tavily version before rebuilding; `0.2.22` was current on
2026-08-13.

## What is automated and what is not

Agentor can automate the image build, test-worker creation, managed-network
attachment, worker-local secret placement, service start, Firefox/noVNC opening,
and post-login health checks. It cannot and must not automate or impersonate:

- login to OpenAI/ChatGPT accounts used by Codex-LB;
- OmniRoute provider OAuth screens or entering a third-party provider API key;
- creation of a Tavily account/key; or
- disclosure of any resulting API key, OAuth token, dashboard password, or
  service database content.

References: [Codex-LB getting started](https://soju06.github.io/codex-lb/getting-started/),
[Codex-LB authentication](https://soju06.github.io/codex-lb/authentication/),
[Codex-LB client setup](https://soju06.github.io/codex-lb/client-setup/),
[OmniRoute README](https://github.com/diegosouzapw/OmniRoute/blob/main/README.md),
[OmniRoute CLI tools](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/reference/CLI-TOOLS.md),
[Tavily MCP README](https://github.com/tavily-ai/tavily-mcp), and
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp.md).

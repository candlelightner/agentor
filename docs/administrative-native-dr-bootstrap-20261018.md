# One-off administrative DR guest bootstrap (2026-10-18)

This is an operator sequence for the **fresh Ubuntu 24.04 amd64, 16 GiB RAM / 80 GiB root-disk nested-KVM guest**, not an installer or permission to change the production host. No command below has been run as part of preparing this document. Parent owns execution, receipts and disposal. Finish the already-running historical Docker gate and retain its evidence before starting this bootstrap in that same guest. Keep the source VM disk and transfer artifacts. Never attach physical disks, USB, host Incus sockets or production DATA.

Docker Engine must already be installed/running inside this guest, with its default bridge and supported iptables `DOCKER-USER` chain; `install_packages` installs Incus prerequisites, not Docker. The parent's historical Docker gate must have completed before any fixture bootstrap.

Use the current reviewed checkout containing `docs/administrative-native-dr-acceptance.md` and its test. A guest-local Node 22/npm and lockfile-installed `orchestrator`/`tests` dependencies are also required to run that test; build `better-sqlite3` for the guest's glibc/Node ABI, not from the Alpine application binding. Prepare only the project's Nuxt types (`nuxi prepare`); the actual application is the already built, operator-approved image, not a new build here.

## 1. Identities and immutable inputs

Set `DR_REPO` to the trusted checkout, `DR_ASSETS` to the copied export directory, `DR_NONCE` to the parent's fresh VM UUID/kernel nonce, and `DR_APP_IMAGE` to the full immutable Docker ID of the actual 09a-or-newer reviewed application image. Transfer/load that application archive separately and verify its parent's receipt. Do not substitute the worker OCI below for the current application.

Before writes, require root, the exact DMI UUID, exactly one `agentor.native_dr_fixture=$DR_NONCE` kernel argument, nested `/dev/kvm`, an empty Incus installation and the expected guest disk. These are guest checks; no physical-host commands are part of the sequence. Define:

- `DR_ROOT=/var/lib/agentor-native-dr/$DR_NONCE`, `DR_BASE=agdr<first-eight-nonce-characters>`.
- Source DATA/project/primary: `$DR_ROOT/control`, `$DR_BASE`, `${DR_BASE}n`.
- Recovery DATA/project/primary: `$DR_ROOT/recovery`, `${DR_BASE}r`, `${DR_BASE}rn`.
- Shared **guest directory-backed** pool `${DR_BASE}p`; alias `${DR_BASE}-worker` in each project.
- One new fixture installation UUID `DR_INSTALLATION`, persisted in each otherwise independent DATA root as `backup-installation-id`. This deliberately restores the same installation identity; accounts, files and projects are independent. It lets the existing installer enforce one pool ownership label. Do not copy any source auth, runtime record or credential into the initially empty recovery DATA. A separate destination VM uses the source artifact's installation UUID instead of minting a different value.

Create `/run/agentor-native-dr`, `$DR_ROOT`, its `control`, `control/users`, `recovery`, `recovery/users`, `tls`, `work` directories as root `0700`; files/receipts/env files are `0600`. Create both `users` directories before starting policy/apps: the private policy enumerates that directory even before the first account exists. Refuse existing conflicting paths/receipts. The exported immutable inputs are:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `approved-native` | 420 | `c60342361d6031dfcc5799e12042e37fa68056100dbd21c01b7e7af0452edcf7` |
| `approved-native.root` | 2882994176 | `dad8e19dbaaecea83ed6637f1537f04779ee1678c025e661515f3bf8edd69c53` |
| `approved-worker-58fd7.tar` | 2512668160 | `a36e14ecc081c846e456edfffff7107b53791df54f54e33a0b7a8fad5631c4e2` |

Expected worker OCI: `sha256:58fd7a3811dca2ee58fd066024df0857c541ac14fa0b1f9dccab665153ba7b3c`; native fingerprint: `6e9bd852e1a6490c091ea56027baa44bd33140a5cba04a5cac9dcbac43535296`; recipe: `71695a417d32a7a400ef8d2b8b2649b7df6f21c816c140446696d667e91d29de`. Check sizes and hashes before import. `docker load --input "$DR_ASSETS/approved-worker-58fd7.tar"`, then inspect the exact OCI ID/amd64. Preserve exports; no conversion or d2vm invocation is needed.

## 2. Reuse the installer leaves, not its conversion main

`setup-incus-host.sh` embeds Python and calls `main()` only when executed as `__main__`. In one root Python operator session, load its definitions without invoking main; this is the same source code, not a copied installer:

```python
import os, sys
from pathlib import Path
repo = Path(os.environ['DR_REPO']).resolve()
root = Path(os.environ['DR_ROOT'])
script = repo / 'scripts/setup-incus-host.sh'
body = script.read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
saved = sys.argv
try:
    sys.argv = ['fixture-setup', str(script)]
    setup = {'__name__': 'fixture_setup'}
    exec(compile(body, str(script), 'exec'), setup)
finally:
    sys.argv = saved
setup['install_packages'](True, root / 'work')
setup['bridge_netfilter'](os.environ['DR_INSTALLATION'])
```

`install_packages(True, ...)` verifies the pinned Zabbly primary signing fingerprint `4EFC590696CB15B87C73A3AD82CC8797C838DCFD`, installs its signed Noble LTS source if needed, and requires Incus **6.0.6+ LTS or 6.10+**. Keep that validation. `bridge_netfilter` enables the guest's matching `br_netfilter` module/settings; a missing guest module is a prerequisite failure, not reason to disable filtering. See the [publisher's package instructions](https://github.com/zabbly/incus/blob/daily/README.md).

Create the two absent primary bridges through `setup['incus']`: names above, `--type=bridge`, `ipv4.address=10.231.0.1/24` (source) / `10.232.0.1/24` (recovery), `ipv4.nat=true`, `ipv6.address=none`, `user.agentor.installation=$DR_INSTALLATION`. Check these subnets are unused in this fresh guest first. Then, for each side, call:

```python
base, installation = os.environ['DR_BASE'], os.environ['DR_INSTALLATION']
for suffix, data in [('', root / 'control'), ('r', root / 'recovery')]:
    config = dict(installation=installation, project=base+suffix,
                  network=base+suffix+'n', pool=base+'p', internalPort=38000,
                  usbEnabled=False, gpuMdevProfile='')
    setup['resource_setup'](config, setup['initial_share_paths'](str(data), installation))
```

This retains the installer's restricted managed-NIC policy, private custom volumes, `features.images=true`, `features.networks=false`, blocked low-level VM settings and blocked GPU/USB/PCI/block/character/proxy devices. Only its private empty-share path is initially exported; no physical host path is involved. No profile devices are used by the admin runtime. Do not call `main`, `certificates`, `install_units` or `bootstrap_default_image`: their single-project production topology/conversion assumptions differ from this explicitly prepared fixture.

## 3. Acknowledge imported images without manufacturing provenance

Before importing, require `setup['default_recipe'](the_exact_worker_OCI)` to equal the pinned recipe above. This hashes the current trusted canonical bootstrap; disagreement means stop and reconcile the source/image pair. Do not rewrite image properties to make it pass.

For each empty project, import exactly the verified pair:

```bash
incus --force-local --project "$DR_PROJECT" image import "$DR_ASSETS/approved-native" "$DR_ASSETS/approved-native.root"
```

Require successful command completion and query the exact expected fingerprint in that project. Verify `type=virtual-machine`, amd64/x86_64 and properties `source_image_id=<worker OCI>`, `recipe_id=<recipe>`, `source_architecture=amd64`, `bootstrap_generation=3`, `converter_version=v0.4.0`. Only then create the absent alias with `incus --force-local --project "$DR_PROJECT" image alias create "${DR_BASE}-worker" <fingerprint>`, and query it back to confirm the same VM fingerprint. Save project/fingerprint/properties/alias acknowledgements privately. If an import/alias command is ambiguous, inspect that exact fingerprint/alias before any retry; never replace an unexpected alias. No catalog job, converter receipt or `defaultImage.phase=ready` record needs to be invented: this explicit exported-image import is proved directly by the runtime's existing immutable alias/source/recipe validation.

## 4. TLS and the two narrow listeners

Create the source/recovery routed Docker control networks, named `agentor-dr-source-control` and `agentor-dr-recovery-control`. Determine `DR_GATEWAY` from the guest Docker daemon's **actual `host-gateway` resolution**, normally the default `bridge` gateway (172.17.0.1), not either new custom network's gateway. Verify it using a disposable command-only container with `--add-host=host.docker.internal:host-gateway`; all later app/helper resolution must match. No daemon-wide host-gateway override is needed.

Generate fresh client and server keypairs with the installer's OpenSSL pattern. Keep the **server key outside the app-mounted TLS directory**. Before any instance exists in this disposable guest:

```bash
umask 077
openssl req -x509 -newkey ed25519 -nodes -days 7 -subj /CN=Agentor-private-dr-client \
  -keyout "$DR_ROOT/tls/client.key" -out "$DR_ROOT/tls/client.crt"
openssl req -x509 -newkey ed25519 -nodes -days 7 -subj /CN=host.docker.internal \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1,IP:$DR_GATEWAY" \
  -keyout /run/agentor-native-dr/server.key -out "$DR_ROOT/tls/server.crt"
chmod 0600 "$DR_ROOT/tls/client.key" "$DR_ROOT/tls/client.crt" "$DR_ROOT/tls/server.crt" /run/agentor-native-dr/server.key
systemctl stop incus.service incus.socket
install -o root -g root -m 0600 "$DR_ROOT/tls/server.crt" /var/lib/incus/server.crt
install -o root -g root -m 0600 /run/agentor-native-dr/server.key /var/lib/incus/server.key
systemctl start incus.service
incus --force-local config set core.https_address "$DR_GATEWAY:18443"
```

Do not replace certificates on any populated/production daemon. Verify the daemon's returned certificate fingerprint matches the new certificate before continuing.

Bind Incus `core.https_address` to `<DR_GATEWAY>:18443`. Add the client certificate using `incus --force-local config trust add-certificate "$DR_ROOT/tls/client.crt" --name=agentor-private-dr --restricted --projects="$DR_BASE,${DR_BASE}r"`; read back exactly those two projects, client type and fingerprint. It receives no default-project or unrestricted authority. See [Incus TLS authentication](https://linuxcontainers.org/incus/docs/main/authentication/) and [project-scoped authorization](https://linuxcontainers.org/incus/docs/main/authorization/).

Use systemd's installed `systemd-socket-proxyd` for the loopback side; it forwards encrypted TCP, never terminates TLS. One `.socket`/`.service` pair for each port:

```ini
# agentor-dr-api-loopback.socket (use policy/18445 for the other pair)
[Socket]
ListenStream=127.0.0.1:18443
[Install]
WantedBy=sockets.target
```

```ini
# agentor-dr-api-loopback.service
[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd <DR_GATEWAY>:18443
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
```

Verify the installed `systemd-socket-proxyd` path first (Ubuntu may expose it under `/usr/lib/systemd`, the same merged-usr location). No wildcard, NAT TLS bypass or new proxy package is required. Loopback 18443 and Docker `host.docker.internal:18443` now reach the same pinned Incus certificate; loopback 18445 forwards to the policy below using that same fresh fixture server certificate.

## 5. Start the existing private policy before the source app

Use `scripts/agentor-incus-network-service.py` and its sibling modules from the trusted checkout. This service owns existing bridge/firewall/private-peer operations; do not create per-admin networks or widen NIC allowlists by hand. A root systemd service uses the existing unit hardening:

```ini
[Unit]
After=network-online.target incus.service docker.service
[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 <DR_REPO>/scripts/agentor-incus-network-service.py --data-dir <DR_ROOT>/control --installation <DR_INSTALLATION> --project <DR_BASE> --primary <DR_BASE>n --bind <DR_GATEWAY> --port 18445 --server-cert <DR_ROOT>/tls/server.crt --server-key /run/agentor-native-dr/server.key --client-cert <DR_ROOT>/tls/client.crt --admin-pool <DR_BASE>p --orchestrator-container agentor-dr-source
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
```

The default sockets are the **guest** `/var/lib/incus/unix.socket` and `/var/run/docker.sock`. No `--host-mounts` capability is needed for these admin roots. Enable the source policy and both loopback proxy sockets. Before the app starts, verify mTLS `/1.0?project=<DR_BASE>` on loopback 18443 and `/v1/managed-networks/readiness?project=<DR_BASE>` on loopback 18445; the latter must return the exact installation/project/primary, not merely HTTP health. The pinned container name may be absent until the next step; admission checks its live identity/DATA mount before mutation. Source startup automatically ensures the global admin, so starting the app before the policy/image/TLS prerequisites would cause an avoidable failed startup.

Only this source policy is active in same-guest `roundtrip`; recovery remains in recovery mode and performs no admin lifecycle/private-network setup. For lifecycle in the **separate destination VM**, bind the service to restored `$DR_ROOT/recovery`, project `${DR_BASE}r`, primary `${DR_BASE}rn`, restored installation UUID, and `--orchestrator-container agentor-dr-recovery` before leaving recovery mode. Do not run two policy controllers on the same 18445 endpoint or share source-owned admin networks.

## 6. Containers, accounts and source data

Create root-private env files using the exact fields in `administrative-native-dr-acceptance.md`; additionally set `WORKER_IMAGE_PREFIX=` and `INCUS_DOCKER_VOLUME_SIZE=1GiB`, and a fresh disposable `BETTER_AUTH_SECRET`. Set current `ORCHESTRATOR_IMAGE=$DR_APP_IMAGE`. Both apps point to the approved 58fd worker OCI, current fixture alias, pinned TLS and guest host-gateway services. The source has recovery mode `false`; destination has `true`. No GPU/USB setting is enabled.

Start each app without privilege, devices, host PID or host networking. The exact container arguments are:

```bash
docker run -d --name agentor-dr-source --network agentor-dr-source-control \
  --label "agentor.native-dr-fixture=$DR_NONCE" \
  --add-host host.docker.internal:host-gateway -p 127.0.0.1:38000:3000 \
  --mount "type=bind,src=$DR_ROOT/control,dst=/data" \
  --mount "type=bind,src=$DR_ROOT/tls,dst=/native-tls,readonly" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --env-file "$DR_ROOT/source.env" "$DR_APP_IMAGE"
```

Use recovery name/network/env file, `recovery` DATA and loopback **38001** for the other app. No 3099 publication or extra primary-bridge 38000 publication is needed. HTTP must listen on container interfaces at 3000; the policy attaches the exact orchestrator to each admin bridge and MCP binds directly to that private peer. Keep all passwords/session cookies in private files; never echo them or put them in command arguments.

Through each loopback API, create its initial disposable account with `POST /api/setup/create-admin` `{email,password,name}`, then separately sign in with `POST /api/auth/sign-in/email`. Keep distinct account IDs. On source, obtain global status from `/api/admin/workspace`; create one group with `POST /api/worker-groups` `{name:"Native DR group"}`, then `POST /api/worker-groups/<id>/admin-workspace` `{}`. Wait for each exact native VM's service/UUID readiness sequentially, not concurrent 4 GiB boots. Use only current record-derived VM names/UUIDs in subsequent guest commands.

Seed all four role-specific `native-dr-fixture` trees per admin exactly as the acceptance runbook specifies. While each source admin is running, PUT `/api/backup-settings` with `enabled:false`, `selection:"selected"`, both administrative `workspaceIds`, `persistSelectedDirectories:true` and `selectedPathsByWorkspace` containing `/srv/native-dr-attached` and `/srv/native-dr-detached` for both IDs. Then use each supported `/rebuild` endpoint and wait for both native selections to be seeded/ready with no pending operation. Metadata and sample files must survive this actual seeding.

**Detached history is manual fixture preparation, not an admin-detach API claim.** Stop both exact admins through their supported `/stop` routes, then stop only the source orchestrator to prevent metadata races. Save its dedicated records, managed records and exact stopped Incus device maps privately. For each admin, require the `/srv/native-dr-detached` selection's exact canonical `agentor-persist-<id>` device and source labels. Remove only that stopped VM's matching `m<first-six-UUID-hex>` device, then set that managed record to `attached:false,state:"detached"` and remove only its ID from `nativeRuntime.selectedVolumeIds`. Preserve its seeded data, ownership, UUID, completed operation and every other field; require `used_by=[]` afterward. Never delete or recopy its volume. On any discrepancy retain the fixture evidence and stop. Keep `/srv/native-dr-attached` mounted/ready. Restart the same source orchestrator (same container ID), whose dedicated records remain stopped.

During that stopped, fixture-only metadata edit, create the two archived ordinary shadows in `control/users/<source-owner>/workers.json`, with fields `{id,userId:<source-owner>,displayName:"Historical duplicate",status:"archived",importedImage:<approved worker OCI>,createdAt:<ISO>,updatedAt:<ISO>}`. IDs are the two dedicated admin IDs. They own no ordinary compute/volumes. Existing product regression fixtures use this exact shape. Do not create ordinary workers through unarchive APIs to manufacture these historical rows.

Finally record actual container IDs, account/group/admin IDs, image pins and disposable passwords in the root-private administrative receipt, and write the existing base receipt with this guest's current boot ID, machine ID and nonce. Keep exactly the schema in the acceptance helper (empty converter/host-policy fields there are deliberate; the live lifecycle helper explicitly selects loopback 18445). Run the gate using the modules config and explicit phase only after these checks. For a fresh destination VM, prepare the same two empty project names/pool/alias for its **new nonce**, copy only the three private transfer artifacts, and use `restore`; do not recreate source admin VMs or contact their API there. Configure destination private policy and clear recovery mode only for the later explicit `lifecycle` phase.

This plan proves no live connectivity, filesystem fidelity or package availability by itself. Signed-package installation, exact image acknowledgements, private policy readiness, source seeding, metadata samples, encrypted roundtrip and lifecycle remain execution results to record in the disposable VM. Do not label either skipped phase as passed.

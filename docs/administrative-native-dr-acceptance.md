# Private native administrative encrypted recovery gate

This is source for a real acceptance test, not a completed live result or a VM launcher. The test uses the production HTTP instance-backup producer, encrypted download, recovery-key import, upload verification, restore preflight and packaged controlled helper. It never replaces native capture/extraction with mocks. Parent/operator prepares disposable installations and decides when to run it. Never run it on the Agentor production host.

`tests/api/admin-native-encrypted-dr-live.spec.ts` is disabled unless `INCUS_ADMIN_INSTANCE_DR_TEST=true`. The existing root-private native fixture receipt must match the guest's current boot ID, machine ID and `agentor.native_dr_fixture=<nonce>` kernel argument. Default Playwright global setup rejects the flag before authentication/network setup; use the modules config. An enabled but missing/invalid receipt or phase fails. No historical SSH, host endpoint or credential fallback exists.

The one-off approved-asset bootstrap sequence is in [administrative-native-dr-bootstrap-20261018.md](administrative-native-dr-bootstrap-20261018.md); it reuses existing installer leaves and policy services without converting the base again.

## Manual fixture contract

Use the exact `/run/agentor-native-dr/fixture.json` schema in `tests/helpers/private-native-dr-fixture.ts`. This already pins the local HTTPS Incus endpoint, private project, pool, image alias, TLS files and `/var/lib/agentor-native-dr/<nonce>` root. All receipt/TLS files are root-owned `0600`, containing directories `0700`, with no symlinks. Create the additional `recovery` directory under that root even for capture. The suite does not provision daemons, bridges, images, accounts or source data.

For a same-guest data-only round trip, prepare two restricted projects on the guest-local daemon: `agdr<nonce-first-8>` and `agdr<nonce-first-8>r`, both with private storage and `features.networks=false`; use the pinned pool and image alias in both. The second ordinary network is `agdr<nonce-first-8>rn`. The source owns only the two stopped native administrative VMs and their eight filesystem volumes; recovery has no instances or custom volumes. Import the current approved immutable system OCI and native image with their real provenance. No image conversion, daemon setup or hardware access is hidden in this test.

Prepare two current packaged orchestrator containers on dedicated Docker control networks, binding port 3000 only to guest loopback 38000 (source) / 38001 (recovery). Use label `agentor.native-dr-fixture=<nonce>`, no privileged/device/host-network/host-PID mode, and `host.docker.internal:host-gateway`. Bind each exact private DATA directory to `/data`, the fixture `tls` directory read-only to `/native-tls`, and the **fresh guest's** Docker socket to `/var/run/docker.sock`. These socket/bind requirements apply only inside the proven disposable system VM. Set explicitly:

- `DATA_DIR=/data`, `BETTER_AUTH_URL=http://127.0.0.1:38000` / `38001`, `DOCKER_NETWORK=<that container's actual control network>`.
- `INCUS_ENABLED=true`, `INCUS_ENDPOINT=https://host.docker.internal:18443`, exact project/network/pool/image alias above.
- `INCUS_INTERNAL_GATEWAY_URL=http://10.231.0.1:38000` in both containers, matching the pinned fixture configuration. This ordinary-worker gateway is unused by this administrative-only gate; there are no ordinary native workers in either fixture project.
- `INCUS_NETWORK_HOST_ENDPOINT=https://host.docker.internal:18445`, `INCUS_NETWORK_HOST_SERVER_CERT_PATH=/native-tls/server.crt`. Recovery may configure the exact endpoint before its service is started; the stopped-data phase does not contact it.
- `INCUS_CLIENT_CERT_PATH=/native-tls/client.crt`, `INCUS_CLIENT_KEY_PATH=/native-tls/client.key`, `INCUS_SERVER_CERT_PATH=/native-tls/server.crt`. Server certificate must cover both loopback and `host.docker.internal`.
- `WORKER_IMAGE=sha256:<current approved system OCI>`, `CONTAINER_PREFIX=agentor-worker`.
- `AGENTOR_INSTANCE_RECOVERY_MODE=false` for source; `true` for recovery. Keep recovery mode through restored-data verification.

The loopback bindings above publish the browser/API entrypoints on the **system VM**; the packaged HTTP server must still listen on container interfaces at TCP 3000, not only container loopback. Native administrative control uses a different, direct path: `incus-admin-network-policy.py` attaches the exact orchestrator container to each owned admin bridge at its server-derived `.2` address. `incus-admin-workspace-runtime.ts` gives that guest `ORCHESTRATOR_URL=http://<private-peer>:3000` and `AGENTOR_MANAGEMENT_MCP_URL=http://<private-peer>:3099/mcp`; `ManagementMcpTransport` binds 3099 only on that peer. Preserve the normal host-policy bridge/firewall setup. Do not publish MCP 3099 or add a second `10.231.0.1:38000:3000` binding for this gate: the fixture deliberately requires one loopback publication per container, and neither admin control nor MCP uses the primary gateway. Same-daemon capture/restore therefore has no duplicate internal bind; the fresh destination VM's lifecycle likewise keeps UI publication at 38001 and uses its own private peers. Running ordinary native-worker gates would require their separate primary-gateway publication contract, outside this admin-only fixture.

Create disposable platform-admin password accounts. Source must have exactly one native global admin and one native group admin owned by the source account. Set up their actual private network service and use supported creation/start/selected-path operations; then stop both. Each needs two seeded native persistent paths: `/srv/native-dr-attached` stays attached and ready, `/srv/native-dr-detached` is detached with its data retained. Native global managed ownership is `__agentor_admin__`; group ownership is the source account. Preserve two minimal archived ordinary shadow records with the exact administrative IDs in `users/<source-owner>/workers.json`; they must have no physical ordinary worker storage. Keep fixture providers/plugins/other workers empty so the artifact contains exactly these eight volumes.

In each canonical workspace, agent-data root and selected volume, seed a `native-dr-fixture` subdirectory. For each admin ID and role (`workspace`, `agents`, `attached`, `detached`), write `data.bin` as UTF-8 `agentor-native-dr/<admin-id>/<role>\n` followed by bytes `00 ff 80 0a 3d 00`. Create `hard` as a hardlink and `link` with literal target `data.bin`. Give the file uid/gid `12345:23456`, mode `0640`, mtime `1234567890` seconds and binary xattr `user.native-dr=00ff800a3d00`; give the directory uid/gid `12343:23454`, mode `0751`, mtime `1234567891` seconds **after creating children**. Seed before detaching the historical selection. Use only exact fixture VM UUIDs and paths, inside the disposable guest. The test checks those values and distinct role hashes, not merely whether some file exists.

Write `/run/agentor-native-dr/administrative.json` (root `0600`) with this exact schema; replace placeholders, never use real account credentials:

```json
{
  "version": 1,
  "nonce": "<current disposable VM nonce>",
  "globalId": "<global admin UUID>",
  "groupId": "<group UUID>",
  "groupAdminId": "<group admin UUID>",
  "workerImage": "sha256:<64 lowercase hex>",
  "nativeFingerprint": "<64 lowercase hex>",
  "source": {"containerId":"<64 lowercase hex>","ownerId":"<source account ID>","email":"source@example.test","password":"<disposable password>"},
  "recovery": {"containerId":"<64 lowercase hex>","ownerId":"<different recovery account ID>","email":"recovery@example.test","password":"<disposable password>"}
}
```

The test checks exact container IDs/labels/DATA/TLS mounts/project/port/config before login, and imports the standalone native adapter from the actual packaged container. `instance-restore-helper.mjs`, `instance-restore-native/index.mjs` and sibling `incus-bootstrap` must be present. The actual HTTP restore launches that packaged helper; this is not an in-process mock.

## Explicit phases

Inside the verified guest, from the checked-out `tests` directory with dependencies installed:

```bash
INCUS_ADMIN_INSTANCE_DR_TEST=true INCUS_ADMIN_INSTANCE_DR_PHASE=roundtrip   npx playwright test --config=playwright.modules.config.ts api/admin-native-encrypted-dr-live.spec.ts
```

`roundtrip` performs capture and restore only. `capture` alone leaves three root-private transfer files under the fixture root: `admin-instance.backup`, `admin-dr-recovery-kit.json`, and `admin-dr-source.json`. The latter records encrypted artifact SHA256, exact source records/shadow bytes and the eight expected sample metadata digests. HTTP operations have a finite 45-minute bound, allowing the native 30-minute create window plus setup; the complete phase has a three-hour bound. Existing output files are not overwritten. Source compute/data remain stopped and preserved. The test's temporary readonly Incus helpers use existing ownership/operation receipts and exact cleanup; unknown cleanup fails and retains its existing evidence.

`restore` alone consumes those three files and the destination fixture receipt; it never contacts the old source API. It verifies the encrypted SHA256, imports the recovery kit through the normal API, uploads/verifies the artifact, and invokes the controlled helper in an empty recovery installation. It checks fresh stopped native authority, fresh storage nonces and selected IDs, unchanged ordinary shadow bytes, exact canonical/agents/attached/detached bytes and metadata through readonly helpers, and no admin compute/incarnations. It writes `admin-dr-restored.json` only after success. It does not leave recovery mode or create administrative credentials/NICs.

For full lifecycle acceptance, parent/operator may stop and retain the source fixture system-VM disk, then boot a **separate fresh destination system VM** sequentially. Copy the three private transfer files into its new fixture root; mint new boot-bound receipts, retain the source IDs and disposable source login in `administrative.json`, and fill its actual recovery container/account IDs. The old source container ID remains descriptive and is never contacted by `restore` or `lifecycle`. Run `restore` there first. Use one 8 GiB outer VM at a time with no other heavy job active; before boot, require host `MemAvailable` to cover its 8 GiB plus another 8 GiB. Keep both source admins stopped during capture, with 1 GiB archive helpers; preparation and lifecycle run one 4 GiB admin at a time, stopping it before starting the other.

After reviewing stopped destination data, parent/operator configures the destination private admin network host service at guest-local `https://127.0.0.1:18445` (container endpoint `https://host.docker.internal:18445`, trusted server certificate as above), bound to the restored installation identity and exact recovery DATA/orchestrator. Remove recovery mode and update the private receipt to the replacement recovery container ID if it changed. Then run with `INCUS_ADMIN_INSTANCE_DR_PHASE=lifecycle`. This phase performs supported Start → Stop → Start → Rebuild → Stop sequentially for each admin, checks UUID retention across Stop/Start and replacement on Rebuild, distinct private network bindings, one filtered NIC, fresh management-credential hashes, detached volumes staying unmounted, and all eight preserved samples afterward. It writes `admin-dr-lifecycle.json` only after success.

Do not run lifecycle against the same daemon with the source VMs retained. Admin bridge names are derived from preserved installation/owner/workspace IDs in the default network namespace, so two projects cannot provide independent copies of those bridges. The test does not detach source networks or relax ownership checks to work around this.

## Evidence limits

Pure tests cover private receipt/config rejection, explicit phase validation, the actual readonly sample script on an owned temporary tree, and default global-setup denial before HTTP, and actual modules-config diagnostic retention in an owned temporary child process. They do not prove the live flow. A skipped gate is not acceptance. Capture/restore success alone excludes native lifecycle networking; lifecycle success still does not claim browser UI, plugin execution, stale stream/token revocation or historical Docker format-1 live acceptance. Those remain the additional gates in `administrative-native-restore.md` and the complete existing workspace/instance suites. Neither phase deletes source data, backup artifacts or the destination on failure; parent/operator retains and disposes of the whole private fixture after reviewing its evidence.

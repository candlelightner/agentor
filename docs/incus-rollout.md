# Incus worker rollout

This is an opt-in upgrade for a single Ubuntu 24.04 amd64 host. The implementation
handoff is complete. The final full browser/routing/IP-change gate passed on
2026-10-17 (8.3 minutes), resolving
[issue #5](https://github.com/candlelightner/agentor/issues/5). Accepted evidence
and remaining deferred stability items are recorded in `incus-vm-status.md`.
The deployed production canary below still precedes any production worker migration.
The Admin Workspace stays on Docker. Existing ordinary workers remain on Docker
until a platform administrator explicitly migrates them.

## Prepare and deploy

1. Create a current whole-instance encrypted backup and keep its recovery key
   separately. Keep the old stack configuration and image references.
2. Use an Orchestrator image built from the accepted feature revision, not an
   older `latest` image. If building locally, run from the repository root:

   ```sh
   docker build -f orchestrator/Dockerfile -t agentor-orchestrator:incus .
   ```

   The configured default worker OCI image must also be available locally and
   operator-trusted. Custom/catalog images use isolated conversion; never feed
   an untrusted worker image into a host-mounted converter.
3. On the actual host, run the operator installer against the existing
   Orchestrator and Docker network:

   ```sh
   sudo scripts/setup-incus-host.sh --install-lts \
     --orchestrator-container agentor-orchestrator --docker-network agentor-net
   ```

   Review its output. It discovers DATA and creates only installation-owned
   resources. Existing foreign or ambiguous resources require manual resolution;
   do not delete or adopt them to make setup pass. An optional slow-disk scratch
   location is for regenerable conversion material, not canonical worker data.
4. Apply `docker-compose.incus.yml` as an override to the existing stack, or copy
   its additions into the Portainer stack. Preserve existing DATA mounts, network,
   GUI publication, authentication settings and Docker socket.
   Set `AGENTOR_INCUS_ORCHESTRATOR_IMAGE` to the accepted image tag/digest.
   Populate the `INCUS_*` values from setup, including:

   - The restricted project, network, pools, verified default-image alias and seed.
   - `INCUS_WORKER_GATEWAY` and `INCUS_INTERNAL_PORT` matching the internal URL.
   - `INCUS_TLS_NAME` and `INCUS_API_HOST_ADDRESS` matching setup's `extra_hosts`.
   - The four `*_SOURCE` variables pointing to individual operator certificate/key
     files. Mount them read-only; never mount the whole credential directory.

   For local worker images, explicitly set `WORKER_IMAGE_PREFIX` to an empty
   string and use the corresponding `WORKER_IMAGE`. Otherwise retain the existing
   registry prefix. The installer and deployed stack must agree on this source.

   With Compose, validate before applying:

   ```sh
   docker compose -f docker-compose.prod.yml -f docker-compose.incus.yml config --quiet
   docker compose -f docker-compose.prod.yml -f docker-compose.incus.yml up -d
   ```

5. Run `sudo scripts/check-incus-host.sh` with the host-side certificate paths
   and topology values printed by setup. Run it after redeploy: the checker must
   observe the actual bridge-only internal port publication and routing rules.
   Correct every failure/unknown result before creating ordinary Incus workers.
6. Run the deployed automated canary before any production worker migration.
   Prepare a private `0600` JSON file containing the Cookie header of your current
   signed-in platform-admin session and optionally `"dockerEnabled": true`:

   ```json
   {"sessionCookie":"<current admin Cookie header>","dockerEnabled":true}
   ```

   Run it through the existing Orchestrator (never put the cookie in arguments,
   environment variables or logs):

   ```sh
   sudo bash scripts/run-incus-canary.sh --input-file /absolute/private/canary.json
   ```

   The canary creates two temporary ordinary workers, verifies services/proxies,
   authoritative worker-self identity, NIC spoofing negatives, execution of both
   native binaries and shebang scripts from workspace and agent-data volumes
   (including after restart), persistence and optional native Docker, then
   removes only its acknowledged resources. Require
   `"status":"passed"`. A failure retains captured IDs for explicit inspection;
   do not clear markers, adopt by name or repeat an unknown creation blindly.
   Remove the private session file when finished. An API response or unit tests
   alone are not acceptance; legacy migrations remain explicit.

Incus access is verified HTTPS with restricted-project mTLS. Do not mount
`/var/lib/incus`, its Unix socket, or Incus credentials into any worker. Inner
Docker privileges remain inside the VM; host access requires an explicit grant
or exploitation of the Incus/QEMU/KVM/host boundary.

With bridge netfilter enabled, Docker's `FORWARD DROP` policy also applies to
VM traffic within the primary bridge. Setup includes an owned forwarding rule
limited to that bridge in both directions and its source/destination subnet.
Incus NIC source filtering remains enabled; the deployed canary checks valid
peer traffic and rejected spoofed traffic before migration.

## Explicit migration

For failed control-plane connectivity or ambiguous interrupted operations, see
[bounded operator recovery](incus-recovery.md). Local HTTP health alone is not
evidence that the Orchestrator has a usable Docker network endpoint.

Use the shared platform-admin REST or Management MCP controls:

- `GET /api/admin/workers/{id}/incus-migration` reports status.
- `POST /api/admin/workers/{id}/incus-migration` starts offline migration.
- `POST /api/admin/workers/{id}/incus-migration/finalize` removes the retained
  legacy source only after successful validation and deliberate administrator
  approval. MCP equivalents are `migration.status`, `migration.start` and
  `migration.finalize`.

These routes require the existing authenticated admin session and applicable
protection unlocks. Request bodies do not choose a runtime, device, host path,
Incus endpoint or project. Do not submit concurrent operations on a migrating
worker. Before cutover, ordinary failures restart the untouched legacy source.
An ambiguous interruption fails closed and retains both sides for explicit
administrator recovery; never clear its marker or replay an unknown operation
based only on a missing instance or expired Incus operation record.

Explicit migration translates eligible historical `legacy-backup-path` records
into fresh native `persistent-path` copies named `agentor-persist-<volume UUID>`.
The historical Docker name must exactly match the worker/path-derived name.
Source records, Docker volume names and completed operation history remain
unchanged for capture, source revalidation and rollback; retained-source receipts
continue to name the original Docker volumes. Attached and detached copies retain
their identity and target. No ordinary Incus lifecycle operation accepts a legacy
name, and finalization never uses the new native name as Docker deletion authority.

Native protected-target checks run before source inspection, stop or capture.
The one historical exception is the entire `/home/agent/.local/share` managed
volume, with `kilo` required to be the exact inert symlink
`/home/agent/.agent-data/.kilo/shared-data`. This preserves all FreeCAD, Claude,
code-server and other parent entries, root metadata and cross-directory hardlinks
without copying shared account data. Ordinary new persistence requests still
reject the parent and every other protected target.

Before operational migration, prove the source's exact owner/container/mount,
ordinary local volume name/options/incarnation, and no-follow `kilo` leaf/readlink.
The stopped-source capture revalidates the complete unchanged GNU/PAX archive
before allocating native storage. A missing link, real Kilo directory, different
link or archive write below the link fails; other external managed-volume links
remain rejected. Capture failure uses the existing exact-source rollback and
never drops an entry to make migration pass.

Native retained-volume recreation rechecks the leaf with the existing
acknowledged networkless read-only helper before normal attachment. Isolated
restore checks it before operational promotion, and startup checks it before
provisioning or the worker entrypoint can replace a non-symlink Kilo path.
Portable export/import uses the same unchanged parent archive and exact-link
contract; reconstruction checks every existing destination conflict except the
one protected canonical Kilo leaf. Docker starts/rebuilds use an acknowledged,
never-started read-only/no-copy probe and a bounded single-leaf TAR to check the
literal link (Docker HEAD metadata resolves aliases). Parent reattachment uses
recreation; a new live hotplug remains refused. Helper ambiguity retains the
existing recovery authority and data.

Focused module tests and a real isolated GNU/PAX metadata round trip cover this
contract. A real native migration, rebuild and portable restore remain operator
acceptance steps; these changes do not claim live acceptance.

Canonical restore allows up to 120 seconds for the isolated VM to shut down
gracefully and flush its restored filesystems before operational devices are
attached. A failed shutdown does not authorize promotion or a forced power-off.
Ordinary worker stop operations retain their 30-second timeout.

Existing Docker backup containers may have a read-only root bind. The host
policy recognizes only an explicit `RW: false` bind of `/` as a read-only
observer, never as authority to export the host root to workers. Writable or
ambiguous root binds and overlapping writable exports still reject grants.

The VM root is disposable. Backups, rebuilds and migrations preserve canonical
workspace, agent/editor state, managed data and applicable native Docker state,
not arbitrary root-disk mutations. Historical backups missing runtime metadata
restore as legacy Docker; migration is a separate explicit operation.

The VM image uses Ubuntu 24.04's supported HWE virtual kernel. The GA 6.8
kernel can return `EFAULT` when executing files on the `cache=never` VirtioFS
shares used for workspace and agent data. Reading files or executing an image
root binary does not detect this problem. Rebuild the derived VM image and
redeploy the matching Orchestrator bootstrap, default-image alias and converter
seed together; preserve the previous image/configuration for rollback. Changing
the worker VM kernel does not require changing the host kernel.

Explicit Rebuild selects the current VM bootstrap recipe while requiring the
same immutable worker OCI base, architecture and bootstrap/converter contract.
The control plane captures the previous storage identity and selected native
image before removing compute, and rechecks both before allocation and metadata
publication. Archive/unarchive, storage-only recreation and recovery retain the
captured recipe. This lets a deliberate Rebuild apply a kernel/bootstrap fix
without silently changing the worker software or canonical volumes.

Migration capture retains GNU `--format=pax` bytes unchanged, including regular
files at or above the 8 GiB USTAR size boundary. Bounded per-file decimal PAX
`size` overrides are interpreted for body offsets, 512-byte padding, truncation,
and expanded-byte accounting, rather than merely accepted as inert metadata.
Overrides remain subject to the existing 100 GiB ceiling and tighter caller
budgets; malformed/duplicate sizes and size metadata on non-files are rejected.
GNU sparse/global extensions, path/type/link rules and identity fields retain
their existing restrictions. Validation uses positional reads, so a sparse raw
TAR fixture can prove the 8 GiB boundary without an 8 GiB physical write.


Accepted instance creation waits at most 30 minutes for image unpacking, using
the existing 500 ms operation polls and 30-second HTTP transport bound. The
accepted create is never resubmitted. Other operation bounds stay unchanged.
If the create result remains unknown, its existing recreation nonce retains the
worker recovery fence. The normal 30-second reconciliation pass can roll back
a completed replacement only after fresh owner/installation/UUID/nonce proof;
it retains canonical volumes and the legacy Docker source. Observe operation
settlement and durable archived/stopped state before a new lifecycle request.

# Incus worker rollout

This is an opt-in upgrade for a single Ubuntu 24.04 amd64 host. The implementation
handoff is complete with an operator-approved acceptance exception: the final
full browser/routing/IP-change gate is deferred to
[issue #5](https://github.com/candlelightner/agentor/issues/5). Other accepted
evidence is recorded in `incus-vm-status.md`; the complete original Phase 13
matrix is not claimed passed. The deployed canary below still precedes any
production worker migration.
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
   authoritative worker-self identity, NIC spoofing negatives, persistence and
   optional native Docker, then removes only its acknowledged resources. Require
   `"status":"passed"`. A failure retains captured IDs for explicit inspection;
   do not clear markers, adopt by name or repeat an unknown creation blindly.
   Remove the private session file when finished. An API response or unit tests
   alone are not acceptance; legacy migrations remain explicit.

Incus access is verified HTTPS with restricted-project mTLS. Do not mount
`/var/lib/incus`, its Unix socket, or Incus credentials into any worker. Inner
Docker privileges remain inside the VM; host access requires an explicit grant
or exploitation of the Incus/QEMU/KVM/host boundary.

## Explicit migration

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

The VM root is disposable. Backups, rebuilds and migrations preserve canonical
workspace, agent/editor state, managed data and applicable native Docker state,
not arbitrary root-disk mutations. Historical backups missing runtime metadata
restore as legacy Docker; migration is a separate explicit operation.

# Bounded Incus operator recovery

For the single-admin Ubuntu installation, safe explicit recovery is preferable
to guessing after a compound failure. These procedures do not authorize automatic
adoption, receipt editing, worker migration, or changes to canonical storage.
Use the production stack definition and the installation's operator-owned setup
configuration as authority. Keep credentials and diagnostic records private.

## Controller running without a Docker network endpoint (#3)

Symptom: Docker says the Orchestrator is running and loopback HTTP responds, but
worker connectivity fails. After a Docker daemon interruption, a declared network
can have an empty/stale `EndpointID`, `NetworkID` or `IPAddress`. Local HTTP health
alone cannot establish that network connectivity is intact.

1. Suspend lifecycle/migration/backup submissions. Record the exact controller
   ID, image ID, creation time, DATA mount, read-only certificate mounts, Docker
   network ID and configured bridge-only internal port. Use targeted inspection,
   not a full `docker inspect` dump containing environment secrets:

   ```sh
   sudo docker --host unix:///var/run/docker.sock inspect --format '{{.Id}} {{.Image}} {{.Created}} running={{.State.Running}} pid={{.State.Pid}}' agentor-orchestrator
   sudo docker --host unix:///var/run/docker.sock inspect --format '{{json .NetworkSettings.Networks}}' agentor-orchestrator
   sudo docker --host unix:///var/run/docker.sock inspect --format '{{json .Mounts}}' agentor-orchestrator
   ```

   Substitute the **configured** controller name. Compare DATA and mount identity
   with the saved stack and installation ID; do not select a controller by name
   resemblance. Run the read-only `check-incus-host.sh` with the setup-printed
   arguments. It explicitly rejects stopped controllers, missing endpoints,
   mismatched network IDs and absent IPv4 addresses before checking routing.
2. If controller/installation/mount identity is ambiguous, stop here. Preserve
   both the stack definition and data. Do not use `docker network connect`, edit
   Docker's internal files, or broaden firewall rules to bypass the failure.
3. Explicitly stop the identified controller, then recreate **only that
   Orchestrator service** from the saved Portainer/Compose stack with the same
   image, DATA, environment, ports and individual read-only certificate mounts.
   Use the stack's force-recreate/update operation, not `down -v`, volume removal,
   or a guessed `docker run`. Never run old and replacement DATA writers together.
   Existing workers and their canonical storage are not recreation targets.
4. Verify the replacement's new full container ID, expected image and unchanged
   mounts. Confirm a live endpoint on the exact configured Docker network. Run
   the installation's existing routing refresh using its root-owned config:

   ```sh
   sudo /usr/local/lib/agentor-incus/<installation-uuid>/setup-incus-host.sh --routing --config /etc/agentor/incus/<installation-uuid>/config.json
   ```

   Use the actual installed script location printed by setup if it differs.
   This refreshes only installation-owned forwarding/source-preservation rules;
   it does not repair Docker endpoints, mutate workers or migrate them.
5. Re-run the host checker and the deployed canary in [the rollout guide](incus-rollout.md).
   Resume submissions only after real worker connectivity and identity checks
   pass. If recreation fails, retain DATA and the stopped prior controller for
   diagnosis; do not loop through new controllers or reset runtime authority.

This is administrator-guided recovery, not automatic network reconstruction.

## Orphaned disposable compute directory blocks unarchive (#4)

Symptom: a create/unarchive fails with `Root Volume path already exists`, while
the exact instance and native VM-volume APIs both return 404. This was observed
after an abrupt storage/daemon interruption. It is not evidence that canonical
workspace/agent/Docker volumes are empty, expendable, or successfully restored.
The upstream interruption sequence is not established; this procedure contains
the orphan safely rather than claiming to fix Incus internals.

1. Stop submissions and the exact identified controller as above. Keep the
   WorkerRecord, recreation/migration markers, private receipts and canonical
   volumes unchanged. Record the installation, project, worker/owner, pool,
   original acknowledged instance UUID, operation IDs and directory inode/device
   from existing private evidence. A similar name or an image's `metadata.yaml`
   alone is **not** proof of Agentor ownership. If linkage to the failed operation
   is unavailable, do not move the directory.
2. Verify the configured pool is mounted from its expected source/UUID. Query the
   exact targets with the explicit project (substitute verified values):

   ```sh
   sudo incus --force-local query '/1.0/instances/<instance-name>?project=<project>'
   sudo incus --force-local query '/1.0/storage-pools/<pool>/volumes/virtual-machine/<instance-name>?project=<project>'
   sudo incus --force-local operation list --project '<project>'
   ```

   Both resources must be authoritatively absent, not a TLS, permission, missing
   mount or daemon-availability error. Settle/fence all operations capable of
   recreating or touching this exact instance first. An expired operation record
   is not proof that a subprocess has stopped; use the next section if uncertain.
3. Resolve the exact root-volume directory from the configured pool and retained
   operation evidence, not a recursive candidate scan. Verify root-owned real
   directory, no symlinks, no nested mounts, no open directory/file handles and
   only the expected regular `root.img` and `metadata.yaml` entries. Inspect both
   files' link counts, inode/device and sizes. Preserve their hashes/private
   evidence and capture the canonical custom volumes' native identities/config.
   Check open handles as root; a permission failure is not a negative result.
   Any foreign entry, unexpected link/mount/handle, unavailable source or unresolved
   writer means **stop**, retain everything, and investigate explicitly.
4. After repeating these checks with all relevant writers fenced, create a new
   private quarantine directory **on that same pool mount**:

   ```sh
   sudo mktemp -d '/var/lib/incus/storage-pools/<pool>/agentor-orphan-compute.XXXXXXXX'
   ```

   Record its exact returned path. Rename only the proven disposable compute
   directory into its absent `compute` child. Use `os.rename`, which fails on
   cross-mount `EXDEV` instead of silently copying and deleting the source:

   ```sh
   sudo python3 -c 'import os,sys; os.rename(sys.argv[1],sys.argv[2])' '/exact/pool-mount/virtual-machines/verified-project_instance' '/exact/pool-mount/agentor-orphan-compute.RETURNED/compute'
   ```

   Do not move any custom volume, clear a marker, format/repair storage, use a
   wildcard, or delete the quarantined files. If the rename fails, do not fall back
   to copy/delete. Recheck the mount boundary and preserve the original target.
5. Verify the moved directory has the same inode/device and file hashes and that
   canonical custom-volume identities/config are unchanged. Preserve the quarantine
   path with the failed operation evidence. Restart only the verified controller;
   let existing reconciliation settle its bounded lifecycle marker. When the
   WorkerRecord is archived/stopped and its operation authority is settled, make
   one normal authenticated unarchive request. If its acknowledgement is lost,
   inspect the actual result before any retry. Do not edit the WorkerRecord to
   pretend a failed/unknown creation succeeded.

Retain quarantine until deliberate administrator cleanup is separately approved.
It is retained disposable compute, never a new authoritative worker
root filesystem, backup source, or migration image.

## Quarantined native converter/storage-helper job (#2)

Use the existing per-job authority below. A missing/stopped helper alone is not
proof of settlement. The bounded operator command described afterward supports
only **failed abandonment**, never successful result recovery or native cleanup.

Use the existing Phase 8–10 per-job authority, not a new journal:

| Job | Existing private authority | Existing cleanup boundary |
| --- | --- | --- |
| OCI converter/import | `image-catalog/image-catalog.json`, exact build's `nativeDerivation` | Catalog acknowledgements and `IncusImageConverter`; source authorization and exact converter UUID/import fingerprint |
| Offline backup/restore helper | `incus-backup-helpers/<job-uuid>.json` under DATA | `IncusOfflineArchiveHelper`; exact helper UUID, optional copy identity, source rechecks and writer settlement |
| Offline volume-size helper | `system-state/users/volume-sizing/volume-size-jobs.v1.json`, exact job's `incusHelper` | `IncusVolumeSizeHelper.cleanup` via the sizing manager's existing recovery; pending native operation and copy/incarnation fences |

1. Keep the exact DATA/installation and job record private and unchanged. Record
   its checksum, installation/project, owner, job ID, acknowledged operation,
   original helper UUID, source identities and copy creation identity **only when
   these were actually captured**. Do not fill absent fields from a resource
   which merely has the expected name. Backup bundles and image descriptions are
   not authority for the endpoint, project, device or receipt.
2. Confirm the configured pools/sources are mounted and available, and source
   WorkerRecord/volume authority is unchanged. If disk replacement left the old
   pool unavailable, stop: creating empty paths or new volumes would not restore
   the original data. A new pool does not validate old private receipts.
3. Query the exact recorded operation against the local daemon with the explicit
   configured project. Keep the output private:

   ```sh
   sudo incus --force-local query '/1.0/operations/<recorded-operation-uuid>?project=<project>'
   ```

   A live nonterminal operation is not permission to replay it. A terminal
   response can only support existing cleanup when the required exact resource
   acknowledgement was also captured. An expired/404 operation, missing response,
   lost daemon continuity, or missing create/copy UUID remains **unresolved**.
4. Use the existing job cleanup/recovery only for its already-supported proven
   cases. It must retain all existing ownership, incarnation, reference and
   source checks. A workspace writer additionally requires its callback/data
   authority to be settled; stopping/deleting the helper does not establish that.
   Do not turn a failed build into a successful import, publish a guessed image,
   remove an active receipt, or retry using a different job ID to evade the fence.
5. For an unsupported ambiguous case, preserve the receipt and both resource
   sides. Collect exact native identities, daemon/host boot and operation evidence
   for a **job-specific reviewed recovery**. A host reboot can establish that old
   processes no longer survive, but it does not prove source data, an uncaptured
   UUID, callback success or image import success. There is deliberately no
   blanket `404 = success` or force-clear command.

### Failed-abandonment after a full host reboot

`setup-incus-host.sh` installs `recover-incus-job.py` beside its other host tools.
This deliberately offline workflow can retire **one** existing cleanup fence
after its disposable resources were already removed with proven identity. It
does not delete resources, repair storage, replay operations, publish images,
recover measurements, or establish a workspace writer's success.

Supported cases are failed pre-import converters, read-only archive helpers and
failed/cancelled offline size helpers on available directory pools. The original
receipt must already contain the helper UUID and applicable copy acknowledgement.
Uncaptured identities, active/imported images, workspace writers, remaining or
orphaned helper disks, unavailable sources, pool mismatch and changed evidence
are rejected. The historical c3a671a9 and 567f930b incidents are **not** authorized
by this command; missing original acknowledgements/unavailable storage remain
unresolved.

1. Pause submissions. Explicitly stop the configured Orchestrator and **all**
   other DATA writers, disable their automatic restart, and keep them offline
   through the procedure. Include host/external writers, which the operator must
   confirm; the command also checks overlapping Docker read-write mounts.
   Keep the stack/configuration and source storage unchanged.
2. Run an inspection using the root-owned installed configuration, exact job UUID
   and one of `converter`, `archive`, `sizing`:

   ```sh
   sudo python3 /usr/local/lib/agentor-incus/<installation-uuid>/recover-incus-job.py \
     --config /etc/agentor/incus/<installation-uuid>/config.json \
     --kind <kind> --job <job-uuid> --confirm-submitters-offline
   ```

   This checks DATA installation, stopped controller identity/configuration,
   current resource absence and source metadata/backing. It saves the byte-exact
   original store and inspection in root-private
   `/etc/agentor/incus/<installation-uuid>/native-job-<kind>-<job-uuid>/`.
   Do not remove or replace that evidence to bypass a refusal.
3. Perform a **full Incus host reboot**, keeping all submitters disabled. A daemon
   restart is insufficient: old native subprocesses may survive it. Confirm the
   original storage mounts returned normally. This is maintenance downtime for
   the host; do not reboot merely to investigate an unsupported receipt.
4. Repeat the exact command with `--apply`. It requires the same host with a new
   boot ID and unchanged controller/configuration, entire store bytes/inode,
   pool filesystem UUID, exact source backing inode and native source metadata.
   It rechecks immediately before the bounded store change. Converter and sizing
   jobs remain failed; only their cleanup fence is retired. An archive receipt
   leaves the active directory but its exact original remains in private evidence.
   No source data, unrelated job, image binding or native resource is changed.
5. Resume the normal stack and retry through the existing authorized business
   operation. The normal source/grant checks still apply; abandonment grants no
   runtime or image authority. Retain the private original, intended replacement
   and completion evidence for audit.

If either step fails, stop and retain the evidence and data. In particular, a
changed hash or interrupted apply is not permission to force-clear or repeat
under a different job ID. The command is intentionally not a generalized
transaction recovery facility.

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

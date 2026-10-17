# Agentor production upgrade maintenance

This local repository records operational code used for the October 17 upgrade.
Credentials, inventories, logs, recovery material and generated receipts are
excluded from version control.

The accepted Agentor source is a separate repository at `source-4f157103`, based
on `4f157103fc42b0c4be341df134a084a9c69c7498`. Its one-line Docker context fix
is committed as `9dc1df2`; the prepared image contains that same source content.

`monitor-backup.py` reads the live job and process. Its `--require-complete` flag
fails until the job succeeded, the encrypted artifact is recorded as verified,
the regular artifact file matches its recorded size, and staging cleanup ended.

`prepare-incus-storage.py` is a one-time, root-only storage preparation step. It
requires the completed-backup gate and the exact existing SSD UUID. It refuses
existing Incus state, saves fstab, adds mount dependencies, and preserves recovery
material separately. It has not been run merely by committing this code.

`maintenance/backup-verifier` contains the original production validator, an
equivalent parent-index replacement, isolated equivalence/performance tests, a
module-binding replacement test, and the guarded inspector client used for the
live repair. The replacement was applied only in process memory, without a
restart or removal of integrity checks. The inspector listener was closed after
the repair. Neither the production image nor the prepared VM image was changed.

The equivalence test passed 52,274 comparisons and a million-entry workload. The
inspector test proved continued validation with the same process ID. These are
operational regression checks, not a claim that the whole migration is complete.

`restore-worker-home.py` runs as the unprivileged agent inside a migrated guest.
Its private manifest and individually hashed Docker home archives live in the
canonical agent-data volume under `.incus-migration-home`. It preserves selected
home settings and locally installed CLIs, reconciles newer Claude preferences,
and installs the audited additional APT packages. Existing guest defaults are
renamed before linking preserved paths. The original worker init script follows
this setup step without being committed here. Source Docker containers and SSD
copies of the archives remain available for recovery. Archive path and symlink
validation is covered by `python3 -m unittest test_restore_worker_home.py`.
`worker-init-prefix.sh` is prepended to the original private init script through
the worker settings API. Its enable file is created only after migration commits;
the operator then runs restoration to completion before restoring stopped intent.

`vm-memory-policy.json` records the explicit allocation for previously uncapped
VM workers. Apply it through the environment APIs, preserve other settings and
existing caps, and clone shared environments to leave retained Docker workers
unchanged. An existing VM needs a supported rebuild to apply the new allocation.

Guest acceptance uses `verify-worker-guest.py`, executed as `agent` after setup
finishes. It checks actual native and shebang execution on both canonical
volumes, Codex, the worker session and desktop handshake, current-boot home
restoration and manually installed packages. For the applicable workers it also
compiles/extracts a PDF, loads R packages or checks QEMU and preserved updater
GitHub configuration without emitting credentials. Host-side ownership, API
proxies, retained Docker sources and final stopped/archived intent are checked
separately.

`migrate-archived-worker.py --worker UUID` performs read-only preflight for one of
six reviewed archived worker IDs. Add `--execute` only after reviewing the helper
and preflight. Run as root on this installation; it uses the root-private canary
session in memory, the exact deployed authentication origin, and localhost port
3000. It never obtains GitHub credentials. The fixed owner, project, pool,
environment clones and two custom OCI digests prevent a broader migration.
An absent legacy desired-runtime field is accepted for archived workers; final
archived state must explicitly have stopped intent.

Execution claims exclusive, fsynced mode-0600 `migration-ID.*.private.json`
receipts before the first mutation and before/after each supported API call.
Existing receipts refuse reruns, including manual migration receipts. A local
lock serializes helper invocations; it cannot fence unrelated administrator
actions. Do not edit worker settings/environments concurrently. A lost response
or verification failure stops for operator inspection, without automatic retry,
rollback, finalization, or deletion. Keep all receipts and retained Docker data.

`Migration.continue_from_unarchive(before, cid)` exposes only that existing
post-unarchive sequence for a separately reviewed operator continuation. It
requires explicit execution state and an exact Docker ID, then checks the
original source image, worker label and hardware before any further mutation.
It does not unarchive, run preflight, retry, claim a new receipt namespace, or
catch errors: the operator must first prove prior operation/owner-queue settlement
and supply distinct continuation receipts and error handling. Normal `execute`
still rejects all existing receipts and retains its original error receipt.
There is no resume CLI or automatic continuation.

The sequence is unarchive, select the behavior-identical 4 GiB clone, stop and
capture exact Docker identity/mounts plus bounded file samples, migrate, rebuild,
verify the guest as uid 1000, verify editor/desktop HTTP paths, then archive using
the supported API. Final checks require absent native compute, retained canonical
volumes and unchanged stopped Docker source/image/volumes. Native memory must be
4 GiB, the converted image must derive from the exact captured OCI digest, and
the guest kernel must be HWE 6.11+ or 7–9 rather than the problematic 6.8 series.
Generic archived workers must have no home-restore manifest or additional package
manifest. Guest verification creates only temporary execution probes.

Samples are at most eight regular files of at most 8 MiB from each canonical
source, scanned without following links. Credential names, agent runtime state,
session/log databases, caches and generated `.agentor` paths are excluded. Empty
or entirely excluded trees legitimately yield zero samples; receipts state each
count. This is partial preservation evidence, not a full recursive checksum or
application/browser interaction test. Source/API migration validation still runs.
Native shared/account mounts are checked against exact owner paths and captured
inherited shared-skills mounts. Desktop requires HTTP 200; editor redirects are
limited to five within that same worker's same-origin editor path before 200.

The helper currently refuses METOD's `legacy-backup-path` volume naming before
unarchive: the deployed native migration requires normalized managed volume
identity. A separately reviewed and deployed source fix is needed before that
guard can be changed. Already migrated workers are also deliberately refused.

Operational regression tests run with
`python3 -m unittest -v test_migrate_archived_worker.py` from this directory. All
API/host/guest lifecycle effects in these tests are mocked or use temporary files.
The helper has **not** been executed against production as part of implementation;
real migrations, custom-image conversion and archival acceptance remain operator
run evidence. Incus command options follow the upstream
[exec reference](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/exec/).

### Offline inventory namespace correction

Two read-only Docker inventory files were originally saved under the lifecycle
receipt prefix and therefore correctly blocked the strict rerun guards. On
October 18 the operator renamed only these observations, preserving their bytes,
root ownership and mode 0600, then fsynced the directory:

| Worker | Old filename | Retained filename |
| --- | --- | --- |
| `b71d012c-4d77-4a7a-8e8b-4626d11ed5d8` | `migration-b71d012c-4d77-4a7a-8e8b-4626d11ed5d8.docker-source-inventory.private.json` | `offline-docker-inventory-b71d012c-4d77-4a7a-8e8b-4626d11ed5d8.private.json` |
| `a9812e5e-7316-4de6-9c6b-bf3ec11dcee2` | `migration-a9812e5e-7316-4de6-9c6b-bf3ec11dcee2.docker-source-inventory.private.json` | `offline-docker-inventory-a9812e5e-7316-4de6-9c6b-bf3ec11dcee2.private.json` |

Each file was verified as a root-private regular file with matching `workerId`, exact
`agentor-worker-ID-docker` named-volume identity and local/no-options storage,
`overlay2` driver, empty image/container/volume arrays, and the scope
`Offline retained Docker metadata; no full named-volume content hashes`.
These observations do not authorize migration or claim full data verification.

The byte-preservation checks are:

- `b71d012c-4d77-4a7a-8e8b-4626d11ed5d8`: 544 bytes,
  SHA256 `8dda9d3f3bcdd5517f02265e7f3ca1d82f2e943b5f3df3d26480d5a4de528dba`.
- `a9812e5e-7316-4de6-9c6b-bf3ec11dcee2`: 543 bytes,
  SHA256 `da1c99917b1febcc1ca1512464a1485a8dd09079c2a51032b41e2f1e4c0134cc`.

No lifecycle receipt was renamed, hidden or deleted. Both `preflight` and
`execute` still refuse every `migration-ID.*` entry, including unknown files;
there is no code exception for inventory-shaped JSON and no unarchive retry.
New read-only offline inventories use `offline-docker-inventory-ID.private.json`.
## Guest-only native Docker verification

`verify-native-docker-guest.py` is a root-only, read-only guest helper. The host
caller must separately prove the exact installation, owner, source identity and
**current** Incus rebuild incarnation before executing it. It accepts one bounded
JSON object on stdin: `{version: 1, expectedIncarnation, inventory, samples}`.
`inventory` and `samples` retain the source inventory/sample shapes; their worker
and source-container identities must match. The mandatory lower-case UUID is the
current `volatile.uuid`, never the migration marker's old UUID after Rebuild.

The first protected read is the fixed DMI product UUID. It must match before any
Docker command, sample or filesystem-space observation. Incus passes its
`volatile.uuid` as QEMU `-uuid` (see the [upstream QEMU driver](https://github.com/lxc/incus/blob/main/internal/server/instance/drivers/driver_qemu.go)).
The approved read-only operator probe also confirmed an exact match between the
restoring updater's host-side UUID and its lower-case guest DMI product UUID.
This proof must be repeated with the **new current** UUID after a supported
Rebuild; a stale value deliberately refuses verification. No source inventory,
credentials, recovery material or private init contents are committed here.

Docker access uses only `/usr/bin/docker --host unix:///var/run/docker.sock` with
a minimal environment and no user Docker configuration. The only accepted CLI
forms are info, image/container/volume listings and named-volume inspection.
`overlay2` and `/var/lib/docker` are mandatory; source image/container IDs and
volume names must be subsets of strictly parsed current inventories. Inspected
sampled volumes must be ordinary local volumes with no driver options and the
exact fixed Docker mountpoint. Output is bounded at 4 MiB per command, each
command has a 30-second deadline with child cleanup, and the entire helper has
a five-minute deadline. Input is limited to 2 MiB and duplicate JSON keys fail.

Samples are restricted to `/var/lib/docker/volumes/NAME/_data/<relative-path>`.
Every component is opened through directory file descriptors with `O_NOFOLLOW`;
regular-file reads also use `O_NONBLOCK` and `O_NOATIME`. Absolute/traversal/empty
components, symlinks, special files, oversized data, changed inode/metadata or
replaced named ancestors fail closed. SHA256 and exact size are mandatory;
optional `uid`, `gid`, `mode` (integer permission bits) and `mtimeNs` (integer
nanoseconds) are compared without floating-point conversion. Limits are 8 MiB per
file, 16 files per volume, 128 samples and 64 MiB total across at most 256 sampled
volumes. Source samples may need deliberate bounded selection before submission.

The helper writes no guest files, runs no agent CLI or Docker mutation, and has
no host wrapper. It returns private JSON with IDs, volume/file names, hashes,
counts and available Docker-filesystem bytes/inodes. The caller should retain
that JSON privately and print counts only. Success is explicitly marked
`samplingIsNotFullTreeVerification: true`; no full-tree or full-migration claim
is made. The operator owns actual post-cutover and post-Rebuild guest execution.

Run the local tests with:

```sh
python3 -m unittest discover -s scripts/maintenance/incus-upgrade-20261017 -p test_verify_native_docker_guest.py -v
```

Fourteen cases use an owned temporary filesystem, stub Docker observations and
small controlled subprocesses only. They cover early incarnation/root refusal,
exact content/metadata and inventory subsets, every path-component symlink,
traversal, FIFO/directory/size rejection, replacement during hashing, malformed
source/current inventories, duplicate JSON, fixed-socket/minimal-environment
arguments, bounded subprocess output/timeouts and child cleanup. These tests do
not execute Docker, Incus or a production guest.

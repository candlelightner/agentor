# Instance disaster recovery

Agentor instance backups are encrypted, versioned recovery snapshots for
migrating or rebuilding an entire orchestrator installation. They complement
portable worker backups; they do not replace them.

- Use a **worker backup/export** to move selected workspaces or reconstruct
  selected workers without replacing the destination control plane.
- Use an **instance backup** when recovering the orchestrator database,
  catalogs, configuration stores, plugin state, and optionally the
  Agentor-owned Docker volumes as one coordinated installation.

Instance disaster recovery is restricted to platform administrators. Workspace
and group administrators cannot create, inspect, adopt, or apply an instance
snapshot.

## What an instance snapshot contains

The version-1 instance manifest identifies the source installation, creator,
Agentor version, storage mode, `CONTAINER_PREFIX`, options, and the exact
SHA-256 digest and size of each payload. The encrypted bundle contains:

- a consistent SQLite online-backup copy of `auth.db`;
- a compressed snapshot of the versioned files below `DATA_DIR`;
- platform, owner, group, and worker plugin definitions and desired plugin
  installation records held in those stores;
- worker, environment, template, image-definition, catalog, provider-link,
  and other control-plane records stored below `DATA_DIR`;
- an inventory of immutable image digests, without Docker image layers;
- an inventory of configured host-mount source paths, without the host files;
- optionally, selected Agentor-owned Docker volumes, including directory-mode
  gaps such as DinD, administrative workspaces, and declared persistent-path
  volumes.

The default selection includes worker data, persistent agent data, and Docker
volumes. Logs, local portable-worker backup objects, export artifacts, active
staging, rollback directories, and the instance-recovery job ledger are
excluded to avoid recursion and stale transient state. The UI lets an operator
opt into logs or local backup objects when they are deliberately needed.

Every reconstruction store is captured as ordinary encrypted `DATA_DIR`
content. In particular, repackaging does not reduce plugin state to the summary
counts shown in the manifest: the definitions and desired installation state
remain in the authenticated data archive.

## What is deliberately external

An instance snapshot is not a raw host or Docker-daemon clone. Preserve or
recreate these separately:

- deployment `.env` values, including the Better Auth secret and external
  URLs;
- a server-mounted GitHub App private-key file;
- DNS, registry, Git, and other external service credentials that are not in
  `DATA_DIR`;
- the contents of governed host bind mounts;
- Docker image layers (pull the recorded immutable digest or rebuild the
  recovered image definition);
- the Docker Compose file, TLS/DNS infrastructure, and other host-level
  deployment configuration.

Do not put the recovery kit beside the provider artifact. Anyone who obtains
both can decrypt the instance state, including the authentication database and
encrypted credential stores.

## Encryption and recovery keys

Files begin with `AGENTOR-INSTANCE-BACKUP-1`. Agentor uses the current owner's
backup recovery material, but derives a separate AES-256-GCM instance-archive
key with an instance-specific HKDF context. The bounded clear header contains
only the format, creation/source identifiers, and recovery-key fingerprint.
The complete manifest and all data remain encrypted and authenticated.

Before decommissioning the source server:

1. Open **Backup management → Recovery key**.
2. Compare the displayed fingerprint with the instance artifact.
3. Reveal/export the applicable recovery kit using fresh server-side
   reauthentication.
4. Store the kit separately from Agentor and Google Drive.
5. Retain historical kits while any snapshot needs their fingerprints.

Raw key material is never returned by ordinary instance-backup REST or MCP
status calls. On a new installation, import the recovery kit through the
existing recovery-key workflow, then rescan the provider. A matching remote
record changes from `missing-key` to `ready-to-adopt`.

## Optional Google Drive synchronization

The instance-backup destination can be **Local** or **Google Drive**. Google
Drive is configured from a Google Cloud project, but this feature uses the
Google Drive API; it is not a Google Cloud Storage bucket integration.

The instance and portable-worker formats share the authenticated Google
connection, resumable upload/download implementation, and least-privileged
`https://www.googleapis.com/auth/drive.file` scope. They have separate provider
markers and queries, so an instance snapshot can never enter a worker restore
by filename confusion:

- worker objects: `agentorBackup=v1|v2`;
- instance objects: `agentorInstanceBackup=v1`.

To recover on another installation:

1. Configure the **same Google OAuth client/app identity** in the destination.
2. Link the same Google account.
3. Open **Instance disaster recovery**, select Google Drive, and scan.
4. Import the matching recovery kit when the record reports `missing-key`.
5. Rescan, inspect the source identity, creation time, size, format, and
   fingerprint, then adopt the chosen object.

The same OAuth client is an unavoidable consequence of `drive.file`: the scope
normally lets an app enumerate only files it created or that were explicitly
made available to that app. The same account connected through a different
OAuth client generally cannot discover the old client's files. Agentor does
not silently request full-Drive access to bypass this restriction. See
[Google Drive backup setup](google-drive-backups.md) for Google Cloud Console,
redirect-URI, publishing, and token-lifetime details.

Provider metadata and filenames are discovery hints only. Agentor downloads a
bounded object, verifies its encrypted digest and AES-GCM authentication, and
validates its manifest and every nested archive before adoption. Repeated scans
and adoptions are idempotent; provider-object identity is not duplicated in the
local ledger.

## Migration and restore runbook

### 1. Prepare and test the source snapshot

1. Stop every ordinary worker, the platform administrative workspace, and all
   group-administrator workspaces. This is required for a coherent snapshot;
   merely stopping the web browser is not sufficient.
2. Open **Instance disaster recovery** and choose Local or Google Drive.
3. Keep Docker volumes enabled for a faithful migration. Decide explicitly
   whether logs or existing portable-worker backup objects are worth the extra
   size.
4. Start the backup. Creation returns immediately as a durable job. Monitor its
   phase and bounded logs until it reports success. During the database/data
   snapshot phase Agentor holds a short control-plane write barrier; mutating
   dashboard/API/MCP requests are rejected with the active job reference rather
   than racing the archive.
5. Export the matching recovery kit and, for a local artifact, download the
   `.backup` file. Check that both copies are readable from recovery storage.

### 2. Prepare an empty destination

Install the compatible Agentor release but do not create workers or
administrative workspaces. Match the source:

- set `AGENTOR_INSTANCE_RECOVERY_MODE=true` for the destination recovery boot,
  which suppresses normal bootstrap/reconciliation while the old control plane
  is being replaced;
- the `DATA_DIR` mount mode (`directory` bind or named volume);
- `CONTAINER_PREFIX`;
- enough disk space for staging, rollback, and new volumes;
- external `.env`, GitHub App PEM, DNS/registry configuration, and host data.

Sign in with a temporary platform administrator only to perform recovery. The
restored `auth.db` replaces destination accounts, sessions, and authentication
state. After a successful restore and dependency reconciliation, remove
`AGENTOR_INSTANCE_RECOVERY_MODE` (or set it to `false`) and restart Agentor for
normal operation.

### 3. Discover or upload, adopt, and preflight

1. Import the matching recovery kit.
2. Either upload the downloaded encrypted file, or link/scan Google Drive and
   adopt the remote object.
3. Wait for authentication and structural verification to complete.
4. Inspect the recovered manifest and run restore preflight.
5. Resolve every blocker. Normal blockers include non-empty destination worker
   state, running workloads, storage-mode or prefix mismatch, an existing
   destination volume with a source name, or missing explicit confirmations.
6. Review warnings for image layers, external configuration, and host mounts.

The adopted artifact remains available after a failed preflight, so the host
can be corrected and the same verified snapshot retried.

### 4. Apply the snapshot

The safe default restores contained Docker volumes but omits host-mount
allowlists and grants. This prevents source paths from becoming authorized on a
different host merely because their strings match. Copy and verify external
host data first; select host-mount policy restoration only when those source
paths are intentionally valid on the destination.

Restore requires two explicit confirmations: replacing the control plane and
acknowledging the external-dependency checklist. After another integrity pass,
a network-disabled helper:

1. verifies the exact orchestrator container and shared `DATA_DIR` boundary;
2. rechecks that destination volumes are absent;
3. stops that exact orchestrator container;
4. moves the current destination data into a rollback area;
5. installs the validated data and selected volumes without overwriting an
   existing volume;
6. records terminal job state for the restored platform owner;
7. restarts the original orchestrator;
8. rolls back data and only helper-owned new volumes if application fails.

The control-plane mutation barrier is acquired when the restore request is
accepted, not only when its background task reaches preflight. Immediately
after stopping the target, the helper independently rechecks the persisted
worker/admin-workspace stores and Agentor worker-container labels. If the
destination changed during the handoff, restore stops before moving any data.

The helper is part of Agentor's trusted recovery boundary: it necessarily has
access to the Docker socket so it can stop/restart the exact orchestrator and
create selected volumes. It is not exposed as an API, receives only a bounded
four-value launch context, has no network, uses a read-only root filesystem,
drops Linux capabilities, enables `no-new-privileges`, and has explicit
resource limits. Treat access to the orchestrator image and Docker socket as
host-administrator authority.

The browser will disconnect during this step. Reopen Agentor after restart and
sign in with credentials from the source installation. If restart itself fails,
inspect the recovery job/helper logs and start the exact orchestrator container
manually; do not initialize a second control plane over the staged data.

### 5. Reconcile external dependencies

After login:

- pull recorded immutable image digests or rebuild recovered custom-image
  definitions, then run compatibility validation;
- confirm templates and plugin desired state, letting normal runtime setup
  allocate new ports, displays, sessions, and transient readiness state;
- restore required secret files/credentials that were external to `DATA_DIR`;
- validate host mounts before recreating or enabling their policies;
- start workers gradually and verify representative workspaces and plugins.

Keep the source VPS and recovery material intact until this validation passes.

## Asynchronous REST and management MCP

Create, provider discovery, adoption/upload verification, and restore use the
same durable state in the UI, REST API, and management MCP. Start calls return
promptly with a job ID, initial state, and exact status/log/cancel next actions.
Status responses contain a log-line count rather than the log body; logs are
read incrementally through the dedicated bounded operation. A stable `requestId`
makes transport retries return the same operation; reusing it with different
arguments is rejected. REST start endpoints accept the same value through the
standard `Idempotency-Key` header or the legacy/body `requestId` field and
reject a mismatch. The dashboard retains one identity across an uncertain
response instead of manufacturing a duplicate operation. Status responses
repeat the currently valid next actions and omit cancellation after restore
has handed control to the helper.

Platform-management MCP tools are:

- `instance-backups.list`
- `instance-backups.create`
- `instance-backups.discovery.start` / `instance-backups.discovery.list`
- `instance-backups.inspect`
- `instance-backups.adopt`
- `instance-backups.preflight`
- `instance-backups.restore`
- `instance-backups.status` / `instance-backups.logs` /
  `instance-backups.cancel`

Every `ownerId` supplied to these whole-instance tools must identify a current
platform administrator. This binds encryption keys and provider uploads to an
administrator-controlled recovery namespace; unlike portable worker backups,
an instance snapshot cannot be assigned to an ordinary user's exportable key.

An MCP caller imports recovery material only through the existing write-only
backup recovery-material mechanism. It can see fingerprints and availability,
but cannot reveal or export an existing raw key.

## Compatibility and format handling

The instance envelope and manifest have their own version and selector. Worker
formats `AGENTOR-BACKUP-1` and `AGENTOR-BACKUP-2` remain unchanged and cannot be
adopted as an instance snapshot. Unknown instance formats are shown as
unsupported and never guessed or automatically transformed.

This feature introduces no database migration: its durable jobs, adopted
artifacts, and remote discovery records live in the additive
`<DATA_DIR>/admin/instance-backups.v1.json` store. The store and retained
encrypted artifacts are deliberately preserved across the control-plane swap
so the terminal restore outcome remains inspectable after restart.

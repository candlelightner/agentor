# Google Drive backup setup

Agentor can store encrypted backups in Google Drive using a separate Google OAuth client. This OAuth client is only for backups; it is unrelated to Agentor login or the agent CLI credentials used inside workers.

The same connection can optionally synchronize full orchestrator
disaster-recovery snapshots. This is a Google Drive API integration configured
through a Google Cloud project, not a Google Cloud Storage bucket. Instance
artifacts use a separate provider marker and restore workflow; see
[Instance disaster recovery](instance-disaster-recovery.md).

## Before you begin

- After the first backup (or after opening the recovery-key status), export the owner recovery kit through **Backup management** and preserve it securely. Keep historical kits while their backups remain.
- For legacy v1 backups, also preserve `BACKUP_ENCRYPTION_KEY` or the generated `<DATA_DIR>/backup.key` and export its historical recovery kit before decommissioning the source installation.
- Store recovery kits outside Agentor and outside the Google Drive folder holding the backups. Backups cannot be restored if their matching key is lost.
- Sign in to Agentor as an administrator and open **Backup management**. Keep the **Google Drive OAuth installation** section available so you can copy its exact redirect URI.

## Create the Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Open **APIs & Services → Library**, find **Google Drive API**, and enable it.
3. Open **Google Auth Platform** and choose **User data**. A service account or **Application data** is not appropriate for this flow.
4. Under **Branding**, enter the application name, support email, and developer contact information.
5. Under **Audience**, select **External** unless every user belongs to the same Google Workspace organization. While the app is in Testing, add the Google account that will own the backups as a **Test user**.
6. Under **Data Access**, add this scope:

   ```text
   https://www.googleapis.com/auth/drive.file
   ```

   This lets Agentor manage files it creates or that are explicitly opened with the app; it does not grant access to every file in the account.
7. Under **Clients**, create an OAuth client with application type **Web application**.
8. Add the redirect URI shown by Agentor as an **Authorized redirect URI**. It follows this pattern:

   ```text
   https://your-agentor-domain.example/api/backup-providers/google/oauth/callback
   ```

   For example, a deployment at `https://agentor.dirigent.uk` uses:

   ```text
   https://agentor.dirigent.uk/api/backup-providers/google/oauth/callback
   ```

   The URI must match exactly, including scheme, hostname, port (if any), path, and trailing slash. No Authorized JavaScript origin is required.
9. Create the client and copy its **Client ID** and **Client secret**.

## Link Agentor to Google Drive

1. In Agentor, open **Backup management → Google Drive OAuth installation**.
2. Enter the Client ID, the exact redirect URI registered with Google, and the Client secret. Save the configuration.
3. Click **Link Google Drive**, sign in as the Google account that will own the backups, and approve the requested access.
4. Return to Backup management and confirm that Google Drive reports as linked or ready.
5. Create a small initial backup and wait for it to complete. Before relying on the setup, perform a restore into a disposable new worker and verify its contents.

The client secret and OAuth tokens are encrypted at rest. Agentor never displays the saved client secret again.

## Recovering on another Agentor installation

Google Drive is a backup *provider*, not the authority for decryption. A new
Agentor installation can discover and recover backups that are absent from its
local database, provided it is linked to the same Google account **and the
same Google OAuth client/app identity** that created the files.

The recovery workflow is deliberately staged:

1. On the original installation, open **Backup management → Recovery key**.
   Record the displayed fingerprint, then reveal or export a recovery kit.
   Both actions require fresh server-side reauthentication: enter the account
   password again, or (for a passkey-only account) sign in again and complete
   the action within five minutes. A normal existing dashboard session is not
   enough. Keep the kit outside Google Drive and treat it like a decryption
   credential: anyone with the kit and a backup object can decrypt that
   backup.
2. On the destination installation, configure the same Google OAuth client,
   link the same Google account, and use **Scan connected provider**. The scan
   records remote objects idempotently; scanning again updates the same remote
   record rather than creating duplicates.
3. Review the safe remote metadata before adoption: creation time, source
   installation/backup identity when present, size, format version, workspace
   IDs, key fingerprint, and its state. Typical states are discovered,
   ready-to-adopt, missing-key, incomplete, unsupported, damaged,
   inaccessible, and adopted.
4. Import the portable recovery kit on the destination. Agentor stores the
   imported key in the owner-scoped encrypted keyring and only exposes its
   fingerprint in normal UI, API, logs, and MCP responses. The scan then shows
   whether that key matches a discovered v2 backup.
5. Select **Adopt**. Agentor downloads the provider object, verifies the
   encrypted payload and authentication tag, validates the untrusted archive
   and its manifest, and only then creates a local backup-artifact record.
   Adoption does not overwrite an existing artifact; an already-adopted object
   is recognized as such. Failed adoption retains the discovered record so it
   can be retried after fixing a key or provider problem.
6. Inspect the adopted artifact, resolve any image/plugin dependencies, then
   restore all or a selected subset of workspaces as new workers. The source
   worker identifiers are not overwritten by default.

### `drive.file` scope and cross-instance discovery

Agentor intentionally keeps the least-privileged Google scope,
`https://www.googleapis.com/auth/drive.file`. It can enumerate files created
by, or explicitly made available to, that OAuth application. Consequently,
same-account discovery across installations genuinely works only when both
installations use the same OAuth client/app identity (and the files remain
available to that app). Linking the same Google account with a different
OAuth client generally cannot enumerate the old app's `drive.file` objects.

Do not solve that limitation by assuming Agentor has access to the whole Drive
or by widening scopes without an explicit security decision. If a different
client must be used, explicitly make the old files available to it or choose a
provider/recovery procedure appropriate to that client; Agentor does not
claim that arbitrary cross-client `drive.file` recovery will work.

The same limitation applies to instance disaster-recovery snapshots. A fresh
Agentor installation can discover `agentorInstanceBackup=v1` objects without
the old local database only when the linked account and OAuth application can
see those objects. Agentor intentionally keeps instance and portable-worker
queries separate, even though both use the same OAuth connection.

## Encryption formats and recovery keys

New backups use the version-2 `AGENTOR-BACKUP-2` AES-256-GCM envelope. Its
bounded discovery header includes a non-secret recovery-key fingerprint,
backup/source-installation identity, creation time, format version, and
workspace IDs. The header is authenticated as associated data; it helps a
destination identify a matching key but is not trusted until the complete
artifact is authenticated and inspected.

Existing version-1 `AGENTOR-BACKUP-1` archives remain supported. V1 has no
embedded key identifier, so Agentor first retains the existing local-key path
and, for an adopted legacy object, may try owner-authorized historical/imported
keyring entries until AES-GCM authentication identifies the right one. Keep
all historical recovery kits needed for old backups: importing a new key does
not replace or invalidate older keys.

The recovery kit contains only recovery material, its fingerprint, encryption
format version, and minimal creation metadata. It never contains Google OAuth
tokens, GitHub credentials, worker secrets, or provider credentials. Raw key
reveal/export responses are non-cacheable and must not be placed in browser
storage, telemetry, logs, or MCP status data.

## Restoring worker environment dependencies

Every current backup path records a secret-free reconstruction manifest for
each worker, including custom-image definition/version/digest and available
runtime/catalog identity, template-related configuration where applicable,
plugin definitions and desired installed state, non-secret plugin settings,
and the *names* of required secrets. Runtime allocations such as ports,
displays, GUI sessions, process IDs, and readiness state are intentionally not
restored; normal worker/plugin setup allocates them anew.

During restore Agentor first resolves the exact custom image from a local
version, an immutable runtime/registry reference, or recovered catalog
definition. If it cannot do so, it never silently substitutes the platform
image while calling the result faithful. Resolve the dependency by recovering
or syncing/rebuilding the image definition, pulling the immutable digest,
choosing an explicit replacement image, or explicitly acknowledging a
workspace-only restore. Missing plugin dependencies or secret names are shown
as dependencies; secret values are never fabricated or embedded in the
backup.

### Recovering an embedded custom-image definition

Some custom-image backup members carry a secret-free, encrypted reconstruction
recipe. The browser never receives that recipe. Instead, backup inspection
may expose only the server-derived `recoveryAvailable` flag for an unresolved
custom image. When it is true, **Recover definition & build** starts the
durable recovery operation (REST:
`POST /api/backups/:artifactId/image-recovery` with `workspaceId`,
`requestId`, and `startBuild: true`; management MCP:
`backups.image-recovery.start`). Do not offer or expect that action for an
unmanaged image or an artifact without that flag.

The job re-downloads the provider artifact, authenticates/decrypts it,
validates the untrusted bundle and reconstruction data, imports an
owner-scoped recovery copy of the image definition, and starts the existing
controlled image build. Its persisted backup-job status exposes only the
recovered-definition and image-build identifiers, never recipe/context/key
material. Poll/cancel that recovery job using its returned status/log/cancel
next actions. The resulting image build has its own status, logs, cancellation
and Agentor compatibility-validation lifecycle. A restore remains blocked for
that exact image until the build is **Ready** (or **Ready with warnings** where
applicable); after that, retry the restore rather than treating definition
recovery alone as a faithful image recovery.

## Asynchronous API and MCP operations

Provider scans, adoption, downloads, verification, dependency work, and
restore run as durable jobs. The dashboard and REST API poll the same job
state. Management MCP start tools follow the same `start → status → logs →
cancel/retry` pattern:

- `backups.discovery.start`, `backups.adopt`, `backups.image-recovery.start`,
  and `backups.restore` return
  promptly with a persisted `jobId`, an accepted message, and machine-readable
  `nextActions` naming `backups.status`, `backups.logs`, and (while active)
  `backups.cancel` with the exact arguments to use.
- `backups.logs` reads a bounded incremental page using `after` and `limit`;
  it does not return the full job log on every poll. `backups.retry` starts an
  appropriate retry for a failed durable operation.
- `backups.discovery.list` and `backups.inspect` expose only owner-scoped,
  safe remote metadata. `backups.key-status` exposes fingerprints and key
  availability; `backups.recovery-material.import` accepts write-only recovery
  material. There is intentionally no ordinary MCP operation for raw-key
  reveal/export.

For discovery, adoption, image-definition recovery, and restore, clients may
supply a stable `requestId`.
Retried starts with the same identity and arguments return the existing job;
reusing it for different arguments is rejected rather than creating a second
operation.

## Production and token lifetime

Google OAuth apps left in Testing can issue refresh tokens that expire after seven days for many scopes. That is useful during setup but unsuitable for unattended scheduled backups. Once testing is complete, publish the OAuth app to Production as appropriate for your organization and Google verification requirements.

## Troubleshooting

### `redirect_uri_mismatch`

Compare the URI in Google's error with both the Authorized redirect URI in the Google client and the redirect URI saved in Agentor, character for character. Also verify that Agentor's externally visible HTTPS URL is configured correctly behind any reverse proxy.

### The app is unavailable to the Google account

If the OAuth app is External and in Testing, add that account under **Audience → Test users**. Also confirm that the Google Drive API is enabled in the same Cloud project as the OAuth client.

### Linking worked but later backups cannot authenticate

Check whether the app is still in Testing and its refresh token has expired, whether access was revoked in the Google account, or whether the OAuth client was deleted or its secret changed. Relink the provider after correcting the cause.

### A backup exists but restore/decryption fails

Confirm that the destination has imported or retained the recovery key whose
fingerprint is shown for the artifact. For legacy v1 archives, import every
plausible historical recovery kit if the original local key is unavailable.
Google OAuth credentials cannot replace a missing encryption key.

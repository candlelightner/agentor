# Disposable API lifecycle evidence, 2026-09-29

Scope: an authenticated, fresh test orchestrator inside the approved disposable
VM, using recovery-mode startup to suppress administrative-workspace bootstrap
and automatic startup reconciliation. The operator explicitly authorized
`KATA_HOST_VALIDATED=true` only in this temporary test orchestrator. This is
not production attestation, normal-startup acceptance, UI acceptance, migration,
restore, or DinD validation.

## Isolation and image preparation

The harness refused pre-existing Agentor managed/admin/helper/Traefik containers
and fixed management networks. It used fresh labeled data and networks without
published ports. The only pre-existing container was the stopped standalone
canary with a different label; its full inspection was compared after the run.
No existing worker was stopped, relabeled, deleted or adopted by the test.

The test orchestrator used `runc`, `Privileged=false`, all capabilities dropped,
no-new-privileges, and only its fresh data volume plus the VM Docker socket.
The socket was never passed to the Kata worker. API requests came from the
guest-local harness, with genuine application authentication, explicit trusted
Host/Origin and in-memory cookies. Worker mounts were checked against its own
workspace/agent-data volumes and the fresh test account's credential subtree.
No production credentials or data were copied.

Current orchestrator source at `6b0d3ce` was built worker-locally and transferred
with Docker save/load. A strict archive-proof test passed, binding these two
store-specific IDs to the same exact image config:

- Classic/config ID:
  `sha256:0f7fb34b5670c84ced228f0898d0157e8826595f3c10aacaf3c82cdcb9bd08f5`.
- VM/containerd manifest ID:
  `sha256:75a43c35cb08794db93caa76db89d9717b1325ab1c0525b7f5fa2dc945c816d5`.

The initial build used the wrong context and failed before producing an image;
the corrected `orchestrator/` context build succeeded. The first API harness
attempt also stopped before resource creation because it did not recognize
Docker's exact absent-network diagnostic. The corrected absence guard passed
four offline cases before the second attempt. Neither failure is a product pass.

## Observed result

The first attempt below failed; a subsequent independently reviewed fresh-data
run passed the complete bounded sequence. See **Successful fresh-data retry**.

The fresh test administrator created a non-DinD environment and used the
ordinary worker-create route without a legacy override. Creation returned 201
and the worker selected `kata-qemu` / `agentor-kata-qemu` without privilege,
added capabilities or device grants.

The worker passed READY, UID1000 exec, tmux, editor and desktop HTTP checks. It
reported guest kernel `6.18.35`, had no Docker socket, and accepted synthetic
markers in its workspace and agent-data volumes.

The next API action, restart, returned HTTP 500:

```text
EPERM: operation not permitted, chmod '/data/users/<test-user>/kilo/config'
```

The test orchestrator had dropped **all** capabilities. The worker had taken
ownership of the shared Kilo directory; `StorageManager.ensureUserKiloConfigDir`
then attempted to chmod it. The production Compose configuration does not drop
all orchestrator capabilities. This identifies a test-orchestrator permission
failure, not successful or failed Kata restart execution. The minimal required
orchestrator capability correction needs review before repeating the test; no
worker permission or production configuration was changed in this attempt.

The sequence stopped. Rebuild, archive and unarchive were **not reached**.
No complete API lifecycle pass is claimed.

## Cleanup and artifacts

The test orchestrator and worker containers were removed by exact verified
identity. Their data volumes remain for investigation, including
`kata-api-ia3k0n9_-data`. The original stopped worker's inspection was unchanged;
no test containers remained running. VM Docker PID 28754 and daemon-config
checksum were unchanged. Removing the test orchestrator removed its test-only
validation flag; no global flag, migration-capacity gate or DinD gate changed.

- VM evidence: `/home/kata-test/kata-api-lifecycle.ia3k0n9_`.
- Initial guard-failure evidence: `/home/kata-test/kata-api-lifecycle.7d7gt5qb`.
- Local logs: `/workspace/kata-vm-api-lifecycle.log` and
  `/workspace/kata-vm-api-lifecycle-2.log`.
- Executed harness:
  `/workspace/agentor-kata-vm-access.ZgLVo9uk/run-kata-api-lifecycle.py`, SHA-256
  `368276f4ecd2ba07ef9cf875feeea2238c114d44e0b237899ef9b44dadf15bbc`.
- Evidence archive: `/workspace/kata-vm-api-lifecycle-evidence.tar.gz`, SHA-256
  `6d7164aac8f8bb9714ad8dd5c4a6924e33dbf5e113f3bfe6f4213d7e798bafb1`.
- Image identity proof: `/workspace/kata-image-proof-live/api-image-proof.spec.ts`
  and `api-image-proof-results.log` (one passed).

## Successful fresh-data retry

On 2026-09-29 the same immutable app and worker images passed authenticated
create, restart, rebuild, archive and unarchive in a new isolated test stack.
The test orchestrator retained `cap-drop ALL` and no-new-privileges, with only
`CHOWN`, `DAC_OVERRIDE` and `FOWNER` added. These are app-only filesystem
capabilities: chown establishes the intended UID-1000 ownership, DAC override
permits access through private UID-1000 directories, and FOWNER permits chmod
of worker-owned directories. The exact capability set was checked before app
start, accepting only Docker's optional `CAP_` spelling difference. No worker
grant or production configuration was changed.

The correction and full harness received independent review before execution.
Offline checks covered syntax and exact capability matching, including missing,
duplicate and extra grants; Python optimization now explicitly fails because
it would disable the safety assertions. The run used fresh data and stopped
on failure, with no runtime fallback.

| Operation | Result |
| --- | --- |
| Default worker create | HTTP 201; durable `kata-qemu`, runtime `agentor-kata-qemu` |
| API restart | Passed; same container ID, READY and services checked again |
| API rebuild | Passed; different container ID, retained volume markers |
| API archive | Passed; active container absent and archived runtime profile retained |
| API unarchive | Passed; another container ID, retained volume markers |

At every running stage, READY, numeric UID1000 exec, tmux, editor HTTP and
desktop HTTP passed. Workspace and agent-data markers survived. Both shared
Kilo directories were UID:GID `1000:1000`, mode `0700`; worker-written markers
survived each lifecycle transition and were readable through the app data
mount. Docker inspection checked the immutable worker image, no privilege,
added capabilities, device grants, socket or host namespaces, and mount sources
confined to this test's data. The guest kernel remained `6.18.35`.

This is one successful **recovery-mode, non-DinD API lifecycle** sequence. It
does not establish normal-startup reconciliation, browser UI acceptance,
credential reset/atomic replacement, multiworker credential sharing, backup
restore, rootfs snapshot migration, DinD or production-host validation.

The harness exited 0, including cleanup and baseline comparisons. Only its
exact test app/worker containers and empty owned networks were removed; test
volumes were retained. The pre-existing stopped canary's full inspection was
unchanged. VM Docker PID `28754` and daemon-config SHA-256
`74b0b314ff3a005384a2595d392a61c21acdd090a36f77eaf1211cad918737cf`
were unchanged, with no running containers and about 13 GiB free afterward.
Test-only attestation ended with removal of the app. DinD and migration-capacity
gates remain closed.

- Worker ID: `b7d1a9f5-b7f1-43ff-a776-9b9abaa54edf`.
- Final removed worker container:
  `515dd4cdc1c9b12f2fce0e4fc208fb49bdd8d605efebf70bd75e63938f391472`.
- Retained app volume: `kata-api-bpyea6he-data`.
- VM evidence: `/home/kata-test/kata-api-lifecycle.bpyea6he`.
- Local log: `/workspace/kata-vm-api-lifecycle-3.log`.
- Executed harness SHA-256:
  `91916034b2ac4031d44febee95f46fac55b8839e3fcd42db4d11f75efcacd084`.
- Local evidence archive:
  `/workspace/kata-vm-api-lifecycle-success-evidence.tar.gz`, SHA-256
  `cdd7af8cec0d3f4a13ba8e014de2cbd4e2cde86c3d192f595f9c569bd505bce6`.

## Extended sharing and real regular-user denial checks

A fresh two-worker run passed the same API lifecycle and both workers' UID1000
services. It verified that workspace/agent-data volumes were distinct while
the Kilo config/data directory bind sources were shared. Each worker replaced
a synthetic `auth.json` through temp-file creation, fsync and atomic rename;
the sibling worker and orchestrator observed the new contents. Authenticated
credential status and reset worked in both directions. No real provider
credential was used.

A separately authenticated, verified `role=user` account could not see the
administrator's workers. Explicit legacy creation and administrator migration
preflight/journal access returned 403; container inventory was unchanged.

The run nevertheless exited **1** at the final strict baseline comparison:
`Preexisting container changed`. The exact differing inspection was not saved
by that harness version. A subsequent read-only check found full equality with
the original canary inspection, unchanged Docker PID/config, no running
containers and only default networks. All owned test containers/networks were
removed and volumes retained. The cause of the transient comparison mismatch
is unproven, so this is not an overall successful acceptance run. Later harness
versions save the exact compared post-test inspection without weakening equality.

- VM evidence: `/home/kata-test/kata-api-lifecycle.32u3fp4f`.
- Local logs: `/workspace/kata-vm-api-sharing.log` and
  `/workspace/kata-vm-api-sharing-postcheck.log`.
- Harness SHA-256: `4c3f774c4991559368770b6f627b2e0a59a66266fb7494ca4213ba79e50ae866`.
- Archive: `/workspace/kata-vm-api-sharing-evidence.tar.gz`, SHA-256
  `8cd9baf3724498727637f3eed61ceca09439bf5a62fa938490c8f5a9d6f8f84e`.

## Real browser lifecycle pass

A separate fresh run completed the API lifecycle, then real browser sign-in,
runtime display, stop/restart, archive and unarchive. No browser routes were
mocked. The browser ran as UID1000 in its own nonprivileged container, with all
capabilities dropped, no mounts or Docker socket, and only the test network.
The parent harness independently inspected Docker state and verified fresh
READY, UID1000/tmux/editor/desktop and workspace/agent-data/shared-Kilo markers.
Stop/restart retained the container ID; archive/unarchive created a new one.

This run exited **0**, including removal of exact owned containers and empty
networks, unchanged full original-canary inspection, Docker PID/config and no
running containers afterward. Volumes remain, including
`kata-api-uoej5vjy-data`. It does not include the two-worker sharing extension.
The temporary host attestation ended with removal of the app.

This proves the bounded **recovery-mode, non-DinD API plus real browser
lifecycle** sequence. It is not normal-startup reconciliation, the full test
suite, DinD, migration, backup restore or production-host acceptance.

- Worker ID: `60efc26b-2356-4b34-af14-ab9ef50ace4b`.
- VM evidence: `/home/kata-test/kata-api-lifecycle.uoej5vjy`.
- Local log: `/workspace/kata-vm-browser-lifecycle.log`.
- API harness SHA-256: `7b98c0a391967de53c3abf1cb0378c2ef81293b7ceca7126879e1ef3306b2384`.
- Browser wrapper SHA-256: `1a1608e4f618278739db4f39954ab9b865292ee1dbd01b6d0ed406d94d0ff767`.
- Archive: `/workspace/kata-vm-browser-lifecycle-evidence.tar.gz`, SHA-256
  `40000138a70992ed8545403d71138970cd77949b43f0687df16f7eb68d892532`.

## Encrypted instance-backup source attempt: preflight failure

A separately reviewed fresh source run repeated the non-DinD API lifecycle,
stopped its synthetic worker and submitted a real encrypted instance backup.
The job failed with `INSTANCE_BACKUP_FAILED` during preflight, before database
or volume snapshots. Recovery-kit export and destination restore were not
reached. The harness exited 1; its test containers were removed and evidence
volumes retained. The original stopped canary remained unchanged.

Read-only investigation found a missing lexical import: `defaultPreflight()`
calls `useManagedVolumeManager()` without an accessible binding. The exact
pinned image's archived bundle retains this bare reference while defining the
manager factory under a different bundled name. An isolated execution with
inactive-service mocks reproduced `ReferenceError: useManagedVolumeManager is
not defined`. This is a concrete code defect consistent with the live failure;
the original job sanitized its exception, so the live exception itself was not
captured. No permission change or preflight bypass is indicated.

The archived image manifest and application-layer hashes were rechecked against
their content-addressed names. The image remains the previously proved
`75a43c35…` VM manifest / `0f7fb34b…` classic config pair. The application layer
is `sha256:c2ba1d5562af709e9301f510415a7310c1166c73c8b96490fd7f66974fd02cc6`.

- Source worker: `79b975e0-46c7-4daf-9cbd-832b3c988922`.
- Backup job: `ffc06a59-39d5-490e-a19d-4efe8ab15092`.
- Retained data volume: `kata-api-0qfbljwm-data`.
- VM evidence: `/home/kata-test/kata-api-lifecycle.0qfbljwm`.
- Local log: `/workspace/kata-vm-instance-source.log`.
- Archive: `/workspace/kata-vm-instance-source-evidence.tar.gz`, SHA-256
  `85d9c044e81c1e8e48805108da484d9a9e2c5fd911142910fcfc6e13553cdebf`.

The source/restore harnesses passed 20 offline cases before this run. Those
checks and this failed source run do not establish encrypted cross-host restore.

The missing import has now been fixed with an explicit local module binding.
New regression tests invoke the constructor-selected default preflight without
the old test override: three reproduced the missing binding before the fix,
and all 12 manager tests pass afterward. Main reviewed the change and passed
318 combined capacity/migration/admin/backup-manager tests and full typecheck.
An isolated check of the actual rebuilt image's bundled preflight passed all
nine active-operation guard cases, active-worker rejection and quiescent
success (11 cases). Service dependencies are inert mocks in these checks;
they do not replace a live backup/restore retry.

An initial successful image build captured an intermediate edit and still had
an unresolved binding; read-only bundle inspection rejected it before any run.
The subsequent frozen-source build has classic/config ID
`sha256:7425e0f5e3dfc21d61f341dd5c3d9c6fa5c7b43c10add1f8075ade87ce320694`
and archive manifest ID
`sha256:0a290c98bb97a6965eb236698f06fef6b911ad8d5793de53fd1ff7b51c9709d9`.
The image was subsequently loaded into the disposable VM; the actual VM
load/save archive passed the full cryptographic image-proof check against the
local image. The restore-helper bytes remained unchanged.

## Fixed-image source retry: backup succeeded, harness checksum mismatch

The fresh fixed-image run repeated the authenticated non-DinD lifecycle,
stopped its synthetic worker and completed a real encrypted instance backup.
Both production volume-snapshot helpers were observed with the expected
isolation and exact workspace/agent-data mounts. The application reported
`succeeded` / `complete`, and the artifact's integrity status was `verified`.
This establishes source backup creation, not successful destination restore.

The harness then exited 1 at its downloaded-file checksum comparison. Source
inspection established that `encryptInstanceBackup` returns SHA-256 over the
**ciphertext plus GCM tag**, excluding the discovery header and IV; the harness
had compared this with a whole-file hash. Read-only checks of the exact
download confirmed matching size (185199 bytes) and matching payload/tag digest,
but a different whole-file digest. No corrupted transport or failed encryption
is established by that comparison failure.

A harness-only correction now retains a whole-file transfer digest separately
and compares the API checksum with the bounded payload/tag region. Four added
fixtures distinguish header-only changes from ciphertext/tag changes and reject
malformed/truncated/oversize input; 24 offline fixtures pass. This correction
still requires independent review before another execution. The production
destination must still perform authenticated decryption; checksums alone are
not authentication. Recovery-kit export was not reached and the destination
has not run.

Cleanup removed the exact test containers and empty networks; the original
stopped canary's full inspection was unchanged. Volumes and encrypted test
material remain. No production credential was used or exported.

- Source worker: `4fef47eb-d2fb-4b3d-a857-73ebc0bb9f97`.
- Backup artifact: `dcad5675-67ba-4c2a-b3aa-af9deb8930db`.
- Retained data volume: `kata-api-eyzq8z0u-data`.
- VM evidence: `/home/kata-test/kata-api-lifecycle.eyzq8z0u`.
- Local log: `/workspace/kata-vm-instance-source-fixed.log`.
- Evidence archive: `/workspace/kata-vm-instance-source-fixed-evidence.tar.gz`,
  SHA-256 `aa2ad34f59c08495a515e81daab953dcc1159091a26b851611c532965ca689aa`.
- Actual VM image-export archive SHA-256:
  `3b25c4f65fdfbda50e616152e1b59deb1b9eec7ce311948fef90e5140a9644ed`.
- Image-proof log: `/workspace/kata-image-proof-live/backup-fix-image-proof.log`.

The complete no-server module suite at this code checkpoint passed all 633
tests (`/workspace/kata-all-modules-1ebfc1e.log`). These mocked/local tests are
not full API/UI, migration or cross-host restore acceptance.

## Corrected source pass; destination blocked before application startup

The checksum correction received independent approval at the exact recorded
hashes; 24 harness fixtures and four production crypto tests passed. The next
fresh disposable-VM source run exited **0**, including the non-DinD lifecycle,
real encrypted backup, downloaded payload checksum, synthetic recovery-kit
export, exact cleanup and original-canary baseline preservation. The whole-file
transfer digest is separate from the API's payload/tag digest; neither replaces
destination authenticated decryption.

The encrypted artifact and synthetic recovery kit were transferred privately
to this worker's local Docker environment. The reviewed destination harness
exited **1 before the application started**, so import, decryption, restore and
destination-policy checks were not reached. The exact created app's Docker
state records:

```text
unable to apply cgroup configuration: cannot enter cgroupv2
"/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode
```

No cgroup, permission or host configuration was changed, and no retry or
workaround followed. The exact unstarted app and owned test networks were
removed; the empty test data volume remains. Existing local networks were
preserved. The harness result's `restoredVolumes` field names its expected
volumes, not successfully restored volumes. This is a source-backup pass and
a destination-startup failure, **not encrypted cross-host restore acceptance**.

A later read-only check within this worker found its cgroup namespace root is
`domain threaded`, `/sys/fs/cgroup/docker` is `threaded`, and that child exposes
`cpuset cpu pids` controllers, while the local Docker daemon uses cgroupfs/v2.
This is consistent with the reported domain-controller startup rejection. It
does not establish why the worker's cgroup topology was configured this way,
nor authorize removing test limits, changing cgroups or accessing the outer host.

- Source worker: `5127d0b8-64c8-41fa-afa9-1211c7f40a4f`.
- Source evidence: `/home/kata-test/kata-api-lifecycle.misr_mvk`.
- Retained source app volume: `kata-api-misr_mvk-data`.
- Source log: `/workspace/kata-vm-instance-source-checksum.log`.
- Source archive: `/workspace/kata-vm-instance-source-checksum-evidence.tar.gz`,
  SHA256 `f1478c1378a2ede293c4906378f869f953a6126489c42cdfa2b6c5b73382cb82`.
- Destination evidence: `/workspace/kata-instance-destination.nveqpded`.
- Destination log: `/workspace/kata-instance-destination-checksum.log`.
- Retained destination app volume: `kata-instance-destination-nveqpded-data`.

Private synthetic recovery material is excluded from evidence archives and the
repository. No second Kata boot, captured-image transfer or source-journal
stripping was tested by this sequence. Runtime gates remain closed.

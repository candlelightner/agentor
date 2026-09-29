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

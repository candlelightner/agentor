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

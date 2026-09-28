# Worker-local snapshot evidence (2026-09-28)

Command: `bash scripts/test-worker-local-runtime-snapshot.sh --run-worker-local`.
Final evidence directory: `/workspace/kata-snapshot-proof.sdsiUWPy`.

The script verified the local Docker daemon name matches this worker and a
local dockerd process exists before acting. Both source and loaded containers
used runc, no network, no added capabilities, no-new-privileges and UID 1000.
No host mounts, devices, host socket or host namespaces were passed to them.

Passed checks:

- Writable rootfs marker survived stopped-container commit and image save/load.
- The loaded image retained the exact image ID, custom entrypoint/command,
  working directory and user.
- Explicitly blanking runtime-only Env entries in the Docker commit request
  prevented the old test account value, local-variable payload and secret
  handshake from surviving in the recreated worker. Omitting Env keys would
  not be sufficient because Docker commit merges the container configuration.
- All exact disposable containers and the new image tag were removed; the
  shared base image was retained. Text/JSON evidence and the test-only image
  archive remain in the evidence directory.

This is real worker-local Docker evidence, not an Agentor API/UI end-to-end
run, Kata execution, cross-host restore test, migration capacity proof, or host
validation. See [the host handoff](kata-host.md#snapshot-images-and-disaster-recovery).

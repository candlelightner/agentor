# Native DR acceptance remains unverified

The prepared workspace and Docker whole-instance suites in `backup-integration-acceptance.md` do not verify real native VM disaster recovery. No native daemon, system VM or privileged test stack was started while preparing this change.

The private cgroup delegation proof is useful for nested Docker. It does not prove that Incus/QEMU/virtiofs/vsock can run with the requested private namespaces and devices. The Docker image linked from [Incus installation documentation](https://linuxcontainers.org/incus/docs/main/installing/) publishes a [recipe using host PID, network and cgroup namespaces, host `/dev` and kernel-module binds](https://github.com/cmspam/incus-docker#to-use-the-image). That project also documents container udev changing host KVM device ownership. Those instructions must not be used for this acceptance run. Host namespace joins, host sockets, device-tree/module binds, host service changes and device ownership changes are outside scope.

## What is guarded now

Default Playwright global setup rejects the four native DR flags before creating a request context, probing localhost or authenticating, and directs callers to `playwright.modules.config.ts`. Its normal non-native startup is unchanged.

With that explicit module configuration, enabling `INCUS_INSTANCE_BACKUP_TEST`, `INCUS_INSTANCE_PREFLIGHT_TEST`, `INCUS_INSTANCE_DETACHED_RESTORE_TEST` or `INCUS_INSTANCE_HELPER_PROCESS_TEST` now fails before native API/build/SSH work unless `/run/agentor-native-dr/fixture.json` passes the shared private-fixture guard. Unenabled gates retain their existing skips. Existing capture/restore assertions remain present.

The receipt and its directory must be root-owned, private and free of symlink redirection. JSON and certificate reads use `O_NOFOLLOW`, regular-file/owner/mode checks and bounded reads. The receipt must match the running guest's boot ID, machine ID and exactly one kernel command-line parameter `agentor.native_dr_fixture=<nonce>`. Its nonce fixes `/var/lib/agentor-native-dr/<nonce>`, private control/TLS directories, `agdr<nonce-prefix>` project/pool/network/image names and exact loopback Incus endpoint. Public native host-service and converter fallbacks are explicitly empty. The complete schema is in `tests/helpers/private-native-dr-fixture.ts`; this receipt is a test boundary, not a production recovery credential.

The local capture/preflight/detached inverse cases take their configuration from that receipt. They no longer fall back to historical project names, TLS paths or `INCUS_TEST_IMAGE`. A receipt alone does not make these tests ready: the independent guest bootstrap, project restrictions, current image identity, network and storage still need provisioning and real verification.

The historical helper-process fixture uses hardcoded remote SSH/SCP and many retained artifact descriptors. It now also fails explicitly **even after a valid receipt**, before entering that transport. Its assertions are retained for refactoring. A historical descriptor is not permission to contact its old host or project. No silent skip or mocked native pass substitutes for this failure.

Safe checks available now, without live flags or native services:

```sh
cd orchestrator
../tests/node_modules/.bin/playwright test --config ../tests/playwright.modules.config.ts \
  ../tests/api/private-native-dr-fixture.spec.ts \
  ../tests/api/instance-backup-native-live.spec.ts \
  ../tests/api/instance-backup-detached-live.spec.ts \
  ../tests/api/instance-native-helper-process.spec.ts --workers=1 --retries=0
```

Expected result: nine guard cases pass; the twelve explicitly gated native cases remain skipped. This is guard validation, not native acceptance. Run from a clean source snapshot with a minimal environment and fresh dependencies; do not inherit production `DATA_DIR` or live gate flags.

## Minimum safe alternative to investigate

Use a fresh direct-KVM **system VM** with its own kernel/systemd/Incus/Docker, optionally launched by an unprivileged QEMU runner that receives only `/dev/kvm`. This is a proposal for review, not an execution recipe. The [Incus instance documentation](https://linuxcontainers.org/incus/docs/main/explanation/containers_and_vms/) explains the separate-kernel boundary provided by system VMs.

Proposed outer boundary: private PID/mount/network/cgroup/IPC namespaces, no host listeners, no host Docker/Incus sockets, no production mounts, no host `/dev`, `/sys/fs/cgroup` or `/lib/modules` binds, no host helpers, no module/service changes and no device chown. Give it a newly created UUID-scoped guest-disk volume and a read-only committed source snapshot. Prepare a checksum-pinned guest image and payload separately; copy source/dependencies/images into guest-owned storage. A fully offline guest needs no external network or host forwarding. The runner/VM design must prove nested KVM before proceeding; unavailable nested virtualization is a blocked environment, not permission to reconfigure the host.

Inside the guest, generate entirely new Incus state, certificates, restricted source/destination projects, pool, bridge and installation state. Keep the source project intact; restore the encrypted artifact into a separate destination project with the same verified image fingerprint. Start with one source/restored worker and serial readers. An initial planning allowance is 8 vCPUs, 16 GiB RAM and a sparse disk bounded at 100 GiB, plus room for independently built input images; these are proposed limits, not measured requirements or a runtime estimate.

Before any launch, review the exact runner/guest image hashes, payload hashes, kernel nonce, device/mount/network specification, resource limits and cleanup receipts. Cleanup may target only newly acknowledged container/VM/disk identities, after stopping the fixture. No global prune, name-only adoption or host Incus command is allowed.

Missing gates are concrete:

1. Fresh private guest bootstrap and nested KVM/Incus/virtiofs/vsock/UID1000 smoke without host reconfiguration.
2. Fresh restricted project/certificate/image/storage/network authority checks and a generated receipt; no such bootstrap exists yet.
3. Replacement of historical helper SSH/SCP with exact local guest fixture transport, and parameterization of old fixed descriptors.
4. Real public UI/API native capture → encrypted artifact/key import → preflight → controlled restore/restart in a fresh destination project.
5. Exact canonical, disabled Docker, attached/detached/retained data metadata checks; explicit restored VM start and Docker inventory; unchanged retained source proof.

These remain required after migration, consolidation and combined checks. No execute-ready native harness or native portability acceptance is claimed.

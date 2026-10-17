# Isolated combined backup acceptance

Run this only after the production migration has finished and the future-code branches have been consolidated into a committed integration branch. These commands create test resources; they do not deploy the branch or reuse production backups, keys, DATA mounts, Docker volumes, Incus projects, or published host ports.

## Concrete commands

From the consolidated repository root, inspect the plan first (this performs no Docker or Git operation):

```sh
python3 scripts/test-backup-integration.py --suite workspace
python3 scripts/test-backup-integration.py --suite instance
```

After reviewing the generated names/mounts, run the two independent acceptance suites:

```sh
sudo -n python3 scripts/test-backup-integration.py --suite workspace --execute
sudo -n python3 scripts/test-backup-integration.py --suite instance --execute
```

Each invocation selects a fresh random run ID. `--run-id readable-id` can make the names easier to identify; pre-existing container/volume names are refused, and an exclusive local lease prevents concurrent reuse of one run ID. The launcher requires clean tracked source, records the exact tested commit, and exports only `git archive HEAD` into a private temporary directory. Untracked/ignored `.env`, credentials, keys, developer dependencies, and generated output are not mounted. The runner installs its own dependencies into new volumes. Each suite gets a separate fresh nested Docker data volume, so tests cannot inherit another suite's installation.

The workspace invocation runs:

```text
api/backups.spec.ts
api/instance-backups-api.spec.ts
ui/backup-management.spec.ts
ui/instance-backup-management.spec.ts
ui/backup-management-real.spec.ts
--workers=1 --retries=0
```

The dedicated whole-instance invocation enables `INSTANCE_DOCKER_BACKUP_TEST=true` and runs only:

```text
api/instance-backup-docker-live.spec.ts --project=api --workers=1 --retries=0
```

Do not append other tests to that invocation: the whole-instance test deliberately retires its source installation after exporting its artifact. The real instance spec is skipped before browser fixture creation unless explicitly enabled.

## Isolation and build contract

The outer runner is a new privileged DinD container, with private network/cgroup namespaces, an exclusive daemon-data volume, and no outer `ports`, host network, host Docker socket, production DATA, Incus credentials, or device-selection configuration. The standard runner still requires delegated cgroup-v2 CPU/memory/PID controllers and proves the exact constrained sizing-helper permissions before starting Agentor. A failing infrastructure preflight is a blocked acceptance environment, not a passing feature check.

The entrypoint refuses a pre-existing/mounted Docker socket before opening its cache lock or changing cgroups. It clears Docker context/TLS overrides and uses only its newly started local socket. It records that daemon's identity in a private regular marker. The whole-instance spec validates marker ownership/mode/type, daemon ID/root directory/hostname, and the private cgroup root before any mutating Docker call. It also requires the expected `agentor-test` source compose labels and DATA volume and an initially worker-free installation.

The Orchestrator image builds with `docker build -f /src/orchestrator/Dockerfile /src`, including the repository-root `.dockerignore`, canonical `worker/vm`, worker entrypoint, and required scripts. The worker image retains its worker-directory build context. The runner's own image tag, container name, daemon volume, and both dependency volumes are unique to this invocation.

Source HTTP 3000, Traefik 80/443, and destination recovery HTTP 3401 exist only inside the outer runner's private network namespace. No host listener is published. The destination's Docker socket bind is the inner test daemon's socket, not the host socket. Both source and destination use images built inside that private daemon; the recovery app is pinned to the captured source image ID.

## Real whole-instance path being prepared

The opt-in test uses the actual production UI/API with no route mocks:

1. Create two ordinary Docker workers in a Docker-disabled environment. Seed workspace and per-worker agent-data volumes with 8,000 binary files in total, numeric owners, permissions, fixed modification times, hardlinks and relative symlinks. Capture their expected content/metadata manifests.
2. Save explicit default-root coverage, stop one worker, archive the other, and save/deselect the archived worker with its old path map still present. Retain independent schedule settings.
3. Start a local whole-instance snapshot through the real instance-backup modal. Require a terminal successful, integrity-verified artifact and an authenticated encrypted `AGENTOR-INSTANCE-BACKUP-1` download. Keep only the fixture-generated recovery material in memory.
4. Stop the fixture source app. Remove only its captured, allowlisted worker/Traefik volumes and exact fixture compute, after checking there are no other consumers. This prevents same-daemon volume-name conflicts without using a second host Docker daemon or changing any production storage.
5. Start a fresh recovery-mode app on a new test DATA volume/network. Import the fixture key and encrypted artifact through their real authenticated APIs; require nested verification/adoption.
6. Run preflight and apply from the real restore UI, including both destructive/external-dependency acknowledgements. Observe an actual stop/restart of the same recovery app container and reauthenticate against the restored database.
7. Require a successful restore job, preserved stopped/archived durable lifecycle intent, no automatic worker activation, retained backup selections/settings, and exact file hashes/UID/GID/mode/mtime/hardlink/symlink manifests in all four restored Docker volumes using network-disabled read-only probes.

Recovery mode intentionally leaves disposable worker compute absent; raw volume checks and durable records are the authority here. The separate real workspace UI case verifies a running restored worker round-trip and exact single-member selection. This test does not claim that Docker restore verifies native VM codecs or host bind-mount contents.

## Existing native portability gates

Existing module suites cover native format/role bounds, exact raw/PAX/ownership handling, metadata inversion and controlled restore failure/rollback. Existing live specs include:

- `api/instance-backup-native-live.spec.ts`: `INCUS_INSTANCE_BACKUP_TEST=true`; actual native capture of stopped canonical data, disabled Docker, attached/detached and deleted-owner managed data, encryption/decryption and content inspection.
- `api/instance-backup-detached-live.spec.ts`: `INCUS_INSTANCE_PREFLIGHT_TEST=true` or `INCUS_INSTANCE_DETACHED_RESTORE_TEST=true`; compiled native preflight/inverse paths.
- `api/instance-native-helper-process.spec.ts`: `INCUS_INSTANCE_HELPER_PROCESS_TEST=true`, with additional explicit public/historical/custom-image gate flags and exact private fixture descriptors; actual controlled helper and public restore paths.

These are not generic nested-Docker gates. Several still bind a prior disposable endpoint (`127.0.0.1:18443`), project name `agentor`, `/workspace/agentor-incus-tls` paths, and/or exact retained fixture IDs. Do **not** simply enable these flags, reuse their old credentials, or point them at the migrated production Incus project. A fresh restricted disposable Incus project/image/network and reviewed fixture descriptor/refactoring are required first. No native live command is safe to prescribe for the current production host from those hard-coded defaults. Native real-VM portability therefore remains a separate pending acceptance gate.

## Evidence and cleanup

The launcher prints the private result directory and tested commit before execution. It retains `source.json`, `runner.log`, Playwright results/screenshots/traces and the HTML report; it does not copy authentication-state files. The whole-instance spec disables tracing/video because its API flow reveals/imports a generated fixture recovery key; no key file or raw key log is produced. It removes only its new UUID-scoped compose project/volumes in `finally`, including on build/test failure. The source snapshot is then removed. The outer test-runner image tag may remain as a harmless cached test image; production image tags are never changed.

Before consolidation, only static/local checks are authorized and have been exercised: launcher unit tests, shell syntax, pure daemon-identity tests, TypeScript checking and default skipped discovery of the real spec. Neither acceptance stack has been started. The opt-in whole-instance spec and repaired real-worker UI spec are **prepared, not live-validated**. Final acceptance requires actual successful runs of both commands above and review of any failures. Comparative ≥2× complete-backup throughput, single-core/small-volume behavior and native VM portability are additional gates; the existing synthetic 2.36× volume-pipeline benchmark does not substitute for them.

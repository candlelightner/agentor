# Incus VM implementation status

Agentor supports ordinary workers and trusted platform/group administrative
workspaces as Incus VMs. The orchestrator and Traefik remain Docker services.
This document describes product support and validation scope; deployment
inventories, local diagnostic logs and recovery receipts belong in private
operator storage.

## Implemented

- Explicit legacy Docker migration with persistent native workspace, agent/editor
  and Docker volumes. Successful migration retains the original source until
  deliberate finalization; unsupported or ambiguous operations fail closed.
- VM create/start/stop/rebuild/archive/unarchive, runtime-aware terminals,
  editor/desktop proxies, files, plugins, metrics and logs.
- Managed storage/network and authorized host-mount integration, approved OCI
  conversion, custom images and verified native default-image promotion.
- Dedicated administrative VMs with private management networking, short-lived
  scoped MCP credentials and identity refresh that preserves healthy terminals.
- Authorized serial USB and supported Intel mediated GPU grants, ownership and
  revocation checks, and rejection of host-storage passthrough.
- Portable and whole-instance backup/restore support, bounded diagnostics and
  server-log downloads, and per-archive indexed pathname verification.

See the [rollout guide](incus-rollout.md), [hardware permissions](hardware-devices.md),
[administrative networking](incus-admin-private-networks.md),
[instance recovery](instance-disaster-recovery.md) and
[native update behavior](production.md#native-worker-image-updates).

## Validation and remaining acceptance

The merged VM implementation passed application typecheck, module tests,
isolated Docker API/UI regression and worker/orchestrator OCI builds for amd64
and arm64. CI results are available in [GitHub Actions](https://github.com/candlelightner/agentor/actions).
An arm64 OCI build does not establish arm64 VM support; the tested VM host target
is Ubuntu 24.04 amd64 with KVM.

Live VM lifecycle, persistent storage, routing, migration and supported Intel
mediated GPU workload checks have been exercised. These results do not imply
that every hardware mode or recovery failure combination is verified.

Keep the following acceptance work explicit:

- Real CLI/browser copy and terminal behavior: issues #7, #14 and #15.
- Representative end-to-end backup throughput and resource use: issue #10.
- Physical USB attach/detach/revocation and remaining hardware criteria: issue #12.
- Native administrative encrypted disaster recovery and compound updater/recovery
  scenarios: issue #13.
- Administrative loading/lifecycle feedback under delayed requests: issue #18.

A skipped live gate is not acceptance. Use disposable fixtures and keep their
identifiers, credentials, raw logs and receipts private. Record only sanitized,
reproducible results in the repository.

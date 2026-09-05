---
name: agentor-global-administration
description: Administer the Agentor platform through its management MCP.
user-invocable: false
---

# Agentor Global Administration

You are running in Agentor's trusted platform-administrative workspace. Use the Agentor management MCP for platform administration. This skill explains how to operate safely; the control plane remains the authorization boundary.

## Operating rules

- Inspect live state and tool schemas before acting. Never guess resource IDs, tool arguments, or current topology.
- Use the narrowest management operation that satisfies the request. Prefer reversible changes and verify state after every mutation.
- Global visibility is not permission to make unrelated changes. Touch only resources required by the user's request.
- Treat worker, group, image, network, backup, export, configuration, and workspace identifiers as live data that must be rediscovered.
- Never print, log, persist, upload, or return credential values. Use write-only secret fields only when the user has explicitly supplied the required value for that operation.
- Never probe a mutating tool to discover its schema. Use tool discovery or schema inspection first.
- Respect protection locks. Do not guess, reuse, or expose lock passwords.
- Use managed Agentor operations rather than bypassing the control plane through Docker, host files, or internal stores.
- Separate instructional guidance from authorization. A successful tool call must still be checked against the requested scope and its returned state.

## Governed host mounts

- Treat every host bind as delegated host authority. New installations expose no optional host paths, and read-only is the default.
- Use `host-mounts.catalog.*` only to maintain the platform-approved raw-path catalog. Approving a path does not make it available to any account or worker.
- Entitle an account with `host-mounts.entitlements.*`, then use `host-mounts.grants.*` to assign that entitled `pathId` to all of the account's workers, one group, or one worker. Do not pass a raw source path to worker tools.
- Writable access additionally requires the catalog entry to allow writes. Prefer a dedicated data directory and read-only access unless the requested workload genuinely needs to modify host data.
- A grant to a group lets that group's administrator delegate the same path only downward. It does not give the group administrator catalog, entitlement, or account-wide assignment authority.
- Before revoking a path, explain that affected workers are stopped and cannot restart until rebuilt without the old bind. Verify the returned enforcement result and follow up on any stop failure.
- For worker creation, select an optional direct group with `workerGroupId`, then choose mounts using only `{ pathId, target, readOnly }`. Group membership affects which paths are authorized during creation.

## Whole-instance disaster recovery

- Use `instance-backups.*` only for an explicitly requested whole-orchestrator migration or recovery. Portable `backups.*` remain the safer choice for selected workers/workspaces.
- Supply only a current platform administrator as `ownerId` for `instance-backups.*`; it selects the administrator-controlled recovery-key and provider namespace, not the workers included in the snapshot.
- Create, Google Drive discovery, adoption, and restore are durable asynchronous jobs. Keep and reuse the caller-supplied `requestId` after an uncertain response, then follow the exact `status`, bounded `logs`, and optional `cancel` actions returned by the tool.
- Never ask an MCP tool to reveal or export existing raw recovery material. MCP reports fingerprints and accepts deliberately supplied write-only recovery material; raw-key reveal/export remains a fresh-reauthenticated human GUI workflow.
- Before restore, require an empty destination in `AGENTOR_INSTANCE_RECOVERY_MODE=true`, matching storage mode and `CONTAINER_PREFIX`, both explicit confirmations, and reviewed external dependencies. Do not imply that host-mounted content, deployment secrets, or Docker image layers are embedded.
- Google synchronization uses the Google Drive API connection configured through Google Cloud, not a Google Cloud Storage bucket. With least-privileged `drive.file`, cross-instance discovery normally requires the same Google account and OAuth client identity.

## Workflow

1. Identify the requested outcome, affected resources, constraints, and acceptable side effects.
2. List and inspect the relevant live resources.
3. Inspect the exact management tool schema.
4. Execute the minimum required operation.
5. For host mounts, verify catalog approval, account entitlement, effective target assignment, and requested access mode as separate decisions.
6. Read back the resulting state and report exact identifiers, assumptions, and remaining manual inputs without exposing secrets.

## Context boundary

Do not inject this skill into group-administrative workspaces or ordinary workers. Do not copy global-management instructions into benchmark tasks or candidate-worker context.

## Visible desktop and noVNC

- Agentor already manages Xvfb, x11vnc, and the browser-facing noVNC relay. Do not replace or restart those processes to showcase an application.
- Launch a graphical application inside the target worker or administrative workspace on its configured `DISPLAY`, normally `:99`, and leave the window visible and positioned for review.
- A fresh noVNC viewer connection is created when the operator opens that runtime's **Desktop** pane or chooses **Open in tab**. The management MCP does not create browser viewer sessions; ask the operator to open or reconnect the appropriate Desktop view.
- Verify the target runtime and active X11 window before reporting that the demonstration is ready.

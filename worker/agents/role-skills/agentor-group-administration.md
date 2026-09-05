---
name: agentor-group-administration
description: Administer one authorized Agentor group and its subtree.
user-invocable: false
---

# Agentor Group Administration

You are running in a trusted administrative workspace bound to one Agentor worker group. Use the Agentor management MCP only within the live group and descendant scope exposed to this workspace. This skill explains safe operation; server-side identity and authorization remain the security boundary.

## Scope rules

- Begin with live group and worker discovery. Never guess the bound group, descendant groups, worker IDs, image IDs, network IDs, or job handles.
- Operate only on the bound group and its authorized descendants. Do not attempt to discover, inspect, or affect resources outside that subtree.
- Tool discovery may already be filtered, but that does not remove your duty to keep every requested target inside the intended group scope.
- Use the narrowest management operation that satisfies the request. Prefer reversible changes and verify state after every mutation.
- Never print, log, persist, upload, or return credential values. Group environment operations should expose names and status only; secret values remain write-only.
- Never invoke a mutating tool to discover its schema. Inspect the schema first.
- Respect worker protection locks and lifecycle state. Do not stop, rebuild, archive, delete, reassign, or unlock a worker unless the request requires it.
- Use managed Agentor operations rather than Docker, host files, or internal stores.
- Group skills improve tool use; they do not grant authority and must never replace server-side subtree checks.
- Whole-instance disaster-recovery tools are deliberately unavailable to group administrative workspaces. Tell the user that only the platform administrator can create, discover, adopt, or restore an orchestrator snapshot; do not try to approximate it through Docker or internal stores.

## Governed host mounts

- You cannot approve raw host paths, entitle an account, or create account-wide host-mount assignments. If a required path is unavailable, tell the user that the account owner or platform administrator must grant it to this administrative group first.
- Begin with `host-mounts.delegations.list`. Its `availablePaths` are usable when creating or updating workers in scope; only `delegablePaths` have an explicit grant to the bound administrative group and may be passed further. Neither list exposes raw host paths.
- Use `host-mounts.delegations.create` only to pass a `delegablePaths` identity to a descendant group or a worker whose direct group is inside the authorized subtree. Never attempt sibling, ancestor, cross-account, or ungrouped targets.
- Use `host-mounts.delegations.delete` only for delegations created by this administrative group. Revocation can stop affected workers and require a rebuild before restart, so confirm that lifecycle impact is intended.
- Worker create/update mount inputs use only `{ pathId, target, readOnly }`; raw `source` is not accepted. Read-only is the default, and read-write works only when the platform catalog explicitly permits it.
- A group-scoped `workers.create` derives the owner from the workspace identity. Select only a permitted target descendant through the discovered group-scoped schema; do not supply `userId`, `ownerId`, `groupId`, or platform `workerGroupId` overrides.

## Workflow

1. Confirm the requested outcome and the bound group/subtree.
2. List and inspect the relevant groups, workers, or group-owned resources.
3. Inspect the exact management tool schema.
4. Execute the minimum scoped operation.
5. For a host mount, verify that the path is available to the bound group and that the target remains in the live descendant subtree immediately before mutation.
6. Read back the resulting state and report exact identifiers, assumptions, and remaining manual inputs without exposing secrets.

## Context boundary

Do not inject this skill into the global administrative workspace or ordinary workers. Do not place management-plane procedures in candidate-worker context.

## Visible desktop and noVNC

- Agentor already manages Xvfb, x11vnc, and the browser-facing noVNC relay. Do not replace or restart those processes to showcase an application.
- Launch a graphical application inside an authorized worker or this administrative workspace on its configured `DISPLAY`, normally `:99`, and leave the window visible and positioned for review.
- A fresh noVNC viewer connection is created when the operator opens that runtime's **Desktop** pane or chooses **Open in tab**. The management MCP does not create browser viewer sessions; ask the operator to open or reconnect the appropriate Desktop view.
- Confirm that the target belongs to the bound group subtree and verify its active X11 window before reporting that the demonstration is ready.

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

## Workflow

1. Identify the requested outcome, affected resources, constraints, and acceptable side effects.
2. List and inspect the relevant live resources.
3. Inspect the exact management tool schema.
4. Execute the minimum required operation.
5. Read back the resulting state and report exact identifiers, assumptions, and remaining manual inputs without exposing secrets.

## Context boundary

Do not inject this skill into group-administrative workspaces or ordinary workers. Do not copy global-management instructions into benchmark tasks or candidate-worker context.

## Visible desktop and noVNC

- Agentor already manages Xvfb, x11vnc, and the browser-facing noVNC relay. Do not replace or restart those processes to showcase an application.
- Launch a graphical application inside the target worker or administrative workspace on its configured `DISPLAY`, normally `:99`, and leave the window visible and positioned for review.
- A fresh noVNC viewer connection is created when the operator opens that runtime's **Desktop** pane or chooses **Open in tab**. The management MCP does not create browser viewer sessions; ask the operator to open or reconnect the appropriate Desktop view.
- Verify the target runtime and active X11 window before reporting that the demonstration is ready.

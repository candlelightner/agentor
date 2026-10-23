# Pane discovery during worker lifecycle changes

`GET /api/containers/:id/panes` requires the same authenticated ownership checks
as before. It executes guest commands only for confirmed running compute without
an unsettled lifecycle operation.

A confirmed stopped worker returns HTTP 409. Unknown/unresponsive or changing
compute returns HTTP 503. Both include `data.code: WORKER_PANES_UNAVAILABLE` and
the observed `data.status`; desired stopped intent alone is not proof of a stop.
Missing workers return 404. An expected lifecycle rejection never changes stopped
state into unknown, and delayed probes cannot overwrite newer lifecycle state.

The GUI uses the shared worker inventory to suspend discovery when compute is
not confirmed running. Failed discovery backs off from six seconds to at most
48 seconds, without overlapping periodic requests. A verified transition back
to running resumes discovery immediately. Closing a pane cancels its polling,
including after a late response.

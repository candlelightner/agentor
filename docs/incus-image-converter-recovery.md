# Recover a failed native image converter

`POST /api/image-builds/<build-id>/recover-converter` with `{}` lets the build owner or a platform administrator clean up the exact disposable converter acknowledged by a failed or cancelled native image build. Authentication and the existing build-owner check apply; no instance name, image, volume, path or force option is accepted.

Recovery validates the recorded source/context, current installation and project, captured VM UUID, fixed converter configuration, profiles and exact root/network devices. It saves each stop/delete intent and accepted operation through the existing catalog mutation chain, then verifies native absence before acknowledging removal. A settled receipt whose exact instance name already has a typed Incus 404 can also be marked removed; a transport error or unknown pending operation cannot. Concurrent work for that immutable native key is refused.

Only this converter VM and its disposable root can be deleted. Source Docker images, imported Incus images, canonical/custom worker volumes, local conversion scratch, backups and catalog history are retained. A job with pending native work, missing UUID, changed ownership/layout, or any image-import receipt remains blocked for separate explicit recovery. Cleanup does not retry conversion, publish an image, or change source permissions; the authorized caller can retry the original operation after cleanup succeeds.

Mock tests cover stopped/running cleanup, acknowledgement failure and restart persistence, unknown-operation refusal, foreign-device/configuration rejection, typed absence, concurrent recovery, owner/admin authorization, and the actual route's strict request body. Real Incus cleanup acceptance must be performed separately by the deployment operator; no live resource was touched while implementing this change.

## Observe native image preparation

Image Catalog and the existing owner-scoped `GET /api/image-builds/<build-id>`
return the same durable native conversion job. MCP `images.build-status` returns
these fields through its existing authorized build-status flow; use its returned
`images.build-logs` action for bounded incremental logs.

`nativeActivity` contains `progressMode: "indeterminate"`, a fixed parent-observed
`phase`, and `phaseStartedAt`. Optional `waitingAt` records a controller heartbeat,
at most once every 15 seconds during execution. It means the controller is still
waiting; it does not measure guest activity or completed work. Native jobs omit
`progress`, including legacy terminal 0/100 markers. No byte count, percentage or
completion estimate is inferred from source-image size or guest output.

Stages cover converter creation/start/readiness, tools/bootstrap preparation,
source transfer, disk conversion/reception, converter removal, trusted image
normalization, metadata, import and publication. The catalog shows overall and
current-stage elapsed time while running. Terminal elapsed uses recorded
`completedAt`; after restart, interrupted jobs remain failed with their last
observed stage and exact recovery acknowledgements. Reopening the catalog reads
the existing job. Image preparation success does not imply worker startup.

Stage entries, bounded waiting messages, readiness diagnostics and terminal
outcomes also go to the official orchestrator log with job ID, phase and elapsed
milliseconds. Only fixed parent messages are emitted there; guest output and
private converter/import authority remain outside that telemetry. Telemetry
write failures log a bounded reason and continue with the previous visible state;
they cannot publish an image, change job permissions or replace cleanup fences.

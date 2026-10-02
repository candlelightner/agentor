# Whole-instance snapshot writer drain

Status: incomplete. Reviewed writer/capture checkpoint25a548f is committed on
the draft branch; further native transport/durable reconciliation work is pending.
The instance-backup barrier now drains registered operations, but registration
is not yet complete and does not prove an atomic control-plane snapshot.
This is separate from the reviewed worker-store quarantine/inventory guards.

## Native and durable-operation work, 2026-10-02

The new command transport owns actual setup/start/inspect requests, response
bodies, upgraded/native200 streams and write callbacks on the same fixed local
daemon. Independent review reproduced premature destruction of buffered output;
the corrected source passes48 focused tests, including delayed consumption.
DockerService capture now uses this transport for setup/start/inspect, with no
Dockerode fallback.81 combined transport/capture tests pass with narrow
independent integration approval. Capture waits actual bridge closure and stdin
callbacks; successful setup/inspect native tails retain separate coordinator
leases. Client transport closure is not proof that a command or daemon mutation
has stopped, and cancellation does not clear mutation uncertainty.

An isolated external-operation journal persists secret-free typed intent before
dispatch, exact identity additions and receipt-bound terminal tombstones. Every
nonterminal record vetoes readiness across clean reopen. Corruption, lost storage,
uncertain persistence or an unclean lock requires offline reconciliation, never
PID/TTL/404 clearing. Independent review reproduced shutdown releasing its lock
before sync/descriptor closure; release now occurs only as the final operation
after both succeed. No post-unlock fsync is attempted. A crash-resurrected lock
is a conservative hold.33 focused tests and narrow independent core review pass;
these are local POSIX fault fixtures, not physical power-cut acceptance.

Neither application startup/dispatch nor backup authority stripping consumes
this journal yet. Trusted operation-specific receipt checkers and bounded
tombstone retirement remain required;256 retained entries currently fail closed.
No blanket restart-safe application reconciliation or full snapshot acceptance
is claimed.

The next wiring must open protected operator-provisioned control storage before
startup helper cleanup or background dispatch, outside included/restored data
and volume domains. Installed identity plus live daemon/storage generation must
be checked, not inferred from a socket pathname or Docker's stable daemon ID.
Durable intent precedes external dispatch; returned full native identities are
bound durably before start/next dispatch. Only server-owned operation-specific
receipts may prove descendant/cleanup completion or explicit background-service
handoff. Initialized-only snapshot/restore readiness must retain every existing
veto; the excluded job cannot give ordinary operations a bypass. Source control
authority must never initialize destination state on restore. Terminal retirement
needs serialized, bounded persistence and exact-reference reconciliation, never
time-based deletion or removal of uncertain records.

The frozen integration passed1,567 offline module tests, full typecheck and
production build. Logs: `/workspace/kata-snapshot-integration-modules-11.log`,
`/workspace/kata-snapshot-integration-typecheck-21.log` and
`/workspace/kata-snapshot-integration-build-8.log`. Existing duplicate-import,
listener and BigInt-target warnings remain visible. These are not live Docker,
whole-instance, capacity, DinD or deployment acceptance.
No deployment, service installation or unrelated workload shutdown is approved.

## Storage/config and initialized inventory continuation, 2026-10-02

StorageManager now admits initialization and direct directory, credential, SSH,
Kilo and removal writers before I/O, retaining exposed caught-error settlements.
Initialization coalesces concurrent calls but still reinspects on subsequent
calls; failed inspection preserves the legacy fallback without publishing
snapshot readiness. Snapshot inventory and restore preflight use its nonwriting
readiness assertion instead of writing lazy initialization. Author storage and
credential checks passed40 tests and typecheck; independent storage/inventory
checks passed78 tests. This is narrow offline evidence, not hidden native Docker
request settlement or restart-safe reconciliation.

Managed-volume startup now loads ordinary, retained, policy and recreation
inventory even in recovery mode, without starting recovery. Excluded inventory
requires prior initialization and rejects quarantined partitions rather than
silently omitting them. The first root integration run had36 passes/1 failure
because a corruption fixture used the wrong policy filename; the corrected run
passed37. Independent review found that generic owner-store swallowed ENOENT
could publish readiness before an exposed read settlement. Both missing-store
and missing-owner catches now await that outcome-neutral lifetime. Six new
frozen-error/late-settlement/quarantine regressions pass. Final independent
84-test run approved the narrow storage/inventory delta; the discarded global
filesystem-patch harness was stopped after stalling and is not passing evidence.

Installation identity, Google OAuth configuration and the legacy v1 key writer
now have logical admission envelopes. Swallowed reads/exclusive-create failures
retain their lifetimes; sanitized identity failures preserve linkage and OAuth
queue recovery waits late failed writes. Existing material-based staging decrypt
remains outside this admission, and v1 envelopes remain compatible. Independent
review approved this narrow delta after54 offline tests. Installation-ID lookup
in runCreate is after barrier release; no readonly exception was added for it.

Root reviewed and verified Docker execCapture stream/callback lifetime changes.
The23-test author checkpoint was followed by four real-local-Unix HTTP fallback
cancellation/premature-closure regressions. Captures are explicitly failed on
abort/native early close; actual component closure and held stdin callbacks stay
owned. Final27-test author run/typecheck pass; root119-test combined integration
also passes. An absent/invalid exit status or Running=true cannot become success.
Native setup/start/inspect failure ownership and durable unknown-command
reconciliation remain separate unfinished boundaries, with new disjoint tasks
in progress. This approval is only for the reviewed capture lifetime delta.

Logs: `/workspace/kata-storage-drain-tests.log`,
`/workspace/kata-storage-independent-review.log`,
`/workspace/kata-managed-inventory-integration-1.log`,
`/workspace/kata-managed-inventory-integration-2.log`, and
`/workspace/kata-backup-config-independent-review.log`,
`/workspace/kata-storage-independent-review-4.log`, and
`/workspace/kata-storage-config-capture-integration.log`.
Full writer/capture integration passed1453 offline tests, typecheck and build:
`/workspace/kata-snapshot-integration-modules-10.log`,
`/workspace/kata-snapshot-integration-typecheck-19.log`, and
`/workspace/kata-snapshot-integration-build-7.log`. These precede acceptance of
the new Linux reader, command transport and durable journal tasks. Existing
duplicate-import/listener and BigInt-target build warnings remain visible.
No full snapshot, capacity, DinD or deployment acceptance is claimed.

## Integration review update, 2026-10-02

BackupManager and BackupStore now enroll initialization, ordinary roots, queue
dispatch, startup sibling cleanup and provider deadline lifetimes. Restore
prepares manager/keyring dependencies before its barrier and uses an existing-
key-only lookup afterward. Independent review approved the narrow manager/store
delta. Recovery reads now bound regular-file reads, reject FIFOs/symlinks, retain
both read/close failure settlements without mutating immutable deadline errors,
and defer missing-keyring readiness until failed-open settlement.38 independent
recovery/deadline tests and4 envelope tests pass. This is not complete backup
or snapshot acceptance; direct installation/provider/config writers still need
coverage.

Terminal admission, captured identity and input/resize work were added. Follow-up
review reproduced premature retirement on attach timeout; the corrected handler
now owns actual late attach results separately from bounded notification and
waits for actual stream closure plus exact-session cleanup.17 terminal regressions
pass in root's combined50-test run. Missing session identity retains process
uncertainty. Native execCapture still needs complete request/stream ownership and
must reject an absent exit code; restart-safe terminal uncertainty is unfinished.

Delayed update dispatch now preregisters its lease and checks swapper exit status.
Follow-up review proved caught pull errors lost their settlement, prune failures
reported idle early, and direct pulls bypassed admission. These have explicit
settlement retention/busy accounting and public admission fixes; uncertain leftover
deletion now stops replacement creation. The update path is still incomplete:
late pull streams, native mutation receipts, helper identity and durable
reconciliation need implementation. The code has only been exercised with
synthetic Docker boundaries; no update was executed.

Earlier verification counts below describe earlier increments. Full integration
after this review passed1363 offline tests, full typecheck and production build.
Logs: `/workspace/kata-snapshot-integration-modules-9.log`,
`/workspace/kata-snapshot-integration-typecheck-18.log`, and
`/workspace/kata-snapshot-integration-build-6.log`. These checks include the key,
terminal and update follow-up regressions. The snapshot consistency gate remains
open because writer/transport/reconciliation coverage is still incomplete.

## Verified gap and core work

The previous `instance-snapshot-gate.ts` had no operation-lifetime accounting.
An operation admitted before `beginInstanceSnapshot` can resume an awaited write
after the database/filesystem snapshot starts. Duplicate same-job acquisitions
also return release callbacks that can clear another holder's barrier. The
outside-repository reproduction `/workspace/kata-snapshot-admission-gap-repro.mjs`
passed two tests documenting these weaknesses; they are not acceptance tests.

The new `instance-control-plane-coordinator.ts` now backs the application gate.
It registers writers synchronously, admits
nested work only through live process-local contexts, supports one-shot forks
for detached tasks, and retains deadline-failed operations until their actual
`operationSettlement`. Unique barrier handles close admission, wait for every
registered descendant, and reject stale release/drain. Drain cancellation or
timeout does not release outstanding operations. Seventeen focused core tests
pass. Independent review found that automatic settlement retention cannot cover
caught deadline errors or grant late continuations the right scope. The explicit
thunk-only `withInstanceOperationDeadline` adapter addresses those integration
cases with sixteen tests; callers still need conversion. Automatic retention
is conservative fallback accounting only. The context-dropping method and
core/manager integration have received narrow independent review. Neither tests nor an empty
operation count prove that all application writers have been enrolled.

Current implementation progress:

- The shared gate rejects duplicate job acquisitions and exposes drain/assert
  methods while retaining callable release compatibility. Admission predicates
  distinguish live descendants from unrelated roots; existing lifecycle/storage
  checks now use that predicate.
- Create closes/drains before authoritative preflight and checks the cut before
  database, data and volume snapshots. Restore drains before staging and checks
  again before helper launch. Excluded instance jobs drop inherited request
  admission; other queued instance jobs retain explicit leases. A draining job
  permits one already-admitted ordinary queued job to run alongside it, avoiding
  a single-slot scheduler self-deadlock. Narrow independent review includes
  twenty-one manager tests, timeout/cancel/post-drain workload veto and a real
  runRestore accepting-request/final-audit test ending at the missing-key boundary.
- MCP transport, direct service invocation, denial/final audits, queued state
  writes and returned streams are enrolled. Its fail-fast deadline wrappers
  retain the underlying thunk. Eleven new tests and existing regressions pass.
  New MCP roots, including audited cancellation, are rejected during a cut.
- Startup service initialization, worker reconciliation, admin identity refresh,
  usage queue and orphan sweep now have operation envelopes. Four focused
  background/context-dropping tests pass; broader background coverage is pending.
- A node-server HTTP adapter covers the complete real H3 listener,
  including handled errors, response hooks and dynamically assigned Nitro
  `waitUntil`. Eight real-local-HTTP tests pass, including disconnect and stream
  cases. Independent review found promise-form `waitUntil` retains only the
  count, not the original promise continuation's admission. The new thunk-only
  task helper addresses that case with a real late-write/cleanup test. The
  narrow initialized-only status/cancel dispatcher received independent review;
  its early Nitro plugin and direct auth-helper wiring also received narrow
  independent review. A production build includes the plugin before services,
  but predates subsequent integration changes and is not final acceptance.
- Read-only snapshot authentication verifies the configured signed session
  cookie and authoritative administrator/session rows without session refresh,
  deletion or lazy initialization. Twenty-three tests include a real pinned
  Better Auth cookie with SQLite query-only enabled. Exact active-job status
  and owner-only abort require this path; DELETE also requires a configured
  trusted Origin. Only the task records cancellation and owns cleanup. Health
  remains available without invoking ordinary application hooks.
- Workspace helper cleanup retains explicit lifetime through late
  create/start/remove settlement and stream finalization. Independent review
  found and verified fixes for ambiguous create+404 and caught putArchive
  timeout. Ambiguous creation or denied cleanup retain conservative process-local
  holds; an authoritative reconciliation interface is not yet implemented.
- Console attach/write/close/idle cleanup owns a child lifetime. Independent
  review caught an early stream-error/destruction race; the reviewed fix now
  waits for actual closed state before exact tmux cleanup receipt. Thirty-four
  focused tests passed. Unknown attachment/cleanup still holds indefinitely;
  neither this nor helper accounting proves restart-safe reconciliation.
- Export jobs now enroll queued dispatch, expiry, download descriptors and
  cleanup, including shutdown during initial persistence and late stream
  destruction. Fifteen focused regressions received independent approval;
  seven existing offline export tests also pass. Production bundle-producer,
  parallel gzip/filter and temporary-directory cleanup received separate narrow
  review with39 combined tests passing. A new native Docker archive/export
  transport separately owns actual request/socket/response closure, including
  late responses and cancellation. An effective-modem guard refuses endpoint
  mismatches before dialing;16 focused tests and independent review passed.
  Both backup consumers and the legacy download route now await producer
  cleanup plus actual destination closure. Independent review found and verified
  the fix for destination-error-before-destroy;12 tests pass, including real
  local H3/HTTP success/disconnect with synthetic auth/services. Full snapshot
  acceptance and authoritative residual-staging reconciliation remain open.
- UI polling uses exact known active-job status during the barrier, preserves
  acceptance identities and ignores stale view/action/preflight responses.
  Thirty-six offline tests passed in parent review; these execute composable
  and modal scripts, not a rendered browser workflow.
- The shared owner/worker lifecycle queue now acquires admission before queue
  insertion and generation changes. Four new drain tests pass; independent
  review passed107 relevant tests including sibling-worker timeout isolation.
  A fifth regression and39 focused tests independently verify that rejected
  late settlement no longer creates an unhandled queue-tail rejection.
- Worker durable-store transactions/reloads and initialization now acquire
  admission before queue insertion or private-draft mutation. Three focused
  tests cover barrier refusal, queued commits/tombstones and sibling-owner
  progress with retained uncertainty quarantine.90 related worker/snapshot/
  migration tests pass; the new store delta is independently approved.
- Generic owner, platform-plugin and Git catalog store queues are enrolled
  before insertion, with serialized reload and rejected-settlement retention.
  Twelve new tests and80 independent related checks pass. This does not replace
  whole logical-operation envelopes. Defaults/built-in and host-mount/hardware
  stores are now separately enrolled, including parallel init sibling settlement
  and catalog+grant deletion cascades.16 new tests and34 independent related
  checks pass; this increment received narrow independent review.
- Credential ensure/reset/removal now own storage setup, every parallel seed
  branch, Kilo legacy migration, ownership attempts and final logs/cache changes.
  Twelve new synthetic regressions and48 independent related tests pass; the
  admission delta is narrowly reviewed. Single-file credential binds and Kilo's
  shared directory semantics remain unchanged. This does not enroll direct
  StorageManager callers or supply a cross-worker credential transaction lock.
- Image-catalog initialization/mutations and build/validation/test-worker
  schedulers now register detached children before dispatch. Fake cancellation
  retains active steps and terminalization and cannot reschedule after terminal
  state. Independent review reproduced completion-over-cancellation and rejected
  writer-settlement races; both are fixed with six additional regressions.
  Root and independent44-test runs pass. Inventory now requires an initialized
  catalog without calling its writing init under the closed barrier; five new
  real-module tests cover ready, absent, failed and pending initialization.
  Hidden controlled Docker build/pull/validator/delete operations remain unfinished.

- Plugin runtime desired-state writes and worker/executor queues now acquire
  admission before work. Late returned streams and stdin callbacks remain owned;
  actual closure is checked rather than trusting close notifications. Valid
  background-command receipts settle without owning the background service;
  missing receipts retain process-local uncertainty.29 focused tests/typecheck
  pass, and this manager delta received narrow independent review. A new native
  setup/start transport now owns HTTP requests, late upgrades and body callbacks,
  including a native duplex for non-upgrade200 stdin.53 focused tests/typecheck
  pass with local Unix HTTP fixtures. Independent review found and verified a
  fix for array-valued exec IDs accepted through regex coercion; final43 focused
  tests and a separate delayed-stdin-callback proof pass. Transport delta is
  narrowly approved. Restart-safe runner uncertainty remains unimplemented.

The latest full module run passed1260 tests, including final plugin-ID,
image race/inventory and catalog-store regressions; it predates selection of the
12 credential tests. Root typecheck and the credential author's subsequent
typecheck passed. The production build including the credential increment
also passed. None of these checks establishes whole-instance acceptance.
These are offline regressions, not
whole-instance acceptance. The full snapshot consistency gate remains open.

Required lock order: admission, owner fence, worker fence, store queue. Never
await the global drain while holding an admitted operation or lower-level lock.
Detached work must reserve its child lifetime before its parent finishes;
AsyncLocalStorage inheritance alone cannot authorize delayed work. Streaming
and cleanup need explicit settlement, not HTTP response-close accounting.

## Integration still required

| Boundary | Required coverage |
| --- | --- |
| HTTP | Final frozen build and whole-app acceptance of installed adapter/non-writing exceptions. Nitro request hooks alone cannot enforce rejection. All ordinary HTTP is enrolled, including mutating GETs. |
| Authentication | Session lookups and barrier-safe read-only exceptions are reviewed narrowly; audit post-auth WebSocket actions and direct credential writes. |
| MCP | Current envelopes cover transport, audits and reviewed console cleanup. Finish authoritative/restart-safe uncertain-helper reconciliation. Stream end or bounded caller timeout does not settle hidden cleanup. |
| Lifecycle and stores | Worker/admin/group queues, worker durable snapshots, generic JSON and private catalog queues; retain late Docker settlement and pending-commit/quarantine vetoes. Store queues alone do not cover logical multi-store mutations. |
| Background tasks | Worker reconciliation, admin identity refresh, usage, orphan sweeping, export expiry cleanup, image/plugin work and startup reconciliation. Preserve existing active-job and unresolved-helper checks. |
| Detached work | Enroll queued backups/restores, export streams/helpers, provider/config/recovery-key writes and the delayed orchestrator-update task before their request releases. This is code integration, not authority to execute an update. |
| Direct filesystem writers | Credential seeding/migration/reset and other direct data-file writes outside generic stores. Optional append-only log prefix semantics do not establish a global log cut. |

BackupStore's independent owner queues/init and BackupManager's pending jobs,
schedule tick, lazy startup recovery and provider cleanup remain to be enrolled.
They do not inherit the generic JSON-store changes. Excluded preflight must
assert prior initialization rather than trigger it. Recovery-key reads also
need a separate nonwriting path: keyring/legacy lookup currently chmod files,
and worker-config decryption may create/chmod its key. Restore performs that
lookup after drain. Prepare dependencies before the barrier and use a narrowly
defined read-only lookup afterward; do not grant ordinary writers an exception.

`InstanceBackupManager.runCreate` must close admission, drain, rerun authoritative
workload/job/quarantine preflight, then snapshot auth, data and volumes. Recheck
barrier ownership at each boundary. Timeout or cancellation must fail before
snapshotting and preserve live-operation accounting.

Restore keeps its early barrier acquisition at acceptance, but drains in its
detached queued task before empty-installation preflight/staging/helper launch.
It must wait for the accepting request and its final MCP audit without waiting
on itself. Instance job ledger/staging/helper work needs a narrowly scoped
internal allowance, not a generalized bypass for included control-plane state.

Existing `instanceSnapshotActive()` admission checks must distinguish legitimate
admitted descendants from new roots. Closing the barrier must not interrupt a
logical transaction halfway through its included-state updates or cleanup.

The existing Better Auth `getSession({query:{disableRefresh:true}})` is not a
read-only status/cancel solution: the pinned library still deletes expired
sessions before checking that flag. The barrier-safe path needs independently
reviewed non-writing authentication, including revoked/banned/expired sessions,
and must not fall through ordinary auth middleware or mutating error hooks.

## Acceptance

Use real H3 adapters for success, handled error, disconnected/streamed response
and `waitUntil`; do not infer completion from a request counter. Pause a logical
mutation between two stores and prove the snapshot captures both final values.
Exercise gate closure before queued dispatch, late external completion after
caller timeout, descendant cleanup, stale contexts, mutating GETs, session
refresh, MCP read/denial audits, export expiry and reconciliation. Verify restore
acceptance and final audit do not self-deadlock. New workload activity or store
quarantine found after drain must still reject preflight.

This covers one authoritative orchestrator process per `DATA_DIR`. Stopped
workloads and exclusion of external writers remain mandatory. Full writer-path
integration and real backup/restore acceptance remain open.

## Next implementation seams (read-only audit, 2026-09-30)

- Image catalog: initialization/queues/fake scheduler are narrowly reviewed.
  Controlled build/pull/validator/deletion timeouts still hide late streams or
  helpers; complete native transport ownership and uncertain-artifact recovery.
- Plugins: manager and native setup/start transport are narrowly reviewed.
  Complete restart-safe unknown-runner reconciliation. Intentional background
  plugin startup is not an everlasting control-plane job.
- Stores: generic, worker, Git, Defaults and separate host/hardware catalog
  admission are reviewed narrowly. Audit remaining logical multi-store actions
  and direct credential/provider/recovery-key filesystem writers. Excluded
  snapshot/restore jobs must use genuinely nonwriting initialized-only reads,
  never lazy initialization or a general permission bypass.
- Terminal WebSockets: authentication alone does not cover detached tmux attach,
  cleanup, input callbacks or resize. Keep the captured container identity and
  require actual cleanup settlement rather than the existing swallowing API.
- Delayed updates: reserve before scheduling the timer and track the external
  replacement helper through termination or uncertainty; returning after helper
  start is not completion. This is a code task, not authority to run an update.
- Backup/export callers: producer cleanup outcomes and actual destination
  closure are integrated and narrowly reviewed; residual staging reconciliation
  and full backup/restore acceptance remain open.

`image-catalog-hierarchy.spec.ts` and new catalog/image drain regressions are
selected by the offline module configuration. Native plugin transport fixtures
exercise real local Unix HTTP, not real Docker or deployment acceptance.

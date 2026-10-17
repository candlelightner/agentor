# Whole-instance volume compression and staging

Docker volume capture now streams `getArchive('/source')` through the existing pathname/type/link/owner sanitizer and into level-6 gzip. It creates neither a raw TAR nor a second sanitized TAR. The existing bundle digest, nested archive validation, encryption and publication gates still run after capture. Native role archives keep their existing byte-preserving codec and staging path; this change does not repack native filesystem metadata.

`/usr/bin/pigz` is already installed in the runtime image. Streaming capture uses `-6 -c -p N`, with `N` capped at four and bounded by Node's available parallelism. If pigz is absent, Node's streaming level-6 gzip provides the same standard gzip contract. No shell is used. A failed/aborted source, parser, compressor or output tears down peer pipelines; child termination escalates from SIGTERM to SIGKILL after one second and is awaited before cleanup. Destinations are exclusive mode-0600 private staging files. Failure removes only the newly created partial, preserving pre-existing outputs.

The status API and whole-instance modal show the current Docker volume, its index/count, monotonically increasing uncompressed TAR input bytes and an average observed input rate after at least one second. Docker's archive response does not give a reliable recursive input size, so expected bytes, percentage and ETA are explicitly unknown. These counters are live telemetry, are separate from compressed/encrypted/provider byte counters, and do not become durable restore authority.

## Reproducible generated-data benchmark

Run `node tests/benchmarks/instance-backup-compression.mjs [volumeMiB=64] [volumes=3]` with orchestrator dependencies installed. It generates one mixed file-tree dataset, then runs the prior raw-TAR → sanitized-TAR → Node level-6 gzip pipeline and the new stream → sanitizer → pigz level-6 pipeline on the same source files, disk and host. Both timings include compressed-TAR validation and SHA-256 hashing. No installation data or Docker resources are accessed. Generated source files and completed outputs are excluded from transient scratch; the current partial gzip is reported separately/inclusively. Temporary files are removed afterward.

Observed 2026-10-17 on the preparation host, Node v22.23.3, eight available CPUs, pigz configured for four compression workers:

- Three volumes, each 4,096 files of 16 KiB (half fresh random bytes, half repeated bytes): 12,288 entries and 201,326,592 file bytes total.
- Total TAR input: 207,621,120 bytes; one volume TAR: 69,207,040 bytes.
- Source generation, encryption, provider upload/download, Docker transport, outer-bundle packing and whole-installation restore are outside these timings.

| Metric | Prior staged pipeline | Streamed parallel pipeline |
| --- | ---: | ---: |
| Total wall seconds | 6.841 | 2.902 |
| Aggregate TAR input MiB/s | 28.94 | 68.23 |
| Volume 1 seconds / MiB/s | 2.721 / 24.26 | 0.944 / 69.89 |
| Volume 2 seconds / MiB/s | 2.070 / 31.88 | 0.940 / 70.22 |
| Volume 3 seconds / MiB/s | 2.007 / 32.88 | 0.990 / 66.65 |
| Compressed volume 1 bytes | 33,924,160 | 33,942,621 |
| Compressed volume 2 bytes | 33,923,984 | 33,942,503 |
| Compressed volume 3 bytes | 33,923,971 | 33,942,637 |
| Total compressed bytes | 101,772,115 | 101,827,761 |
| Peak TAR scratch bytes | 138,414,080 | 0 |
| Peak transient bytes including current partial gzip | 172,338,240 | 33,942,637 |
| Estimated average busy CPU cores | 1.32 | 3.31 |
| Peak pigz thread count (compression plus I/O) | 0 | 6 |

This is a measured **2.36× volume-pipeline speedup**, with compressed size increasing about 0.055%. CPU estimates combine Node `process.cpuUsage()` with 10 ms sampling of this process's pigz children using Linux USER_HZ=100; final short-lived child ticks may be missed. Scratch is sampled, with explicit observations at stage boundaries. The benchmark is intentionally not a fixed-throughput CI assertion. Concurrent host load, page cache, small files, small volumes, single-core limits and I/O-bound sources can change the result. Overall backup throughput does not necessarily improve by 2.36× because the excluded stages remain.

## Validation and remaining acceptance

Automated tests exercise Node/pigz gzip compatibility; GNU tar extraction with exact file contents, permissions, modification times, hardlinks and symlinks; special-entry omission; malformed/truncated/traversal rejection; source and child errors; cancellation; a SIGTERM-ignoring child; exclusive-output preservation; helper cleanup; and a complete encrypted two-volume artifact round-trip through the real manager, fake provider, decryption, nested validation and tar extraction. Docker source/helper calls in that manager test are mocked. The actual production modal/composable browser tests run against mocked API responses in an isolated fixture.

A real Dockerized API/UI whole-instance backup and empty-destination restore remains an acceptance gap. No production backup, volume, key, VM or container was changed. Small-volume/single-core and I/O-bound representative benchmarks also remain unmeasured. The synthetic pipeline result does not establish the issue's ≥2× full-backup performance criterion or close all issue #10 acceptance criteria.

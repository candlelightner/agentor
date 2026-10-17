# Whole-instance archive verification benchmark

Run `node tests/benchmarks/instance-backup-verification.mjs [entries=24000] [fileBytes=4096]` from the repository root with orchestrator dependencies installed. It builds the current validator and a copy with the prior quadratic `assertTreeEntry` body, then verifies the exact same generated gzip archive with both. No production archive, installation data, or Docker resource is read. Scratch is removed on success or failure.

Observed on the preparation host, 2026-10-17 (Node v22.23.3):

| Metric | Prior scan | Parent index |
| --- | ---: | ---: |
| Entries | 24,000 | 24,000 |
| File bytes | 98,304,000 | 98,304,000 |
| Expanded TAR bytes | 110,593,024 | 110,593,024 |
| Compressed bytes | 947,686 | 947,686 |
| Validation seconds | 6.756 | 0.411 |
| Expanded MiB/s | 15.61 | 256.93 |
| User CPU seconds | 6.999 | 0.622 |
| System CPU seconds | 0.143 | 0.042 |

The measured validator speedup is 16.46×. Generation/compression, outer-bundle extraction, encryption and restore are outside these timings. Each file reuses one randomly generated 4 KiB body, making the archive file-heavy and highly compressible; this is a pathname-validation regression dataset, not representative application backup compression evidence. Warm page cache and other concurrent host load can affect results. The earlier ~80 MiB/s production observation is not a universal target; this synthetic archive exceeds that order of throughput but does not prove production end-to-end performance.

Ordinary CI tests verify 24,000 entries without a fixed throughput requirement, along with independent archive indexes, implicit/late directories, duplicates, forbidden paths and conflicts in both orders. Real Dockerized API/UI restore acceptance remains a separate gate.

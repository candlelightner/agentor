# Agentor production upgrade maintenance

This local repository records operational code used for the October 17 upgrade.
Credentials, inventories, logs, recovery material and generated receipts are
excluded from version control.

The accepted Agentor source is a separate repository at `source-4f157103`, based
on `4f157103fc42b0c4be341df134a084a9c69c7498`. Its one-line Docker context fix
is committed as `9dc1df2`; the prepared image contains that same source content.

`monitor-backup.py` reads the live job and process. Its `--require-complete` flag
fails until the job succeeded, the encrypted artifact is recorded as verified,
the regular artifact file matches its recorded size, and staging cleanup ended.

`prepare-incus-storage.py` is a one-time, root-only storage preparation step. It
requires the completed-backup gate and the exact existing SSD UUID. It refuses
existing Incus state, saves fstab, adds mount dependencies, and preserves recovery
material separately. It has not been run merely by committing this code.

`maintenance/backup-verifier` contains the original production validator, an
equivalent parent-index replacement, isolated equivalence/performance tests, a
module-binding replacement test, and the guarded inspector client used for the
live repair. The replacement was applied only in process memory, without a
restart or removal of integrity checks. The inspector listener was closed after
the repair. Neither the production image nor the prepared VM image was changed.

The equivalence test passed 52,274 comparisons and a million-entry workload. The
inspector test proved continued validation with the same process ID. These are
operational regression checks, not a claim that the whole migration is complete.

`restore-worker-home.py` runs as the unprivileged agent inside a migrated guest.
Its private manifest and individually hashed Docker home archives live in the
canonical agent-data volume under `.incus-migration-home`. It preserves selected
home settings and locally installed CLIs, reconciles newer Claude preferences,
and installs the audited additional APT packages. Existing guest defaults are
renamed before linking preserved paths. The original worker init script follows
this setup step without being committed here. Source Docker containers and SSD
copies of the archives remain available for recovery. Archive path and symlink
validation is covered by `python3 -m unittest test_restore_worker_home.py`.

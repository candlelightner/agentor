# VM resource metrics

VM RAM is sampled from the guest kernel through the Incus agent. It follows
htop's default numeric memory meter, rather than Incus's `memory.usage` counter,
which includes guest cache:

```text
used KiB = MemTotal - MemFree - Buffers - Cached - SReclaimable + Shmem
           - reclaimable guest ZFS ARC
```

Shared memory counts as used. Buffers, filesystem cache and reclaimable slab
do not. If concurrently sampled free/cache counters add up beyond MemTotal,
htop falls back to `MemTotal - MemFree + Shmem` before the ARC adjustment.
Guest ZFS ARC contributes `max(0, size/1024 - c_min/1024)` KiB, with each
division truncated as in htop. ZFS backing storage outside the guest does not
affect this calculation. Missing ARC counters mean no guest ZFS adjustment;
present but unreadable or invalid counters make the sample unavailable.

The REST API and MCP expose raw bytes: `memoryUsedBytes` is the above value
multiplied by 1024, `memoryLimitBytes` is guest `MemTotal` multiplied by 1024,
and `memoryUtilization` is their ratio as a percentage. `memoryAccounting:
"guest-htop"` identifies these semantics. The GUI uses KiB/MiB/GiB for VM RAM.
Docker memory accounting and its display remain unchanged.

Guest MemTotal can be lower than configured RAM because the guest kernel
reserves memory. Configured allocation remains a VM setting. These metrics do
not include host-side QEMU, device, or other virtualization overhead. htop
sampling intervals and rounded display values can produce small differences.

Sampling needs a responsive Incus agent and guest Python, but does not require
worker provisioning files or a healthy worker service. Each attempt has a
five-second deadline, bounded output and ownership/incarnation checks. Bad or
missing counters are never replaced with allocated RAM or a fresh zero.

`lastChecked` records the sample time and is null before any sample exists.
Unavailable samples carry an error; stale samples retain their original values
and timestamp with `status: "unknown"` and an error after 30 seconds. Treat
those numeric values as historical or placeholders. The GUI displays
**Metrics unavailable**, including during failed frontend polling. Reading a
snapshot does not extend its freshness. A fresh sample restores normal display.

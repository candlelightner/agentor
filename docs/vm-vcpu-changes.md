# Change an existing VM's vCPU count

The **Virtual CPU cores** editor is available in ordinary VM settings and in
platform/group administrative VM management. It shows the assigned count from
the owned VM definition and the maximum reported by the Incus backend.

1. Stop the VM, then select **Refresh vCPU count**.
2. Enter a positive integer within the backend maximum and select **Save vCPU
   count**. Protected workers require their current lock password.
3. Start the VM normally. The new count is visible inside the guest after boot.

The update changes the stopped VM definition in place and retains its storage.
It does not require an image rebuild. Running VMs reject changes with guidance
to stop first; automatic shutdown and live CPU hotplug are not used.

An ordinary worker saves a per-VM `vcpuCount` override. It takes precedence over
its environment and applied bootstrap CPU defaults through restart, rebuild,
archive/unarchive and portable export/import. Administrative VMs persist the
desired and applied count together; older administrative records default to two.

Every update checks ownership, instance UUID, the unchanged remaining definition,
backend capacity, unsettled native operations and the latest Incus ETag. A
durable intent is recorded before submission. The assigned value is confirmed
by readback before the saved setting is published.

If a request loses its confirmed outcome, the VM remains protected from
conflicting lifecycle actions. Refresh the editor and use **Reconcile pending
CPU change** for that recorded target. Reconciliation observes the original
operation and exact VM identity; it never resubmits the resize. A confirmed
rejection preserves the previous count. Missing operation acknowledgement or
changed identity requires operator recovery; preserve the VM and its storage.
Rebuild is not a CPU-operation recovery action.

Administrative VM changes also require an installed host policy that advertises
CPU-count update support. Older policy installations reject the update before
changing compute. Follow the bounded policy update procedure in
[administrative networking](incus-admin-private-networks.md).

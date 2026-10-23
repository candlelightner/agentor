# Change an existing VM's vCPU count

The **Virtual CPU cores** editor is available in ordinary VM settings and in
platform/group administrative VM management. It shows the assigned count from
the owned VM definition and the maximum allowed by the Incus backend and inherited group policy.

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

## Group ceilings and delegation

Groups have an optional **Maximum vCPUs per worker** setting. It limits each VM
independently; there is no cumulative group CPU pool. The effective ceiling is
the lowest configured value in the group's ancestry, including the group itself.
A blank setting inherits. A new explicit child ceiling cannot exceed its effective
parent ceiling. The effective maximum shown by the CPU editor also respects the
backend's CPU capacity.

Global administrators can configure root and child ceilings. Group administrators
can configure only descendant groups, within the effective parent ceiling; they
cannot raise or clear the ceiling of their own administrative group. No delegated
resize is allowed until an inherited ceiling has been configured. Ordinary owner
REST access remains subject to applicable group ceilings. Platform administrative
VMs remain restricted to global administration.

Ceilings apply to ordinary and group administrative VM allocation, including new
VM definitions and replacement/import paths. Existing VM allocations remain
visible and are not automatically shrunk or stopped after a ceiling is lowered.
Their next new allocation must fit. Reading or reconciling an already submitted
CPU operation does not submit another allocation and remains available.

Moving a capped worker to an uncapped or more permissive group is rejected;
a global administrator must first adjust the source ceiling. Group administrators
cannot reparent groups to escape an inherited ceiling. The server enforces these
checks for GUI, REST and management MCP callers.

vCPU counts describe guest CPUs, not reserved host CPU time. A per-worker ceiling
does not prevent aggregate host CPU contention when many workers run together.

## Management MCP

Use `workers.cpu.get`, `workers.cpu.set`, and `workers.cpu.reconcile` for ordinary
workers (`workerId`). Use `admin-workspace.cpu.get/set/reconcile` for the calling
administrative workspace, and `groups.admin-workspace.cpu.get/set/reconcile`
with `groupId` for a group administrative workspace. Group identities can target
only their bound group and live descendants. Global identities can administer
all applicable targets.

Set requests take a positive integer `vcpuCount` and, when required, `lockPassword`.
Stop the VM explicitly first, inspect its CPU settings, set the count, start it,
and inspect again. A caller timeout does not cancel the backend operation.
Inspect pending state and use the explicit reconciliation tool; it can observe
only the recorded operation and cannot create a new resize. Group ceilings can
be configured through `groups.create` and `groups.update` using `maxVcpuCount`
(a positive integer or null to inherit), subject to the delegation rules above.

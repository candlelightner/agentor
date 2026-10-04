"""Disposable guest capability probe only; not a production volume helper.

The independent watchdog is started before freezing. It restores only states
changed by this probe, even if its controller is killed or the caller vanishes.
"""
import os
import pathlib
import sys
import time

root = pathlib.Path('/sys/fs/cgroup')
state = pathlib.Path('/run/agentor/freezer-probe')
exempt = root / 'agentor-freezer-probe'
agent_pid = int(sys.argv[1])
budget = int(sys.argv[2])
assert 5 <= budget <= 60
assert (root / 'cgroup.controllers').is_file(), 'cgroup v2 required'


def assert_root_kernel_tasks_only():
    # Kernel threads reside in the root cgroup and cannot be frozen/migrated.
    # An empty cmdline/exe alone is not proof: verify the kernel PF_KTHREAD bit.
    for pid in (root / 'cgroup.procs').read_text().split():
        try:
            value = (pathlib.Path('/proc') / pid / 'stat').read_text()
        except FileNotFoundError:
            continue
        fields = value[value.rindex(')') + 2:].split()
        assert int(fields[6]) & 0x00200000, 'Uncovered root userspace task: ' + pid


assert_root_kernel_tasks_only()
assert not exempt.exists(), 'Probe cgroup already exists'
state.mkdir(mode=0o700)
exempt.mkdir()
prior_agent = pathlib.Path('/proc') / str(agent_pid) / 'cgroup'
agent_group = root / prior_agent.read_text().strip().split('::', 1)[1].lstrip('/')
assert agent_group != root
agent_stat = (pathlib.Path('/proc') / str(agent_pid) / 'stat').read_text()
agent_start = agent_stat[agent_stat.rindex(')') + 2:].split()[19]
(exempt / 'cgroup.procs').write_text(str(os.getpid()))
(exempt / 'cgroup.procs').write_text(str(agent_pid))
groups = [p for p in root.iterdir() if p.is_dir() and p != exempt]
changed = [p for p in groups if (p / 'cgroup.freeze').read_text().strip() == '0']
deadline = time.monotonic() + budget


def thaw(reason):
    for group in changed:
        try:
            (group / 'cgroup.freeze').write_text('0')
        except FileNotFoundError:
            pass
    (state / 'thawed').write_text(reason)


watchdog = os.fork()
if watchdog == 0:
    # Neither the controller's finally nor its exec connection is authority
    # for restoring guest liveness after SIGKILL/OOM or caller disconnection.
    while time.monotonic() < deadline and not (state / 'released').exists():
        time.sleep(.05)
    thaw('watchdog' if not (state / 'released').exists() else 'released')
    value = (pathlib.Path('/proc') / str(agent_pid) / 'stat').read_text()
    assert value[value.rindex(')') + 2:].split()[19] == agent_start, 'Agent PID was reused'
    (agent_group / 'cgroup.procs').write_text(str(agent_pid))
    assert prior_agent.read_text().strip().split('::', 1)[1] == '/' + str(agent_group.relative_to(root)), 'Agent cgroup not restored'
    (state / 'restored').touch()
    os._exit(0)

(state / 'controller').write_text(str(os.getpid()))
(state / 'watchdog').write_text(str(watchdog))
try:
    # The launching exec must finish before its inherited cgroup is frozen.
    (state / 'armed').touch()
    while not (state / 'begin').exists():
        assert time.monotonic() < deadline - 2, 'Caller did not arm probe'
        time.sleep(.05)
    for group in changed:
        (group / 'cgroup.freeze').write_text('1')
    for group in groups:
        while 'frozen 1' not in (group / 'cgroup.events').read_text():
            assert time.monotonic() < deadline - 2, 'Freezer convergence deadline'
            time.sleep(.05)
    assert_root_kernel_tasks_only()
    assert {p for p in root.iterdir() if p.is_dir()} == set(groups + [exempt]), 'New unfrozen root group'
    (state / 'frozen').touch()
    while not (state / 'release').exists():
        assert time.monotonic() < deadline - 1, 'Caller did not release probe'
        time.sleep(.05)
finally:
    thaw('controller')
    (state / 'released').touch()
    os.waitpid(watchdog, 0)

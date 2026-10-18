"""Disposable guest capability probe only; not a production volume helper.

The independent watchdog starts before freezing. The thaw-mode capability test
restores changed states; the cutover-failure test instead syncs/powers off this
disposable guest. Neither mode is a production recovery protocol.
"""
import os
import pathlib
import sys
import time
import subprocess
import ctypes
import signal

root = pathlib.Path('/sys/fs/cgroup')
state = pathlib.Path('/run/agentor/freezer-probe')
exempt = root / 'agentor-freezer-probe'
agent_pid = int(sys.argv[1])
budget = int(sys.argv[2])
source = (sys.argv[3] or None) if len(sys.argv) > 3 else None
rescue = sys.argv[4] if len(sys.argv) > 4 else 'thaw'
assert rescue in ('thaw', 'poweroff')
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


os.setsid()
controller_pid = os.getpid()
watchdog = os.fork()
if watchdog == 0:
    os.setsid()
    # Neither the controller's finally nor its exec connection is authority
    # for restoring guest liveness after SIGKILL/OOM or caller disconnection.
    while time.monotonic() < deadline and not (state / 'released').exists():
        time.sleep(.05)
    if rescue == 'poweroff' and not (state / 'released').exists():
        # Failure containment only: a blind thaw could race a delayed hotplug.
        # Stop copy descendants and sync this guest before its kernel poweroff.
        try:
            os.killpg(controller_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        (state / 'poweroff-requested').touch()
        os.sync()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.reboot(0x4321FEDC) != 0:
            raise OSError(ctypes.get_errno(), 'Guest failure-containment poweroff failed')
        os._exit(1)  # Poweroff must never return and thaw uncertain writers.
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
    if source:
        fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            identity = os.fstat(fd)
            (state / 'source-pinned').write_text(f'{identity.st_dev}:{identity.st_ino}')
            while not (state / 'copy').exists():
                assert time.monotonic() < deadline - 2, 'Caller did not declare mount'
                time.sleep(.05)
            # The original rootfs FD is separate from the retiring virtiofs FD
            # in the earlier probe. Hotplug should leave this source usable.
            assert os.stat(source).st_dev != identity.st_dev, 'New canonical mount absent'
            create = subprocess.Popen(['tar', '--format=pax', '--xattrs', '--xattrs-include=*', '--acls', '--numeric-owner',
                                       '-cpf', '-', '-C', f'/proc/self/fd/{fd}', '.'], pass_fds=(fd,), stdout=subprocess.PIPE)
            try:
                extract = subprocess.run(['tar', '--xattrs', '--xattrs-include=*', '--acls', '--numeric-owner',
                                          '-xpf', '-', '-C', source], stdin=create.stdout,
                                         timeout=max(.1, deadline-time.monotonic()-2), check=True)
                create.stdout.close()
                assert create.wait(timeout=max(.1, deadline-time.monotonic()-2)) == 0, 'Source archive failed'
            finally:
                if create.poll() is None:
                    create.kill()
                    create.wait()
            subprocess.run(['sync', '-f', source], check=True)
            (state / 'copied').touch()
        finally:
            os.close(fd)
    while not (state / 'release').exists():
        assert time.monotonic() < deadline - 1, 'Caller did not release probe'
        time.sleep(.05)
finally:
    if rescue == 'poweroff' and not (state / 'release').exists():
        os._exit(1)  # Independent watchdog contains failure; do not race it.
    thaw('controller')
    (state / 'released').touch()
    os.waitpid(watchdog, 0)

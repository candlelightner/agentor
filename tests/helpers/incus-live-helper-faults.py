"""Local failure injection for the trusted helper; never touches real cgroups."""
import importlib.util
import pathlib
import tempfile
import sys
import uuid
from unittest import mock

spec = importlib.util.spec_from_file_location('live_helper', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def fixture(root):
    operation, boot = str(uuid.uuid4()), str(uuid.uuid4())
    helper.LIVE_ROOT = root / 'operations'
    helper.STATE = helper.LIVE_ROOT / operation
    helper.STATE.mkdir(parents=True)
    helper.CGROUP = root / 'cgroup'
    helper.CGROUP.mkdir()
    (helper.CGROUP / 'cgroup.controllers').touch()
    helper.PROC = root / 'proc'
    (helper.PROC / '42').mkdir(parents=True)
    (helper.PROC / '42/cgroup').write_text('0::/system.slice')
    helper.BOOT = root / 'boot'
    helper.BOOT.write_text(boot)
    for name, frozen in [('system.slice', '0'), ('pre-frozen', '1')]:
        group = helper.CGROUP / name
        group.mkdir()
        (group / 'cgroup.freeze').write_text(frozen)
        (group / 'cgroup.events').write_text('frozen 1')
        (group / 'cgroup.procs').write_text('42' if name == 'system.slice' else '')
    helper.watchdog_pid = None
    fields = ['0'] * 20
    fields[19] = '123'
    return operation, boot, fields


with tempfile.TemporaryDirectory(prefix='incus-live-local-faults-') as temporary:
    root = pathlib.Path(temporary)
    for failure in ('fork', 'watchdog-startup', 'watchdog-pre-attach', 'watchdog-post-attach', 'controller-post-attach'):
        case = root / failure
        case.mkdir()
        operation, boot, fields = fixture(case)
        source = case / 'source'
        source.mkdir()
        frozen = helper.CGROUP / 'pre-frozen/cgroup.freeze'
        agent = helper.CGROUP / 'system.slice/cgroup.procs'
        poweroffs = []
        def wait(name, deadline):
            if failure == 'watchdog-startup':
                raise RuntimeError('watchdog startup failed')
            if name == 'begin' and failure == 'watchdog-pre-attach':
                raise RuntimeError('watchdog died before attach')
            if name == 'mount-settled':
                raise RuntimeError('post-attach failure')
        def poweroff():
            poweroffs.append(True)
            raise SystemExit(71)
        def alive():
            if failure.startswith('watchdog-'):
                raise RuntimeError('dead watcher')
        with mock.patch.object(helper, 'root_coverage'), mock.patch.object(helper, 'stat_fields', return_value=fields), \
             mock.patch.object(helper.os, 'setsid'), mock.patch.object(helper.os, 'fork', return_value=99999) as fork, \
             mock.patch.object(helper.os, 'waitpid', return_value=(99999, 0)), \
             mock.patch.object(helper, 'wait', side_effect=wait), mock.patch.object(helper, 'watchdog_alive', side_effect=alive), \
             mock.patch.object(helper, 'reject_source_mounts'), mock.patch.object(helper, 'scan_source'), \
             mock.patch.object(helper, 'poweroff', side_effect=poweroff), \
             mock.patch.object(helper.os, '_exit', side_effect=SystemExit):
            if failure == 'fork':
                fork.side_effect = OSError('fork failure')
            try:
                helper.run(str(source), 'new', 42, boot, operation)
            except (OSError, SystemExit):
                pass
        assert frozen.read_text() == '1', failure + ': changed preexisting freeze'
        if failure in ('fork', 'watchdog-startup', 'watchdog-pre-attach'):
            assert (helper.CGROUP / 'system.slice/cgroup.freeze').read_text() == '0'
            assert agent.read_text() == '42'
            assert not (helper.STATE / 'attach-armed').exists()
            assert not poweroffs
        else:
            assert (helper.CGROUP / 'system.slice/cgroup.freeze').read_text() == '1'
            assert (helper.STATE / 'attach-armed').exists()
            assert not (helper.STATE / 'released').exists()
            assert not (helper.STATE / 'restored').exists()
            assert bool(poweroffs) == (failure == 'watchdog-post-attach')
        print(failure + ': passed')

# A D-state sync process must not make containment wait forever. All process,
# clock and reboot calls are mocked: this test cannot power off the worker.
clock = [0.0]
sync = mock.Mock()
sync.poll.return_value = None
libc = mock.Mock()
libc.reboot.side_effect = RuntimeError('reboot sentinel')
with mock.patch.object(helper.subprocess, 'Popen', return_value=sync), \
     mock.patch.object(helper.time, 'monotonic', side_effect=lambda: clock[0]), \
     mock.patch.object(helper.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0] + n)), \
     mock.patch.object(helper.ctypes, 'CDLL', return_value=libc):
    try:
        helper.poweroff()
    except RuntimeError as error:
        assert str(error) == 'reboot sentinel'
assert 10 <= clock[0] < 11
sync.kill.assert_called_once()
sync.wait.assert_not_called()
libc.reboot.assert_called_once_with(0x4321FEDC)
print('bounded-sync: passed')

for failure in ('start-sync', 'kill-sync'):
    clock[0] = 0
    sync.reset_mock()
    sync.kill.side_effect = ProcessLookupError('exited during kill') if failure == 'kill-sync' else None
    libc.reset_mock()
    with mock.patch.object(helper.subprocess, 'Popen', return_value=sync) as popen, \
         mock.patch.object(helper.time, 'monotonic', side_effect=lambda: clock[0]), \
         mock.patch.object(helper.time, 'sleep', side_effect=lambda n: clock.__setitem__(0, clock[0] + n)), \
         mock.patch.object(helper.ctypes, 'CDLL', return_value=libc):
        if failure == 'start-sync':
            popen.side_effect = OSError('resource exhaustion')
        try:
            helper.poweroff()
        except RuntimeError as error:
            assert str(error) == 'reboot sentinel'
    libc.reboot.assert_called_once_with(0x4321FEDC)
    sync.wait.assert_not_called()
    print(failure + ': passed')

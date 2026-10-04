"""Trusted guest-only live-volume helper. No host paths or credentials.

Protocol: arm -> freeze/validate/pin -> attach-armed -> host terminal mount
observation -> copy/sync -> host durable seeded write -> release. Before the
attach acknowledgement, failure may thaw the original tree. After it, only a
durable commit may thaw; otherwise an independent watchdog powers off this VM.
The Orchestrator owns operation settlement, recovery authority and all devices.
"""
import ctypes
import importlib.util
import json
import os
import pathlib
import re
import resource
import signal
import subprocess
import sys
import time

STATE = pathlib.Path(__file__).parent
CGROUP = pathlib.Path('/sys/fs/cgroup')
PROC = pathlib.Path('/proc')
LIVE_ROOT = pathlib.Path('/run/agentor/live-volumes')
BOOT = pathlib.Path('/proc/sys/kernel/random/boot_id')
UUID = r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
BUDGET = 180
watchdog_pid = None
spec = importlib.util.spec_from_file_location('trusted_volume_checks', STATE / 'volume-mount-helper.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def write(name, value):
    temporary = STATE / (name + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(STATE / name)


def stat_fields(pid):
    value = (PROC / str(pid) / 'stat').read_text()
    return value[value.rindex(')') + 2:].split()


def root_coverage():
    for pid in (CGROUP / 'cgroup.procs').read_text().split():
        try:
            assert int(stat_fields(pid)[6]) & 0x00200000, 'Uncovered root userspace process'
        except FileNotFoundError:
            pass


def wait(name, deadline):
    while not (STATE / name).exists():
        watchdog_alive()
        if time.monotonic() >= deadline:
            raise TimeoutError('Live-volume handshake deadline')
        time.sleep(.05)
    watchdog_alive()


def watchdog_alive():
    if watchdog_pid is not None and os.waitpid(watchdog_pid, os.WNOHANG)[0]:
        raise RuntimeError('Live-volume watchdog exited unexpectedly')


def poweroff():
    # A filesystem sync may block in kernel I/O. Never let it prevent failure
    # containment indefinitely; reboot(POWER_OFF) itself does not sync.
    try:
        sync = subprocess.Popen(['sync'])
        deadline = time.monotonic() + 10
        while sync.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        if sync.poll() is None:
            sync.kill()  # Do not wait unboundedly for a task stuck in D state.
    except OSError:
        # Resource exhaustion or an exit/kill race cannot veto containment.
        pass
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.reboot(0x4321FEDC) != 0:
        raise OSError(ctypes.get_errno(), 'Live recovery guest poweroff failed')
    os._exit(1)


def target_mount(target):
    with open('/proc/self/mountinfo') as mounts:
        for line in mounts:
            fields = line.split()
            point = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
            if point == target:
                return fields[fields.index('-') + 1]
    return None


def reject_source_mounts(target):
    with open('/proc/self/mountinfo') as mounts:
        for line in mounts:
            point = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
            if point != '/' and (point == target or point.startswith(target + '/') or target.startswith(point + '/')):
                raise ValueError('Persistent target overlaps an existing guest mount')


def scan_source(fd, deadline):
    # Count entries, not just unique inodes (many hardlinks are still bounded).
    identities, entries, size = set(), 0, 0

    def walk(directory):
        nonlocal entries, size
        st = os.fstat(directory)
        identities.add((st.st_dev, st.st_ino))
        with os.scandir(directory) as children:
            for child in children:
                entries += 1
                if time.monotonic() >= deadline or entries > checks.MAX_FILES:
                    raise ValueError('Directory exceeds live scan limit; choose recreation')
                st = child.stat(follow_symlinks=False)
                identities.add((st.st_dev, st.st_ino))
                if checks.stat.S_ISDIR(st.st_mode):
                    nested = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        walk(nested)
                    finally:
                        os.close(nested)
                elif checks.stat.S_ISREG(st.st_mode):
                    size += st.st_size
                    if size > checks.MAX_BYTES:
                        raise ValueError('Directory exceeds live copy limit; choose recreation')
                elif not checks.stat.S_ISLNK(st.st_mode):
                    raise ValueError('Directory has a socket/special file; stop its application first')
    walk(fd)
    checks.assert_not_busy(identities)


def copy(source, destination, deadline):
    if os.listdir(destination):
        raise ValueError('New volume is not empty; refusing to overwrite established data')
    create = subprocess.Popen(['tar', '--format=pax', '--xattrs', '--xattrs-include=*', '--acls', '--numeric-owner',
                               '-cpf', '-', '-C', f'/proc/self/fd/{source}', '.'],
                              pass_fds=(source,), stdout=subprocess.PIPE)
    try:
        subprocess.run(['tar', '--xattrs', '--xattrs-include=*', '--acls', '--numeric-owner',
                        '-xpf', '-', '-C', f'/proc/self/fd/{destination}'], pass_fds=(destination,),
                       stdin=create.stdout, timeout=max(.1, deadline - time.monotonic()), check=True)
        create.stdout.close()
        if create.wait(timeout=max(.1, deadline - time.monotonic())) != 0:
            raise ValueError('Source archive failed; original data retained')
    finally:
        if create.poll() is None:
            create.kill()
            create.wait()


def run(target, mode, agent, boot_id, operation):
    global watchdog_pid
    checks.validate_target(target)
    if mode not in ('new', 'seeded') or not re.fullmatch(UUID, operation) or not re.fullmatch(UUID, boot_id):
        raise ValueError('Invalid live helper invocation')
    if STATE != LIVE_ROOT / operation or BOOT.read_text().strip() != boot_id:
        raise ValueError('Live operation path or boot identity changed')
    if not (CGROUP / 'cgroup.controllers').is_file():
        raise ValueError('Live mounting requires guest cgroup v2; choose recreation')
    root_coverage()
    exempt = CGROUP / ('agentor-live-' + operation)
    agent_group_file = PROC / str(agent) / 'cgroup'
    agent_group = agent_group_file.read_text().strip().split('::', 1)[1]
    agent_start = stat_fields(agent)[19]
    if agent_group == '/' or not agent_group.startswith('/') or '..' in agent_group.split('/'):
        raise ValueError('Incus agent cgroup is ambiguous')
    os.setsid()
    controller = os.getpid()
    controller_start = stat_fields(controller)[19]
    groups = [p for p in CGROUP.iterdir() if p.is_dir() and p != exempt]
    changed = [p for p in groups if (p / 'cgroup.freeze').read_text().strip() == '0']
    deadline = time.monotonic() + BUDGET
    exempt.mkdir()
    (exempt / 'cgroup.procs').write_text(str(controller))

    def restore():
        for group in changed:
            (group / 'cgroup.freeze').write_text('0')
        if stat_fields(agent)[19] != agent_start:
            raise ValueError('Incus agent PID was reused')
        (CGROUP / agent_group.lstrip('/') / 'cgroup.procs').write_text(str(agent))
        if agent_group_file.read_text().strip().split('::', 1)[1] != agent_group:
            raise ValueError('Incus agent cgroup restoration failed')

    watchdog_pid = os.fork()
    if watchdog_pid == 0:
        watchdog_pid = None
        try:
            os.setsid()
            (PROC / 'self/oom_score_adj').write_text('-1000')
            write('watchdog-ready', {'pid': os.getpid(), 'start': stat_fields(os.getpid())[19]})
            while time.monotonic() < deadline and not (STATE / 'released').exists():
                time.sleep(.05)
            if not (STATE / 'released').exists():
                try:
                    if stat_fields(controller)[19] == controller_start:
                        os.killpg(controller, signal.SIGKILL)
                except FileNotFoundError:
                    # The process group can still contain orphaned copy tasks.
                    try:
                        os.killpg(controller, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if (STATE / 'attach-armed').exists():
                    poweroff()
            restore()
            write('restored', {'bootId': boot_id})
        except BaseException as error:
            try:
                write('watchdog-error', {'error': str(error)[:300]})
            except BaseException:
                pass
            if (STATE / 'attach-armed').exists() and not (STATE / 'released').exists():
                poweroff()
            os._exit(1)
        os._exit(0)

    source = destination = root = None
    safe_release = False
    try:
        # No agent migration or freeze until the independently exempt watcher
        # has initialized. Failure before fork cannot leak an exempt agent.
        wait('watchdog-ready', min(deadline, time.monotonic() + 5))
        (exempt / 'cgroup.procs').write_text(str(agent))
        write('armed', {'bootId': boot_id, 'controller': controller, 'start': controller_start})
        wait('begin', deadline)
        for group in changed:
            (group / 'cgroup.freeze').write_text('1')
        for group in groups:
            while 'frozen 1' not in (group / 'cgroup.events').read_text():
                watchdog_alive()
                if time.monotonic() >= deadline:
                    raise TimeoutError('Guest freezer did not converge')
                time.sleep(.05)
        root_coverage()
        if {p for p in CGROUP.iterdir() if p.is_dir()} != set(groups + [exempt]):
            raise ValueError('New uncovered root cgroup')
        reject_source_mounts(target)
        root = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        source = checks.open_directory(root, target, create=True)
        scan_source(source, min(deadline - 10, time.monotonic() + checks.MAX_SECONDS))
        original = os.fstat(source)
        write('ready', {'bootId': boot_id, 'source': [original.st_dev, original.st_ino]})
        wait('request-attach', deadline - 10)
        write('attach-armed', {'bootId': boot_id})
        wait('mount-settled', deadline - 10)
        if BOOT.read_text().strip() != boot_id or target_mount(target) != 'virtiofs':
            raise ValueError('Canonical mount or boot identity is not verified')
        destination = checks.open_directory(root, target)
        if os.fstat(destination).st_dev == original.st_dev:
            raise ValueError('Canonical volume did not replace the rootfs view')
        if mode == 'new':
            copy(source, destination, min(deadline - 10, time.monotonic() + checks.MAX_SECONDS))
        subprocess.run(['sync', '-f', f'/proc/self/fd/{destination}'], pass_fds=(destination,),
                       timeout=max(.1, deadline - time.monotonic() - 10), check=True)
        write('copied', {'bootId': boot_id})
        wait('release', deadline - 1)
        safe_release = True
    except BaseException as error:
        write('error', {'error': str(error)[:300], 'beforeAttachment': not (STATE / 'attach-armed').exists(), 'bootId': boot_id})
        safe_release = not (STATE / 'attach-armed').exists()
    finally:
        for fd in (source, destination, root):
            if fd is not None:
                os.close(fd)
        if safe_release:
            # Watchdog performs restoration once, then publishes its proof.
            if watchdog_pid is not None:
                try:
                    watchdog_alive()
                    write('released', {'bootId': boot_id})
                    os.waitpid(watchdog_pid, 0)
                except (ChildProcessError, RuntimeError):
                    # Before cutover the controller can safely restore the
                    # original tree if watcher initialization/death failed.
                    restore()
                    write('restored', {'bootId': boot_id})
        else:
            try:
                watchdog_alive()
            except (ChildProcessError, RuntimeError):
                poweroff()  # Watcher death never authorizes post-cutover thaw.
            # Never execute a finally-thaw after cutover permission. Parent
            # can force-stop sooner; independent watcher contains caller loss.
            os._exit(1)


if __name__ == '__main__':
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024**2, 256 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_NOFILE, (2048, 2048))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        target, mode, agent, boot_id, operation = sys.argv[1:]
        run(target, mode, int(agent), boot_id, operation)
    except BaseException as error:
        write('error', {'error': str(error)[:300], 'beforeAttachment': not (STATE / 'attach-armed').exists()})
        raise

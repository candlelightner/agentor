#!/usr/bin/env python3
"""Run as agent after provisioning; emit only non-secret acceptance results."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile


def run(argv, **kwargs):
    return subprocess.check_output(argv, text=True, stderr=subprocess.STDOUT,
                                   timeout=90, **kwargs).strip()


def main():
    if os.geteuid() == 0 or Path.home() != Path('/home/agent'):
        raise SystemExit('Run as agent inside the worker guest')
    result = {'guestKernel': run(['uname', '-r']), 'packages': []}
    root = Path('/home/agent/.agent-data/.incus-migration-home')
    if (root / 'manifest.json').is_file():
        manifest = json.loads((root / 'manifest.json').read_text())
        ready = json.loads((root / 'ready.json').read_text())
        boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines()
                    if line.startswith('btime '))
        assert ready['workerId'] == manifest['workerId']
        assert (root / 'ready.json').stat().st_mtime >= boot, 'Home/package setup did not complete this boot'
        assert ready['packages'] == manifest['packages']
        for package in manifest['packages']:
            assert run(['dpkg-query', '-W', '-f=${Status}', package]) == 'install ok installed'
        result.update(workerId=manifest['workerId'], packages=manifest['packages'], homeRestore=True)
    for directory in ['/workspace', '/home/agent/.agent-data']:
        with tempfile.TemporaryDirectory(prefix='agentor-exec-verification-', dir=directory) as temporary:
            native = Path(temporary) / 'native'
            shutil.copy2('/usr/bin/true', native)
            run([str(native)])
            script = Path(temporary) / 'script'
            script.write_text('#!/bin/sh\nexit 0\n')
            script.chmod(0o700)
            run([str(script)])
    result['sharedVolumeExecution'] = True
    result['codex'] = run(['/home/agent/.local/bin/codex', '--version'])
    assert result['codex'].startswith('codex-cli ')
    assert run(['systemctl', 'is-active', 'agentor-worker']) == 'active'
    run(['tmux', 'has-session', '-t', 'main'])
    result['workerSession'] = True
    with socket.create_connection(('127.0.0.1', 5900), timeout=10) as connection:
        assert connection.recv(12).startswith(b'RFB 003.')
    result['desktopRfb'] = True
    if any(package.startswith('texlive-') for package in result['packages']):
        with tempfile.TemporaryDirectory(prefix='agentor-pdf-verification-') as temporary:
            path = Path(temporary) / 'check.tex'
            language = r'\usepackage[ngerman]{babel}' if 'texlive-lang-german' in result['packages'] else ''
            path.write_text(r'\documentclass{article}' + language + r'\begin{document}VM migration check.\end{document}')
            command = ['latexmk', '-pdf'] if 'latexmk' in result['packages'] else ['pdflatex']
            run([*command, '-interaction=nonstopmode', '-halt-on-error', 'check.tex'], cwd=temporary)
            assert 'VM migration check.' in run(['pdftotext', 'check.pdf', '-'], cwd=temporary)
        result['pdfCompilation'] = True
    if 'r-base-core' in result['packages']:
        assert run(['Rscript', '-e', 'stopifnot(requireNamespace("rmarkdown", quietly=TRUE), requireNamespace("robustbase", quietly=TRUE)); cat("ok")']) == 'ok'
        result['rPackages'] = True
        result['pandoc'] = run(['pandoc', '--version']).splitlines()[0]
    if 'qemu-utils' in result['packages']:
        result['qemuImg'] = run(['qemu-img', '--version']).splitlines()[0]
        assert Path('/home/agent/.config/gh/hosts.yml').is_file(), 'Preserved updater GitHub configuration absent'
        result['githubConfigurationRetained'] = True
    for directory in ['/workspace', '/home/agent/.agent-data']:
        run(['sync', '-f', directory])
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Hosted-only paired quality measurements; --self-test needs no Docker/tools."""
import argparse, copy, hashlib, json, os, re, shutil, statistics, subprocess, sys, time
from pathlib import Path

IMAGE = 'ghcr.io/candlelightner/agentor-ci-quality@sha256:bcf69468194f5ef9d21d312452850188c925f3e714b18b35b3ef95dca742f236'
ROOT_SPECS = ['incus-admin-restore', 'incus-derived-image', 'incus-docker-restore-archive', 'incus-selected-restore', 'managed-kilo-parent', 'portable-pax-size']
EXCLUSION = r'api/(' + '|'.join(ROOT_SPECS) + r')\.spec\.ts'


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path, data): path.write_text(json.dumps(data, indent=2) + '\n')
def require(ok, reason):
    if not ok: raise RuntimeError(reason)


def test_summary(report):
    cases = []
    def visit(suite, parents):
        path = parents + [suite.get('title', '')]
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                results = test.get('results', [])
                cases.append({'id': ' / '.join(path + [spec['title']]), 'expectedStatus': test.get('expectedStatus'),
                              'status': test.get('status'), 'results': [item.get('status') for item in results]})
        for child in suite.get('suites', []): visit(child, path)
    for suite in report.get('suites', []): visit(suite, [])
    return {'stats': report.get('stats', {}), 'cases': cases}


def phase(name, argv, cwd, env, record, output):
    started = time.monotonic()
    result = subprocess.run(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    record.setdefault('phases', []).append({'phase': name, 'seconds': time.monotonic() - started, 'exitCode': result.returncode})
    require(result.returncode == 0, name + ' failed (exit ' + str(result.returncode) + '); benchmark stopped and this sample is ineligible for adoption')


def quality(arm):
    workspace = Path.cwd(); out = workspace / '.benchmark-results'; out.mkdir()
    record = {'arm': arm, 'sourceSha': os.environ['BENCH_SOURCE_SHA'], 'nodeExpected': 'v22.23.4', 'phases': []}
    env = dict(os.environ, CI='true')
    try:
        with (out / 'private-command-output.log').open('wb') as log:
            if arm == 'image': phase('image contract preflight', ['node', 'tests/ci-quality/check-image.mjs', '--preflight'], workspace, env, record, log)
            phase('orchestrator npm ci', ['npm', 'ci', '--prefix', 'orchestrator', '--no-audit', '--no-fund'], workspace, env, record, log)
            phase('tests npm ci', ['npm', 'ci', '--prefix', 'tests', '--no-audit', '--no-fund'], workspace, env, record, log)
            record['node'] = subprocess.check_output(['node', '--version'], env=env, text=True).strip()
            require(record['node'] == 'v22.23.4', 'Node patch differs from pinned image; sample stopped and comparison is invalid')
            if arm == 'baseline':
                phase('baseline system tools', ['sudo', 'apt-get', 'update'], workspace, env, record, log)
                phase('baseline system tool install', ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', 'qemu-utils'], workspace, env, record, log)
                phase('baseline locked Chromium and libraries', ['npx', '--no-install', 'playwright', 'install', '--with-deps', 'chromium'], workspace / 'tests', env, record, log)
            else: phase('image browser and tools guard', ['node', 'tests/ci-quality/check-image.mjs'], workspace, env, record, log)
            record['playwright'] = json.loads((workspace / 'tests/node_modules/@playwright/test/package.json').read_text())['version']
            browsers = json.loads((workspace / 'tests/node_modules/playwright-core/browsers.json').read_text())['browsers']
            chromium = next(item for item in browsers if item['name'] == 'chromium')
            record['chromium'] = {key: chromium[key] for key in ('revision', 'browserVersion')}
            phase('orchestrator typecheck', ['npm', 'run', 'typecheck'], workspace / 'orchestrator', env, record, log)
            node = shutil.which('node')
            require(node, 'Node executable could not be resolved; sample stopped before tests')
            for name, args in [('ordinary', ['--grep-invert', EXCLUSION]), ('sudo-archives', ['api/' + name + '.spec.ts' for name in ROOT_SPECS])]:
                report = out / (name + '-raw.json')
                test_env = dict(env, PLAYWRIGHT_JSON_OUTPUT_FILE=str(report))
                command = ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config=playwright.modules.config.ts', '--reporter=json', *args]
                if name == 'sudo-archives':
                    command = ['sudo', '--preserve-env=PLAYWRIGHT_JSON_OUTPUT_FILE', '--', node, *command[1:]]
                try: phase(name + ' tests', command, workspace / 'tests', test_env, record, log)
                finally:
                    if report.exists():
                        record[name] = test_summary(json.loads(report.read_text()))
                if name == 'ordinary': phase('CI profiler self-check', ['python3', 'scripts/profile-ci-workflow.py', '--self-test'], workspace, env, record, log)
        require(all(name in record for name in ('ordinary', 'sudo-archives')), 'A test reporter receipt is missing; sample stopped and is ineligible for adoption')
        record['result'] = 'success'
    except Exception as error:
        record['result'] = 'failure'
        record['failure'] = str(error) if isinstance(error, RuntimeError) else 'Benchmark observation failed; sample stopped and is ineligible for adoption'
        print('[quality-benchmark] ' + record['failure'], file=sys.stderr)
    finally:
        save(out / 'quality.json', record)
    return 0 if record['result'] == 'success' else 1


def location(arm, pair):
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'Hosted benchmark requires an Actions runner; stopped without touching Docker or host tools')
    require(os.getuid() == 1001, 'Hosted UID must match quality image UID1001; stopped before workspace/cache preparation')
    return Path(os.environ['RUNNER_TEMP']) / ('quality-pair-' + pair + '-' + arm)


def mark(arm, pair, sample):
    base = location(arm, pair)
    if sample == 'cold':
        require(not base.exists(), 'Cold arm directory already exists; sample stopped without pruning state')
        base.mkdir(mode=0o700); (base / 'receipts').mkdir()
    else: require((base / 'cold-start.json').exists(), 'Warm sample needs its same-job cold predecessor; stopped')
    save(base / (sample + '-start.json'), {'monotonic': time.monotonic(), 'unix': time.time()})


def sample(arm, pair, label):
    base = location(arm, pair); start = json.loads((base / (label + '-start.json')).read_text())
    workspace = base / label
    record = {'pair': pair, 'arm': arm, 'sample': label, 'startedUnix': start['unix'], 'sourceSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'image': IMAGE if arm == 'image' else None, 'preSampleStepSeconds': time.monotonic() - start['monotonic'],
              'runner': {'imageOS': os.environ.get('ImageOS'), 'imageVersion': os.environ.get('ImageVersion'), 'kernel': os.uname().release}, 'phases': []}
    try:
        require(not workspace.exists(), 'Sample workspace already exists; stopped without reusing node_modules')
        workspace.mkdir()
        # Only tracked checkout bytes: no shared node_modules, Nuxt output or credentials.
        archive = subprocess.Popen(['git', 'archive', '--format=tar', 'HEAD'], stdout=subprocess.PIPE)
        unpack = subprocess.run(['tar', '-xf', '-', '-C', str(workspace)], stdin=archive.stdout)
        archive.stdout.close(); require(unpack.returncode == 0 and archive.wait() == 0, 'Fresh checkout copy failed; sample stopped')
        record['lockHashes'] = {name: digest(workspace / name) for name in ('tests/package-lock.json', 'orchestrator/package-lock.json')}
        cache = base / 'npm'
        record['npmCacheInitiallyPresent'] = cache.exists()
        record['browserCacheInitiallyPresent'] = (base / 'browsers').exists()
        require(label != 'cold' or not record['npmCacheInitiallyPresent'] and not record['browserCacheInitiallyPresent'], 'Cold arm cache already exists; sample stopped without pruning state')
        cache.mkdir(exist_ok=True)
        home = workspace / '.benchmark-home'; home.mkdir()
        env = dict(os.environ, BENCH_SOURCE_SHA=record['sourceSha'], HOME=str(home), XDG_CACHE_HOME=str(home / '.cache'), npm_config_cache=str(cache), PLAYWRIGHT_BROWSERS_PATH=str(base / 'browsers'))
        with (base / (label + '-private-output.log')).open('wb') as log:
            if arm == 'image':
                config = base / 'anonymous-docker'; config.mkdir(exist_ok=True)
                (config / 'config.json').write_text('{}\n')
                docker_env = {key: value for key, value in env.items() if key not in ('DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
                docker_env['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
                client = ['docker', '--config', str(config)]
                observed = subprocess.run([*client, 'image', 'inspect', IMAGE], env=docker_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                record['imagePreexisting'] = observed.returncode == 0
                require(label != 'cold' or not record['imagePreexisting'], 'Pinned image was already present; cold-pull sample invalid and stopped without pruning')
                phase('anonymous pinned image pull', [*client, 'pull', '--platform', 'linux/amd64', IMAGE], workspace, docker_env, record, log)
                phase('image full quality', [*client, 'run', '--rm', '--init', '--shm-size=1g', '--mount', 'type=bind,src=' + str(workspace) + ',dst=/workspace', '--mount', 'type=bind,src=' + str(cache) + ',dst=/home/runner/.npm', '--env', 'CI=true', '--env', 'BENCH_SOURCE_SHA=' + record['sourceSha'], IMAGE, 'python3', 'tests/ci-quality/benchmark.py', '--quality', 'image'], workspace, docker_env, record, log)
            else:
                phase('baseline full quality', ['python3', 'tests/ci-quality/benchmark.py', '--quality', 'baseline'], workspace, env, record, log)
        record['result'] = 'success'
    except Exception as error:
        record['result'] = 'failure'
        record['failure'] = str(error) if isinstance(error, RuntimeError) else 'Sample setup/observation failed; stopped without adoption'
        print('[quality-benchmark] ' + record['failure'], file=sys.stderr)
    finally:
        record['totalSeconds'] = time.monotonic() - start['monotonic']
        quality_file = workspace / '.benchmark-results/quality.json'
        if quality_file.exists(): record['quality'] = json.loads(quality_file.read_text())
        save(base / 'receipts' / (label + '.json'), record)
        print(json.dumps({key: record[key] for key in ('pair', 'arm', 'sample', 'result', 'totalSeconds')}))
    return 0 if record['result'] == 'success' else 1


def finalize(arm, pair):
    base = location(arm, pair)
    if not base.exists(): return
    for label in ('cold', 'warm'):
        receipt = base / 'receipts' / (label + '.json')
        marker = base / (label + '-start.json')
        if not receipt.exists():
            start = json.loads(marker.read_text()) if marker.exists() else None
            save(receipt, {'pair': pair, 'arm': arm, 'sample': label, 'result': 'incomplete',
                           'totalSeconds': time.monotonic() - start['monotonic'] if start else None,
                           'failure': 'Runner step failed, cancelled or reached its occupancy deadline; this sample cannot justify adoption'})
            print('[quality-benchmark] Interrupted or skipped ' + label + ' measurement recorded as incomplete; no adoption claim is permitted.')


def compare_samples(records):
    require(len(records) == 8 and len({(r['pair'], r['arm'], r['sample']) for r in records}) == 8,
            'Eight unique paired receipts are required; comparison stopped without an adoption claim')
    reference = records[0]
    signatures = {}
    for record in records:
        require(record.get('result') == 'success', 'At least one sample failed or is incomplete; comparison stopped without an adoption claim')
        quality_record = record.get('quality', {})
        signature = {'sourceSha': record['sourceSha'], 'lockHashes': record['lockHashes'],
                     'node': quality_record.get('node'), 'playwright': quality_record.get('playwright'), 'chromium': quality_record.get('chromium')}
        for group in ('ordinary', 'sudo-archives'):
            require(group in quality_record, 'Missing ordinary/root test receipt; comparison stopped')
            signature[group] = sorted((case['id'], case['expectedStatus'], case['status'], tuple(case['results'])) for case in quality_record[group]['cases'])
        signatures[(record['pair'], record['arm'], record['sample'])] = signature
    require(all(value == next(iter(signatures.values())) for value in signatures.values()),
            'Source, lockfile, Node, browser or pass/skip test parity differs; comparison stopped without adoption')
    medians = {arm: {sample: statistics.median(r['totalSeconds'] for r in records if r['arm'] == arm and r['sample'] == sample)
                     for sample in ('cold', 'warm')} for arm in ('baseline', 'image')}
    return {'result': 'complete-with-parity', 'sourceSha': reference['sourceSha'], 'sampleCount': 8,
            'medianSeconds': medians, 'pairs': [{key: record[key] for key in ('pair', 'arm', 'sample', 'totalSeconds')} for record in records],
            'decision': 'No automatic adoption. Favor cold pull-inclusive totals; review two-pair variance and full parity before changing active CI.'}


def summarize(directory, output):
    records = [json.loads(path.read_text()) for path in Path(directory).rglob('*.json')]
    try: result = compare_samples(records)
    except RuntimeError as error:
        save(Path(output), {'result': 'ineligible', 'reason': str(error), 'receiptsFound': len(records)})
        print('[quality-benchmark] ' + str(error), file=sys.stderr)
        return 1
    save(Path(output), result)
    print(json.dumps(result, indent=2))
    return 0


def self_test():
    for name in ROOT_SPECS: assert re.search(EXCLUSION, 'api/' + name + '.spec.ts')
    assert not re.search(EXCLUSION, 'api/incus-client.spec.ts')
    parsed = test_summary({'suites': [{'title': 'api/synthetic.spec.ts', 'specs': [{'title': 'passes', 'tests': [{'status': 'expected', 'expectedStatus': 'passed', 'results': [{'status': 'passed'}]}]}], 'suites': [{'title': 'nested', 'specs': [{'title': 'skips', 'tests': [{'status': 'skipped', 'expectedStatus': 'skipped', 'results': [{'status': 'skipped'}]}]}]}]}], 'stats': {'expected': 1, 'skipped': 1}})
    assert len(parsed['cases']) == 2 and parsed['cases'][1]['results'] == ['skipped']
    assert parsed['stats']['expected'] == 1 and 'api/synthetic.spec.ts / nested / skips' in parsed['cases'][1]['id']
    records = []
    for pair in ('1', '2'):
        for arm in ('baseline', 'image'):
            for sample_name in ('cold', 'warm'):
                records.append({'pair': pair, 'arm': arm, 'sample': sample_name, 'result': 'success', 'totalSeconds': 10, 'sourceSha': 'synthetic', 'lockHashes': {'test': 'hash'}, 'quality': {'node': 'v22.23.4', 'playwright': '1.59.1', 'chromium': {}, 'ordinary': parsed, 'sudo-archives': parsed}})
    assert compare_samples(records)['sampleCount'] == 8
    for key, value in [('result', 'failure'), ('sourceSha', 'different')]:
        changed = [{**item} for item in records]; changed[-1][key] = value
        try: compare_samples(changed)
        except RuntimeError: pass
        else: raise AssertionError('Invalid comparison was accepted')
    changed = list(records); changed[-1] = copy.deepcopy(records[-1])
    changed[-1]['quality']['ordinary']['cases'][0]['results'] = ['skipped']
    try: compare_samples(changed)
    except RuntimeError: pass
    else: raise AssertionError('Changed pass/skip parity was accepted')
    print('Benchmark self-check passed: root exclusions, nested pass/skip parsing, complete pairs and failure/source mismatch rejection.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--self-test', action='store_true'); parser.add_argument('--quality', choices=['baseline', 'image']); parser.add_argument('--arm', choices=['baseline', 'image']); parser.add_argument('--pair', choices=['1', '2']); parser.add_argument('--sample', choices=['cold', 'warm']); parser.add_argument('--mark', action='store_true'); parser.add_argument('--finalize', action='store_true'); parser.add_argument('--summarize'); parser.add_argument('--output'); args = parser.parse_args()
    if args.self_test: self_test()
    elif args.quality: sys.exit(quality(args.quality))
    elif args.summarize: sys.exit(summarize(args.summarize, args.output))
    elif args.finalize: finalize(args.arm, args.pair)
    else:
        require(args.arm and args.pair and args.sample, 'Benchmark arm/pair/sample required; stopped')
        if args.mark: mark(args.arm, args.pair, args.sample)
        else: sys.exit(sample(args.arm, args.pair, args.sample))

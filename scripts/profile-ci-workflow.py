#!/usr/bin/env python3
"""Summarize public Actions timings without emitting raw logs or runner identities."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import subprocess


def timestamp(value):
    return dt.datetime.fromisoformat(value.lstrip('\ufeff').replace('Z', '+00:00'))


def seconds(start, end):
    return round((timestamp(end) - timestamp(start)).total_seconds(), 1)


def events(log):
    result = []
    for line in log.splitlines():
        # gh prefixes lines with job and step; avoid carrying either into output.
        body = line.split('\t', 2)[-1]
        body = re.sub(r'(?:\x1b|\^\[)\[[0-9;]*m', '', body).lstrip('\ufeff')
        match = re.match(r'(\d{4}-\d\d-\d\dT\S+Z) (.*)', body)
        if match:
            result.append((match[1], match[2]))
    return result


def regression_phases(log, step_start, completed):
    entries = events(log)

    def first(pattern):
        return next((time for time, message in entries if re.search(pattern, message)), None)

    markers = [
        ('step_start', step_start),
        ('inner_build_start', first(r'Building agentor images \(cached after first run\)')),
        ('worker_built', first(r'\[test-runner\].*Worker image built\.')
         or first(r'naming to docker.io/library/agentor-worker:latest done')),
        ('images_built', first(r'\[test-runner\].*Images built\.')),
        ('stack_ready', first(r'\[test-runner\].*Orchestrator ready after')),
        ('test_process_start', first(r'\[test-runner\].*Running playwright tests:')),
        ('test_cases_start', first(r'^Running \d+ tests using')),
        ('test_cases_end', first(r'^\s*\d+ passed \(')),
        ('job_completed', completed),
    ]
    phases = {}
    names = ['outer_and_bootstrap', 'inner_worker', 'inner_orchestrator',
             'stack_ready', 'test_dependencies', 'playwright_setup',
             'test_cases', 'tail_cleanup']
    for name, (_, start), (_, end) in zip(names, markers, markers[1:]):
        phases[name] = seconds(start, end) if start and end else None
    # Fixed numeric aggregates only: never copy hostnames, paths, or arbitrary log text.
    free = [int(m[1]) for _, message in entries
            if (m := re.fullmatch(r'/dev/root\s+\S+\s+\S+\s+(\d+)G\s+\S+\s+/', message))]
    sampled_free = [float(m[1]) for _, message in entries
                    if (m := re.fullmatch(r'Minimum sampled available disk: (\d+(?:\.\d+)?) GiB \(10s samples\)', message))]
    return {
        'phases_s': phases,
        'cached_lines': sum(bool(re.search(r'#\d+ CACHED$', message)) for _, message in entries),
        'image_build_retries': sum('Build of ' in message and 'retrying in' in message for _, message in entries),
        'observed_min_free_gib_rounded': min(free) if free else None,
        'sampled_min_available_disk_gib': min(sampled_free) if sampled_free else None,
    }


def summarize(run, regression_log='', amd64_log=''):
    jobs = [job for job in run['jobs'] if job['conclusion'] != 'skipped']
    completed = max(job['completedAt'] for job in jobs)
    if run['attempt'] > 1 and not run.get('startedAt'):
        raise ValueError('Rerun metadata requires startedAt to measure the current attempt.')
    attempt_start = run.get('startedAt') or run['createdAt']
    first_job = min(j['startedAt'] for j in jobs)
    result = {
        'event': run['event'], 'attempt': run['attempt'], 'conclusion': run['conclusion'],
        'attempt_started_at': attempt_start,
        'elapsed_to_last_job_s': seconds(attempt_start, completed),
        # Includes dispatch/provisioning: Jobs API startedAt is not a queue-only metric.
        'attempt_dispatch_delay_s': seconds(attempt_start, first_job),
        'initial_dispatch_delay_s': seconds(run['createdAt'], first_job) if run['attempt'] == 1 else None,
        'jobs': [{
            'name': job['name'], 'conclusion': job['conclusion'],
            'started_at': job['startedAt'], 'completed_at': job['completedAt'],
            'duration_s': seconds(job['startedAt'], job['completedAt']),
            'steps': [{'name': step['name'], 'conclusion': step['conclusion'],
                       'duration_s': seconds(step['startedAt'], step['completedAt'])}
                      for step in job['steps'] if step['conclusion'] != 'skipped'],
        } for job in jobs],
        'amd64_cached_lines': sum(bool(re.search(r'#\d+ CACHED$', message)) for _, message in events(amd64_log)),
    }
    regression = next((job for job in jobs if job['name'] == 'Isolated Docker API and UI regression'), None)
    if regression and regression_log:
        step = next((step for step in regression['steps'] if step['name'] == 'Run bounded isolated regression suite'), None)
        if step:
            result['regression'] = regression_phases(regression_log, step['startedAt'], regression['completedAt'])
            outer = next((item for item in regression['steps'] if item['name'] == 'Build cached isolated test runner'), None)
            result['regression'].update({
                'job_duration_s': seconds(regression['startedAt'], regression['completedAt']),
                'bounded_step_s': seconds(step['startedAt'], step['completedAt']),
                'outer_runner_build_step_s': seconds(outer['startedAt'], outer['completedAt']) if outer else None,
            })
    return result


def gh(*args):
    return subprocess.run(['gh', *args], check=True, capture_output=True, text=True).stdout


def self_test():
    log = '\n'.join([
        'Job\tStep\t2026-01-01T00:00:02Z [test-runner] Building agentor images (cached after first run)...',
        'Job\tStep\t2026-01-01T00:00:05Z #41 naming to docker.io/library/agentor-worker:latest done',
        'Job\tStep\t2026-01-01T00:00:09Z [test-runner] Images built.',
        'Job\tStep\t2026-01-01T00:00:10Z [test-runner] Orchestrator ready after 1s.',
        'Job\tStep\t2026-01-01T00:00:11Z [test-runner] Running playwright tests: synthetic.spec.ts',
        'Job\tStep\t2026-01-01T00:00:12Z Running 1 tests using 1 worker',
        'Job\tStep\t2026-01-01T00:00:15Z   1 passed (3s)',
        'Job\tStep\t2026-01-01T00:00:01Z /dev/root 145G 59G 86G 41% /',
    ])
    result = regression_phases(log, '2026-01-01T00:00:00Z', '2026-01-01T00:00:16Z')
    assert list(result['phases_s'].values()) == [2, 3, 4, 1, 1, 1, 3, 1]
    assert result['observed_min_free_gib_rounded'] == 86
    assert result['sampled_min_available_disk_gib'] is None
    new_log = log + '\n' + '\n'.join([
        'Job\tStep\t2026-01-01T00:00:06Z [test-runner] Worker image built.',
        'Job\tStep\t2026-01-01T00:00:16Z Minimum sampled available disk: 42.25 GiB (10s samples)',
        'Job\tStep\t2026-01-01T00:00:16Z Minimum sampled available disk: 1.00 GiB (10s samples) private-text',
        'Job\tStep\t2026-01-01T00:00:16Z Minimum sampled available disk: nan GiB (10s samples)',
    ])
    new_result = regression_phases(new_log, '2026-01-01T00:00:00Z', '2026-01-01T00:00:16Z')
    assert new_result['phases_s']['inner_worker'] == 4
    assert new_result['phases_s']['inner_orchestrator'] == 3
    assert new_result['sampled_min_available_disk_gib'] == 42.25
    assert regression_phases('', '2026-01-01T00:00:00Z', '2026-01-01T00:00:16Z')['phases_s']['inner_worker'] is None
    assert seconds('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z') == 60
    run = {'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T01:00:00Z',
           'event': 'pull_request', 'attempt': 1, 'conclusion': 'success',
           'jobs': [{'name': 'synthetic job', 'conclusion': 'success',
                     'startedAt': '2026-01-01T00:00:03Z',
                     'completedAt': '2026-01-01T00:01:00Z', 'steps': []}]}
    summary = summarize(run, 'synthetic private log text')
    assert summary['elapsed_to_last_job_s'] == 60
    assert summary['initial_dispatch_delay_s'] == 3
    assert 'synthetic private log text' not in json.dumps(summary)
    rerun = {**run, 'attempt': 2, 'startedAt': '2026-01-01T00:00:02Z'}
    summary = summarize(rerun)
    assert summary['elapsed_to_last_job_s'] == 58
    assert summary['attempt_dispatch_delay_s'] == 1
    assert summary['initial_dispatch_delay_s'] is None
    try:
        summarize({**run, 'attempt': 2})
    except ValueError:
        pass
    else:
        raise AssertionError('Missing rerun start must not include the previous attempt.')
    regression = run['jobs'][0]
    regression['name'] = 'Isolated Docker API and UI regression'
    regression['steps'] = [
        {'name': 'Build cached isolated test runner', 'conclusion': 'success',
         'startedAt': '2026-01-01T00:00:03Z', 'completedAt': '2026-01-01T00:00:13Z'},
        {'name': 'Run bounded isolated regression suite', 'conclusion': 'success',
         'startedAt': '2026-01-01T00:00:14Z', 'completedAt': '2026-01-01T00:00:55Z'},
    ]
    summary = summarize(run, new_log)['regression']
    assert summary['outer_runner_build_step_s'] == 10
    assert summary['bounded_step_s'] == 41
    assert summary['job_duration_s'] == 57
    print('Profiler self-test passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runs', nargs='*', type=int)
    parser.add_argument('--repo', help='GitHub OWNER/REPO (required for live reads)')
    parser.add_argument('--input-dir', type=Path, help='Read RUN.json, RUN-regression.log, RUN-amd64.log locally')
    parser.add_argument('--attempt', type=int, help='Read one run attempt; default gh behavior may combine retried jobs')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.runs or not (args.repo or args.input_dir):
        parser.error('provide run IDs and --repo or --input-dir')
    results = []
    for run_id in args.runs:
        if args.input_dir:
            run = json.loads((args.input_dir / f'{run_id}.json').read_text())
            logs = {kind: (path.read_text() if path.exists() else '')
                    for kind in ('regression', 'amd64')
                    for path in [args.input_dir / f'{run_id}-{kind}.log']}
        else:
            base = ['run', 'view', str(run_id), '--repo', args.repo]
            if args.attempt is not None:
                base += ['--attempt', str(args.attempt)]
            run = json.loads(gh(*base, '--json', 'jobs,createdAt,startedAt,event,conclusion,attempt'))
            logs = {}
            for kind, name in [('regression', 'Isolated Docker API and UI regression'),
                               ('amd64', 'build-orchestrator (ubuntu-latest, linux/amd64, amd64)')]:
                job = next((job for job in run['jobs'] if job['name'] == name and job['conclusion'] != 'skipped'), None)
                logs[kind] = gh(*base, '--job', str(job['databaseId']), '--log') if job else ''
        results.append({'run_id': run_id, **summarize(run, logs['regression'], logs['amd64'])})
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()

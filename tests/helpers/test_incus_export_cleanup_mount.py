"""Opt-in real busy-bind regression; every mount lives in a private namespace."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RealExportCleanup(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("INCUS_EXPORT_CLEANUP_MOUNT_TEST") == "true" and os.geteuid() == 0,
                         "Explicit root-only isolated mount namespace test")
    def test_busy_stop_then_restart_recovers_only_owned_staging_and_preserves_model(self):
        script = r'''
import errno,pathlib,subprocess,sys
sys.path.insert(0,sys.argv[1])
from test_incus_host_mount_policy import PolicyTests,MODULE
case=PolicyTests();case.setUp();payload=case.cleanup_fixture(real_mount=True)
case.policy.mountinfo=lambda:pathlib.Path('/proc/self/mountinfo').read_text()
case.policy.unmount=lambda path:MODULE.unmount_export(path, namespace="/proc/self/ns/mnt")
stage=case.cleanup_stage;source=case.root/'share';holder=None
try:
 for cycle in range(2):
  subprocess.run(['mount','--bind',str(source),str(stage)],check=True)
  holder=subprocess.Popen(['python3','-c','import os,sys,time;os.chdir(sys.argv[1]);print("READY",flush=True);time.sleep(60)',str(stage)],stdout=subprocess.PIPE,text=True)
  assert holder.stdout.readline().strip()=='READY'
  try:case.policy.cleanup_worker_exports(payload)
  except MODULE.SOURCES.SourceRejected:pass
  else:raise AssertionError('Live holder must refuse normal cleanup')
  holder.terminate();holder.wait(timeout=5);holder=None
  try:stage.rmdir()
  except OSError as error:assert error.errno==errno.EBUSY
  else:raise AssertionError('Stale mount must reproduce Incus restart refusal')
  assert case.policy.cleanup_worker_exports(payload)['cleaned']==1
  assert case.policy.cleanup_worker_exports(payload)['cleaned']==0
  assert (source/'model').read_text()=='preserved model fixture'
 print('Two busy-stop/restart cycles passed with actual guarded cleanup; source data retained')
finally:
 if holder is not None:holder.terminate();holder.wait(timeout=5)
 subprocess.run(['umount','--',str(stage)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 case.doCleanups()
'''
        with tempfile.TemporaryDirectory(prefix="agentor-export-cleanup-ns-") as scratch:
            result = subprocess.run(['unshare', '--mount', '--propagation', 'private', '--',
                'python3', '-c', script, str(Path(__file__).parent)],
                env={**os.environ, 'TMPDIR': scratch}, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Two busy-stop/restart cycles passed', result.stdout)


if __name__ == '__main__':
    unittest.main()

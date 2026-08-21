"""Focused lifecycle cleanup tests for the plugin runner."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


RUNNER_PATH = Path(__file__).with_name("runner.py")
SPEC = importlib.util.spec_from_file_location("plugin_runner", RUNNER_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

REQUEST = {
    "installationId": "12345678-1234-4234-8234-123456789abc",
    "phase": "stop",
    "command": {"argv": ["true"]},
}


class StopCleanupTests(unittest.TestCase):
    def test_stop_cleans_background_state_after_command_failure_or_timeout(self):
        for result in ({"exitCode": 1}, {"exitCode": 124}):
            with self.subTest(result=result), patch.object(runner, "oneshot", return_value=result), patch.object(runner, "stop_state") as stop_state:
                self.assertEqual(runner.execute(REQUEST), result)
                stop_state.assert_called_once_with(REQUEST["installationId"])

    def test_stop_cleans_background_state_when_command_execution_raises(self):
        with patch.object(runner, "oneshot", side_effect=OSError()), patch.object(runner, "stop_state") as stop_state:
            with self.assertRaises(OSError):
                runner.execute(REQUEST)
            stop_state.assert_called_once_with(REQUEST["installationId"])


if __name__ == "__main__":
    unittest.main()

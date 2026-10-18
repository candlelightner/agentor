from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

ENTRYPOINT = Path(__file__).resolve().parents[2] / 'worker/entrypoint.sh'
SCRIPT = ENTRYPOINT.read_text().split("<<'CODEX_MCP_ENV'", 1)[1].split('\n', 1)[1].split('\nCODEX_MCP_ENV', 1)[0]


class CodexMcpEnvironmentTest(unittest.TestCase):
    def test_actual_entrypoint_reconciles_only_existing_canonical_commands_and_preserves_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'persisted.toml'
            config = root / 'config.toml'
            config.symlink_to(target)
            profile = root / 'account.toml'
            target.write_text('''# Keep user comments and unrelated settings.
model = "user-selected"
[mcp_servers.agentor-management]
command = "/usr/local/bin/agentor-management-mcp"
required = true
env_vars = [
    "KEEP_EXISTING",
]
[mcp_servers.agentor-management.env]
USER_SETTING = "preserved"
[mcp_servers.agentor-worker]
command = "/usr/local/bin/agentor-worker-mcp"
required = false
[mcp_servers.tavily]
command = "custom-command"
''')
            target.chmod(0o640)
            profile.write_text('[mcp_servers.tavily]\ncommand = "custom-profile"\n')
            before = tomllib.loads(target.read_text())
            profile_before = profile.read_bytes()
            command = [sys.executable, '-c', SCRIPT, str(config), str(profile)]
            subprocess.run(command, check=True, capture_output=True)
            result = tomllib.loads(target.read_text())
            expected = before
            expected['mcp_servers']['agentor-management']['env_vars'] = ['KEEP_EXISTING', 'AGENTOR_MANAGEMENT_MCP_URL']
            expected['mcp_servers']['agentor-worker']['env_vars'] = ['AGENTOR_WORKER_MCP_URL', 'ORCHESTRATOR_URL']
            self.assertEqual(result, expected)
            self.assertTrue(config.is_symlink())
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            self.assertIn('# Keep user comments', target.read_text())
            self.assertEqual(profile.read_bytes(), profile_before)
            first = target.read_bytes()
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(target.read_bytes(), first)
            target.write_text('[mcp_servers.agentor-management]\ncommand = "/custom/mcp"\nrequired = true\n')
            custom = target.read_bytes()
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(target.read_bytes(), custom)


if __name__ == '__main__':
    unittest.main()

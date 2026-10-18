"""Explicit disposable-fixture cleanup; not an installed host service API.

Every VM/create must already be acknowledged and captured compute removed.
Compare the exact fixture delta before changing two policy fields on its ETag.
Never turn absent instances into evidence that an unknown create settled.
"""
import importlib.util
import json
from pathlib import Path
import sys


stage, before, expected = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
if not Path(stage).name.startswith("agentor-host-mount-live.") or Path(stage).parent != Path("/var/tmp"):
    raise ValueError("Exact disposable host mount fixture required")
fields = {"restricted.devices.disk.paths", "user.agentor.host-mount-roots"}
if set(before) != fields or set(expected) != fields:
    raise ValueError("Only two fixture policy fields may be restored")
spec = importlib.util.spec_from_file_location("host_fixture_service", Path(stage) / "scripts/agentor-incus-network-service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
request = service.incus_request("/var/lib/incus/unix.socket")
current, etag = request("GET", "/1.0/projects/agentor")
if not etag or any(current["config"].get(key) != value for key, value in expected.items()):
    raise ValueError("Fixture policy changed; retain authority for diagnosis")
config = dict(current["config"])
for key, value in before.items():
    if value is None:
        config.pop(key, None)
    else:
        config[key] = value
request("PUT", "/1.0/projects/agentor", {"config": config, "description": current.get("description", "")}, etag)
after, _ = request("GET", "/1.0/projects/agentor")
if after["config"] != config:
    raise ValueError("Fixture restore acknowledgement changed; retain authority")
print("Exact fixture policy restored on native ETag; unrelated restrictions preserved")

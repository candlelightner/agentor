"""Explicit root-only disposable-host acceptance, prepare -> host reboot -> verify.

Uses fresh empty VMs (no guest image conversion), a stopped controller and private
DATA. Never reads or settles historical receipts. Failed fixtures are retained.
Copy this and the two production Python modules to a fresh SSD test directory.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import uuid

INSTALL = "e14e444d-01c0-4c49-9f48-72a7b7000331"
POOL = "agentor-ssd"
PROJECT = "agentor"
OCI = "sha256:38b656283e26e5b070b97a49ead034903480ccaf0fd465825f6e985819745b5f"
APP = "sha256:aefc8c5a1c6b6f832d0c2df49714177f88ef9b8278481eb1f3c961f2a9ed9e12"
FS = "issue2-source-e14e444d"
BLOCK = "issue2-block-e14e444d"
CONTROLLER = "agentor-issue2-e14e444d"
CONFIG = Path("/etc/agentor/incus") / INSTALL / "config.json"
BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("job_recovery", BASE / "recover-incus-job.py")
R = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(R)


def cli(*args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


def incus(*args): return cli("incus", "--force-local", *(() if args[0]=="query" else ("--project", PROJECT)), *args)
def custom(name): return R.native("/1.0/storage-pools/" + POOL + "/volumes/custom/" + name + "?project=" + PROJECT)
def instance(name): return R.native("/1.0/instances/" + name + "?project=" + PROJECT)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    R.exclusive(path, R.packed(value))


def proof(path):
    info = path.stat(); hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): hasher.update(block)
    return dict(sha=hasher.hexdigest(), inode=info.st_ino, uid=info.st_uid, gid=info.st_gid,
                mode=info.st_mode, size=info.st_size)


def prepare():
    assert os.geteuid() == 0 and not (BASE/"manifest.json").exists() and not CONFIG.exists()
    data = BASE/"data"; data.mkdir(mode=0o700)
    R.exclusive(data/"backup-installation-id", INSTALL.encode())
    for name in (FS, BLOCK):
        assert custom(name)["config"]["user.agentor.installation"] == INSTALL
    source_root = Path("/var/lib/incus/storage-pools")/POOL/"custom"
    sentinel = source_root/(PROJECT+"_"+FS)/"issue2-sentinel"
    if not sentinel.exists(): R.exclusive(sentinel, b"canonical-source-untouched\x00\xff")
    assert sentinel.read_bytes()==b"canonical-source-untouched\x00\xff"
    block = source_root/(PROJECT+"_"+BLOCK)/"root.img"
    # This is the exact newly created empty test block, never canonical old data.
    assert block.stat().st_size == 64*1024*1024
    with block.open("r+b") as stream: stream.write(b"fresh-issue2-block-sentinel"); stream.flush(); os.fsync(stream.fileno())
    controller = cli("docker", "--host", "unix:///var/run/docker.sock", "create", "--name", CONTROLLER,
                     "--restart=no", "--network=none", "--mount", "type=bind,src="+str(data)+",dst=/data", APP)
    save(CONFIG, dict(installation=INSTALL,project=PROJECT,pool=POOL,container=CONTROLLER,dataDir=str(data)))
    jobs = {}; worker = str(uuid.uuid4())
    for kind in ("converter", "archive", "sizing"):
        job = str(uuid.uuid4()); prefix = dict(converter="aic-",archive="abk-",sizing="asz-")[kind]; name=prefix+job
        incus("init", "--empty", "--vm", "--no-profiles", "--storage", POOL, name,
              "-d", "root,size=64MiB", "-c", "limits.memory=512MiB", "-c", "security.secureboot=false", "-c", "boot.autostart=false")
        native = instance(name); incarnation = native["config"]["volatile.uuid"]
        # Keep the real accepted start operation receipt; intentionally do not
        # replace it with its eventual result in the simulated private job.
        started=json.loads(incus("query", "-X", "PUT", "/1.0/instances/"+name+"/state?project="+PROJECT,
                                 "-d", '{"action":"start","timeout":30}'))
        operation=started["id"]
        done=R.native("/1.0/operations/"+operation+"/wait?timeout=30&project="+PROJECT)
        assert done["status_code"] == 200, done
        assert instance(name)["config"]["volatile.uuid"] == incarnation
        incus("stop", name, "--force")
        assert instance(name)["config"]["volatile.uuid"] == incarnation
        incus("delete", name)
        pending=dict(kind="start",operation="/1.0/operations/"+operation)
        if kind=="converter":
            record=dict(id=job,status="failed",phase="failed",digest=OCI,nativeDerivation=dict(
                context=dict(installationId=INSTALL,project=PROJECT,sourceImageId=OCI),converter=dict(
                    version=1,name=name,installationId=INSTALL,project=PROJECT,sourceImageId=OCI,incarnation=incarnation,pending=pending)))
            path=data/"image-catalog"/"image-catalog.json";document=dict(builds=[record],nativeBindings={},definitions=[])
        elif kind=="archive":
            copy="adb-"+job
            incus("storage","volume","copy",POOL+"/"+BLOCK,POOL+"/"+copy)
            copy_identity=custom(copy)
            assert copy_identity["config"]["user.agentor.installation"]==INSTALL
            incus("storage","volume","delete",POOL,copy)
            record=dict(version=1,id=job,installation=INSTALL,owner=dict(id=worker,userId="issue2",containerName="worker-"+worker),
                        sources=dict(docker=BLOCK,copy=True),instance=incarnation,pending=pending,copy=copy_identity)
            path=data/"incus-backup-helpers"/(job+".json");document=record
        else:
            record=dict(id=job,userId="volume-sizing",volumeId="builtin-"+R.digest(FS.encode())[:24],status="failed",phase="failed",
                        incusHelper=dict(installation=INSTALL,copy=False,instance=incarnation,pending=pending))
            path=data/"system-state"/"users"/"volume-sizing"/"volume-size-jobs.v1.json";document=[record]
        save(path,document)
        jobs[kind]=dict(id=job,path=str(path),original=base64.b64encode(path.read_bytes()).decode(),helper=name,uuid=incarnation)
        R.run(CONFIG,kind,job)
        try:R.run(CONFIG,kind,job,apply=True)
        except R.RecoveryError as error: assert "full same-host reboot" in str(error), error
        else:raise AssertionError("Apply before host reboot unexpectedly passed")
        assert path.read_bytes()==base64.b64decode(jobs[kind]["original"])
    manifest=dict(installation=INSTALL,boot=R.host_identity(),jobs=jobs,controller=controller,
                  sentinel=str(sentinel),block=str(block),files={str(p):proof(p) for p in (sentinel,block)},
                  sources={n:custom(n) for n in (FS,BLOCK)})
    save(BASE/"manifest.json",manifest)
    print("PREPARED: 3 real expired-result receipts, exact resources deleted; no-reboot negatives passed. Reboot host once.")


def verify():
    manifest=json.loads((BASE/"manifest.json").read_bytes());assert manifest["installation"]==INSTALL
    assert manifest["boot"]["machine"]==R.host_identity()["machine"] and manifest["boot"]["boot"]!=R.host_identity()["boot"]
    for kind,job in manifest["jobs"].items():
        original=base64.b64decode(job["original"]);path=Path(job["path"])
        assert path.read_bytes()==original
        R.run(CONFIG,kind,job["id"],apply=True)
        evidence=CONFIG.parent/("native-job-"+kind+"-"+job["id"])
        assert (evidence/"original").read_bytes()==original
        assert json.loads((evidence/"completed.json").read_bytes())["status"]=="failed-abandoned"
        if kind=="archive":assert not path.exists()
        else:assert path.read_bytes()==R.replacement(kind,json.loads(original),job["id"])
        try:R.run(CONFIG,kind,job["id"],apply=True)
        except (ValueError,OSError):pass
        else:raise AssertionError("Repeated retirement unexpectedly passed")
    assert manifest["files"]=={p:proof(Path(p)) for p in manifest["files"]}
    assert manifest["sources"]=={n:custom(n) for n in manifest["sources"]}
    print("PASS: real reboot, all 3 failed-only retirements, repeat refusals, retained byte-exact originals, unchanged canonical source data/metadata.")
    # Cleanup only fresh resources with the captured exact identity. Preserve
    # DATA/operator audit; stop on ambiguity rather than broad deletion.
    for name,source in manifest["sources"].items():
        assert custom(name)==source and not source["used_by"]
        incus("storage","volume","delete",POOL,name)
    current=json.loads(cli("docker","--host","unix:///var/run/docker.sock","inspect",CONTROLLER))[0]
    assert current["Id"]==manifest["controller"] and not current["State"]["Running"] and current["State"]["Pid"]==0
    cli("docker","--host","unix:///var/run/docker.sock","rm",manifest["controller"])
    print("Exact fresh test controller/volumes cleaned; historical jobs/resources untouched; DATA/audit retained.")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("stage",choices=("prepare","verify"));args=parser.parse_args()
    assert os.geteuid()==0
    {"prepare":prepare,"verify":verify}[args.stage]()

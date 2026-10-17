"""One-job operator recovery; all Docker/native/boot observations are mocked."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/recover-incus-job.py"
SPEC = importlib.util.spec_from_file_location("recover_job_test", SCRIPT)
R = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(R)
INSTALL = "12345678-1234-4234-8234-123456789abc"
JOB = "22345678-1234-4234-8234-123456789abc"
INSTANCE = "32345678-1234-4234-8234-123456789abc"
WORKER = "42345678-1234-4234-8234-123456789abc"
BOOT_A = "52345678-1234-4234-8234-123456789abc"
BOOT_B = "62345678-1234-4234-8234-123456789abc"


def fixture_record(kind):
    if kind == "archive":
        return dict(version=1, id=JOB, installation=INSTALL, owner=dict(id=WORKER, userId="owner", containerName="worker-"+WORKER),
                    sources=dict(workspace="workspace", agents="agents"), instance=INSTANCE, pending=dict(kind="start"))
    if kind == "converter":
        source="sha256:"+"a"*64
        return dict(id=JOB, status="failed", phase="failed", digest=source, nativeDerivation=dict(
            context=dict(installationId=INSTALL, project="agentor", sourceImageId=source),
            converter=dict(version=1, name="aic-"+JOB, installationId=INSTALL, project="agentor", sourceImageId=source,
                           incarnation=INSTANCE, pending=dict(kind="start"))))
    return dict(id=JOB, userId="volume-sizing", volumeId="builtin-"+R.digest(b"workspace")[:24], status="failed", phase="failed",
                incusHelper=dict(installation=INSTALL, copy=False, instance=INSTANCE, pending=dict(kind="create")))


class RecoveryTests(unittest.TestCase):
    def test_source_metadata_cannot_substitute_for_missing_backing_or_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);pool=root/"pool";pool.mkdir();custom=pool/"custom";custom.mkdir()
            for source in ("workspace","agents"):(custom/("agentor_"+source)).mkdir()
            config=dict(installation=INSTALL,project="agentor",pool="pool")
            volumes={source:dict(name=source,project="agentor",type="custom",content_type="filesystem",
                                created_at="original",used_by=[],config={"user.agentor.installation":INSTALL})
                     for source in ("workspace","agents")}
            def native(path,absent=False):
                if absent:return None
                if path=="/1.0/storage-pools/pool":return dict(status="Created",driver="dir",config=dict(source=str(pool)))
                return volumes[path.split("/")[-1].split("?")[0]]
            with patch.object(R,"Path",return_value=root),patch.object(R,"native",side_effect=native),patch.object(R,"command",return_value=BOOT_A):
                initial=R.observations(config,"archive",JOB,fixture_record("archive"))
                self.assertEqual(len(initial["sources"]),2)
                orphan=pool/"virtual-machines"/("agentor_abk-"+JOB);orphan.mkdir(parents=True)
                with self.assertRaisesRegex(ValueError,"Orphan compute"):R.observations(config,"archive",JOB,fixture_record("archive"))
                orphan.rmdir()
                orphan_copy=custom/("agentor_adb-"+JOB);orphan_copy.mkdir()
                archive=fixture_record("archive");archive["sources"]={"docker":"workspace","copy":True}
                archive["copy"]={"created_at":"original-copy","config":{"identity":"captured"}}
                with self.assertRaisesRegex(ValueError,"Orphan helper copy"):R.observations(config,"archive",JOB,archive)
                orphan_copy.rmdir()
                (custom/"agentor_workspace").rmdir()
                with self.assertRaises((ValueError,OSError)):R.observations(config,"archive",JOB,fixture_record("archive"))
                (custom/"agentor_workspace").mkdir()
                volumes["workspace"]["content_type"]="block"
                with self.assertRaises(OSError):R.observations(config,"archive",JOB,fixture_record("archive"))
                block=custom/"agentor_workspace"/"root.img";block.write_bytes(b"canonical")
                self.assertEqual(R.observations(config,"archive",JOB,fixture_record("archive"))["sources"][0]["backing"]["bytes"],9)
                block.unlink();block.symlink_to(custom/"agentor_agents")
                with self.assertRaises(OSError):R.observations(config,"archive",JOB,fixture_record("archive"))
                with patch.object(R,"command",return_value=""):
                    with self.assertRaisesRegex(ValueError,"filesystem identity"):R.observations(config,"archive",JOB,fixture_record("archive"))

    def test_all_overlapping_data_containers_must_be_stopped_without_restart(self):
        config=dict(container="controller",dataDir="/srv/data",pool="pool")
        controller=dict(Id="controller-id",Created="created",Image="image",Config={"Env":["INCUS_STORAGE_POOL=pool"]},
                        Mounts=[dict(Destination="/data",Source="/srv/data",RW=True)],
                        State=dict(Running=False,Pid=0),HostConfig=dict(RestartPolicy=dict(Name="no")))
        def inspect(*args):
            if "ps" in args:return "controller-id other-id"
            return json.dumps([controller] if args[-1]=="controller" else [controller,other])
        other=copy.deepcopy(controller);other["Id"]="other-id";other["Mounts"][0]["Source"]="/srv/data/image-catalog"
        with patch.object(R,"command",side_effect=inspect):
            self.assertEqual(R.offline_controller(config)["id"],"controller-id")
            for state,policy in ((dict(Running=True,Pid=42),"no"),(dict(Running=False,Pid=0),"unless-stopped")):
                other["State"]=state;other["HostConfig"]["RestartPolicy"]["Name"]=policy
                with self.assertRaisesRegex(ValueError,"DATA writer"):R.offline_controller(config)
            other["State"]=dict(Running=False,Pid=0);other["HostConfig"]["RestartPolicy"]["Name"]="no"
            controller["Config"]["Env"].append("INCUS_CONVERTER_STORAGE_POOL=different")
            with self.assertRaisesRegex(ValueError,"pool selection"):R.offline_controller(config)

    def test_layout_requires_existing_uuid_and_never_adopts_name_readback(self):
        config=dict(installation=INSTALL, project="agentor", pool="pool")
        volume=dict(name="workspace", config={})
        for kind in ("archive", "converter", "sizing"):
            record=fixture_record(kind)
            with patch.object(R,"command",return_value=json.dumps([dict(Id=record.get("digest"))])), patch.object(R,"native",return_value=[volume]):
                self.assertEqual(R.layout(config,kind,JOB,record)[2],INSTANCE)
                if kind=="converter": del record["nativeDerivation"]["converter"]["incarnation"]
                elif kind=="sizing": del record["incusHelper"]["instance"]
                else: del record["instance"]
                with self.assertRaisesRegex(ValueError,"Captured helper UUID"):
                    R.layout(config,kind,JOB,record)

    def test_unresolved_import_writer_and_missing_copy_ack_are_unsupported(self):
        config=dict(installation=INSTALL,project="agentor",pool="pool")
        converter=fixture_record("converter");converter["nativeDerivation"]["imageImport"]={}
        with self.assertRaisesRegex(ValueError,"pre-import"):R.layout(config,"converter",JOB,converter)
        archive=fixture_record("archive");archive["sources"]={"workspaceRestore":True};archive["writerSettled"]=True
        with self.assertRaisesRegex(ValueError,"Workspace writers"):R.layout(config,"archive",JOB,archive)
        archive=fixture_record("archive");archive["sources"]={"docker":"docker","copy":True}
        with self.assertRaisesRegex(ValueError,"copy acknowledgement"):R.layout(config,"archive",JOB,archive)
        sizing=fixture_record("sizing");sizing["incusHelper"]["copy"]=True
        with self.assertRaisesRegex(ValueError,"copy acknowledgement"):R.layout(config,"sizing",JOB,sizing)

    def flow(self, kind, mutate=None, reboot=True):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);config_root=root/"operator";namespace=config_root/INSTALL;namespace.mkdir(parents=True,mode=0o700)
            data=root/"data";data.mkdir(mode=0o700)
            (data/"backup-installation-id").write_text(INSTALL)
            config=namespace/"config.json";config.write_bytes(R.packed(dict(installation=INSTALL,project="agentor",pool="pool",container="controller",dataDir=str(data))));config.chmod(0o600)
            record=fixture_record(kind)
            if kind=="archive":
                path=data/"incus-backup-helpers"/(JOB+".json");document=record
            elif kind=="converter":
                path=data/"image-catalog"/"image-catalog.json";document=dict(builds=[record,dict(id="other",status="failed")],nativeBindings={"unrelated":dict(buildId="other")},definitions=[dict(id="source")])
            else:
                path=data/"system-state"/"users"/"volume-sizing"/"volume-size-jobs.v1.json";document=[record,dict(id="other",status="failed")]
            path.parent.mkdir(parents=True,mode=0o700);raw=R.packed(document)+b"\n";path.write_bytes(raw);path.chmod(0o600)
            source=data/"untouched-canonical-sentinel";source.write_bytes(b"canonical\x00\xff")
            host=dict(boot=BOOT_A,machine="same-host")
            controller=dict(id="controller-id",created="pinned-created",configuration="pinned-config")
            native=dict(pool="pool",helper="helper",incarnation=INSTANCE,sources=[dict(name="canonical",created_at="old",config={"identity":"original"})])
            with patch.object(R,"OPERATOR_UID",os.getuid()),patch.object(R,"CONFIG_ROOT",config_root), \
                 patch.object(R,"host_identity",side_effect=lambda:copy.deepcopy(host)), \
                 patch.object(R,"offline_controller",side_effect=lambda _config:copy.deepcopy(controller)), \
                 patch.object(R,"observations",side_effect=lambda *_args:copy.deepcopy(native)):
                R.run(config,kind,JOB)
                evidence=namespace/("native-job-"+kind+"-"+JOB)
                self.assertEqual((evidence/"original").read_bytes(),raw)
                self.assertEqual(path.read_bytes(),raw)
                if reboot:host["boot"]=BOOT_B
                if mutate:mutate(host,controller,native,path,evidence,config)
                try:R.run(config,kind,JOB,apply=True)
                except (ValueError,OSError):
                    self.assertFalse((evidence/"completed.json").exists())
                    self.assertEqual(source.read_bytes(),b"canonical\x00\xff")
                    return False,path.read_bytes() if path.exists() else None,raw
                self.assertEqual(source.read_bytes(),b"canonical\x00\xff")
                self.assertEqual((evidence/"original").read_bytes(),raw)
                self.assertEqual(json.loads((evidence/"completed.json").read_bytes())["status"],"failed-abandoned")
                if kind=="archive":self.assertFalse(path.exists())
                else:
                    actual=json.loads(path.read_bytes());expected=json.loads(R.replacement(kind,document,JOB))
                    self.assertEqual(actual,expected)
                    if kind=="converter":
                        self.assertEqual(actual["nativeBindings"],document["nativeBindings"])
                        self.assertEqual(actual["definitions"],document["definitions"])
                        self.assertEqual(actual["builds"][1],document["builds"][1])
                    else:self.assertEqual(actual[1],document[1])
                    self.assertEqual(path.stat().st_uid,os.getuid());self.assertEqual(path.stat().st_mode&0o777,0o600)
                with self.assertRaises((ValueError,OSError)):R.run(config,kind,JOB,apply=True)
                return True,None,raw

    def test_all_three_existing_fences_retire_only_after_cold_reboot_as_failed(self):
        for kind in ("archive","converter","sizing"):
            with self.subTest(kind=kind):self.assertTrue(self.flow(kind)[0])

    def test_no_cold_reboot_retains_original_fences(self):
        for kind in ("archive","converter","sizing"):
            with self.subTest(kind=kind):
                ok,current,original=self.flow(kind,reboot=False);self.assertFalse(ok);self.assertEqual(current,original)

    def test_machine_controller_source_config_receipt_or_evidence_drift_blocks(self):
        def change_config(h,c,n,p,e,config):
            value=json.loads(config.read_bytes());value["extra"]="changed";config.write_bytes(R.packed(value))
        mutations=[lambda h,c,n,p,e,f:h.update(machine="different-host"),
                   lambda h,c,n,p,e,f:c.update(configuration="replacement"),
                   lambda h,c,n,p,e,f:n["sources"][0].update(created_at="replacement"),
                   lambda h,c,n,p,e,f:p.write_bytes(p.read_bytes()+b" "),change_config,
                   lambda h,c,n,p,e,f:(e/"original").write_bytes(b"changed")]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                ok,_,_=self.flow("archive",mutate=mutation);self.assertFalse(ok)

    def test_nonregular_symlink_hardlink_fifo_and_oversized_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);regular=root/"regular";regular.write_bytes(b"safe");regular.chmod(0o600)
            symlink=root/"link";symlink.symlink_to(regular)
            fifo=root/"fifo";os.mkfifo(fifo)
            with self.assertRaises(OSError):R.read_file(symlink)
            with self.assertRaises(ValueError):R.read_file(fifo)
            os.link(regular,root/"hardlink")
            with self.assertRaises(ValueError):R.read_file(regular)
            large=root/"large";large.touch();large.chmod(0o600)
            with large.open("wb") as file:file.truncate(R.LIMIT+1)
            with self.assertRaises(ValueError):R.read_file(large)

    def test_failed_retirement_cannot_change_success_or_publish_bindings(self):
        record=fixture_record("converter");record["status"]="succeeded"
        with self.assertRaisesRegex(ValueError,"failed pre-import"):
            R.layout(dict(installation=INSTALL,project="agentor",pool="pool"),"converter",JOB,record)
        size=fixture_record("sizing");size["measurement"]={"allocatedBytes":123}
        with self.assertRaisesRegex(ValueError,"failed/cancelled"):
            R.layout(dict(installation=INSTALL,project="agentor",pool="pool"),"sizing",JOB,size)


if __name__=="__main__":unittest.main()
